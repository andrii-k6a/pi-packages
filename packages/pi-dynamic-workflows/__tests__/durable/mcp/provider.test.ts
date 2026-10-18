import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AssistantMessage,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type TranscriptContext,
  Type
} from '@earendil-works/pi-ai';
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable';
import { StdioTransport } from '@earendil-works/pi-mcp';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { WorkflowHost, type WorkflowRunBinding } from '../../../src/durable/host.js';
import { mcpToolNames, type WorkflowMcpAllowlist } from '../../../src/durable/mcp/config.js';
import { createMcpProvider } from '../../../src/durable/mcp/provider.js';
import type { WorkflowExtensionProvider } from '../../../src/durable/providers.js';
import { SUBAGENT_EXTENSION_NAME } from '../../../src/durable/subagent.js';
import { createWorkflowRunBinding } from '../../../src/pi/workflow-tool.js';

const SERVER = join(import.meta.dirname, '../../fixtures', 'mcp-server.mjs');

type Request = {
  prompt: string;
  userMessages: string[];
  /** `toolName:text` of every tool result so far. */
  results: string[];
  failed: string[];
  offered: Set<string>;
  system: string;
  signal?: AbortSignal;
};

let directory: string;
let cwd: string;
let agentDir: string;
let log: string;
let faux: ReturnType<typeof fauxProvider>;
let hosts: WorkflowHost[];
let counter: number;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pi-workflow-mcp-'));
  cwd = join(directory, 'workspace');
  agentDir = join(directory, 'agent');
  log = join(directory, 'server.log');
  await mkdir(cwd);
  await mkdir(agentDir);
  vi.stubEnv('TEST_SECRET', 's3cret');
  faux = fauxProvider({ models: [{ id: 'faux-1' }] });
  hosts = [];
  counter = 0;
});

afterEach(async () => {
  for (const host of hosts) await host.closeAll();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((part) => (part as { text?: string }).text ?? '').join('')
      : '';

function respond(responder: (request: Request) => AssistantMessage | Promise<AssistantMessage>) {
  const step = async (context: TranscriptContext, options?: { signal?: AbortSignal }) => {
    const userMessages = context.messages
      .filter((message) => message.role === 'user')
      .map((message) => textOf(message.content));
    const offered = new Set<string>();
    for (const message of context.messages) {
      if (message.role !== 'system') continue;
      const delta = message as {
        toolsAdded?: Array<{ name: string }>;
        toolsRemoved?: Array<{ name: string }>;
      };
      for (const tool of delta.toolsAdded ?? []) offered.add(tool.name);
      for (const tool of delta.toolsRemoved ?? []) offered.delete(tool.name);
    }
    const toolResults = context.messages.filter((message) => message.role === 'toolResult');
    return responder({
      prompt: userMessages[0] ?? '',
      userMessages,
      results: toolResults.map(
        (message) => `${(message as { toolName: string }).toolName}:${textOf(message.content)}`
      ),
      failed: toolResults
        .filter((message) => (message as { isError?: boolean }).isError)
        .map((message) => (message as { toolName: string }).toolName),
      offered,
      system: context.messages
        .filter((message) => message.role === 'system')
        .map((message) => JSON.stringify(message))
        .join('\n'),
      signal: options?.signal
    });
  };
  faux.setResponses(Array.from({ length: 300 }, () => step));
}

const call = (name: string, args: Record<string, string> = {}) =>
  fauxAssistantMessage([fauxToolCall(name, args, { id: `call-${++counter}` })], {
    stopReason: 'toolUse'
  });
const say = (value: string) => fauxAssistantMessage([fauxText(value)]);

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  /** Waits for the gate; rejects when the request is cancelled (the run is closing). */
  const wait = (signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      opened.then(resolve);
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  return { open, wait };
}

async function until(condition: () => boolean, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const serverLog = (path = log) =>
  existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : [];

function binding(overrides: Partial<WorkflowRunBinding> = {}): WorkflowRunBinding {
  const models = createModels();
  models.setProvider(faux.provider);
  return {
    models,
    route: { provider: 'faux', modelId: 'faux-1', thinkingLevel: 'off' },
    resolveProfile() {
      throw new Error('no profiles');
    },
    promptContext: async () => ({ contextFiles: [], skills: '', append: '' }),
    ...overrides
  };
}

async function writePiConfig(servers: Record<string, unknown>, path = join(agentDir, 'mcp.json')) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify({ mcpServers: servers }));
}

const fake = (extra: Record<string, unknown> = {}) => ({
  command: process.execPath,
  args: [SERVER],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Pi expands this config placeholder, not JavaScript.
  env: { MCP_LOG: log, SECRET_CHECK: '${TEST_SECRET}' },
  ...extra
});

function host(allowlist: WorkflowMcpAllowlist | undefined, extra: object = {}): WorkflowHost {
  const value = new WorkflowHost({
    runsRoot: join(directory, 'runs'),
    watchIntervalMs: 20,
    settings: { retry: { enabled: false, maxRetries: 0 } },
    ...(allowlist ? { providers: [createMcpProvider({ allowlist, agentDir })] } : {}),
    ...extra
  });
  hosts.push(value);
  return value;
}

const ONE_AGENT = `export const meta = { name: 'mcp_demo', description: 'Use MCP tools' }
return await agent('use the tools', { label: 'worker' })`;

test('subagents call approved MCP tools; unapproved, Pi-hidden, and unlisted tools are never offered', async () => {
  await writePiConfig({
    fake: fake({ toolExposure: { 'delete_*': 'hidden' } }),
    other: fake({ env: { MCP_LOG: join(directory, 'other.log') } })
  });
  const seen: Set<string>[] = [];
  respond(({ results, offered }) => {
    seen.push(offered);
    if (results.length === 0) return call('mcp__fake__echo', { text: 'hi' });
    if (results.length === 1) return call('mcp__fake__read_env', { name: 'SECRET_CHECK' });
    if (results.length === 2) return call('mcp__fake__fail');
    return say(results.join(' | '));
  });
  const runs = host({ servers: { fake: { tools: ['echo', 'read_env', 'fail', 'delete_all'] } } });
  const handle = await runs.start({ script: ONE_AGENT, cwd }, binding());
  const outcome = await handle.wait();
  await handle.close();

  assert.equal(outcome.status, 'completed');
  if (outcome.status !== 'completed') return;
  const answer = outcome.value as string;
  assert.match(answer, /mcp__fake__echo:echo: hi/);
  // Environment references in Pi's mcp.json are resolved for the server process.
  assert.match(answer, /mcp__fake__read_env:SECRET_CHECK=s3cret/);
  assert.match(answer, /mcp__fake__fail:boom from server/);

  const offered = [...(seen.at(-1) ?? [])].filter((name) => name.startsWith('mcp__')).sort();
  assert.deepEqual(offered, ['mcp__fake__echo', 'mcp__fake__fail', 'mcp__fake__read_env']);
  assert.ok(outcome.snapshot.logs.includes('mcp fake: 3 of 5 tool(s) available'));

  // The server saw exactly the calls made; the unapproved server never started.
  assert.deepEqual(
    serverLog().filter((line) => line.startsWith('call')),
    ['call echo hi', 'call read_env', 'call fail']
  );
  assert.equal(existsSync(join(directory, 'other.log')), false);
  // Closing the run released the connection, which stopped the server.
  await until(() => serverLog().includes('exit'));
});

test('a failing MCP result is an error result for the model, not a failed subagent', async () => {
  await writePiConfig({ fake: fake() });
  let failed: string[] = [];
  respond(({ results, failed: errors }) => {
    if (results.length === 0) return call('mcp__fake__fail');
    failed = errors;
    return say('handled');
  });
  const runs = host({ servers: { fake: {} } });
  const handle = await runs.start({ script: ONE_AGENT, cwd }, binding());
  const outcome = await handle.wait();
  await handle.close();
  assert.equal(outcome.status, 'completed');
  assert.deepEqual(failed, ['mcp__fake__fail']);
});

test('an unreachable or undefined server degrades to a note; the workflow still runs', async () => {
  await writePiConfig({
    ghost: { command: join(directory, 'no-such-binary') },
    off: fake({ enabled: false })
  });
  const offered: string[] = [];
  respond(({ offered: tools }) => {
    offered.push(...[...tools].filter((name) => name.startsWith('mcp__')));
    return say('plain answer');
  });
  const runs = host({ servers: { ghost: {}, off: {}, missing: {} } });
  const handle = await runs.start({ script: ONE_AGENT, cwd }, binding());
  const outcome = await handle.wait();
  await handle.close();

  assert.equal(outcome.status, 'completed');
  if (outcome.status !== 'completed') return;
  assert.equal(outcome.value, 'plain answer');
  assert.deepEqual(offered, []);
  const logs = outcome.snapshot.logs.join('\n');
  assert.match(logs, /mcp ghost: unavailable \(/);
  assert.match(logs, /mcp off: disabled in Pi's mcp\.json/);
  assert.match(logs, /mcp missing: not defined in Pi's mcp\.json/);
});

test('raw MCP protocol errors cannot leak credentials into persisted tool diagnostics', async () => {
  const secret = 'protocol-credential-DO-NOT-PERSIST';
  await writePiConfig({ fake: fake({ env: { MCP_PROTOCOL_ERROR: secret } }) });
  let resultText = '';
  respond(({ results }) => {
    if (results.length === 0) return call('mcp__fake__echo', { text: 'hello' });
    resultText = results.join('\n');
    return say('handled protocol failure');
  });
  const runs = host({ servers: { fake: { tools: ['echo'] } } });
  const handle = await runs.start({ script: ONE_AGENT, cwd }, binding());
  const outcome = await handle.wait();
  assert.equal(outcome.status, 'completed');
  assert.match(resultText, /connection or request failed/);
  assert.equal(resultText.includes(secret), false);
  const conversationId = outcome.snapshot.agents[0].conversationId;
  assert.ok(conversationId !== undefined);
  const transcript = await runs.transcript(handle.runId, conversationId);
  assert.equal(JSON.stringify(transcript).includes(secret), false);
  await handle.close();
});

test('project-level servers are used only when the project is trusted', async () => {
  await writePiConfig({}, join(agentDir, 'mcp.json'));
  await writePiConfig({ projsrv: fake() }, join(cwd, '.pi', 'mcp.json'));
  respond(({ results }) =>
    results.length === 0 ? call('mcp__projsrv__echo', { text: 'p' }) : say(results[0])
  );
  const runs = host({ servers: { projsrv: { tools: ['echo'] } } });

  const untrusted = await runs.start(
    { script: ONE_AGENT, cwd },
    binding({ projectTrusted: false })
  );
  const first = await untrusted.wait();
  await untrusted.close();
  assert.ok(first.snapshot.logs.includes("mcp projsrv: not defined in Pi's mcp.json"));
  assert.equal(serverLog().length, 0);

  const trusted = await runs.start({ script: ONE_AGENT, cwd }, binding({ projectTrusted: true }));
  const second = await trusted.wait();
  await trusted.close();
  assert.equal(second.status, 'completed');
  if (second.status === 'completed') assert.match(second.value as string, /echo: p/);
});

test('resuming from a trusted session does not execute another project’s MCP configuration', async () => {
  await writePiConfig({ projsrv: fake() }, join(cwd, '.pi', 'mcp.json'));
  respond(() => say('ok'));
  const runs = host({ servers: { projsrv: {} } });
  const handle = await runs.start(
    {
      script: `${ONE_AGENT.replace('return await', 'await')}\nthrow new Error('retry')`,
      cwd
    },
    binding({ projectTrusted: false })
  );
  assert.equal((await handle.wait()).status, 'failed');
  await handle.close();
  const other = join(directory, 'trusted-project');
  await mkdir(other);
  const fromOther = createWorkflowRunBinding({
    cwd: other,
    isProjectTrusted: () => true,
    modelRegistry: { runtime: binding().models },
    model: { provider: 'faux', id: 'faux-1' },
    thinkingLevel: 'off',
    scopedModels: []
  } as never);
  const resumed = await runs.resume(handle.runId, {}, fromOther);
  await resumed.wait();
  await resumed.close();
  assert.equal(serverLog().length, 0);
});

test('MCP names survive reordered catalogs and hiding or unapproving a collision sibling', async () => {
  const catalog = ['get-item', 'get_item'];
  const expected = mcpToolNames('fake', catalog).get('get-item') as string;
  const open = async (names: string[], hidden: boolean) => {
    await writePiConfig({
      fake: fake({
        env: { MCP_LOG: log, MCP_TOOLS: JSON.stringify(names) },
        ...(hidden ? { toolExposure: { get_item: 'hidden' } } : {})
      })
    });
    return createMcpProvider({
      agentDir,
      allowlist: { servers: { fake: { tools: ['get-item'] } } }
    }).open({ cwd, projectTrusted: false });
  };
  const before = await open(catalog, false);
  try {
    assert.deepEqual(
      before.extensions[0].tools?.map((tool) => tool.name),
      [expected]
    );
  } finally {
    await before.close();
  }
  const after = await open([...catalog].reverse(), true);
  try {
    assert.deepEqual(
      after.extensions[0].tools?.map((tool) => tool.name),
      [expected]
    );
  } finally {
    await after.close();
  }
});

test('concurrent runs share one server connection, released when the last run closes', async () => {
  await writePiConfig({ fake: fake() });
  const hold = gate();
  respond(async ({ prompt, results, signal }) => {
    if (prompt === 'hold') {
      await hold.wait(signal);
      return say('released');
    }
    return results.length === 0 ? call('mcp__fake__echo', { text: 'quick' }) : say('quick done');
  });
  const runs = host({ servers: { fake: { tools: ['echo'] } } });
  const slow = await runs.start(
    {
      script: "export const meta = { name: 'slow', description: 'd' }\nreturn await agent('hold')",
      cwd
    },
    binding()
  );
  const quick = await runs.start(
    {
      script:
        "export const meta = { name: 'quick', description: 'd' }\nreturn await agent('quick')",
      cwd
    },
    binding()
  );
  assert.equal((await quick.wait()).status, 'completed');
  await quick.close();
  // The slow run still holds the connection, so the server is still up.
  assert.equal(serverLog().includes('exit'), false);

  hold.open();
  assert.equal((await slow.wait()).status, 'completed');
  await slow.close();
  await until(() => serverLog().includes('exit'));
  assert.equal(serverLog().filter((line) => line === 'spawn').length, 1);
});

const TWO_STEPS = `export const meta = { name: 'two_steps', description: 'Two sequential agents' }
const first = await agent('first one', { label: 'first' })
const second = await agent('second one', { label: 'second' })
return { first, second }`;

test('a resumed run reconnects its MCP servers and later agents use them', async () => {
  await writePiConfig({ fake: fake() });
  const hold = gate();
  respond(async ({ prompt, results, signal }) => {
    if (prompt === 'first one') {
      await hold.wait(signal);
      return say('first done');
    }
    return results.length === 0
      ? call('mcp__fake__echo', { text: 'after restart' })
      : say(results[0]);
  });
  const allowlist = { servers: { fake: { tools: ['echo'] } } };
  const before = host(allowlist);
  const handle = await before.start({ script: TWO_STEPS, cwd }, binding());
  await until(() => serverLog().includes('spawn'));
  await new Promise((resolve) => setTimeout(resolve, 100));
  await before.closeAll();
  assert.equal((await handle.wait()).status, 'interrupted');
  await until(() => serverLog().includes('exit'));

  hold.open();
  const after = host(allowlist);
  const resumed = await after.resume(handle.runId, {}, binding());
  assert.equal(resumed.mode, 'continued');
  const outcome = await resumed.wait();
  await resumed.close();

  assert.equal(outcome.status, 'completed');
  if (outcome.status !== 'completed') return;
  assert.deepEqual(outcome.value, {
    first: 'first done',
    second: 'mcp__fake__echo:echo: after restart'
  });
  // One server process per process lifetime: reconnect, not reuse of a dead connection.
  assert.equal(serverLog().filter((line) => line === 'spawn').length, 2);
});

test('after a restart without the provider, agents say which extension is missing', async () => {
  await writePiConfig({ fake: fake() });
  const hold = gate();
  const offeredToSecond: boolean[] = [];
  respond(async ({ prompt, offered, signal }) => {
    if (prompt === 'first one') {
      await hold.wait(signal);
      return say('first done');
    }
    offeredToSecond.push(offered.has('mcp__fake__echo'));
    return say('second done without mcp');
  });
  const before = host({ servers: { fake: { tools: ['echo'] } } });
  const handle = await before.start({ script: TWO_STEPS, cwd }, binding());
  await until(() => serverLog().includes('spawn'));
  await new Promise((resolve) => setTimeout(resolve, 100));
  await before.closeAll();
  await handle.wait();

  hold.open();
  const bare = host(undefined);
  const resumed = await bare.resume(handle.runId, {}, binding());
  const outcome = await resumed.wait();
  await resumed.close();

  assert.equal(outcome.status, 'completed');
  assert.deepEqual(offeredToSecond, [false]);
  assert.ok(
    outcome.snapshot.logs.some((line) =>
      line.includes('extension workflow.mcp.fake is not installed in this process')
    )
  );
});

test.each(['mcp', 'curated'] as const)(
  'an agent created while its %s extension is missing regains its tools on a later resume',
  async (kind) => {
    await writePiConfig({ fake: fake() });
    await writeFile(join(cwd, 'probe.txt'), 'advance to the next model request');
    const Notes = defineExtension({
      name: 'notes',
      tools: [
        defineTool({
          name: 'lookup_note',
          description: 'Look up a note',
          parameters: Type.Object({ text: Type.String() }),
          execute: async (args) => ({ output: [{ type: 'text', text: `note: ${args.text}` }] })
        })
      ]
    });
    const tool = kind === 'mcp' ? 'mcp__fake__echo' : 'lookup_note';
    const allowlist = kind === 'mcp' ? { servers: { fake: { tools: ['echo'] } } } : undefined;
    const extra = kind === 'curated' ? { extensions: [Notes] } : {};
    const firstHold = gate();
    const secondHold = gate();
    let firstStarted = false;
    let restored = false;
    const offeredToSecond: boolean[] = [];
    respond(async ({ prompt, offered, results, signal }) => {
      if (prompt === 'first one') {
        firstStarted = true;
        await firstHold.wait(signal);
        return say('first done');
      }
      offeredToSecond.push(offered.has(tool));
      if (results.length >= 2) return say(results.at(-1) ?? '');
      if (!restored) await secondHold.wait(signal);
      // A harmless built-in call advances the request prepared without the extension.
      return results.length === 0
        ? call('read', { path: 'probe.txt' })
        : call(tool, { text: 'restored' });
    });
    const before = host(allowlist, extra);
    const handle = await before.start({ script: TWO_STEPS, cwd }, binding());
    await until(() => firstStarted);
    await before.closeAll();
    assert.equal((await handle.wait()).status, 'interrupted');

    firstHold.open();
    const bare = host(undefined);
    const withoutExtension = await bare.resume(handle.runId, {}, binding());
    await until(() => offeredToSecond.length === 1);
    const report = await bare.report(handle.runId);
    assert.ok(
      report.attempts[0].logs.some((line) =>
        line.includes(
          `extension ${kind === 'mcp' ? 'workflow.mcp.fake' : 'notes'} is not installed`
        )
      )
    );
    await bare.closeAll();
    assert.equal((await withoutExtension.wait()).status, 'interrupted');

    restored = true;
    const after = host(allowlist, extra);
    const withExtension = await after.resume(handle.runId, {}, binding());
    const outcome = await withExtension.wait();
    await withExtension.close();
    assert.equal(outcome.status, 'completed');
    // Durable resumes the already-prepared request with its original tool set. The next request
    // must resolve the retained names again and offer the restored extension's tool.
    assert.equal(offeredToSecond[0], false);
    assert.equal(offeredToSecond.at(-1), true);
    if (outcome.status === 'completed') {
      assert.deepEqual(outcome.value, {
        first: 'first done',
        second: `${tool}:${kind === 'mcp' ? 'echo' : 'note'}: restored`
      });
    }
  }
);

test('curated Pi Durable extensions reach every subagent, and reserved or duplicate names are refused', async () => {
  const Notes = defineExtension({
    name: 'notes',
    tools: [
      defineTool({
        name: 'lookup_note',
        description: 'Look up a note',
        parameters: Type.Object({ topic: Type.String() }),
        execute: async (args) => ({ output: [{ type: 'text', text: `note about ${args.topic}` }] })
      })
    ],
    sections: [section('house_rules', () => 'HOUSE_RULES_MARKER')]
  });
  let system = '';
  respond(({ results, system: prompt }) => {
    system ||= prompt;
    return results.length === 0 ? call('lookup_note', { topic: 'caching' }) : say(results[0]);
  });
  const runs = host(undefined, { extensions: [Notes] });
  const handle = await runs.start({ script: ONE_AGENT, cwd }, binding());
  const outcome = await handle.wait();
  await handle.close();

  assert.equal(outcome.status, 'completed');
  if (outcome.status === 'completed') assert.equal(outcome.value, 'lookup_note:note about caching');
  assert.match(system, /HOUSE_RULES_MARKER/);

  const named = (name: string) => defineExtension({ name });
  assert.throws(() => new WorkflowHost({ extensions: [named('workflow.mine')] }), /reserved/);
  assert.throws(() => new WorkflowHost({ extensions: [named('coding-tools')] }), /reserved/);
  assert.throws(() => new WorkflowHost({ extensions: [named('a'), named('a')] }), /listed twice/);
});

test.each([
  'workflow.tasks',
  'workflow.output.fake',
  'workflow.mcp.fake',
  'coding-tools',
  SUBAGENT_EXTENSION_NAME
])('provider cannot replace reserved extension %s', async (name) => {
  let closed = false;
  respond(() => say('core tasks still work'));
  const provider: WorkflowExtensionProvider = {
    name: 'untrusted-provider',
    open: async () => ({
      extensions: [defineExtension({ name })],
      notes: [],
      close: async () => {
        closed = true;
      }
    })
  };
  const runs = host(undefined, { providers: [provider] });
  const handle = await runs.start({ script: ONE_AGENT, cwd }, binding());
  const outcome = await handle.wait();
  await handle.close();
  assert.equal(outcome.status, 'completed');
  assert.equal(closed, true);
  assert.ok(outcome.snapshot.logs.some((line) => line.includes('is reserved')));
});

test('MCP stderr and raw transport exceptions do not enter provider notes or durable logs', async () => {
  const secret = 'synthetic-credential-DO-NOT-PERSIST';
  await writePiConfig({
    failing: {
      command: process.execPath,
      args: ['-e', 'console.error(process.env.CREDENTIAL); process.exit(1)'],
      env: { CREDENTIAL: secret }
    },
    remote: {
      url: `https://example.invalid/${secret}`,
      headers: { Authorization: `Bearer ${secret}` }
    }
  });
  const stdio = createMcpProvider({ agentDir, allowlist: { servers: { failing: {} } } });
  const lease = await stdio.open({ cwd, projectTrusted: false });
  try {
    assert.match(lease.notes.join('\n'), /unavailable/);
    assert.equal(lease.notes.join('\n').includes(secret), false);
  } finally {
    await lease.close();
  }
  const remote = createMcpProvider({
    agentDir,
    allowlist: { servers: { remote: {} } },
    createTransport: () => {
      throw new Error(`HTTP failure with ${secret}`);
    }
  });
  respond(() => say('works without MCP'));
  const runs = host(undefined, { providers: [remote] });
  const handle = await runs.start({ script: ONE_AGENT, cwd }, binding());
  const outcome = await handle.wait();
  await handle.close();
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.snapshot.logs.join('\n').includes(secret), false);
  const reportPath = join(directory, 'runs', handle.runId, 'reports.log');
  assert.equal(existsSync(reportPath) && readFileSync(reportPath, 'utf8').includes(secret), false);
});

test('provider extension precedence follows declaration order, not acquisition timing', async () => {
  const hold = gate();
  let opening = false;
  const closed: string[] = [];
  const provider = (name: string): WorkflowExtensionProvider => ({
    name,
    open: async () => {
      if (name === 'first') {
        opening = true;
        await hold.wait();
      }
      return {
        extensions: [
          defineExtension({
            name: 'source',
            tools: [
              defineTool({
                name: 'source',
                description: 'Which provider supplied this tool',
                parameters: Type.Object({}),
                execute: async () => ({ output: [{ type: 'text', text: name }] })
              })
            ]
          })
        ],
        notes: [],
        close: async () => {
          closed.push(name);
        }
      };
    }
  });
  respond(({ results }) => (results.length ? say(results[0]) : call('source')));
  const runs = host(undefined, { providers: [provider('first'), provider('second')] });
  const starting = runs.start({ script: ONE_AGENT, cwd }, binding());
  await until(() => opening);
  hold.open();
  const handle = await starting;
  const outcome = await handle.wait();
  await handle.close();
  assert.equal(outcome.status, 'completed');
  if (outcome.status === 'completed') assert.equal(outcome.value, 'source:first');
  assert.ok(
    outcome.snapshot.logs.includes('extension source was provided twice; the first one is used')
  );
  assert.deepEqual(closed.sort(), ['first', 'second']);
});

test('a provider that fails to open is a note, and cancelling while providers open leaves no run behind', async () => {
  respond(() => say('ok'));
  const broken: WorkflowExtensionProvider = {
    name: 'broken',
    open: async () => {
      throw new Error('boom while opening');
    }
  };
  const runs = host(undefined, { providers: [broken] });
  const handle = await runs.start({ script: ONE_AGENT, cwd }, binding());
  const outcome = await handle.wait();
  await handle.close();
  assert.equal(outcome.status, 'completed');
  assert.ok(outcome.snapshot.logs.includes('broken: unavailable (provider failed to open)'));
  assert.equal(outcome.snapshot.logs.join('\n').includes('boom while opening'), false);

  const stuck: WorkflowExtensionProvider = {
    name: 'stuck',
    open: ({ signal }) =>
      new Promise((resolve) => {
        signal?.addEventListener('abort', () =>
          resolve({ extensions: [], notes: [], close: async () => {} })
        );
      })
  };
  const isolated = new WorkflowHost({
    runsRoot: join(directory, 'runs-cancel'),
    providers: [stuck]
  });
  hosts.push(isolated);
  const controller = new AbortController();
  const starting = isolated.start(
    { script: ONE_AGENT, cwd },
    binding({ signal: controller.signal })
  );
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(starting, /Workflow was aborted/);
  assert.deepEqual(
    readdirSync(join(directory, 'runs-cancel')).filter((name) => name !== '.locks'),
    []
  );
});

test('a failed first connection is not remembered: the next run sharing it tries again', async () => {
  await writePiConfig({ fake: fake() });
  let attempts = 0;
  const provider = createMcpProvider({
    agentDir,
    allowlist: { servers: { fake: { tools: ['echo'] } } },
    createTransport: ({ cwd: serverCwd }) => {
      attempts++;
      if (attempts === 1) throw new Error('server was not ready');
      return new StdioTransport({
        command: process.execPath,
        args: [SERVER],
        cwd: serverCwd,
        env: { MCP_LOG: log },
        stderr: 'pipe'
      });
    }
  });

  const first = await provider.open({ cwd, projectTrusted: false });
  try {
    assert.match(first.notes.join('\n'), /mcp fake: unavailable/);
    assert.deepEqual(first.extensions, []);
    // The first run still holds the connection, so the second one shares it.
    const second = await provider.open({ cwd, projectTrusted: false });
    try {
      assert.match(second.notes.join('\n'), /mcp fake: 1 of \d+ tool\(s\) available/);
      assert.equal(second.extensions.length, 1);
      assert.equal(attempts, 2);
    } finally {
      await second.close();
    }
  } finally {
    await first.close();
  }
});
