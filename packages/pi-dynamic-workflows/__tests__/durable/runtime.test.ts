import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
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
import { hashScript, WorkflowHost } from '../../src/durable/host.js';
import { listRuns, runDatabasePath } from '../../src/durable/store.js';
import type {
  RunCheckpoint,
  WorkflowAgentInput,
  WorkflowRunInput
} from '../../src/durable/tasks/contracts.js';
import { agentBaseKey } from '../../src/durable/tasks/run.js';
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

function host(options: ConstructorParameters<typeof WorkflowHost>[0] = {}): WorkflowHost {
  const value = new WorkflowHost({
    runsRoot: join(directory, 'runs'),
    watchIntervalMs: 20,
    ...options
  });
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

test.each(['phase', 'agent'] as const)(
  'recovery bypasses an unreached %s profile and preserves completed call identities',
  async (selection) => {
    const script = `export const meta = { name: 'unreached_profile', description: 'Recover a later stage' }
phase('Find', { profile: 'basic' })
const found = await agent('finder', { label: 'finder' })
const gate = await agent('gate', { label: 'gate' })
if (gate === null) throw new Error('finding incomplete')
${selection === 'phase' ? "phase('Verify', { profile: 'unreached' })" : "phase('Verify')"}
const verified = await agent('verifier', { label: 'verifier'${selection === 'agent' ? ", profile: 'unreached'" : ''} })
if (verified === null) throw new Error('verification incomplete')
return { found, verified }`;
    const original = { provider: 'faux', modelId: 'faux-1', thinkingLevel: 'off' } as const;
    respond(({ prompt }) => {
      if (prompt === 'gate') throw new Error('quota_exceeded');
      return text(prompt);
    });
    const firstHost = host();
    const first = await firstHost.start(
      { script, cwd },
      binding({
        resolveProfile(name) {
          assert.equal(name, 'basic', 'verification must not start in the first attempt');
          return original;
        }
      })
    );
    assert.equal((await first.wait()).status, 'failed');
    await first.close();
    assert.deepEqual(prompts, ['finder', 'gate']);
    const initial = (await firstHost.report(first.runId)).attempts[0];
    const finderKey = Object.values(initial.agents).find((row) => row.label === 'finder')?.key;
    assert.ok(finderKey);
    assert.equal(initial.profileRoutes?.unreached, undefined);
    await firstHost.closeAll();

    const replacement = { provider: 'faux', modelId: 'faux-fast', thinkingLevel: 'off' } as const;
    const recoveryBinding = binding({
      resolveProfile(name, pinned) {
        if (name !== 'fast')
          throw new WorkflowProfileRoutingError(name, 'original profile is unavailable');
        if (pinned) assert.deepEqual(pinned, replacement);
        return replacement;
      }
    });
    const secondHost = host();
    prompts.length = 0;
    respond(({ prompt }) => {
      if (prompt === 'verifier') throw new Error('provider unavailable');
      return text(prompt);
    });
    const recovered = await secondHost.resume(
      first.runId,
      { resumeProfile: 'fast' },
      recoveryBinding
    );
    assert.equal((await recovered.wait()).status, 'failed');
    await recovered.close();
    assert.deepEqual(prompts, ['gate', 'verifier']);
    assert.deepEqual(
      (await secondHost.report(first.runId)).attempts.at(-1)?.profileRoutes?.unreached,
      replacement
    );
    await secondHost.closeAll();

    const finalHost = host();
    prompts.length = 0;
    respond(({ prompt }) => text(prompt));
    const final = await finalHost.resume(first.runId, {}, recoveryBinding);
    const outcome = await final.wait();
    assert.equal(outcome.status, 'completed');
    await final.close();
    assert.deepEqual(prompts, ['verifier']);
    const latest = (await finalHost.report(first.runId)).attempts.at(-1);
    assert.ok(latest);
    assert.equal(latest.agents[finderKey].reusedFrom, 1);
    assert.equal(latest.agents[finderKey].profile, 'basic');
    assert.equal(latest.agents[finderKey].model, 'faux/faux-1');
    assert.deepEqual(
      Object.values(latest.agents)
        .filter((row) => row.label !== 'finder')
        .map((row) => [row.label, row.profile, row.model, row.reusedFrom]),
      [
        ['gate', 'fast', 'faux/faux-fast', 2],
        ['verifier', 'fast', 'faux/faux-fast', undefined]
      ]
    );
    assert.equal(latest.script, script);
  }
);

test('recovery bypasses an unavailable workflow profile before its first call', async () => {
  const script = `export const meta = { name: 'unresolved_default', description: 'Recover a default route', profile: 'unavailable' }
return await agent('work', { label: 'worker' })`;
  const runs = host();
  const first = await runs.start({ script, cwd }, binding());
  assert.equal((await first.wait()).status, 'failed');
  await first.close();
  assert.deepEqual(prompts, []);
  respond(() => text('recovered'));
  const recovered = await runs.resume(first.runId, { resumeProfile: 'fast' }, binding());
  const outcome = await recovered.wait();
  assert.equal(outcome.status, 'completed');
  if (outcome.status === 'completed') assert.equal(outcome.value, 'recovered');
  await recovered.close();
  assert.deepEqual(prompts, ['work']);
});

test('recovery profile preserves logical calls across failed, aborted, and reopened attempts', async () => {
  let stage = 1;
  const script = `export const meta = { name: 'recovery', description: 'Recover unfinished work', profile: 'hard' }
phase('Find')
const found = await parallel(['finder-a', 'finder-b'].map(label => () => agent(label, { label })))
if (found.includes(null)) throw new Error('finder failed')
phase('Verify')
const verified = await parallel(['verifier-a', 'verifier-b'].map(label => () => agent(label, { label })))
if (verified.includes(null)) throw new Error('verifier failed')
return { found, verified }`;
  const route = { provider: 'faux', modelId: 'faux-1', thinkingLevel: 'off' } as const;
  const firstBinding = binding({ resolveProfile: () => route });
  respond(({ prompt }) => {
    if (prompt.startsWith('verifier') || (stage === 1 && prompt === 'finder-b')) {
      throw new Error('premium model budget_exceeded');
    }
    return text(prompt);
  });
  const runs = host();
  const first = await runs.start({ script, cwd }, firstBinding);
  assert.equal((await first.wait()).status, 'failed');
  await first.close();
  stage = 2;
  const second = await runs.resume(first.runId, {}, firstBinding);
  assert.equal((await second.wait()).status, 'failed');
  await second.close();
  // A changed-input attempt must not erase older compatible completed calls.
  const aborted = await runs.resume(first.runId, { args: { unused: true } }, firstBinding);
  await aborted.abort();
  await aborted.wait();
  await aborted.close();
  await runs.closeAll();
  const reopened = host();
  const recoveryBinding = binding({
    resolveProfile(name, pinned) {
      assert.equal(name, 'fast', 'the disabled original profile must not authorize new work');
      const saved = { provider: 'faux', modelId: 'faux-fast', thinkingLevel: 'off' } as const;
      if (pinned) assert.deepEqual(pinned, saved);
      return saved;
    }
  });
  let attempts = 0;
  respond(({ prompt }) => {
    attempts++;
    if (prompt === 'verifier-b') throw new Error('unknown provider failure');
    return text(prompt);
  });
  const fallback = await reopened.resume(first.runId, { resumeProfile: 'fast' }, recoveryBinding);
  assert.equal((await fallback.wait()).status, 'failed');
  await fallback.close();
  assert.equal(attempts, 2, 'only unfinished verifiers execute');
  await reopened.closeAll();
  const finalHost = host();
  const beforeInvalid = prompts.length;
  await assert.rejects(
    finalHost.resume(first.runId, { resumeProfile: 'disabled' }, recoveryBinding)
  );
  assert.equal(prompts.length, beforeInvalid);
  respond(({ prompt }) => text(prompt));
  prompts.length = 0;
  const final = await finalHost.resume(first.runId, {}, recoveryBinding);
  const outcome = await final.wait();
  assert.equal(outcome.status, 'completed');
  if (outcome.status === 'completed' && outcome.usageReceipt)
    await final.acknowledgeUsage(outcome.usageReceipt.id);
  await final.close();
  assert.deepEqual(prompts, ['verifier-b']);
  const stored = await finalHost.resume(
    first.runId,
    {},
    binding({
      resolveProfile: () => {
        throw new Error('all profiles disabled');
      }
    })
  );
  const saved = await stored.wait();
  assert.equal(saved.status, 'completed');
  if (saved.status === 'completed') assert.equal(saved.unreportedUsage.totalTokens, 0);
  await stored.close();
  assert.deepEqual(prompts, ['verifier-b']);
  const report = await finalHost.report(first.runId);
  const latest = report.attempts.at(-1);
  assert.ok(latest);
  const rows = Object.values(latest.agents);
  assert.deepEqual(
    rows.map((row) => [row.label, row.profile, row.model, row.reusedFrom]),
    [
      ['finder-a', 'hard', 'faux/faux-1', 1],
      ['finder-b', 'hard', 'faux/faux-1', 2],
      ['verifier-a', 'fast', 'faux/faux-fast', 4],
      ['verifier-b', 'fast', 'faux/faux-fast', undefined]
    ]
  );
  assert.equal(report.attempts.at(-1)?.script, script);
  assert.deepEqual(report.attempts.at(-1)?.args, { unused: true });
  prompts.length = 0;
  const changed = await finalHost.resume(
    first.runId,
    { script: `${script}\n// deliberate changed input` },
    firstBinding
  );
  const changedOutcome = await changed.wait();
  assert.equal(changedOutcome.status, 'completed');
  await changed.close();
  assert.deepEqual(
    [...prompts].sort(),
    ['verifier-a', 'verifier-b'],
    'ordinary changed-input execution must not adopt recovery-only route aliases'
  );
  const changedAttempt = (await finalHost.report(first.runId)).attempts.at(-1);
  assert.ok(changedAttempt);
  const changedRows = Object.values(changedAttempt.agents);
  assert.ok(changedRows.every((row) => row.model === 'faux/faux-1' && row.profile === 'hard'));
  if (changedOutcome.status === 'completed')
    assert.equal(
      changedOutcome.unreportedUsage.totalTokens,
      changedRows
        .filter((row) => row.reusedFrom === undefined)
        .reduce((total, row) => total + (row.usage?.totalTokens ?? 0), 0),
      'reused work is not billed again'
    );
});

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
  assert.match(system, /coding tools use the directory shown in <cwd>/);

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

const exec = promisify(execFile);
async function initializeGit() {
  await exec('git', ['init', '-q', cwd]);
  await exec('git', ['-C', cwd, 'config', 'user.name', 'Test']);
  await exec('git', ['-C', cwd, 'config', 'user.email', 'test@example.com']);
  await exec('git', ['-C', cwd, 'add', '.']);
  await exec('git', ['-C', cwd, 'commit', '-qm', 'base']);
}

const ISOLATED = `export const meta = { name: 'isolated', description: 'Edit in isolation' }
return await agent('edit', { label: 'editor', isolation: 'worktree' })`;

test('parallel worktrees bind read, write, edit, and bash to separate checkouts and preserve a nested cwd', async () => {
  const subdirectory = join(cwd, 'project');
  await mkdir(subdirectory);
  await writeFile(join(subdirectory, 'notes.txt'), 'base\n');
  await initializeGit();
  await writeFile(join(subdirectory, 'notes.txt'), 'parent changes\n');
  await writeFile(join(subdirectory, 'parent-only.txt'), 'untracked');
  respond(({ prompt, toolResults, system }) => {
    assert.match(system, /editing an isolated Git worktree/);
    const calls = [
      fauxToolCall('read', { path: 'notes.txt' }),
      fauxToolCall('write', { path: 'new.txt', content: prompt }),
      fauxToolCall('edit', { path: 'notes.txt', oldText: 'base', newText: prompt }),
      fauxToolCall('bash', { command: 'pwd; git branch --show-current; test ! -e parent-only.txt' })
    ];
    if (toolResults.length > 0) assert.equal(toolResults[0], 'read:base\n');
    return toolResults.length < calls.length
      ? fauxAssistantMessage([calls[toolResults.length]], { stopReason: 'toolUse' })
      : text(toolResults.at(-1) ?? '');
  });
  const runs = host();
  const handle = await runs.start(
    {
      script: `export const meta = { name: 'parallel-edits', description: 'Edit independently' }
return await parallel(['alpha', 'beta'].map(label => () => agent(label, { label, isolation: 'worktree' })))`,
      cwd: subdirectory
    },
    binding()
  );
  const outcome = await handle.wait();
  await handle.close();
  assert.equal(outcome.status, 'completed');
  const report = await runs.report(handle.runId);
  const rows = Object.values(report.attempts[0].agents).sort((a, b) => a.index - b.index);
  assert.equal(new Set(rows.map((row) => row.worktree?.path)).size, 2);
  assert.equal(new Set(rows.map((row) => row.worktree?.branch)).size, 2);
  for (const row of rows) {
    assert.equal(row.status, 'done', row.error);
    assert.ok(row.worktree);
    assert.equal(row.worktree.cwd, join(row.worktree.path, 'project'));
    assert.equal(await readFile(join(row.worktree.cwd, 'notes.txt'), 'utf8'), `${row.label}\n`);
    assert.equal(await readFile(join(row.worktree.cwd, 'new.txt'), 'utf8'), row.label);
    assert.equal(outcome.status, 'completed');
    if (outcome.status !== 'completed') return;
    const value = (outcome.value as string[])[['alpha', 'beta'].indexOf(row.label)];
    assert.ok(value.includes(row.worktree.cwd));
    assert.ok(value.includes(row.worktree.branch));
  }
  assert.equal(await readFile(join(subdirectory, 'notes.txt'), 'utf8'), 'parent changes\n');
  assert.equal(await readFile(join(subdirectory, 'parent-only.txt'), 'utf8'), 'untracked');
  assert.equal(
    (await exec('git', ['-C', cwd, 'status', '--porcelain'])).stdout.trim(),
    'M project/notes.txt\n?? project/parent-only.txt'
  );
});

test('an interrupted editing agent resumes in its original worktree with its edits intact', async () => {
  await initializeGit();
  let waiting = false;
  let continueAgent = false;
  respond(async ({ toolResults, signal }) => {
    if (!toolResults.length)
      return fauxAssistantMessage(
        [fauxToolCall('write', { path: 'saved.txt', content: 'saved edit' })],
        { stopReason: 'toolUse' }
      );
    waiting = true;
    if (!continueAgent)
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('closing')), { once: true });
      });
    return text('finished');
  });
  const first = host();
  const handle = await first.start({ script: ISOLATED, cwd }, binding());
  await until(() => waiting);
  const before = Object.values((await first.report(handle.runId)).attempts[0].agents)[0];
  assert.ok(before.worktree);
  await handle.close();
  assert.equal((await handle.wait()).status, 'interrupted');
  assert.equal(await readFile(join(before.worktree.cwd, 'saved.txt'), 'utf8'), 'saved edit');
  continueAgent = true;
  const second = host();
  const resumed = await second.resume(handle.runId, {}, binding());
  assert.equal(resumed.mode, 'continued');
  assert.equal((await resumed.wait()).status, 'completed');
  await resumed.close();
  const after = Object.values((await second.report(handle.runId)).attempts[0].agents)[0];
  assert.deepEqual(after.worktree, before.worktree);
  assert.equal(after.conversationId, before.conversationId);
  assert.ok(after.worktree);
  assert.equal(await readFile(join(after.worktree.cwd, 'saved.txt'), 'utf8'), 'saved edit');
  assert.equal(
    (await exec('git', ['-C', cwd, 'worktree', 'list', '--porcelain'])).stdout.match(/^worktree /gm)
      ?.length,
    2
  );
});

test.each(['generation', 'tool'] as const)(
  'resume validates persisted worktrees before any %s can edit the wrong branch',
  async (stage) => {
    await initializeGit();
    let waiting = false;
    let restart = false;
    let restartedRequests = 0;
    let restartedTools = 0;
    const writer = defineExtension({
      name: 'resumable-writer',
      tools: [
        defineTool({
          name: 'resumable_write',
          description: 'Write a note after resumption',
          parameters: Type.Object({}),
          replay: 'safe',
          execute: async (_args, api, context) => {
            if (!restart) {
              waiting = true;
              await new Promise<never>((_resolve, reject) => {
                context.abortSignal?.addEventListener('abort', () => reject(new Error('closing')), {
                  once: true
                });
              });
            }
            restartedTools++;
            return api.executeTool(
              'write',
              { path: 'notes.txt', content: 'resumed edit' },
              context
            );
          }
        })
      ]
    });
    respond(async ({ toolResults, signal }) => {
      if (!restart && stage === 'generation') {
        waiting = true;
        await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('closing')), { once: true });
        });
      }
      if (restart) restartedRequests++;
      return toolResults.length
        ? text('finished')
        : fauxAssistantMessage(
            [
              stage === 'tool'
                ? fauxToolCall('resumable_write', {})
                : fauxToolCall('write', { path: 'notes.txt', content: 'resumed edit' })
            ],
            { stopReason: 'toolUse' }
          );
    });
    const first = host({ extensions: [writer] });
    const handle = await first.start({ script: ISOLATED, cwd }, binding());
    await until(() => waiting);
    const original = Object.values((await first.report(handle.runId)).attempts[0].agents)[0];
    assert.ok(original.worktree);
    await handle.close();
    await exec('git', ['-C', original.worktree.cwd, 'switch', '-qc', 'wrong-branch']);
    restart = true;
    const second = host({ extensions: [writer] });
    let failure: unknown;
    try {
      const resumed = await second.resume(handle.runId, {}, binding());
      await resumed.wait();
      await resumed.close();
    } catch (error) {
      failure = error;
    }
    assert.equal(
      await readFile(join(original.worktree.cwd, 'notes.txt'), 'utf8'),
      'durable notes\n'
    );
    assert.equal(restartedRequests, 0);
    assert.equal(restartedTools, 0);
    assert.match(String(failure), /worktree.*different branch/);
    assert.equal(second.isActive(handle.runId), false);
    assert.equal((await second.report(handle.runId)).status, 'interrupted');

    await exec('git', ['-C', original.worktree.cwd, 'switch', '-q', original.worktree.branch]);
    const resumed = await second.resume(handle.runId, {}, binding());
    assert.equal(resumed.mode, 'continued');
    const outcome = await resumed.wait();
    assert.equal(outcome.status, 'completed');
    await resumed.close();
    assert.equal(await readFile(join(original.worktree.cwd, 'notes.txt'), 'utf8'), 'resumed edit');
    assert.equal(await readFile(join(cwd, 'notes.txt'), 'utf8'), 'durable notes\n');
  }
);

test('an unfinished legacy hint attempt is drained before isolated replacements start', async () => {
  await initializeGit();
  const legacyScript = `export const meta = { name: 'upgrade', description: 'Recover a legacy run' }
const scan = await agent('scan', { label: 'scan' })
return [scan, await agent('edit', { label: 'editor', isolation: 'worktree' })]`;
  let waiting = false;
  let restart = false;
  let restartedScans = 0;
  respond(async ({ prompt, toolResults, signal }) => {
    if (prompt === 'scan') {
      if (restart) restartedScans++;
      return text('scanned');
    }
    if (!restart) {
      waiting = true;
      await new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('closing')), { once: true });
      });
    }
    return toolResults.length
      ? text('finished')
      : fauxAssistantMessage(
          [fauxToolCall('write', { path: 'notes.txt', content: 'isolated edit' })],
          { stopReason: 'toolUse' }
        );
  });
  const runs = host();
  const handle = await runs.start(
    { script: legacyScript.replace(", isolation: 'worktree'", ''), cwd },
    binding()
  );
  await until(() => waiting);
  const attempt = (await runs.report(handle.runId)).attempts[0];
  const editor = Object.values(attempt.agents).find((row) => row.label === 'editor');
  assert.ok(editor?.taskId);
  await handle.close();

  // Store the prompt-only isolation wire shape, including its old call key and shared cwd.
  const legacyKey = `${agentBaseKey('edit', { requestedLabel: 'editor', instructions: 'Requested isolation: worktree' }, binding().route)}.1`;
  const storage = await openNodeSqliteStorage(runDatabasePath(runs.runsRoot, handle.runId));
  try {
    const runTask = await storage.task(handle.attemptId as TaskId, BACKGROUND_CONTEXT);
    const agentTask = await storage.task(editor.taskId as TaskId, BACKGROUND_CONTEXT);
    assert.ok(runTask && agentTask);
    assert.notEqual(runTask.state.status, 'terminal');
    const checkpoint = runTask.state.checkpoint as RunCheckpoint;
    const agents = { ...checkpoint.agents };
    delete agents[editor.key];
    agents[legacyKey] = editor.taskId;
    await storage.commit(
      [
        {
          type: 'task',
          value: {
            ...runTask,
            input: {
              ...(runTask.input as WorkflowRunInput),
              script: legacyScript,
              scriptHash: hashScript(legacyScript)
            },
            state: { status: 'pending', checkpoint: { ...checkpoint, agents } }
          }
        },
        {
          type: 'task',
          value: {
            ...agentTask,
            input: {
              ...(agentTask.input as WorkflowAgentInput),
              key: legacyKey,
              instructions: 'Requested isolation: worktree\n\nTask label: editor'
            }
          }
        }
      ],
      BACKGROUND_CONTEXT
    );
  } finally {
    await storage.close(BACKGROUND_CONTEXT);
  }
  const fixture = await Harness.open(
    await openNodeSqliteStorage(runDatabasePath(runs.runsRoot, handle.runId)),
    { models: binding().models, registry: createRegistry() },
    BACKGROUND_CONTEXT
  );
  try {
    await fixture.commit(async (tx) => {
      const stored = await tx.doc(WorkflowAttemptDoc, String(handle.attemptId), {
        number: 1,
        taskId: handle.attemptId,
        scriptHash: hashScript(legacyScript),
        at: 0
      });
      delete stored.agents[editor.key];
      stored.agents[legacyKey] = { ...editor, key: legacyKey };
      stored.scriptHash = hashScript(legacyScript);
    }, BACKGROUND_CONTEXT);
  } finally {
    await fixture.close(BACKGROUND_CONTEXT);
  }

  restart = true;
  const resumed = await runs.resume(handle.runId, {}, binding());
  const outcome = await resumed.wait();
  await resumed.close();
  assert.equal(await readFile(join(cwd, 'notes.txt'), 'utf8'), 'durable notes\n');
  assert.equal(resumed.mode, 'retried');
  assert.equal(outcome.status, 'completed');
  if (outcome.status === 'completed') assert.deepEqual(outcome.value, ['scanned', 'finished']);
  assert.equal(restartedScans, 0);
  const report = await runs.report(handle.runId);
  assert.equal(report.attempts.length, 2);
  assert.equal(report.attempts[0].status, 'aborted');
  assert.equal(report.attempts[0].agents[legacyKey].status, 'skipped');
  const replacement = Object.values(report.attempts[1].agents).find(
    (row) => row.label === 'editor'
  );
  assert.ok(replacement?.worktree);
  assert.equal(replacement.status, 'done');
  assert.equal(
    await readFile(join(replacement.worktree.cwd, 'notes.txt'), 'utf8'),
    'isolated edit'
  );
});

test.each(['outside Git', 'without a commit', 'untracked subdirectory'])(
  'worktree isolation fails closed %s',
  async (state) => {
    let runCwd = cwd;
    if (state === 'without a commit') await exec('git', ['init', '-q', cwd]);
    if (state === 'untracked subdirectory') {
      await initializeGit();
      runCwd = join(cwd, 'untracked');
      await mkdir(runCwd);
    }
    respond(() => {
      throw new Error('the model must not run without isolation');
    });
    const runs = host();
    const handle = await runs.start({ script: ISOLATED, cwd: runCwd }, binding());
    const outcome = await handle.wait();
    await handle.close();
    assert.equal(outcome.status, 'completed');
    if (outcome.status === 'completed') assert.equal(outcome.value, null);
    assert.deepEqual(prompts, []);
    const row = Object.values((await runs.report(handle.runId)).attempts[0].agents)[0];
    assert.equal(row.status, 'error');
    assert.match(row.error ?? '', /Git worktree isolation failed/);
    assert.equal(row.conversationId, undefined);
  }
);

test('reused editing results retain worktree identity and a fresh execution gets a new checkout', async () => {
  await initializeGit();
  respond(() => text('done'));
  const runs = host();
  const script = ISOLATED.replace('return await', 'const result = await');
  const handle = await runs.start(
    { script: `${script}\nthrow new Error('script bug')`, cwd },
    binding()
  );
  assert.equal((await handle.wait()).status, 'failed');
  await handle.close();
  const original = Object.values((await runs.report(handle.runId)).attempts[0].agents)[0];
  assert.ok(original.worktree);
  await writeFile(join(original.worktree.cwd, 'keep.txt'), 'retained');
  prompts.length = 0;
  const resumed = await runs.resume(
    handle.runId,
    {
      script: `${script}\nreturn [result, await agent('different edit', { label: 'editor', isolation: 'worktree' })]`
    },
    binding()
  );
  assert.equal((await resumed.wait()).status, 'completed');
  await resumed.close();
  const rows = Object.values((await runs.report(handle.runId)).attempts[1].agents).sort(
    (a, b) => a.index - b.index
  );
  assert.deepEqual(rows[0].worktree, original.worktree);
  assert.equal(rows[0].reusedFrom, 1);
  assert.ok(rows[1].worktree);
  assert.notEqual(rows[1].worktree.path, original.worktree.path);
  assert.deepEqual(prompts, ['different edit']);
  assert.equal(await readFile(join(original.worktree.cwd, 'keep.txt'), 'utf8'), 'retained');
});

test('real isolation never reuses a legacy prompt-hint result with otherwise identical inputs', () => {
  const options = { requestedLabel: 'editor', instructions: 'Requested isolation: worktree' };
  assert.notEqual(
    agentBaseKey('edit', options, undefined),
    agentBaseKey('edit', { ...options, isolation: 'worktree' }, undefined)
  );
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

test('a queued steer is visible, can be withdrawn, and then never reaches the agent', async () => {
  const release = gate();
  respond(async ({ toolResults, userMessages }) => {
    if (toolResults.length > 0)
      return text(`finished after ${userMessages.length} user message(s)`);
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
  const seen: Array<{ queued: number; queuedTexts: string[] }> = [];
  const stop = await runs.follow(handle.runId, conversationId, ({ items, queued }) =>
    seen.push({ queued, queuedTexts: items.filter((item) => item.queued).map((i) => i.text) })
  );

  await runs.steer(handle.runId, conversationId, 'Use pnpm');
  await until(() => seen.at(-1)?.queued === 1);
  assert.deepEqual(seen.at(-1)?.queuedTexts, ['Use pnpm']);

  assert.deepEqual(await runs.withdrawSteers(handle.runId, conversationId), ['Use pnpm']);
  await until(() => seen.at(-1)?.queued === 0);
  assert.deepEqual(await runs.withdrawSteers(handle.runId, conversationId), []);

  release.open();
  const outcome = await handle.wait();
  stop();
  assert.equal(outcome.status, 'completed');
  if (outcome.status === 'completed')
    assert.equal(outcome.value, 'finished after 1 user message(s)');
  await handle.close();
});

/** The first request of an agent hangs until it is interrupted; every later one answers. */
function respondHangingFirst() {
  respond(async ({ userMessages, signal }) => {
    if (userMessages.length === 1) {
      await new Promise<never>((_, reject) =>
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      );
    }
    return text(`resumed with: ${userMessages.at(-1)}`);
  });
}

async function startPausable(runs: WorkflowHost, isolation?: 'worktree') {
  respondHangingFirst();
  const handle = await runs.start(
    {
      script: `${AUDIT_HEADER}\nreturn await agent('work', ${JSON.stringify({ label: 'worker', isolation })})`,
      cwd
    },
    binding()
  );
  await until(() => prompts.includes('work'));
  const conversationId = await agentConversation(runs, handle.runId, 'worker');
  const seen: Array<{ texts: string[]; paused: boolean }> = [];
  const stop = await runs.follow(handle.runId, conversationId, ({ items, paused }) =>
    seen.push({ texts: items.map((item) => item.text), paused })
  );
  const state = () => seen.at(-1);
  return { handle, conversationId, stop, state };
}

const settledWithin = async (promise: Promise<unknown>, ms: number) =>
  Promise.race([
    promise.then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), ms))
  ]);

test('a paused agent keeps its call pending and resumes with the message the user sends', async () => {
  const runs = host();
  const { handle, conversationId, stop, state } = await startPausable(runs);

  const result = await runs.pauseAgent(handle.runId, conversationId);
  assert.deepEqual(result, { paused: true, withdrawn: [] });
  await until(() => state()?.paused === true);
  assert.ok(state()?.texts.includes('⏸ paused'));
  const row = (await runs.report(handle.runId)).attempts[0].agents;
  assert.equal(Object.values(row)[0].paused, true);
  assert.equal(
    await settledWithin(handle.wait(), 400),
    false,
    'the run keeps waiting for the agent'
  );

  await runs.resumeAgent(handle.runId, conversationId, '  Do X instead  ');
  const outcome = await handle.wait();
  stop();

  assert.equal(outcome.status, 'completed');
  if (outcome.status === 'completed') assert.equal(outcome.value, 'resumed with: Do X instead');
  await until(() => state()?.paused === false && !!state()?.texts.includes('Do X instead'));
  const texts = state()?.texts ?? [];
  assert.ok(texts.indexOf('⏸ paused') < texts.indexOf('▶ resumed'));
  assert.ok(texts.indexOf('▶ resumed') < texts.indexOf('Do X instead'));
  await assert.rejects(runs.pauseAgent(handle.runId, conversationId), /agent is not running/);
  await handle.close();
});

test('resuming without a message sends a visible "Continue."', async () => {
  const runs = host();
  const { handle, conversationId, stop } = await startPausable(runs);
  await runs.pauseAgent(handle.runId, conversationId);
  await runs.resumeAgent(handle.runId, conversationId);
  const outcome = await handle.wait();
  stop();
  assert.equal(outcome.status, 'completed');
  if (outcome.status === 'completed') assert.equal(outcome.value, 'resumed with: Continue.');
  await handle.close();
});

test('pausing hands back the steers it withdrew, and they never reach the agent', async () => {
  const runs = host();
  const { handle, conversationId, stop } = await startPausable(runs);
  await runs.steer(handle.runId, conversationId, 'queued thought');

  const { withdrawn } = await runs.pauseAgent(handle.runId, conversationId);
  assert.deepEqual(withdrawn, ['queued thought']);
  await runs.resumeAgent(handle.runId, conversationId, 'edited thought');
  const outcome = await handle.wait();
  stop();
  assert.equal(outcome.status, 'completed');
  if (outcome.status === 'completed') assert.equal(outcome.value, 'resumed with: edited thought');
  await handle.close();
});

test('cancelling a paused agent fails its call and the run continues', async () => {
  const runs = host();
  const { handle, conversationId, stop } = await startPausable(runs);
  await runs.pauseAgent(handle.runId, conversationId);

  await runs.cancelAgent(handle.runId, conversationId);
  const outcome = await handle.wait();
  stop();

  assert.equal(outcome.status, 'completed');
  if (outcome.status !== 'completed') return;
  assert.equal(outcome.value, null);
  const worker = outcome.snapshot.agents.find((agent) => agent.label === 'worker');
  assert.equal(worker?.status, 'error');
  assert.match(worker?.error ?? '', /cancelled/);
  await handle.close();
});

test('aborting the run does not wait for a paused agent', async () => {
  const runs = host();
  const { handle, conversationId, stop } = await startPausable(runs);
  await runs.pauseAgent(handle.runId, conversationId);

  await handle.abort();
  const outcome = await handle.wait();
  stop();

  assert.equal(outcome.status, 'aborted');
  assert.equal(outcome.snapshot.agents[0].status, 'skipped');
  await handle.close();
});

test.each([undefined, 'worktree'] as const)(
  'a paused agent keeps its checkout across close and resume (isolation: %s)',
  async (isolation) => {
    if (isolation) await initializeGit();
    const runs = host();
    const { handle, conversationId, stop } = await startPausable(runs, isolation);
    const before = Object.values((await runs.report(handle.runId)).attempts[0].agents)[0];
    if (isolation) assert.ok(before.worktree);
    await runs.pauseAgent(handle.runId, conversationId);
    stop();
    await handle.close();
    prompts = [];

    const continued = await runs.resume(handle.runId, {}, binding());
    assert.equal(continued.mode, 'continued');
    await until(async () => {
      const agents = (await runs.report(handle.runId)).attempts[0].agents;
      return Object.values(agents)[0].paused === true;
    });
    assert.equal(await settledWithin(continued.wait(), 400), false);
    assert.deepEqual(prompts, []);

    await runs.resumeAgent(handle.runId, conversationId, 'carry on');
    const outcome = await continued.wait();
    assert.equal(outcome.status, 'completed');
    if (outcome.status === 'completed') assert.equal(outcome.value, 'resumed with: carry on');
    await continued.close();
    const after = Object.values((await runs.report(handle.runId)).attempts[0].agents)[0];
    assert.deepEqual(after.worktree, before.worktree);
  }
);

test.each(['cancel', 'abort'] as const)(
  'worktrees and uncommitted edits survive explicit %s',
  async (action) => {
    await initializeGit();
    const runs = host();
    const { handle, conversationId, stop } = await startPausable(runs, 'worktree');
    const before = Object.values((await runs.report(handle.runId)).attempts[0].agents)[0];
    assert.ok(before.worktree);
    await writeFile(join(before.worktree.cwd, 'keep.txt'), 'uncommitted edit');
    await runs.pauseAgent(handle.runId, conversationId);
    if (action === 'cancel') await runs.cancelAgent(handle.runId, conversationId);
    else await handle.abort();
    const outcome = await handle.wait();
    assert.equal(outcome.status, action === 'cancel' ? 'completed' : 'aborted');
    stop();
    await handle.close();
    const after = Object.values((await runs.report(handle.runId)).attempts[0].agents)[0];
    assert.deepEqual(after.worktree, before.worktree);
    assert.equal(await readFile(join(before.worktree.cwd, 'keep.txt'), 'utf8'), 'uncommitted edit');
  }
);

test('only a working agent can be paused, and only a paused one resumed', async () => {
  const runs = host();
  const { handle, conversationId, stop } = await startPausable(runs);
  await assert.rejects(runs.resumeAgent(handle.runId, conversationId), /not paused/);
  await runs.pauseAgent(handle.runId, conversationId);
  await assert.rejects(runs.pauseAgent(handle.runId, conversationId), /not working right now/);
  await runs.cancelAgent(handle.runId, conversationId);
  await handle.wait();
  stop();
  await handle.close();
});
