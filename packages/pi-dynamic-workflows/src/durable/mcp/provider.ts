import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getAgentDir, type McpServerConfig } from '@earendil-works/pi-coding-agent';
import {
  defineExtension,
  defineTool,
  type Extension,
  type ToolRegistration
} from '@earendil-works/pi-durable';
import {
  McpAuthRequiredError,
  McpClient,
  type Tool as McpTool,
  type McpTransport,
  StdioTransport,
  StreamableHttpTransport,
  toLlmContent
} from '@earendil-works/pi-mcp';
import { Type } from 'typebox';
import { terminalLine } from '../../shared/terminal-text.js';
import { ownInternalExtension } from '../extension-admission.js';
import type {
  WorkflowExtensionProvider,
  WorkflowProviderContext,
  WorkflowProviderLease
} from '../providers.js';
import {
  createToolMatcher,
  expandHome,
  isHiddenByPi,
  loadPiMcpServers,
  mcpToolNames,
  resolveConfigValueAsync,
  resolveHeaders,
  unsupportedReason,
  type WorkflowMcpAllowlist
} from './config.js';

export const MCP_EXTENSION_PREFIX = 'workflow.mcp.';
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_S = 60;
const MAX_NOTE_LENGTH = 200;
const CLIENT_VERSION = '0.1.0';

export interface McpServerTarget {
  name: string;
  config: McpServerConfig;
  /** Working directory of the run; relative stdio `cwd` values resolve against it. */
  cwd: string;
}

/** Creates the transport for a server; tests inject in-memory transports. */
export type McpTransportFactory = (target: McpServerTarget) => McpTransport;

export interface McpProviderOptions {
  /** Servers (and tools) workflow subagents may use; everything else in Pi's `mcp.json` stays out. */
  allowlist: WorkflowMcpAllowlist;
  /** Where Pi's user-level `mcp.json` lives. Default: the Pi agent directory. */
  agentDir?: string;
  /** Per server, covering the handshake and the tool listing. Default 15 s. */
  connectTimeoutMs?: number;
  createTransport?: McpTransportFactory;
}

/**
 * Gives workflow subagents the allowlisted tools of MCP servers configured in Pi's `mcp.json`.
 *
 * Pi Durable's model for external tools (README, "Calling tools from tools"): the host owns the
 * client, each MCP tool is a Pi Durable tool named `mcp__<server>__<tool>`, and the registry is
 * process-local, so after a restart the provider reconnects and the stored extension names resolve
 * again. Connections are shared by every run in the process and released by reference count, as the
 * spec advises for extensions that own resources (§7.1).
 *
 * Tools remain declared directly, even on Pi Durable 1.2.0 and later: honoring Pi's codemode/deferred
 * exposure needs an explicitly configured sandbox/search extension. The tool list is read when a
 * run opens, and servers that need OAuth or a `/login` provider token are skipped with a note.
 */
export function createMcpProvider(options: McpProviderOptions): WorkflowExtensionProvider {
  const pool = new McpPool(options);
  return {
    name: 'mcp',
    async open(context) {
      const approved = Object.entries(options.allowlist.servers);
      if (approved.length === 0) return emptyLease();
      return openServers(pool, options, approved, context);
    }
  };
}

async function openServers(
  pool: McpPool,
  options: McpProviderOptions,
  approved: Array<[string, { tools?: string[] }]>,
  context: WorkflowProviderContext
): Promise<WorkflowProviderLease> {
  const config = loadPiMcpServers({
    agentDir: options.agentDir ?? getAgentDir(),
    cwd: context.cwd,
    projectTrusted: context.projectTrusted
  });
  // Config diagnostics can contain source text or paths with credentials. Keep run logs curated;
  // the user can inspect the original configuration with Pi's /mcp diagnostics.
  const notes = config.errors.length
    ? [`mcp config: ${config.errors.length} invalid entry or file(s); inspect /mcp in Pi`]
    : [];
  const held: McpConnection[] = [];
  const extensions: Extension[] = [];

  const releaseHeld = () => Promise.allSettled(held.map((connection) => pool.release(connection)));
  try {
    await Promise.all(
      approved.map(async ([server, approval]) => {
        const entry = config.servers.get(server);
        if (!entry) {
          notes.push(`mcp ${server}: not defined in Pi's mcp.json`);
          return;
        }
        if (entry.config.enabled === false) {
          notes.push(`mcp ${server}: disabled in Pi's mcp.json`);
          return;
        }
        const unsupported = unsupportedReason(entry.config);
        if (unsupported) {
          notes.push(`mcp ${server}: unavailable (${unsupported})`);
          return;
        }
        const connection = pool.acquire({ name: server, config: entry.config, cwd: context.cwd });
        held.push(connection);
        try {
          await race(connection.ready(), context.signal);
        } catch (error) {
          if (context.signal?.aborted) return;
          notes.push(note(`mcp ${server}: unavailable (${describe(error)})`));
          return;
        }
        const built = createServerExtension(server, entry.config, approval.tools, connection);
        if (built.count === 0) {
          notes.push(`mcp ${server}: connected, but no tool is both approved and visible`);
          return;
        }
        extensions.push(built.extension);
        notes.push(`mcp ${server}: ${built.count} of ${connection.tools.length} tool(s) available`);
      })
    );
  } catch (error) {
    // No lease will be returned, so nothing else would ever release what was acquired.
    await releaseHeld();
    throw error;
  }

  extensions.sort((a, b) => (a.name < b.name ? -1 : 1));
  notes.sort();
  let closed = false;
  const lease: WorkflowProviderLease = {
    extensions,
    notes,
    async close() {
      if (closed) return;
      closed = true;
      await releaseHeld();
    }
  };
  if (context.signal?.aborted) await lease.close();
  return lease;
}

function createServerExtension(
  server: string,
  config: McpServerConfig,
  approvedTools: string[] | undefined,
  connection: McpConnection
): { extension: Extension; count: number } {
  const allowed = approvedTools ? createToolMatcher(approvedTools) : () => true;
  const names = mcpToolNames(
    server,
    connection.tools.map((tool) => tool.name)
  );
  const tools: ToolRegistration[] = [];
  for (const tool of connection.tools) {
    if (!allowed(tool.name) || isHiddenByPi(config, tool.name)) continue;
    tools.push(createMcpTool(server, names.get(tool.name) as string, tool, connection));
  }
  return {
    extension: ownInternalExtension(
      defineExtension({ name: `${MCP_EXTENSION_PREFIX}${server}`, tools })
    ),
    count: tools.length
  };
}

function createMcpTool(server: string, name: string, tool: McpTool, connection: McpConnection) {
  return defineTool({
    name,
    description: tool.description ?? tool.title ?? `MCP tool ${tool.name} of server ${server}`,
    // Providers require an object schema, and some reject one without `properties`.
    parameters: Type.Unsafe<Record<string, unknown>>({
      ...tool.inputSchema,
      type: 'object',
      properties: tool.inputSchema.properties ?? {}
    }),
    // No `replay: 'safe'`: a call cut off by a crash may already have changed the server, and MCP
    // annotations are hints, not guarantees. The model gets an `interrupted` result and decides.
    execute: async (args, api, context) => {
      const signal = context.abortSignal;
      try {
        const client = await connection.ensure(signal);
        const result = await client.callTool(tool.name, args, {
          signal,
          onProgress: (progress) =>
            api.output(
              `${progress.message ?? `Progress ${progress.progress}${progress.total ? `/${progress.total}` : ''}`}\n`
            )
        });
        const content = toLlmContent(result);
        if (result.isError && content.length === 0) {
          content.push({ type: 'text', text: `MCP tool ${tool.name} failed` });
        }
        // MCP reports tool failures in the result rather than as protocol errors.
        return { output: content, ...(result.isError === true ? { isError: true } : {}) };
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new Error(`MCP server "${server}" tool "${tool.name}": ${describe(error)}`);
      }
    }
  });
}

/* ───────────────────────── connections ───────────────────────── */

class McpPool {
  readonly #connections = new Map<string, McpConnection>();
  constructor(private readonly options: McpProviderOptions) {}

  acquire(target: McpServerTarget): McpConnection {
    const key = JSON.stringify([target.name, target.cwd, target.config]);
    let connection = this.#connections.get(key);
    if (!connection) {
      connection = new McpConnection(key, target, this.options);
      this.#connections.set(key, connection);
    }
    connection.refs++;
    return connection;
  }

  async release(connection: McpConnection): Promise<void> {
    connection.refs--;
    if (connection.refs > 0) return;
    if (this.#connections.get(connection.key) === connection)
      this.#connections.delete(connection.key);
    await connection.close();
  }
}

/** One server connection, reconnecting on demand after it drops (as Pi does). */
class McpConnection {
  refs = 0;
  tools: McpTool[] = [];
  #client: McpClient | undefined;
  #connecting: Promise<McpClient> | undefined;
  #initial: Promise<void> | undefined;
  #closed = false;

  constructor(
    readonly key: string,
    private readonly target: McpServerTarget,
    private readonly options: McpProviderOptions
  ) {}

  /**
   * Resolves once the first connection (and tool listing) succeeded; rejects with its failure.
   * A failure is not remembered: another run sharing this connection gets a fresh attempt.
   */
  ready(): Promise<void> {
    this.#initial ??= this.ensure().then(
      () => undefined,
      (error) => {
        this.#initial = undefined;
        throw error;
      }
    );
    return this.#initial;
  }

  ensure(signal?: AbortSignal): Promise<McpClient> {
    if (this.#closed)
      return Promise.reject(new Error('the workflow run has closed this connection'));
    if (this.#client?.connectionState === 'connected') return Promise.resolve(this.#client);
    this.#connecting ??= this.#connect().finally(() => {
      this.#connecting = undefined;
    });
    return race(this.#connecting, signal);
  }

  async close(): Promise<void> {
    this.#closed = true;
    const client = this.#client;
    this.#client = undefined;
    // A connect still in flight closes its own client when it notices the connection was closed.
    await client?.close().catch(() => undefined);
  }

  async #connect(): Promise<McpClient> {
    const { name, config, cwd } = this.target;
    const timeoutMs = this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const client = new McpClient({
      name: 'pi-dynamic-workflows',
      version: CLIENT_VERSION,
      requestTimeoutMs: (config.timeout ?? DEFAULT_REQUEST_TIMEOUT_S) * 1000,
      roots: [{ uri: pathToFileURL(cwd).href, name: basename(cwd) }]
    });
    try {
      const transport = this.options.createTransport
        ? this.options.createTransport(this.target)
        : await createDefaultTransport(this.target);
      await withTimeout(
        client.connect(transport),
        timeoutMs,
        `connecting to MCP server "${name}" timed out after ${Math.round(timeoutMs / 1000)}s`
      );
      if (this.tools.length === 0) {
        this.tools = client.serverCapabilities?.tools
          ? await withTimeout(
              client.listTools(),
              timeoutMs,
              `listing the tools of "${name}" timed out`
            )
          : [];
      }
    } catch (error) {
      await client.close().catch(() => undefined);
      throw new McpFailure(safeFailureMessage(error));
    }
    if (this.#closed) {
      await client.close().catch(() => undefined);
      throw new Error('the workflow run has closed this connection');
    }
    client.onClose(() => {
      if (this.#client === client) this.#client = undefined;
    });
    this.#client = client;
    return client;
  }
}

async function createDefaultTransport({
  name,
  config,
  cwd
}: McpServerTarget): Promise<McpTransport> {
  if ('url' in config) {
    return new StreamableHttpTransport({
      url: config.url,
      headers: await resolveHeaders(config.headers, `MCP server "${name}"`)
    });
  }
  const env: Record<string, string> = {};
  await Promise.all(
    Object.entries(config.env ?? {}).map(async ([key, value]) => {
      env[key] = await resolveConfigValueAsync(value, `MCP server "${name}" env "${key}"`);
    })
  );
  return new StdioTransport({
    command: expandHome(config.command),
    args: config.args?.map(expandHome),
    cwd: resolve(cwd, expandHome(config.cwd ?? '.')),
    env,
    stderr: 'pipe'
  });
}

/* ───────────────────────── helpers ───────────────────────── */

function emptyLease(): WorkflowProviderLease {
  return { extensions: [], notes: [], close: async () => {} };
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new McpFailure(message)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Stops waiting when `signal` aborts; the underlying work is not cancelled. */
function race<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise<T>((resolvePromise, reject) => {
    const onAbort = () => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolvePromise(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

/** Only locally authored diagnostic messages may cross into durable logs or tool failures. */
class McpFailure extends Error {}

function safeFailureMessage(error: unknown): string {
  if (error instanceof McpFailure) return error.message;
  if (error instanceof McpAuthRequiredError) {
    return 'it requires sign-in (use /mcp in Pi); workflows cannot sign in yet, so give it an Authorization header';
  }
  // Transport exceptions, URLs, stderr, and protocol error messages are arbitrary server data.
  // Do not attach a cause: Durable may serialize it. Raw diagnostics belong in /mcp, not a run.
  return 'connection or request failed; inspect /mcp in Pi for diagnostics';
}

function describe(error: unknown): string {
  return note(safeFailureMessage(error));
}

/** One bounded, single-line terminal note. This is formatting, not secret redaction. */
function note(value: string): string {
  const line = terminalLine(value);
  return line.length > MAX_NOTE_LENGTH ? `${line.slice(0, MAX_NOTE_LENGTH - 1)}…` : line;
}
