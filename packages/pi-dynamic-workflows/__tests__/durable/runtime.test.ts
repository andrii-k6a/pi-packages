import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import {
  type AssistantMessage,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type TranscriptContext
} from '@earendil-works/pi-ai';
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  LiveDoc,
  type TaskId
} from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { Type } from 'typebox';
import { afterEach, beforeEach, test } from 'vitest';
import { WorkflowAttemptDoc } from '../../src/durable/docs.js';
import type { WorkflowRunBinding } from '../../src/durable/host.js';
import { WorkflowHost } from '../../src/durable/host.js';
import { listRuns } from '../../src/durable/store.js';
import { WorkflowProfileRoutingError } from '../../src/profiles/contracts.js';

type Responder = (request: {
  prompt: string;
  context: TranscriptContext;
  system: string;
  toolResults: string[];
  userMessages: string[];
  signal?: AbortSignal;
}) => AssistantMessage | Promise<AssistantMessage>;

let directory: string;
let cwd: string;
let faux: ReturnType<typeof fauxProvider>;
let prompts: string[];
let hosts: WorkflowHost[];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pi-durable-workflow-'));
  cwd = join(directory, 'workspace');
  await import('node:fs/promises').then((fs) => fs.mkdir(cwd));
  await writeFile(join(cwd, 'notes.txt'), 'durable notes\n');
  faux = fauxProvider({ models: [{ id: 'faux-1' }, { id: 'faux-fast' }] });
  prompts = [];
  hosts = [];
});

afterEach(async () => {
  for (const host of hosts) await host.closeAll();
  await rm(directory, { recursive: true, force: true });
});

function respond(responder: Responder): void {
  const step = async (context: TranscriptContext, options?: { signal?: AbortSignal }) => {
    const users = context.messages.filter((message) => message.role === 'user');
    const userMessages = users.map((message) => textOf(message.content));
    const prompt = userMessages[0] ?? '';
    const system = context.messages
      .filter((message) => message.role === 'system')
      .map((message) => JSON.stringify(message))
      .join('\n');
    const toolResults = context.messages
      .filter((message) => message.role === 'toolResult')
      .map((message) => `${(message as { toolName: string }).toolName}:${textOf(message.content)}`);
    if (toolResults.length === 0 && userMessages.length === 1) prompts.push(prompt);
    return responder({
      prompt,
      context,
      system,
      toolResults,
      userMessages,
      signal: options?.signal
    });
  };
  faux.setResponses(Array.from({ length: 400 }, () => step));
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (part as { text?: string }).text ?? '').join('');
}

function host(): WorkflowHost {
  const value = new WorkflowHost({ runsRoot: join(directory, 'runs'), watchIntervalMs: 20 });
  hosts.push(value);
  return value;
}

function binding(overrides: Partial<WorkflowRunBinding> = {}): WorkflowRunBinding {
  const models = createModels();
  models.setProvider(faux.provider);
  return {
    models,
    route: { provider: 'faux', modelId: 'faux-1', thinkingLevel: 'off' },
    resolveProfile(name) {
      if (name === 'fast') return { provider: 'faux', modelId: 'faux-fast', thinkingLevel: 'off' };
      throw new WorkflowProfileRoutingError(name, 'the profile is not approved');
    },
    promptContext: async () => ({
      contextFiles: [{ path: '/repo/AGENTS.md', content: 'PROJECT_RULES_MARKER' }],
      skills: '',
      append: ''
    }),
    ...overrides
  };
}

const text = (value: string) => fauxAssistantMessage([fauxText(value)]);

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

/** Resolves once `condition` holds, polling briefly. */
async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const FANOUT = `export const meta = { name: 'fanout', description: 'Fan out and synthesize' }
phase('Scan')
const found = await parallel(['alpha', 'beta'].map(name => () => agent('scan ' + name, { label: name })))
phase('Synthesize')
const summary = await agent('combine ' + found.join(' & '), {
  label: 'synth',
  schema: { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] }
})
return { found, summary }`;

function fanoutResponder(slow?: Promise<void>): Responder {
  return async ({ prompt, toolResults, signal }) => {
    if (prompt.startsWith('combine')) {
      if (slow) {
        await new Promise<void>((resolve, reject) => {
          slow.then(resolve);
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
      if (toolResults.some((result) => result.startsWith('structured_output'))) return text('done');
      return fauxAssistantMessage(
        [fauxToolCall('structured_output', { verdict: `ok:${prompt}` })],
        {
          stopReason: 'toolUse'
        }
      );
    }
    return text(`found ${prompt.slice(5)}`);
  };
}

test('a durable workflow fans out subagents, validates structured output, and records everything', async () => {
  let system = '';
  respond(async (request) => {
    system ||= request.system;
    if (request.prompt === 'scan alpha' && request.toolResults.length === 0) {
      return fauxAssistantMessage([fauxToolCall('read', { path: 'notes.txt' })], {
        stopReason: 'toolUse'
      });
    }
    if (request.prompt === 'scan alpha') return text(`found alpha with ${request.toolResults[0]}`);
    return fanoutResponder()(request);
  });
  const runs = host();
  const handle = await runs.start({ script: FANOUT, cwd }, binding());
  const snapshots: number[] = [];
  const stop = handle.watch((snapshot) => snapshots.push(snapshot.agentCount));
  const outcome = await handle.wait();
  stop();
  await handle.close();

  assert.equal(outcome.status, 'completed');
  if (outcome.status !== 'completed') return;
  const value = outcome.value as { found: string[]; summary: { verdict: string } };
  assert.match(value.found[0], /^found alpha with read:durable notes/);
  assert.equal(value.found[1], 'found beta');
  assert.equal(
    value.summary.verdict,
    'ok:combine found alpha with read:durable notes\n & found beta'
  );
  assert.equal(outcome.agentCount, 3);
  assert.deepEqual(outcome.phases, ['Scan', 'Synthesize']);
  assert.ok(outcome.unreportedUsage.totalTokens > 0);
  assert.ok(snapshots.length > 0);

  // Subagents get Pi-style prompt sections, including captured project context.
  assert.match(system, /PROJECT_RULES_MARKER/);
  assert.match(system, /subagent of a dynamic workflow/);
  assert.match(system, /filesystem access and the working directory are shared/);

  const report = await runs.report(handle.runId);
  assert.equal(report.status, 'completed');
  const rows = Object.values(report.attempts[0].agents).sort((a, b) => a.index - b.index);
  assert.deepEqual(
    rows.map((row) => [row.label, row.status, row.model]),
    [
      ['alpha', 'done', 'faux/faux-1'],
      ['beta', 'done', 'faux/faux-1'],
      ['synth', 'done', 'faux/faux-1']
    ]
  );
  assert.ok(rows.every((row) => row.endedAt !== undefined && row.usage?.totalTokens));
  assert.equal(report.usage.totalTokens, outcome.unreportedUsage.totalTokens);

  const alpha = rows[0].conversationId as number;
  const transcript = await runs.transcript(handle.runId, alpha);
  assert.deepEqual(
    transcript.map((item) => item.role),
    ['user', 'tool-call', 'tool-result', 'assistant']
  );
  assert.equal(transcript[2].toolName, 'read');
  const structuredTranscript = await runs.transcript(
    handle.runId,
    rows[2].conversationId as number
  );
  assert.ok(
    structuredTranscript.some(
      (item) => item.role === 'tool-result' && item.text === 'Structured output recorded.'
    )
  );

  const [index] = listRuns(runs.runsRoot);
  assert.equal(index.runId, handle.runId);
  assert.equal(index.status, 'completed');
  assert.deepEqual(index.agents, { total: 3, done: 3, error: 0, running: 0 });
});

test('nested tools receive output while structured_output stays model-only', async () => {
  const nested = defineExtension({
    name: 'nested',
    tools: [
      defineTool({
        name: 'inspect',
        description: 'Inspect with nested tools',
        parameters: Type.Object({}),
        execute: async (_args, api, context) => {
          const result = await api.executeTool('read', { path: 'notes.txt' }, context);
          assert.equal(result.structuredOutput, 'durable notes\n');
          const blocked = await api.executeTool('structured_output', { count: 999 }, context);
          assert.equal(blocked.isError, true);
          assert.ok(blocked.diagnostics.some((item) => item.code === 'tool_unavailable'));
          return { output: [{ type: 'text', text: String(result.structuredOutput) }] };
        }
      })
    ]
  });
  respond(({ toolResults }) => {
    if (!toolResults.length)
      return fauxAssistantMessage([fauxToolCall('inspect', {})], { stopReason: 'toolUse' });
    assert.ok(toolResults.some((result) => result === 'inspect:durable notes\n'));
    return fauxAssistantMessage([fauxToolCall('structured_output', { count: 3 })], {
      stopReason: 'toolUse'
    });
  });
  const runs = new WorkflowHost({ runsRoot: join(directory, 'runs'), extensions: [nested] });
  hosts.push(runs);
  const handle = await runs.start(
    {
      script: `export const meta = { name: 'nested', description: 'd' }; return await agent('work', { schema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] } })`,
      cwd
    },
    binding()
  );
  const outcome = await handle.wait();
  assert.equal(outcome.status, 'completed');
  if (outcome.status === 'completed') assert.deepEqual(outcome.value, { count: 3 });
  await handle.close();
});

test('inspection and stored-result snapshots retain unresolved compaction failures', async () => {
  respond(() => text('ok'));
  const runs = host();
  const handle = await runs.start(
    {
      script: `export const meta = { name: 'compaction', description: 'd' }; return await agent('work')`,
      cwd
    },
    binding()
  );
  const outcome = await handle.wait();
  const conversationId = outcome.snapshot.agents[0].conversationId as number;
  await handle.close();
  const harness = await Harness.open(
    await openNodeSqliteStorage(join(runs.runsRoot, handle.runId, 'run.sqlite')),
    { models: binding().models, registry: createRegistry() },
    BACKGROUND_CONTEXT
  );
  try {
    await harness.commit(async (tx) => {
      // Same durable state a failed background compaction leaves after the agent has answered.
      (await tx.doc(LiveDoc, conversationId as never)).compactionFailure = {
        taskId: 999 as never,
        reason: 'threshold',
        error: 'summary service unavailable'
      };
    }, BACKGROUND_CONTEXT);
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
  const report = await runs.report(handle.runId);
  assert.equal(
    report.attempts[0].compactionFailures?.[conversationId],
    'summary service unavailable'
  );
  const stored = await runs.resume(handle.runId, {}, binding());
  const replay = await stored.wait();
  assert.equal(replay.snapshot.agents[0].warning, 'compaction failed: summary service unavailable');
  await stored.close();
});

test('closing mid-run keeps the run resumable, and resuming re-runs only unfinished work', async () => {
  const slow = gate();
  respond(fanoutResponder(slow.opened));
  const first = host();
  const handle = await first.start({ script: FANOUT, cwd }, binding());
  await until(() => prompts.some((prompt) => prompt.startsWith('combine')));

  // Quit, reload, or session switch: close without aborting.
  await first.closeAll();
  const interrupted = await handle.wait();
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(listRuns(first.runsRoot)[0].status, 'interrupted');

  // A later process resumes from durable checkpoints.
  slow.open();
  prompts = [];
  const second = host();
  const resumed = await second.resume(handle.runId, {}, binding());
  assert.equal(resumed.mode, 'continued');
  assert.equal(resumed.attemptNumber, 1);
  const outcome = await resumed.wait();
  await resumed.close();

  assert.equal(outcome.status, 'completed');
  // Only the interrupted synthesis request ran again; the scans were not repeated.
  assert.ok(prompts.every((prompt) => prompt.startsWith('combine')));
  const report = await second.report(handle.runId);
  assert.equal(report.attempts.length, 1);
  assert.deepEqual(
    Object.values(report.attempts[0].agents).map((row) => row.status),
    ['done', 'done', 'done']
  );
});

test('abort stops subagents bottom-up; resuming starts a new attempt that reuses completed agents', async () => {
  const slow = gate();
  respond(fanoutResponder(slow.opened));
  const runs = host();
  const handle = await runs.start({ script: FANOUT, cwd }, binding());
  await until(() => prompts.some((prompt) => prompt.startsWith('combine')));
  await handle.abort();
  const aborted = await handle.wait();
  await handle.close();

  assert.equal(aborted.status, 'aborted');
  const statuses = Object.values(aborted.snapshot.agents).map((agent) => agent.status);
  assert.deepEqual(statuses, ['done', 'done', 'skipped']);

  slow.open();
  prompts = [];
  const retried = await runs.resume(handle.runId, {}, binding());
  assert.equal(retried.mode, 'retried');
  assert.equal(retried.attemptNumber, 2);
  const outcome = await retried.wait();
  await retried.close();

  assert.equal(outcome.status, 'completed');
  assert.deepEqual(
    prompts.filter((prompt) => prompt.startsWith('scan')),
    []
  );
  const agents = outcome.snapshot.agents;
  assert.deepEqual(
    agents.map((agent) => [agent.label, agent.reusedFrom]),
    [
      ['alpha', 1],
      ['beta', 1],
      ['synth', undefined]
    ]
  );
});

test('a failed script can be fixed and resumed without repeating completed agents', async () => {
  respond(async ({ prompt }) => text(`answer ${prompt}`));
  const runs = host();
  const broken = `export const meta = { name: 'fix_me', description: 'Fails after scanning' }
const a = await agent('scan one', { label: 'one' })
const b = await agent('scan two', { label: 'two' })
throw new Error('synthesis bug: ' + a.length)`;
  const handle = await runs.start({ script: broken, cwd }, binding());
  const failed = await handle.wait();
  await handle.close();
  assert.equal(failed.status, 'failed');
  if (failed.status === 'failed') assert.match(failed.error, /synthesis bug/);

  prompts = [];
  const fixed = broken.replace("throw new Error('synthesis bug: ' + a.length)", 'return [a, b]');
  const retried = await runs.resume(handle.runId, { script: fixed }, binding());
  const outcome = await retried.wait();
  await retried.close();

  assert.equal(outcome.status, 'completed');
  if (outcome.status !== 'completed') return;
  assert.deepEqual(outcome.value, ['answer scan one', 'answer scan two']);
  assert.deepEqual(prompts, []);
  // The first attempt already spent these tokens, but they were never returned to a parent
  // session (failures throw), so the completing attempt reports them now, exactly once.
  assert.ok(outcome.unreportedUsage.totalTokens > 0);
  assert.ok(outcome.usageReceipt);
  // Embedding hosts acknowledge only after persisting the usage and receipt in their own store.
  await runs.acknowledgeUsage(handle.runId, outcome.usageReceipt.id);

  const again = await runs.resume(handle.runId, {}, binding());
  assert.equal(again.mode, 'completed');
  const replay = await again.wait();
  await again.close();
  assert.equal(replay.status, 'completed');
  if (replay.status === 'completed') assert.equal(replay.unreportedUsage.totalTokens, 0);
});

test.each(['return 1n', 'const x = {}; x.self = x; return x'])(
  'non-JSON workflow results fail durably and report the same status: %s',
  async (body) => {
    respond(() => text('ok'));
    const runs = host();
    const handle = await runs.start(
      {
        script: `export const meta = { name: 'bad_json', description: 'd' }; await agent('work'); ${body}`,
        cwd
      },
      binding()
    );
    const outcome = await handle.wait();
    await handle.close();
    assert.equal(outcome.status, 'failed');
    if (outcome.status === 'failed') assert.match(outcome.error, /JSON-serializable/);
    assert.equal(outcome.snapshot.status, 'failed');
    const report = await runs.report(handle.runId);
    assert.equal(report.status, 'failed');
    assert.equal(report.attempts[0].status, 'failed');
    assert.match(report.attempts[0].error ?? '', /JSON-serializable/);
    assert.equal(runs.list()[0].status, 'failed');
  }
);

test('terminal task faults override stale attempt and agent documents in every read view', async () => {
  respond(() => text('ok'));
  const runs = host();
  const handle = await runs.start(
    {
      script:
        "export const meta = { name: 'faulted', description: 'd' }; return await agent('work')",
      cwd
    },
    binding()
  );
  await handle.wait();
  await handle.close();
  const harness = await Harness.open(
    await openNodeSqliteStorage(join(runs.runsRoot, handle.runId, 'run.sqlite')),
    { models: binding().models, registry: createRegistry() },
    BACKGROUND_CONTEXT
  );
  const faultedIds = [handle.attemptId];
  try {
    await harness.commit(async (tx) => {
      // Faults are scheduler-owned: they need not have run the extension's document-writing code.
      const attempt = await tx.doc(WorkflowAttemptDoc, String(handle.attemptId), {
        number: 1,
        taskId: handle.attemptId,
        scriptHash: '',
        at: 0
      });
      attempt.status = 'running';
      delete attempt.error;
      delete attempt.endedAt;
      const row = Object.values(attempt.agents)[0];
      row.status = 'running';
      faultedIds.push(row.taskId as number);
    }, BACKGROUND_CONTEXT);
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
  const storage = await openNodeSqliteStorage(join(runs.runsRoot, handle.runId, 'run.sqlite'));
  try {
    for (const id of faultedIds) {
      const record = await storage.task(id as TaskId, BACKGROUND_CONTEXT);
      assert.ok(record);
      await storage.commit(
        [
          {
            type: 'task',
            value: {
              ...record,
              memos: undefined,
              state: {
                status: 'terminal',
                outcome: { status: 'faulted', error: { message: 'injected uncaught fault' } }
              }
            }
          }
        ],
        BACKGROUND_CONTEXT
      );
    }
  } finally {
    await storage.close(BACKGROUND_CONTEXT);
  }
  const report = await runs.report(handle.runId);
  assert.equal(report.status, 'failed');
  assert.match(report.attempts[0].error ?? '', /injected uncaught fault/);
  const row = Object.values(report.attempts[0].agents)[0];
  assert.equal(row.status, 'error');
  assert.match(row.error ?? '', /injected uncaught fault/);
  assert.equal(runs.list()[0].status, 'failed');
  assert.equal(runs.list()[0].agents.running, 0);
});

test.each([undefined, '{broken', '{"version":1}'])(
  'missing or invalid index caches leave runs discoverable and are repaired on inspection: %s',
  async (cache) => {
    respond(() => text('ok'));
    const runs = host();
    const handle = await runs.start(
      {
        script:
          "export const meta = { name: 'cached', description: 'd' }; return await agent('work')",
        cwd
      },
      binding()
    );
    await handle.wait();
    await handle.close();
    const indexPath = join(runs.runsRoot, handle.runId, 'index.json');
    if (cache === undefined) await unlink(indexPath);
    else await writeFile(indexPath, cache);
    assert.equal(runs.list().length, 1);
    assert.equal(runs.list()[0].runId, handle.runId);
    assert.match(runs.list()[0].error ?? '', /cache missing or invalid/);
    assert.equal((await runs.report(handle.runId)).status, 'completed');
    assert.equal(runs.list()[0].name, 'cached');
    assert.equal(runs.list()[0].status, 'completed');
    assert.equal(runs.list()[0].error, undefined);
  }
);

test('a listing-cache write failure does not turn committed success into a failed tool result', async () => {
  const hold = gate();
  respond(async () => {
    await hold.opened;
    return text('ok');
  });
  const runs = host();
  const handle = await runs.start(
    {
      script:
        "export const meta = { name: 'cache_failure', description: 'd' }; return await agent('work')",
      cwd
    },
    binding()
  );
  const indexPath = join(runs.runsRoot, handle.runId, 'index.json');
  await unlink(indexPath);
  await mkdir(indexPath);
  hold.open();
  assert.equal((await handle.wait()).status, 'completed');
  await handle.close();
  assert.equal(runs.list()[0].runId, handle.runId);
});

test('a schema agent that answers in prose is nudged to call structured_output', async () => {
  respond(async ({ userMessages, toolResults }) => {
    if (toolResults.some((result) => result.startsWith('structured_output'))) return text('done');
    if (userMessages.length === 1) return text('Here is my answer in prose.');
    return fauxAssistantMessage([fauxToolCall('structured_output', { count: 3 })], {
      stopReason: 'toolUse'
    });
  });
  const runs = host();
  const handle = await runs.start(
    {
      script: `export const meta = { name: 'nudge', description: 'Nudge to structured output' }
return await agent('count things', { schema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] } })`,
      cwd
    },
    binding()
  );
  const outcome = await handle.wait();
  await handle.close();
  assert.equal(outcome.status, 'completed');
  if (outcome.status === 'completed') assert.deepEqual(outcome.value, { count: 3 });
});

test('failed subagents return null to the script and are recorded as errors', async () => {
  respond(async ({ prompt }) =>
    prompt === 'boom'
      ? fauxAssistantMessage([fauxText('')], { stopReason: 'error', errorMessage: 'provider down' })
      : text(`ok ${prompt}`)
  );
  const runs = new WorkflowHost({
    runsRoot: join(directory, 'runs'),
    settings: { retry: { enabled: false, maxRetries: 0 } }
  });
  hosts.push(runs);
  const handle = await runs.start(
    {
      script: `export const meta = { name: 'partial', description: 'One agent fails' }
const results = await parallel([() => agent('boom', { label: 'boom' }), () => agent('fine', { label: 'fine' })])
return results`,
      cwd
    },
    binding()
  );
  const outcome = await handle.wait();
  await handle.close();
  assert.equal(outcome.status, 'completed');
  if (outcome.status !== 'completed') return;
  assert.deepEqual(outcome.value, [null, 'ok fine']);
  const boom = outcome.snapshot.agents.find((agent) => agent.label === 'boom');
  assert.equal(boom?.status, 'error');
  assert.match(boom?.error ?? '', /provider down|did not answer/);
  assert.ok(outcome.snapshot.logs.some((log) => log.includes('agent boom failed')));
});

test('profiles route subagents durably, and unknown profiles fail the attempt loudly', async () => {
  const models: string[] = [];
  respond(async ({ context }) => {
    models.push(JSON.stringify(context).includes('faux-fast') ? 'fast' : 'default');
    return text('ok');
  });
  const runs = host();
  const handle = await runs.start(
    {
      script: `export const meta = { name: 'routes', description: 'Route by profile' }
await agent('default route', { label: 'default' })
await agent('fast route', { label: 'fast', profile: 'fast' })
return true`,
      cwd
    },
    binding()
  );
  const outcome = await handle.wait();
  await handle.close();
  assert.equal(outcome.status, 'completed');
  assert.deepEqual(
    outcome.snapshot.agents.map((agent) => [agent.label, agent.model, agent.profile]),
    [
      ['default', 'faux/faux-1', undefined],
      ['fast', 'faux/faux-fast', 'fast']
    ]
  );

  const unknown = await runs.start(
    {
      script: `export const meta = { name: 'bad_route', description: 'Unknown profile' }
await agent('x', { profile: 'nope' })
return true`,
      cwd
    },
    binding()
  );
  const failed = await unknown.wait();
  await unknown.close();
  assert.equal(failed.status, 'failed');
  if (failed.status === 'failed')
    assert.match(failed.error, /Cannot route workflow profile "nope"/);
});

test('identical agent calls get distinct durable identities that survive replay', async () => {
  const slow = gate();
  let calls = 0;
  respond(async ({ prompt, signal }) => {
    calls++;
    if (prompt === 'item' && calls === 2) {
      await new Promise<void>((resolve, reject) => {
        slow.opened.then(resolve);
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }
    return text(`r${calls}`);
  });
  const script = `export const meta = { name: 'dupes', description: 'Duplicate prompts' }
const results = await pipeline([1, 2, 3], () => agent('item'), (prev) => prev.toUpperCase())
return results`;
  const first = host();
  const handle = await first.start({ script, cwd }, binding());
  await until(() => calls >= 2);
  await first.closeAll();
  slow.open();

  calls = 10;
  const second = host();
  const resumed = await second.resume(handle.runId, {}, binding());
  const outcome = await resumed.wait();
  await resumed.close();
  assert.equal(outcome.status, 'completed');
  if (outcome.status !== 'completed') return;
  const values = outcome.value as string[];
  assert.equal(values.length, 3);
  assert.equal(new Set(outcome.snapshot.agents.map((agent) => agent.id)).size, 3);
  // The agent that finished before the interruption kept its result.
  assert.ok(values.includes('R1'));
});

test('the concurrency limit bounds live subagent tasks', async () => {
  let active = 0;
  let peak = 0;
  respond(async ({ prompt }) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    active--;
    return text(`ok ${prompt}`);
  });
  const runs = host();
  const handle = await runs.start(
    {
      script: `export const meta = { name: 'bounded', description: 'Bounded fan-out' }
return await parallel([1, 2, 3, 4, 5].map(n => () => agent('task ' + n, { label: 't' + n })))`,
      cwd,
      concurrency: 2
    },
    binding()
  );
  const outcome = await handle.wait();
  await handle.close();
  assert.equal(outcome.status, 'completed');
  assert.ok(peak <= 2, `peak ${peak}`);
});

test('invalid structured output is rejected back to the model, which then corrects it', async () => {
  let attempts = 0;
  respond(async ({ toolResults }) => {
    if (toolResults.some((result) => result === 'structured_output:Structured output recorded.'))
      return text('done');
    attempts++;
    return fauxAssistantMessage(
      [fauxToolCall('structured_output', attempts === 1 ? { count: 'three' } : { count: 3 })],
      { stopReason: 'toolUse' }
    );
  });
  const runs = host();
  const handle = await runs.start(
    {
      script: `export const meta = { name: 'validate', description: 'Validate output' }
return await agent('count', { schema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] } })`,
      cwd
    },
    binding()
  );
  const outcome = await handle.wait();
  await handle.close();
  assert.equal(outcome.status, 'completed');
  if (outcome.status === 'completed') assert.deepEqual(outcome.value, { count: 3 });
  assert.equal(attempts, 2);
});

test('an interrupted run can be aborted from another host, and a held run refuses a second owner', async () => {
  const slow = gate();
  respond(fanoutResponder(slow.opened));
  const first = host();
  const handle = await first.start({ script: FANOUT, cwd }, binding());
  await until(() => prompts.some((prompt) => prompt.startsWith('combine')));

  const second = host();
  await assert.rejects(second.resume(handle.runId, {}, binding()), /open in another Pi process/);
  await assert.rejects(second.report(handle.runId), /open in another Pi process/);

  await first.closeAll();
  assert.equal(await second.abort(handle.runId), 'aborted');
  const report = await second.report(handle.runId);
  assert.equal(report.status, 'aborted');
  assert.deepEqual(
    Object.values(report.attempts[0].agents).map((row) => row.status),
    ['done', 'done', 'skipped']
  );
  assert.equal(await second.abort(handle.runId), 'not_live');
  slow.open();
  second.delete(handle.runId);
  assert.deepEqual(second.list(), []);
});

const AUDIT_HEADER = "export const meta = { name: 'audit', description: 'regression coverage' }\n";

test('tokenBudget and the agent-call cap reach the script, and replay with the attempt', async () => {
  respond(async ({ prompt }) => text(`ok ${prompt}`));
  const runs = new WorkflowHost({
    runsRoot: join(directory, 'runs'),
    watchIntervalMs: 20,
    maxAgents: 2
  });
  hosts.push(runs);
  const handle = await runs.start(
    {
      script: `${AUDIT_HEADER}
const budgetView = { total: budget.total, remaining: budget.remaining() }
const outcomes = []
for (const name of ['a', 'b', 'c']) {
  try { outcomes.push(await agent(name, { label: name })) } catch (error) { outcomes.push(error.message) }
}
return { budgetView, outcomes }`,
      cwd,
      tokenBudget: 1_000_000
    },
    binding()
  );
  const outcome = await handle.wait();
  assert.equal(outcome.status, 'completed');
  if (outcome.status !== 'completed') return;
  assert.deepEqual(outcome.value, {
    budgetView: { total: 1_000_000, remaining: 1_000_000 },
    outcomes: [
      'ok a',
      'ok b',
      'workflow agent limit reached: at most 2 agent() calls are allowed per attempt'
    ]
  });
  const report = await runs.report(handle.runId);
  assert.equal(report.attempts.length, 1);
  await handle.close();
});

test('resuming with a different token budget replaces a live attempt; the same budget continues it', async () => {
  const release = gate();
  respond(async ({ prompt, signal }) => {
    if (prompt === 'slow') {
      await new Promise<void>((resolve, reject) => {
        release.opened.then(resolve);
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }
    return text(`ok ${prompt}`);
  });
  const script = `${AUDIT_HEADER}
const a = await agent('fast', { label: 'fast' })
const b = await agent('slow', { label: 'slow' })
return { a, b, total: budget.total }`;
  const first = host();
  const started = await first.start({ script, cwd, tokenBudget: 5_000_000 }, binding());
  await until(async () => {
    const report = await first.report(started.runId);
    return Object.values(report.attempts[0]?.agents ?? {}).some(
      (row) => row.label === 'fast' && row.status === 'done'
    );
  });
  await started.close();

  const second = host();
  const same = await second.resume(started.runId, { tokenBudget: 5_000_000 }, binding());
  assert.equal(same.mode, 'continued');
  await same.close();

  const third = host();
  const changed = await third.resume(started.runId, { tokenBudget: 9_000_000 }, binding());
  assert.equal(changed.mode, 'retried');
  release.open();
  const outcome = await changed.wait();
  assert.equal(outcome.status, 'completed');
  if (outcome.status === 'completed') {
    assert.deepEqual(outcome.value, { a: 'ok fast', b: 'ok slow', total: 9_000_000 });
    assert.ok(outcome.snapshot.agents.some((agent) => agent.reusedFrom === 1));
  }
  await changed.close();
});

test('the agent-call cap is validated, and a continued attempt keeps the cap it started with', async () => {
  assert.throws(() => new WorkflowHost({ maxAgents: 0 }), /positive integer or Infinity/);
  assert.throws(() => new WorkflowHost({ maxAgents: 1.5 }), /positive integer or Infinity/);
  assert.doesNotThrow(() => new WorkflowHost({ maxAgents: Number.POSITIVE_INFINITY }));

  const release = gate();
  respond(async ({ prompt, signal }) => {
    if (prompt === 'slow') {
      await new Promise<void>((resolve, reject) => {
        release.opened.then(resolve);
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }
    return text(`ok ${prompt}`);
  });
  const script = `${AUDIT_HEADER}
await agent('fast', { label: 'fast' })
await agent('slow', { label: 'slow' })
try { await agent('third', { label: 'third' }) } catch (error) { return error.message }
return 'no limit'`;
  const first = new WorkflowHost({ runsRoot: join(directory, 'runs'), maxAgents: 2 });
  hosts.push(first);
  const started = await first.start({ script, cwd }, binding());
  await until(() => prompts.includes('slow'));
  await first.closeAll();

  // A restarted process configured without that cap must not change what the attempt replays.
  release.open();
  const second = host();
  const resumed = await second.resume(started.runId, {}, binding());
  assert.equal(resumed.mode, 'continued');
  const outcome = await resumed.wait();
  await resumed.close();
  assert.equal(outcome.status, 'completed');
  if (outcome.status === 'completed') {
    assert.equal(
      outcome.value,
      'workflow agent limit reached: at most 2 agent() calls are allowed per attempt'
    );
  }
});

test('aborting an unknown run fails without creating storage for it', async () => {
  const runs = host();
  const id = '20260101-000000-never_existed-abcd';
  await assert.rejects(() => runs.abort(id), /unknown workflow run/);
  assert.deepEqual(runs.list(), []);
  assert.equal(listRuns(runs.runsRoot).length, 0);
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(join(runs.runsRoot, id)), false);
});

test('a subagent that ends without any text fails instead of returning an empty string', async () => {
  respond(async ({ prompt }) => (prompt === 'mute' ? text('') : text(`ok ${prompt}`)));
  const runs = host();
  const handle = await runs.start(
    {
      script: `${AUDIT_HEADER}
const results = await parallel([() => agent('mute', { label: 'mute' }), () => agent('fine', { label: 'fine' })])
return results`,
      cwd
    },
    binding()
  );
  const outcome = await handle.wait();
  assert.equal(outcome.status, 'completed');
  if (outcome.status !== 'completed') return;
  assert.deepEqual(outcome.value, [null, 'ok fine']);
  const mute = outcome.snapshot.agents.find((agent) => agent.label === 'mute');
  assert.equal(mute?.status, 'error');
  assert.match(mute?.error ?? '', /without a text answer/);
  await handle.close();
});

test('an unusable structured-output schema fails before any subagent is created', async () => {
  respond(async ({ prompt }) => text(`ok ${prompt}`));
  const runs = host();
  const handle = await runs.start(
    {
      script: `${AUDIT_HEADER}
return await agent('x', { schema: { type: 'array', items: { type: 'string' } } })`,
      cwd
    },
    binding()
  );
  const outcome = await handle.wait();
  assert.equal(outcome.status, 'failed');
  if (outcome.status === 'failed') assert.match(outcome.error, /type: "object"/);
  assert.deepEqual(prompts, []);
  await handle.close();
});

async function agentConversation(runs: WorkflowHost, runId: string, label: string) {
  const report = await runs.report(runId);
  const row = Object.values(report.attempts.at(-1)?.agents ?? {}).find(
    (candidate) => candidate.label === label
  );
  assert.ok(row?.conversationId !== undefined, `agent ${label} has a conversation`);
  return row.conversationId;
}

test('a running subagent can be followed live and steered, and the steer reaches its next request', async () => {
  const release = gate();
  respond(async ({ userMessages }) => {
    if (userMessages.length > 1) return text(`steered: ${userMessages[1]}`);
    await release.opened;
    return fauxAssistantMessage([fauxToolCall('read', { path: 'notes.txt' })], {
      stopReason: 'toolUse'
    });
  });
  const runs = host();
  const handle = await runs.start(
    { script: `${AUDIT_HEADER}\nreturn await agent('work', { label: 'worker' })`, cwd },
    binding()
  );
  await until(() => prompts.includes('work'));
  const conversationId = await agentConversation(runs, handle.runId, 'worker');

  const seen: Array<{ texts: string[]; busy: boolean }> = [];
  const stop = await runs.follow(handle.runId, conversationId, ({ items, busy }) =>
    seen.push({ texts: items.map((item) => item.text), busy })
  );
  await runs.steer(handle.runId, conversationId, '  Use pnpm, not npm  ');
  release.open();
  const outcome = await handle.wait();

  assert.equal(outcome.status, 'completed');
  if (outcome.status === 'completed') assert.equal(outcome.value, 'steered: Use pnpm, not npm');
  await until(() => seen.at(-1)?.busy === false);
  stop();
  const last = seen.at(-1);
  assert.ok(seen[0].busy, 'the first delivery is the current state of a working agent');
  assert.deepEqual(
    [last?.texts.includes('work'), last?.texts.includes('Use pnpm, not npm')],
    [true, true]
  );
  assert.equal(last?.texts.at(-1), 'steered: Use pnpm, not npm');
  await handle.close();
});

test('cancelling one subagent fails only its agent() call, and the run completes', async () => {
  respond(async ({ prompt, signal }) => {
    if (prompt === 'stuck') {
      await new Promise<never>((_, reject) =>
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      );
    }
    return text(`ok ${prompt}`);
  });
  const runs = host();
  const handle = await runs.start(
    {
      script: `${AUDIT_HEADER}
const results = await parallel([() => agent('stuck', { label: 'stuck' }), () => agent('fine', { label: 'fine' })])
return results`,
      cwd
    },
    binding()
  );
  await until(() => prompts.includes('stuck') && prompts.includes('fine'));
  const conversationId = await agentConversation(runs, handle.runId, 'stuck');
  await until(async () => {
    const report = await runs.report(handle.runId);
    return Object.values(report.attempts[0].agents).some(
      (row) => row.label === 'fine' && row.status === 'done'
    );
  });

  await runs.cancelAgent(handle.runId, conversationId);
  const outcome = await handle.wait();

  assert.equal(outcome.status, 'completed');
  if (outcome.status !== 'completed') return;
  assert.deepEqual(outcome.value, [null, 'ok fine']);
  const stuck = outcome.snapshot.agents.find((agent) => agent.label === 'stuck');
  assert.equal(stuck?.status, 'error');
  await assert.rejects(runs.cancelAgent(handle.runId, conversationId), /agent is not running/);
  await assert.rejects(runs.steer(handle.runId, conversationId, 'hi'), /agent is not running/);
  await handle.close();
  await assert.rejects(
    runs.steer(handle.runId, conversationId, 'hi'),
    /not running in this session/
  );
});

const CANCELLED_AGENT_SCRIPT = `${AUDIT_HEADER}
const first = await parallel([() => agent('stuck', { label: 'stuck' }), () => agent('fine', { label: 'fine' })])
const last = await agent('last', { label: 'last' })
return { first, last }`;

async function startWithCancelledAgent(runs: WorkflowHost, hold: ReturnType<typeof gate>) {
  let unstuck = false;
  respond(async ({ prompt, signal }) => {
    if (prompt === 'stuck' && !unstuck) {
      await new Promise<never>((_, reject) =>
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      );
    }
    if (prompt === 'last') {
      await new Promise<void>((resolve, reject) => {
        hold.opened.then(resolve);
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }
    return text(`ok ${prompt}`);
  });
  const handle = await runs.start({ script: CANCELLED_AGENT_SCRIPT, cwd }, binding());
  await until(() => prompts.includes('stuck') && prompts.includes('fine'));
  await runs.cancelAgent(handle.runId, await agentConversation(runs, handle.runId, 'stuck'));
  await until(() => prompts.includes('last'));
  prompts = [];
  unstuck = true;
  return handle;
}

test('resuming in place keeps a cancelled agent cancelled', async () => {
  const hold = gate();
  const runs = host();
  const handle = await startWithCancelledAgent(runs, hold);
  await handle.close();

  hold.open();
  const resumed = await runs.resume(handle.runId, {}, binding());
  const outcome = await resumed.wait();
  await resumed.close();

  assert.equal(resumed.mode, 'continued');
  assert.equal(outcome.status, 'completed');
  if (outcome.status === 'completed')
    assert.deepEqual(outcome.value, { first: [null, 'ok fine'], last: 'ok last' });
  assert.ok(!prompts.includes('stuck'));
});

test('a new attempt after an abort runs a cancelled agent again and reuses completed ones', async () => {
  const hold = gate();
  const runs = host();
  const handle = await startWithCancelledAgent(runs, hold);
  await handle.abort();
  await handle.wait();
  await handle.close();

  hold.open();
  const retried = await runs.resume(handle.runId, {}, binding());
  const outcome = await retried.wait();
  await retried.close();

  assert.equal(retried.mode, 'retried');
  assert.equal(outcome.status, 'completed');
  if (outcome.status === 'completed')
    assert.deepEqual(outcome.value, { first: ['ok stuck', 'ok fine'], last: 'ok last' });
  assert.ok(prompts.includes('stuck'));
  assert.ok(!prompts.includes('fine'));
});
