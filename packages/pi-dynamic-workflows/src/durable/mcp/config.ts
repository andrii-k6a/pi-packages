import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  getShellConfig,
  type McpServerConfig
} from '@earendil-works/pi-coding-agent';
import { terminalInput } from '../../shared/terminal-text.js';

/**
 * Two files cooperate:
 *
 * - Pi's own `mcp.json` (user-level, plus `.pi/mcp.json` in trusted projects) says how to reach each
 *   MCP server. It is read, never written.
 * - `<agentDir>/pi-dynamic-workflows/mcp.json` says which of those servers (and which of their
 *   tools) workflow subagents may use. Subagents run unattended with shell and edit access, so
 *   nothing is shared with them by default.
 */

const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
const MAX_TOOL_NAME_LENGTH = 64;
const COMMAND_TIMEOUT_MS = 10_000;
const OVERRIDE_KEYS = ['enabled', 'exposure', 'toolExposure'];
const EXPOSURES = ['codemode', 'deferred', 'direct', 'hidden'];

/* ───────────────────────── workflows allowlist ───────────────────────── */

export interface WorkflowMcpServerApproval {
  /** Server tool names or `*` patterns subagents may call. Absent: every tool Pi has not hidden. */
  tools?: string[];
}

export interface WorkflowMcpAllowlist {
  servers: Record<string, WorkflowMcpServerApproval>;
}

export function workflowMcpPath(agentDir = getAgentDir()): string {
  return join(agentDir, 'pi-dynamic-workflows', 'mcp.json');
}

/** Loads approved servers; a missing file approves none. Malformed files fail loudly, like profiles. */
export function loadWorkflowMcpAllowlist(agentDir = getAgentDir()): WorkflowMcpAllowlist {
  const path = workflowMcpPath(agentDir);
  if (!existsSync(path)) return { servers: {} };
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw allowlistError(path, `invalid JSON: ${text(message)}`);
  }
  return parseWorkflowMcpAllowlist(config, path);
}

export function parseWorkflowMcpAllowlist(config: unknown, path: string): WorkflowMcpAllowlist {
  if (!isRecord(config)) throw allowlistError(path, 'expected an object');
  for (const key of Object.keys(config)) {
    if (key !== 'servers') throw allowlistError(path, `unknown key ${quote(key)}`);
  }
  if (!isRecord(config.servers)) throw allowlistError(path, '"servers" must be an object');
  const servers: Record<string, WorkflowMcpServerApproval> = {};
  const namespaces = new Map<string, string>();
  for (const [name, value] of Object.entries(config.servers)) {
    if (!SERVER_NAME.test(name)) {
      throw allowlistError(
        path,
        `server name ${quote(name)} may use only letters, digits, "_" and "-"`
      );
    }
    const namespace = name.replace(/-/g, '_');
    const clash = namespaces.get(namespace);
    if (clash)
      throw allowlistError(path, `servers ${quote(clash)} and ${quote(name)} are the same server`);
    namespaces.set(namespace, name);
    if (!isRecord(value)) throw allowlistError(path, `server ${quote(name)} must be an object`);
    for (const key of Object.keys(value)) {
      if (key !== 'tools') {
        throw allowlistError(path, `server ${quote(name)} has unknown key ${quote(key)}`);
      }
    }
    if (value.tools === undefined) {
      servers[name] = {};
      continue;
    }
    if (
      !Array.isArray(value.tools) ||
      !value.tools.every((tool) => typeof tool === 'string' && tool.trim() && text(tool) === tool)
    ) {
      throw allowlistError(
        path,
        `server ${quote(name)}: "tools" must be an array of tool names or patterns`
      );
    }
    servers[name] = { tools: [...new Set((value.tools as string[]).map((tool) => tool.trim()))] };
  }
  return { servers };
}

/* ───────────────────────── Pi's mcp.json (read-only subset) ───────────────────────── */

export interface PiMcpServer {
  name: string;
  config: McpServerConfig;
  source: string;
  scope: 'global' | 'project';
}

export interface LoadedPiMcpServers {
  servers: Map<string, PiMcpServer>;
  errors: string[];
}

/**
 * Pi's `loadMcpConfig` is internal to the coding agent, so this reads the documented format:
 * `mcpServers` in the agent directory and, for trusted projects, `<cwd>/.pi/mcp.json`; project
 * entries replace global ones, and a project entry with only `enabled`/`exposure`/`toolExposure`
 * overrides the global server of that name.
 */
export function loadPiMcpServers(options: {
  agentDir: string;
  cwd: string;
  projectTrusted: boolean;
}): LoadedPiMcpServers {
  const state: LoadedPiMcpServers = { servers: new Map(), errors: [] };
  readPiMcpFile(join(options.agentDir, 'mcp.json'), 'global', state);
  if (options.projectTrusted) {
    readPiMcpFile(join(options.cwd, CONFIG_DIR_NAME, 'mcp.json'), 'project', state);
  }
  return state;
}

function readPiMcpFile(path: string, scope: 'global' | 'project', state: LoadedPiMcpServers): void {
  if (!existsSync(path)) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // JSON parser messages may quote credentials from the source file.
    state.errors.push(`${path}: unreadable or invalid JSON`);
    return;
  }
  if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
    state.errors.push(`${path}: expected an object with an "mcpServers" object`);
    return;
  }
  for (const [name, value] of Object.entries(parsed.mcpServers ?? {})) {
    if (scope === 'project' && isRecord(value) && isOverride(value)) {
      const base = state.servers.get(name);
      const extra = Object.keys(value).filter((key) => !OVERRIDE_KEYS.includes(key));
      if (!base) {
        state.errors.push(
          `${path}: server "${name}" needs "command" or "url", or a global server to override`
        );
      } else if (extra.length > 0) {
        state.errors.push(
          `${path}: server "${name}": an override can only set ${OVERRIDE_KEYS.join(', ')}`
        );
      } else {
        const config = validateServer(name, { ...base.config, ...value });
        if (typeof config === 'string') state.errors.push(`${path}: ${config}`);
        else state.servers.set(name, { ...base, config });
      }
      continue;
    }
    const config = validateServer(name, value);
    if (typeof config === 'string') {
      state.errors.push(`${path}: ${config}`);
      continue;
    }
    const clash = [...state.servers.keys()].find(
      (other) => other !== name && namespaceOf(other) === namespaceOf(name)
    );
    if (clash) {
      state.errors.push(`${path}: server "${name}" conflicts with "${clash}"`);
      continue;
    }
    state.servers.set(name, { name, config, source: path, scope });
  }
}

function isOverride(value: Record<string, unknown>): boolean {
  return value.command === undefined && value.url === undefined && value.type === undefined;
}

function namespaceOf(server: string): string {
  return `mcp__${server.replace(/-/g, '_')}`;
}

/** Validates an entry the way Pi documents it; returns the entry, or a message naming the problem. */
function validateServer(name: string, raw: unknown): McpServerConfig | string {
  if (!SERVER_NAME.test(name))
    return `invalid server name "${name}" (use letters, digits, "_" and "-")`;
  if (!isRecord(raw)) return `server "${name}" must be an object`;
  const value: Record<string, unknown> = { ...raw };
  if (value.exposure === 'codemode-deferred') value.exposure = 'codemode';
  const { type, exposure, enabled, timeout, toolExposure } = value;
  if (exposure !== undefined && !EXPOSURES.includes(exposure as string)) {
    return `server "${name}": exposure must be one of ${EXPOSURES.map((item) => `"${item}"`).join(', ')}`;
  }
  if (toolExposure !== undefined) {
    if (!isRecord(toolExposure))
      return `server "${name}": toolExposure must map tool names to exposures`;
    for (const [tool, item] of Object.entries(toolExposure)) {
      if (!EXPOSURES.includes(item as string)) {
        return `server "${name}": toolExposure "${tool}" must be one of ${EXPOSURES.join(', ')}`;
      }
    }
  }
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    return `server "${name}": enabled must be a boolean`;
  }
  if (timeout !== undefined && (typeof timeout !== 'number' || !(timeout > 0))) {
    return `server "${name}": timeout must be a positive number of seconds`;
  }
  if (type === 'sse') return `server "${name}": legacy SSE transport is not supported`;
  if (
    typeof value.url === 'string' &&
    (type === undefined || type === 'http' || type === 'streamable-http')
  ) {
    if (!URL.canParse(value.url) || !/^https?:$/.test(new URL(value.url).protocol)) {
      return `server "${name}": url must be an http or https URL`;
    }
    if (value.headers !== undefined && !isStringRecord(value.headers)) {
      return `server "${name}": headers must map names to strings`;
    }
    return value as unknown as McpServerConfig;
  }
  if (typeof value.command === 'string' && (type === undefined || type === 'stdio')) {
    if (
      value.args !== undefined &&
      !(Array.isArray(value.args) && value.args.every((arg) => typeof arg === 'string'))
    ) {
      return `server "${name}": args must be an array of strings`;
    }
    if (value.env !== undefined && !isStringRecord(value.env)) {
      return `server "${name}": env must map names to strings`;
    }
    if (value.cwd !== undefined && typeof value.cwd !== 'string') {
      return `server "${name}": cwd must be a string`;
    }
    return value as unknown as McpServerConfig;
  }
  return `server "${name}" needs either "command" (stdio) or "url" (streamable HTTP)`;
}

/** Why workflows cannot connect to this server at all, if they cannot. */
export function unsupportedReason(config: McpServerConfig): string | undefined {
  const value = config as unknown as Record<string, unknown>;
  if (value.oauth !== undefined) return 'it uses OAuth sign-in, which workflows do not support yet';
  if (value.auth !== undefined)
    return 'it uses a /login provider token, which workflows do not support yet';
  return undefined;
}

/* ───────────────────────── values, names, matching ───────────────────────── */

/** `~` and `~/…` name the home directory, like in a shell. */
export function expandHome(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/') || (process.platform === 'win32' && value.startsWith('~\\'))) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

/**
 * Resolve an `env`/`headers` value as Pi does: a leading `!` runs the rest as a command and uses its
 * trimmed output; otherwise `${NAME}` and `$NAME` read the environment, `$$` and `$!` are literal.
 * Errors name the variable or setting, never the value or the command output.
 */
export function resolveConfigValue(
  config: string,
  description: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (config.startsWith('!')) {
    const shell = getShellConfig();
    const command = config.slice(1);
    const result = spawnSync(
      shell.shell,
      shell.commandTransport === 'stdin' ? shell.args : [...shell.args, command],
      {
        encoding: 'utf8',
        timeout: COMMAND_TIMEOUT_MS,
        env,
        stdio: ['pipe', 'pipe', 'ignore'],
        ...(shell.commandTransport === 'stdin' ? { input: command } : {})
      }
    );
    const output = result.stdout?.trim();
    if (result.error || result.status !== 0 || !output) {
      throw new Error(`${description}: the command did not produce a value`);
    }
    return output;
  }
  let resolved = '';
  let index = 0;
  while (index < config.length) {
    const dollar = config.indexOf('$', index);
    if (dollar < 0) {
      resolved += config.slice(index);
      break;
    }
    resolved += config.slice(index, dollar);
    const next = config[dollar + 1];
    if (next === '$' || next === '!') {
      resolved += next;
      index = dollar + 2;
      continue;
    }
    let name: string | undefined;
    let end = dollar + 1;
    if (next === '{') {
      const close = config.indexOf('}', dollar + 2);
      const candidate = close < 0 ? undefined : config.slice(dollar + 2, close);
      if (candidate !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(candidate)) {
        name = candidate;
        end = close + 1;
      }
    } else {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(config.slice(dollar + 1));
      if (match) {
        name = match[0];
        end = dollar + 1 + match[0].length;
      }
    }
    if (name === undefined) {
      resolved += '$';
      index = dollar + 1;
      continue;
    }
    const value = env[name];
    if (!value) throw new Error(`${description}: environment variable ${name} is not set`);
    resolved += value;
    index = end;
  }
  return resolved;
}

/**
 * Same result as `resolveConfigValue`, but a `!command` runs without blocking Pi's event loop
 * (a secret-manager lookup can take seconds). Errors still never include the command's output.
 */
export async function resolveConfigValueAsync(
  config: string,
  description: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  if (!config.startsWith('!')) return resolveConfigValue(config, description, env);
  const output = await runCommand(config.slice(1), env);
  if (!output) throw new Error(`${description}: the command did not produce a value`);
  return output;
}

function runCommand(command: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const shell = getShellConfig();
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const finish = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const child = spawn(
      shell.shell,
      shell.commandTransport === 'stdin' ? shell.args : [...shell.args, command],
      { env, stdio: ['pipe', 'pipe', 'ignore'] }
    );
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(undefined);
    }, COMMAND_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
    });
    child.stdin.on('error', () => {});
    child.on('error', () => finish(undefined));
    child.on('close', (code) => finish(code === 0 ? output.trim() || undefined : undefined));
    child.stdin.end(shell.commandTransport === 'stdin' ? command : undefined);
  });
}

export async function resolveHeaders(
  headers: Record<string, string> | undefined,
  description: string
): Promise<Record<string, string> | undefined> {
  if (!headers) return undefined;
  const entries = await Promise.all(
    Object.entries(headers).map(
      async ([key, value]) =>
        [key, await resolveConfigValueAsync(value, `${description} header "${key}"`)] as const
    )
  );
  return Object.fromEntries(entries);
}

/** `mcp__<server>__<tool>` as Pi names it: anything but `[A-Za-z0-9_]` becomes `_`; hash when long or taken. */
export function mcpToolName(
  server: string,
  tool: string,
  isTaken: (name: string) => boolean = () => false
): string {
  const name = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, '_');
  if (name.length <= MAX_TOOL_NAME_LENGTH && !isTaken(name)) return name;
  const hash = createHash('sha256').update(`${server}\0${tool}`).digest('hex').slice(0, 8);
  return `${name.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`;
}

/** Name a complete server catalog before filtering it; every member of a collision gets a hash. */
export function mcpToolNames(server: string, tools: readonly string[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const tool of new Set(tools)) {
    const name = mcpToolName(server, tool);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return new Map(
    tools.map((tool) => [tool, mcpToolName(server, tool, (name) => (counts.get(name) ?? 0) > 1)])
  );
}

/** Exact names and `*` patterns, as in Pi's `toolExposure`. */
export function createToolMatcher(entries: readonly string[]): (name: string) => boolean {
  const names = new Set(entries.filter((entry) => !entry.includes('*')));
  const patterns = entries.filter((entry) => entry.includes('*')).map(patternToRegExp);
  return (name) => names.has(name) || patterns.some((pattern) => pattern.test(name));
}

function patternToRegExp(pattern: string): RegExp {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`);
}

/**
 * Whether Pi's configuration hides a tool: an exact `toolExposure` entry wins over patterns (first
 * match in the object wins among patterns), then the server's own `exposure`. Any other exposure
 * means "reachable"; workflows can only declare tools directly for now.
 */
export function isHiddenByPi(config: McpServerConfig, tool: string): boolean {
  const overrides = config.toolExposure ?? {};
  const exact = overrides[tool];
  if (exact !== undefined) return exact === 'hidden';
  for (const [pattern, exposure] of Object.entries(overrides)) {
    if (pattern.includes('*') && patternToRegExp(pattern).test(tool)) return exposure === 'hidden';
  }
  return config.exposure === 'hidden';
}

/* ───────────────────────── helpers ───────────────────────── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

function text(value: string): string {
  return terminalInput(value);
}

function quote(value: string): string {
  return JSON.stringify(text(value));
}

function allowlistError(path: string, message: string): Error {
  return new Error(`Invalid dynamic workflow MCP configuration at ${text(path)}: ${message}`);
}
