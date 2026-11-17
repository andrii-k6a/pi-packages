import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { JsonObject } from '@earendil-works/pi-ai';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type TranscriptContext
} from '@earendil-works/pi-ai';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { afterEach, beforeEach, expect, test } from 'vitest';
import {
  WorkflowHost,
  type WorkflowHostOptions,
  type WorkflowRunBinding
} from '../../src/durable/host.js';
import type { SdlcResult } from '../../src/durable/sdlc-state.js';
import { SDLC_SCRIPT } from '../../src/workflow/builtins/sdlc.js';
import type { SdlcArgs } from '../../src/workflow/sdlc/contracts.js';

const exec = promisify(execFile);
let directory: string;
let cwd: string;
let hosts: WorkflowHost[];
let faux: ReturnType<typeof fauxProvider>;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pi-sdlc-host-'));
  cwd = join(directory, 'workspace');
  await mkdir(cwd);
  await writeFile(join(cwd, 'api.md'), '# Original API\n');
  faux = fauxProvider({ models: [{ id: 'test' }] });
  hosts = [];
});
afterEach(async () => {
  await Promise.all(hosts.map((host) => host.closeAll()));
  await rm(directory, { recursive: true, force: true });
});
function host(options: WorkflowHostOptions = {}) {
  const result = new WorkflowHost({
    runsRoot: join(directory, 'runs'),
    roles: { agentDir: join(directory, 'user') },
    ...options
  });
  hosts.push(result);
  return result;
}
function binding(): WorkflowRunBinding {
  const models = createModels();
  models.setProvider(faux.provider);
  return {
    models,
    route: { provider: 'faux', modelId: 'test', thinkingLevel: 'off' },
    resolveProfile: () => ({ provider: 'faux', modelId: 'test', thinkingLevel: 'off' }),
    promptContext: async () => ({ contextFiles: [], skills: '', append: '' }),
    projectTrusted: true
  };
}
const args: SdlcArgs = {
  goal: 'Document the API',
  acceptance: [{ id: 'docs', description: 'API is documented', verification: 'inspection' }]
};
const done = {
  summary: 'Documented API',
  artifacts: [{ name: 'note', content: 'Relevant interface decisions', references: ['api.md'] }],
  limitations: []
};
function textOf(content: unknown): string {
  return typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((part) => (part as { text?: string }).text ?? '').join('')
      : '';
}
function request(context: TranscriptContext) {
  const prompt = context.messages
    .filter((message) => message.role === 'user')
    .map((message) => textOf(message.content))
    .join('\n');
  const data = JSON.parse(prompt.split('Task input (data):\n')[1].split('\n\n')[0]);
  const outputDone = context.messages.some(
    (message) =>
      message.role === 'toolResult' &&
      (message as { toolName: string }).toolName === 'structured_output'
  );
  return { prompt, data, outputDone };
}
function output(value: object) {
  return fauxAssistantMessage([fauxToolCall('structured_output', value as JsonObject)], {
    stopReason: 'toolUse'
  });
}
const text = () => fauxAssistantMessage([fauxText('Done')]);
function review(data: ReturnType<typeof request>['data']) {
  return {
    goalRevision: data.brief.goalRevision,
    candidateRevision: data.candidateRevision,
    codeReview: { verdict: 'pass', findings: [], limitations: [] as string[] },
    outcomes: data.brief.acceptance.map((outcome: { id: string }) => ({
      id: outcome.id,
      status: 'met',
      evidenceIds: [],
      observations: [{ file: 'api.md', line: 1, observation: 'The requested API is documented' }],
      reason: 'Original outcome established by inspected source'
    })),
    findingDispositions: [],
    coverageGaps: []
  };
}
function respond(
  responder: (
    context: TranscriptContext,
    signal?: AbortSignal
  ) => ReturnType<typeof text> | Promise<ReturnType<typeof text>>
) {
  faux.setResponses(
    Array.from(
      { length: 100 },
      () => (context: TranscriptContext, options?: { signal?: AbortSignal }) =>
        responder(context, options?.signal)
    )
  );
}
async function until(condition: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for durable progress');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('real host persists accepted product state, artifacts, pinned roles and completed resume semantics', async () => {
  respond((context) => {
    const { data, prompt, outputDone } = request(context);
    if (outputDone) return text();
    return output(prompt.includes('Independently inspect the assembled') ? review(data) : done);
  });
  const h = host();
  const run = await h.start({ script: SDLC_SCRIPT, args, cwd }, binding());
  const outcome = await run.wait();
  expect(outcome.status).toBe('completed');
  if (outcome.status !== 'completed') throw new Error(outcome.error);
  expect((outcome.value as unknown as SdlcResult).outcome, JSON.stringify(outcome.value)).toBe(
    'accepted'
  );
  const state = await h.inspectSdlc(run.runId);
  expect(Object.keys(state.roleSnapshots)).toEqual(['analyst', 'implementer', 'reviewer']);
  expect(state.tasks.map((task) => task.kind)).toEqual(['implementation', 'review']);
  expect(
    (
      await h.sdlcArtifact(
        run.runId,
        state.evidence.find((evidence) => evidence.kind === 'artifact')!.id
      )
    ).result
  ).toMatchObject({ name: 'note', content: 'Relevant interface decisions' });
  const reviewer = state.tasks.find((task) => task.kind === 'review');
  if (!reviewer?.prompt) throw new Error('Expected a persisted reviewer prompt');
  const reviewerInput = JSON.parse(reviewer.prompt.split('Task input (data):\n')[1]);
  const cached = reviewerInput.evidenceManifest.find((item: { path?: string }) => item.path);
  expect(JSON.parse(await readFile(cached.path, 'utf8'))).toMatchObject({
    name: 'note',
    content: 'Relevant interface decisions'
  });
  await writeFile(cached.path, '{"content":"non-authoritative cache edit"}');
  expect((await h.sdlcArtifact(run.runId, cached.id)).result).toMatchObject({
    name: 'note',
    content: 'Relevant interface decisions'
  });
  expect((await h.report(run.runId)).attempts[0].agents).toBeDefined();
  await run.close();
  const count = faux.state.callCount;
  const reopened = await host().resume(run.runId, {}, binding());
  expect(reopened.mode).toBe('completed');
  expect(await reopened.wait()).toMatchObject({ status: 'completed' });
  expect(faux.state.callCount).toBe(count);
  await reopened.close();
});

test('real host questions survive reopening; answers do not schedule; continuation retains identity and cumulative spend', async () => {
  let ask = true;
  respond((context) => {
    const { data, prompt, outputDone } = request(context);
    if (outputDone) return text();
    if (prompt.includes('Independently inspect the assembled')) return output(review(data));
    return output(
      ask
        ? {
            ...done,
            questions: [
              { id: 'naming', text: 'Which names?', choices: ['old', 'new'], affectedTasks: [] }
            ]
          }
        : done
    );
  });
  const h = host();
  const first = await h.start({ script: SDLC_SCRIPT, args, cwd }, binding());
  expect(await first.wait()).toMatchObject({
    status: 'completed',
    value: { outcome: 'needs-input' }
  });
  const oldState = await h.inspectSdlc(first.runId);
  await first.close();
  const secondHost = host();
  const count = faux.state.callCount;
  await secondHost.answerSdlc(
    first.runId,
    { questionId: 'naming', briefRevision: 1, answer: 'new' },
    binding()
  );
  expect(faux.state.callCount).toBe(count);
  await expect(
    secondHost.answerSdlc(
      first.runId,
      { questionId: 'naming', briefRevision: 1, answer: 'old' },
      binding()
    )
  ).rejects.toThrow('already');
  ask = false;
  const continued = await secondHost.continueSdlc(first.runId, {}, binding());
  expect(continued.runId).toBe(first.runId);
  expect(continued.attemptNumber).toBe(2);
  expect(await continued.wait()).toMatchObject({
    status: 'completed',
    value: { outcome: 'accepted' }
  });
  const state = await secondHost.inspectSdlc(first.runId);
  expect(state.brief.clarifications[0].answer).toBe('new');
  expect(state.usage.totalTokens).toBeGreaterThanOrEqual(oldState.usage.totalTokens);
  expect(state.consumed.tasks).toBe(3);
  await continued.close();
});

test('real host keeps a malformed review incomplete and continuation repeats only that review', async () => {
  let malformed = true;
  respond((context) => {
    const { data, prompt, outputDone } = request(context);
    if (outputDone) return text();
    if (!prompt.includes('Independently inspect the assembled')) return output(done);
    return output(malformed ? { ...review(data), candidateRevision: 'older' } : review(data));
  });
  const first = await host().start({ script: SDLC_SCRIPT, args, cwd }, binding());
  expect(await first.wait()).toMatchObject({
    status: 'completed',
    value: { outcome: 'incomplete' }
  });
  await first.close();
  malformed = false;
  const secondHost = host();
  const continued = await secondHost.continueSdlc(first.runId, {}, binding());
  expect(await continued.wait()).toMatchObject({
    status: 'completed',
    value: { outcome: 'accepted' }
  });
  const state = await secondHost.inspectSdlc(first.runId);
  expect(state.tasks.map((task) => `${task.kind}:${task.status}`)).toEqual([
    'implementation:completed',
    'review:invalidated',
    'review:completed'
  ]);
  expect(state.consumed).toMatchObject({ tasks: 3, failedTasks: 1 });
  await continued.close();
});

test.each([false, true])(
  'discovered checks verify string criteria only with an explicit review association (%s)',
  async (associate) => {
    await writeFile(
      join(cwd, 'package.json'),
      JSON.stringify({ scripts: { test: 'node --test --test-reporter=tap behavior.mjs' } })
    );
    await writeFile(
      join(cwd, 'behavior.mjs'),
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('preserves falsy hits', () => assert.equal(0 ?? 1, 0));\n"
    );
    respond((context) => {
      const { data, prompt, outputDone } = request(context);
      if (outputDone) return text();
      if (!prompt.includes('Independently inspect the assembled')) return output(done);
      const result = review(data);
      result.outcomes = result.outcomes.map((outcome: { id: string }) => ({
        ...outcome,
        evidenceIds: data.checks.map((check: { id: string }) => check.id),
        ...(associate && outcome.id !== 'goal' ? { checkIds: ['repository-tests'] } : {})
      }));
      return output(result);
    });
    const h = host();
    const run = await h.start(
      {
        script: SDLC_SCRIPT,
        args: { goal: 'Fix cache misses', acceptance: ['Falsy cache hits are preserved'] },
        cwd
      },
      binding()
    );
    expect(await run.wait()).toMatchObject({
      status: 'completed',
      value: { outcome: associate ? 'accepted' : 'incomplete' }
    });
    const state = await h.inspectSdlc(run.runId);
    expect(state.args.checks).toMatchObject([{ id: 'repository-tests', outcomes: ['goal'] }]);
    expect(state.consumed.tasks).toBe(2);
    expect(state.assessments[0].outcomes[1].status).toBe(associate ? 'met' : 'unverified');
    await run.close();
  }
);

test.each([
  'limitation',
  'candidate',
  'omitted outcome',
  'path',
  'unknown check',
  'qualified finding IDs'
])('reviewer can repair invalid %s within the same conversation', async (field) => {
  let rejected = false;
  respond((context) => {
    const { data, prompt, outputDone } = request(context);
    if (!prompt.includes('Independently inspect the assembled'))
      return outputDone ? text() : output(done);
    const prior = context.messages.filter((message) => message.role === 'toolResult').at(-1);
    rejected ||= prior?.isError === true;
    if (outputDone && !prior?.isError) return text();
    const result = review(data);
    if (!rejected) {
      if (field === 'limitation') result.codeReview.limitations = ['x'.repeat(601)];
      if (field === 'candidate') result.candidateRevision = 'older';
      if (field === 'qualified finding IDs')
        return output({
          ...result,
          codeReview: {
            ...result.codeReview,
            findings: ['F1', `${data.assignment.id}:F1`].map((id) => ({
              id,
              file: 'api.md',
              line: 1,
              summary: 'The API is documented',
              evidence: 'The documentation includes the API',
              priority: 2,
              scenario: 'Readers can find the requested API',
              alternative: '',
              references: [{ file: 'api.md', line: 1, observation: 'API description is present' }],
              verdict: 'REFUTED',
              reason: 'The API is documented',
              counterevidence: '',
              limitations: []
            }))
          }
        });
      if (field === 'omitted outcome') result.outcomes = [];
      if (field === 'path') result.outcomes[0].observations[0].file = '../outside.md';
      if (field === 'unknown check')
        result.outcomes = result.outcomes.map((item: object) => ({
          ...item,
          checkIds: ['not-configured']
        }));
    }
    return output(result);
  });
  const h = host();
  const run = await h.start({ script: SDLC_SCRIPT, args, cwd }, binding());
  expect(await run.wait()).toMatchObject({ status: 'completed', value: { outcome: 'accepted' } });
  expect(rejected).toBe(true);
  const state = await h.inspectSdlc(run.runId);
  expect(state.consumed).toMatchObject({ tasks: 2, failedTasks: 0 });
  expect(state.tasks.filter((task) => task.kind === 'review')).toHaveLength(1);
  await run.close();
});

test.each(['summary', 'reference observation'])(
  'reviewer can repair an overlong %s before structured output commits',
  async (field) => {
    let rejected = false;
    respond((context) => {
      const { data, prompt, outputDone } = request(context);
      if (!prompt.includes('Independently inspect the assembled'))
        return outputDone ? text() : output(done);
      const prior = context.messages.filter((message) => message.role === 'toolResult').at(-1);
      rejected ||= prior?.isError === true;
      if (outputDone && !prior?.isError) return text();
      const result = review(data);
      return output({
        ...result,
        codeReview: {
          ...result.codeReview,
          findings: [
            {
              id: 'F1',
              file: 'api.md',
              line: 1,
              summary: !rejected && field === 'summary' ? 'x'.repeat(300) : 'No missing API',
              evidence: 'The source documents the requested API',
              priority: 2,
              scenario: 'The documented API is available',
              alternative: '',
              references: [
                {
                  file: 'api.md',
                  line: 1,
                  observation:
                    !rejected && field === 'reference observation'
                      ? 'x'.repeat(500)
                      : 'The API is documented'
                }
              ],
              verdict: 'REFUTED',
              reason: 'Current source already covers the API',
              counterevidence: '',
              limitations: []
            }
          ]
        }
      });
    });
    const run = await host().start({ script: SDLC_SCRIPT, args, cwd }, binding());
    expect(await run.wait()).toMatchObject({ status: 'completed', value: { outcome: 'accepted' } });
    expect(rejected).toBe(true);
    await run.close();
  }
);

test('explicit no-work completes without a provider call or a dummy agent', async () => {
  const h = host();
  const run = await h.start(
    {
      script: SDLC_SCRIPT,
      args: { ...args, noWork: { confirmed: true, reason: 'Explicitly empty requested scope' } },
      cwd
    },
    binding()
  );
  expect(await run.wait()).toMatchObject({
    status: 'completed',
    agentCount: 0,
    value: { outcome: 'no-work' }
  });
  expect(faux.state.callCount).toBe(0);
  await run.close();
});

test('nonlocal execution is rejected before workspace effects', async () => {
  const env = new NodeExecutionEnv({ cwd });
  const nonlocal = { ...env, cwd, id: 'remote' } as unknown as NodeExecutionEnv;
  const h = host({ env: () => nonlocal });
  await expect(
    h.start(
      { script: SDLC_SCRIPT, args: { ...args, workspace: { mode: 'isolated' } }, cwd },
      binding()
    )
  ).rejects.toThrow('Nonlocal execution is unsupported');
  expect(h.list()).toEqual([]);
  expect(await readFile(join(cwd, 'api.md'), 'utf8')).toBe('# Original API\n');
});

test('real check runs in selected cwd and observed behavioral evidence permits acceptance', async () => {
  await writeFile(join(cwd, 'tests.js'), "console.log('2 passing');\n");
  respond((context) => {
    const { data, prompt, outputDone } = request(context);
    if (outputDone) return text();
    if (!prompt.includes('Independently inspect the assembled')) return output(done);
    const result = review(data);
    result.outcomes = result.outcomes.map((outcome: object) => ({
      ...outcome,
      evidenceIds: data.checks.map((check: { id: string }) => check.id)
    }));
    return output(result);
  });
  const h = host();
  const run = await h.start(
    {
      script: SDLC_SCRIPT,
      args: {
        goal: 'Preserve behavior',
        checks: [
          { id: 'tests', argv: [process.execPath, 'tests.js'], kind: 'test', outcomes: ['goal'] }
        ]
      },
      cwd
    },
    binding()
  );
  expect(await run.wait()).toMatchObject({ status: 'completed', value: { outcome: 'accepted' } });
  const state = await h.inspectSdlc(run.runId);
  expect(
    state.checks.every(
      (check) =>
        check.result?.cwd === state.workspace.cwd &&
        check.result.testCount === 2 &&
        check.result.status === 'passed'
    )
  ).toBe(true);
  await run.close();
});

test('restored role conversations install actual guarded bundles and retain instructions after role edits', async () => {
  const agents = join(directory, 'user', 'agents');
  await mkdir(agents, { recursive: true });
  const definition = (body: string) =>
    `---\nname: custom\ndescription: Test implementer\ntools: [read]\n---\n${body}\n`;
  await writeFile(join(agents, 'custom.md'), definition('PINNED_INSTRUCTIONS'));
  let entered = false;
  let restoredSystem = '';
  respond(async (context, signal) => {
    const { prompt } = request(context);
    if (prompt.includes('Independently inspect the assembled'))
      return output(review(request(context).data));
    entered = true;
    await new Promise<void>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('interrupted')), { once: true });
    });
    return text();
  });
  const firstHost = host();
  const run = await firstHost.start(
    { script: SDLC_SCRIPT, args: { ...args, policy: { roles: { implementer: 'custom' } } }, cwd },
    binding()
  );
  await until(() => entered);
  const firstIdentity = (await firstHost.inspectSdlc(run.runId)).tasks[0].inputRevision;
  await run.close();
  expect((await run.wait()).status).toBe('interrupted');
  await writeFile(join(agents, 'custom.md'), definition('EDITED_INSTRUCTIONS'));
  respond((context) => {
    const { data, prompt, outputDone } = request(context);
    const system = context.messages
      .filter((message) => message.role === 'system')
      .map((message) => JSON.stringify(message))
      .join('\n');
    if (!prompt.includes('Independently inspect the assembled')) restoredSystem = system;
    return outputDone
      ? text()
      : output(prompt.includes('Independently inspect the assembled') ? review(data) : done);
  });
  const secondHost = host();
  const resumed = await secondHost.resume(run.runId, {}, binding());
  expect(await resumed.wait()).toMatchObject({
    status: 'completed',
    value: { outcome: 'accepted' }
  });
  expect(restoredSystem).toContain('PINNED_INSTRUCTIONS');
  expect(restoredSystem).not.toContain('EDITED_INSTRUCTIONS');
  expect((await secondHost.inspectSdlc(run.runId)).tasks[0].inputRevision).toBe(firstIdentity);
  await resumed.close();
}, 30_000);

test('two real operations cannot mutate the same existing target concurrently and release on interruption', async () => {
  await exec('git', ['init', '-q', cwd]);
  await exec('git', ['-C', cwd, 'add', '.']);
  await exec('git', [
    '-C',
    cwd,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.test',
    'commit',
    '-qm',
    'initial'
  ]);
  let entered = false;
  respond(async (_context, signal) => {
    entered = true;
    await new Promise<void>((_resolve, reject) =>
      signal?.addEventListener('abort', () => reject(new Error('closed')), { once: true })
    );
    return text();
  });
  const firstHost = host();
  const first = await firstHost.start({ script: SDLC_SCRIPT, args, cwd }, binding());
  await until(() => entered);
  const otherHost = host();
  const other = await otherHost.start({ script: SDLC_SCRIPT, args, cwd }, binding());
  expect(await other.wait()).toMatchObject({ status: 'completed', value: { outcome: 'blocked' } });
  await other.close();
  await first.close();
  respond((context) => {
    const { prompt, data, outputDone } = request(context);
    return outputDone
      ? text()
      : output(prompt.includes('Independently inspect the assembled') ? review(data) : done);
  });
  const resumed = await host().resume(first.runId, {}, binding());
  expect(await resumed.wait()).toMatchObject({
    status: 'completed',
    value: { outcome: 'accepted' }
  });
  await resumed.close();
}, 30_000);

test('recovery acquires workspace ownership before restoring a writer', async () => {
  let entered = 0;
  respond(async (_context, signal) => {
    entered++;
    await new Promise<void>((_resolve, reject) =>
      signal?.addEventListener('abort', () => reject(new Error('closed')), { once: true })
    );
    return text();
  });
  const first = await host().start({ script: SDLC_SCRIPT, args, cwd }, binding());
  await until(() => entered === 1);
  await first.close();
  expect((await first.wait()).status).toBe('interrupted');
  const owner = await host().start({ script: SDLC_SCRIPT, args, cwd }, binding());
  await until(() => entered === 2);
  const calls = faux.state.callCount;
  respond((context) => {
    const { data, prompt, outputDone } = request(context);
    if (outputDone) return text();
    if (prompt.includes('Independently inspect the assembled')) return output(review(data));
    const wrote = context.messages.some(
      (message) => message.role === 'toolResult' && message.toolName === 'write'
    );
    return wrote
      ? output(done)
      : fauxAssistantMessage(
          [fauxToolCall('write', { path: 'api.md', content: '# Updated API\n' })],
          { stopReason: 'toolUse' }
        );
  });
  const recovery = host();
  await expect(recovery.resume(first.runId, {}, binding())).rejects.toThrow(
    'owned by another active operation'
  );
  expect(faux.state.callCount).toBe(calls);
  expect(await readFile(join(cwd, 'api.md'), 'utf8')).toBe('# Original API\n');
  await owner.close();
  const resumed = await recovery.resume(first.runId, {}, binding());
  expect(await resumed.wait()).toMatchObject({
    status: 'completed',
    value: { outcome: 'accepted' }
  });
  expect(await readFile(join(cwd, 'api.md'), 'utf8')).toBe('# Updated API\n');
  await resumed.close();
}, 30_000);

test('SDLC respects the recorded host agent cap before admitting its reviewer', async () => {
  let reviewers = 0;
  respond((context) => {
    const { data, prompt, outputDone } = request(context);
    if (outputDone) return text();
    if (prompt.includes('Independently inspect the assembled')) {
      reviewers++;
      return output(review(data));
    }
    return output(done);
  });
  const h = host({ maxAgents: 1 });
  const run = await h.start({ script: SDLC_SCRIPT, args, cwd }, binding());
  expect(await run.wait()).toMatchObject({
    status: 'completed',
    value: { outcome: 'incomplete' }
  });
  expect(reviewers).toBe(0);
  expect((await h.inspectSdlc(run.runId)).result?.unresolvedWork.join(' ')).toMatch(/agent limit/);
  expect(Object.keys((await h.report(run.runId)).attempts[0].agents)).toHaveLength(1);
  await run.close();
});
