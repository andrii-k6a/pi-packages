import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  type TranscriptContext
} from '@earendil-works/pi-ai';
import { afterEach, beforeEach, test } from 'vitest';
import { WorkflowHost } from '../../src/durable/host.js';
import {
  createWorkflowRunBinding,
  createWorkflowTool,
  workflowFailureMessage
} from '../../src/pi/workflow-tool.js';
import type { WorkflowSnapshot } from '../../src/workflow/snapshot.js';

let directory: string;
let cwd: string;
let host: WorkflowHost;
let faux: ReturnType<typeof fauxProvider>;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pi-workflow-tool-'));
  cwd = join(directory, 'workspace');
  await mkdir(cwd);
  host = new WorkflowHost({ runsRoot: join(directory, 'runs'), watchIntervalMs: 10 });
  faux = fauxProvider({ models: [{ id: 'faux-1' }] });
});

afterEach(async () => {
  await host.closeAll();
  await rm(directory, { recursive: true, force: true });
});

function toolContext() {
  const models = createModels();
  models.setProvider(faux.provider);
  return {
    cwd,
    model: { provider: 'faux', id: 'faux-1' },
    thinkingLevel: 'off',
    scopedModels: [],
    isProjectTrusted: () => false,
    sessionManager: { getSessionFile: () => join(directory, 'parent.jsonl') },
    modelRegistry: {
      runtime: models,
      find: (provider: string, id: string) =>
        provider === 'faux' ? { provider, id, reasoning: false } : undefined,
      getAvailable: () => [{ provider: 'faux', id: 'faux-1', reasoning: false }]
    }
  } as never;
}

function respond(handler: (prompt: string, signal?: AbortSignal) => Promise<string>) {
  faux.setResponses(
    Array.from(
      { length: 100 },
      () => async (context: TranscriptContext, options?: { signal?: AbortSignal }) => {
        const user = context.messages.find((message) => message.role === 'user');
        const prompt = typeof user?.content === 'string' ? user.content : '';
        return fauxAssistantMessage([fauxText(await handler(prompt, options?.signal))]);
      }
    )
  );
}

const promptContext = async () => ({ contextFiles: [], skills: '', append: '' });

const SCRIPT = `export const meta = { name: 'tool_demo', description: 'Tool demo' }
phase('Scan')
const a = await agent('quick scan', { label: 'quick' })
const b = await agent('slow scan', { label: 'slow' })
return { a, b }`;

test('workflow tool runs a durable workflow, streams progress, and reports its run id and spend', async () => {
  respond(async (prompt) => `done: ${prompt}`);
  const tool = createWorkflowTool({ host, promptContext });
  const updates: WorkflowSnapshot[] = [];
  const result = await tool.execute(
    'call-1',
    { script: SCRIPT },
    undefined,
    (update) => updates.push(update.details as WorkflowSnapshot),
    toolContext()
  );

  const text = result.content[0];
  assert.equal(text?.type, 'text');
  const runId = (result.details as WorkflowSnapshot).runId as string;
  assert.match(runId, /^\d{8}-\d{6}-tool_demo-[0-9a-f]{4}$/);
  assert.ok(text?.type === 'text' && text.text.includes(`Run id: ${runId}.`));
  assert.ok(text?.type === 'text' && text.text.includes('"a": "done: quick scan"'));
  assert.ok((result as { usage?: { totalTokens: number } }).usage?.totalTokens);
  assert.ok(updates.length > 0);
  assert.equal(updates.at(-1)?.name, 'tool_demo');
  assert.equal(host.list()[0].parentSessionFile, join(directory, 'parent.jsonl'));
});

test('Esc aborts subagents, the error names the run, and resume finishes without repeating work', async () => {
  const seen: string[] = [];
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  respond(async (prompt, signal) => {
    seen.push(prompt);
    if (prompt === 'slow scan') {
      await new Promise<void>((resolve, reject) => {
        released.then(resolve);
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }
    return `done: ${prompt}`;
  });
  const tool = createWorkflowTool({ host, promptContext });
  const controller = new AbortController();
  const execution = tool.execute(
    'call-1',
    { script: SCRIPT },
    controller.signal,
    undefined,
    toolContext()
  );
  while (!seen.includes('slow scan')) await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  const error = await execution.then(
    () => undefined,
    (reason: Error) => reason
  );
  assert.ok(error);
  const runId = /run (\S+)\)/.exec(error.message)?.[1] as string;
  assert.match(error.message, /was aborted/);
  assert.ok(error.message.includes(`{ "resume": "${runId}" }`));

  release();
  seen.length = 0;
  const resumed = await tool.execute(
    'call-2',
    { resume: runId },
    undefined,
    undefined,
    toolContext()
  );
  const text = resumed.content[0];
  assert.ok(text?.type === 'text' && text.text.includes('(1 reused from earlier attempts)'));
  assert.deepEqual(seen, ['slow scan']);
});

test('workflow tool requires a script or a resume run id, and rejects unknown runs', async () => {
  const tool = createWorkflowTool({ host, promptContext });
  assert.throws(() => tool.prepareArguments?.({}), /requires `script`, or `resume`/);
  await assert.rejects(
    tool.execute('call-1', { resume: '../escape' }, undefined, undefined, toolContext()),
    /invalid workflow run id/
  );
  await assert.rejects(
    tool.execute(
      'call-1',
      { resume: '20260101-000000-missing-0000' },
      undefined,
      undefined,
      toolContext()
    ),
    /unknown workflow run/
  );
});

test('createWorkflowRunBinding forwards the parent model runtime, route, and profiles', () => {
  const ctx = toolContext() as { modelRegistry: { runtime: unknown } };
  const binding = createWorkflowRunBinding(ctx as never, {
    profiles: [
      { name: 'fast', description: 'Fast', provider: 'faux', model: 'faux-1', thinkingLevel: 'off' }
    ]
  });

  assert.equal(binding.models, ctx.modelRegistry.runtime);
  assert.deepEqual(binding.route, { provider: 'faux', modelId: 'faux-1', thinkingLevel: 'off' });
  assert.deepEqual(binding.resolveProfile('fast'), {
    provider: 'faux',
    modelId: 'faux-1',
    thinkingLevel: 'off'
  });
  assert.throws(() => binding.resolveProfile('slow'), /not approved/);
  assert.equal(binding.parentSessionFile, join(directory, 'parent.jsonl'));
});

test('project trust is scoped to the canonical calling directory, including prompt discovery', async () => {
  const ctx = toolContext() as { isProjectTrusted: () => boolean };
  ctx.isProjectTrusted = () => true;
  const binding = createWorkflowRunBinding(ctx as never);
  assert.equal(typeof binding.projectTrusted, 'function');
  if (typeof binding.projectTrusted !== 'function') return;
  assert.equal(binding.projectTrusted(cwd), true);
  assert.equal(binding.projectTrusted(directory), false);
  assert.equal(binding.projectTrusted(join(directory, 'missing')), false);
  const alias = join(directory, 'workspace-alias');
  await symlink(cwd, alias, 'junction');
  assert.equal(binding.projectTrusted(alias), true);
  ctx.isProjectTrusted = () => false;
  assert.equal(binding.projectTrusted(cwd), false);
});

test('createWorkflowRunBinding fails clearly when Pi runtime is unavailable', () => {
  assert.throws(
    () =>
      createWorkflowRunBinding({
        modelRegistry: {},
        model: undefined,
        thinkingLevel: undefined,
        scopedModels: [],
        cwd
      } as never),
    /workflow requires Pi ModelRuntime/
  );
});

test('failure messages tell the model how to resume', () => {
  const snapshot = { name: 'demo', doneCount: 2 } as WorkflowSnapshot;
  assert.match(
    workflowFailureMessage({ status: 'failed', error: 'boom', snapshot }, 'run-1'),
    /failed: boom \(run run-1\)\. 2 completed agent result\(s\) are saved.*\{ "resume": "run-1" \}.*fixed "script"/
  );
  assert.match(
    workflowFailureMessage({ status: 'interrupted', error: 'x', snapshot }, 'run-1'),
    /interrupted \(run run-1\): x\. Committed progress is saved/
  );
});

test('createWorkflowTool describes phases as optional and dynamic', () => {
  const tool = createWorkflowTool();

  assert.match(
    tool.promptSnippet ?? '',
    /export const meta = \{ name: 'short_snake_case', description:/
  );
  assert.doesNotMatch(tool.promptSnippet ?? '', /phases: \[/);
  assert.ok(
    tool.promptGuidelines?.some((line) => line.includes('meta.phases is optional metadata'))
  );
  assert.ok(
    tool.promptGuidelines?.some((line) =>
      line.includes('Phase names may be conditional or built in a loop')
    )
  );
});

test('createWorkflowTool keeps essential guidance while avoiding repeated schema instructions', () => {
  const tool = createWorkflowTool();
  const guidance = tool.promptGuidelines?.join('\n') ?? '';

  assert.ok(guidance.length <= 2000);
  const scriptDescription = tool.parameters.properties.script as { description?: string };
  assert.ok((scriptDescription.description ?? '').length < 200);
  assert.ok(scriptDescription.description?.includes("meta = { name: '...', description: '...' }"));
  assert.match(guidance, /only when the user explicitly asks/);
  assert.match(guidance, /First statement: `export const meta =/);
  assert.match(guidance, /Date\.now\(\).*Math\.random\(\)/);
  assert.ok(
    guidance.includes("await parallel(items.map(item => () => agent('...', { label: '...' })))")
  );
  assert.ok(guidance.includes('await parallel(items.map(item => agent(...)))'));
  assert.match(guidance, /check for nulls/i);
  assert.match(guidance, /plain JSON Schema via opts\.schema/);
  assert.match(guidance, /Subagents cannot start workflows themselves/);
});

test('createWorkflowTool is model-only so codemode scripts cannot call it', () => {
  assert.equal(createWorkflowTool().exposure, 'model-only');
});

test('createWorkflowTool omits profile guidance when no profiles are configured', () => {
  const guidance = createWorkflowTool().promptGuidelines?.join('\n') ?? '';

  assert.doesNotMatch(guidance, /Available profiles:/);
  assert.doesNotMatch(guidance, /Profile precedence/);
});

test('createWorkflowTool exposes profile names and descriptions without routing internals', () => {
  const tool = createWorkflowTool({
    profiles: [
      {
        name: 'fast',
        description: 'Quick repository triage',
        provider: 'SENTINEL_PROVIDER',
        model: 'SENTINEL_RAW_MODEL',
        thinkingLevel: 'xhigh'
      },
      {
        name: 'thorough',
        description: 'Careful architecture review',
        provider: 'SECOND_SENTINEL_PROVIDER',
        model: 'SECOND_SENTINEL_RAW_MODEL',
        thinkingLevel: 'high'
      }
    ]
  });
  const guidance = tool.promptGuidelines?.at(-1) ?? '';

  assert.match(guidance, /^- "fast" — Quick repository triage$/m);
  assert.match(guidance, /^- "thorough" — Careful architecture review$/m);
  assert.match(guidance, /profile order has no meaning/);
  assert.match(
    guidance,
    /profile: "<profile-name>".*phase\("Review", \{ profile: "<profile-name>" \}\).*agent\("\.\.\.", \{ profile: "<profile-name>" \}\)/s
  );
  assert.match(guidance, /agent > phase > workflow > active session/);
  assert.match(guidance, /`phase\("Next phase"\)` without `profile` resets routing/);
  assert.match(guidance, /`meta\.phases` is documentation only/);
  assert.doesNotMatch(guidance, /SENTINEL_PROVIDER|SENTINEL_RAW_MODEL|xhigh|high/);
});

const BUDGET_SCRIPT = `export const meta = { name: 'budget_demo', description: 'Budget demo' }
const a = await agent('x'.repeat(1500), { label: 'long' })
return { total: budget.total, remaining: budget.remaining(), a: a.length }`;

test('tool parameters are typed objects, so no backend sees a typeless JSON Schema', () => {
  const tool = createWorkflowTool();
  const properties = tool.parameters.properties as unknown as Record<
    string,
    Record<string, unknown>
  >;

  for (const [name, schema] of Object.entries(properties)) {
    assert.ok(schema.type, `${name} declares a type`);
  }
  assert.equal(properties.args.type, 'object');
  assert.equal(properties.args.additionalProperties, true);
  assert.equal(properties.tokenBudget.type, 'integer');
  assert.equal(properties.tokenBudget.minimum, 1);
});

test('prepareArguments rejects non-object args and an unusable tokenBudget', () => {
  const tool = createWorkflowTool();
  const prepare = (value: unknown) => tool.prepareArguments?.(value);

  assert.deepEqual(prepare({ script: 'x', args: { a: 1 }, tokenBudget: 5 }), {
    script: 'x',
    args: { a: 1 },
    tokenBudget: 5
  });
  assert.throws(() => prepare({ script: 'x', args: [1, 2] }), /`args` to be a JSON object/);
  assert.throws(() => prepare({ script: 'x', args: 'text' }), /`args` to be a JSON object/);
  assert.throws(() => prepare({ script: 'x', args: null }), /`args` to be a JSON object/);
  for (const bad of [0, -1, 1.5, '10', Number.NaN]) {
    assert.throws(
      () => prepare({ script: 'x', tokenBudget: bad }),
      /`tokenBudget` to be a positive integer/,
      String(bad)
    );
  }
});

test('tokenBudget reaches the script, and the result details stay compact', async () => {
  respond(async (prompt) => `answer to ${prompt.length} chars`);
  const tool = createWorkflowTool({ host, promptContext });
  const updates: WorkflowSnapshot[] = [];
  const result = await tool.execute(
    'call-budget',
    { script: BUDGET_SCRIPT, tokenBudget: 777_000 },
    undefined,
    (update) => updates.push(update.details as WorkflowSnapshot),
    toolContext()
  );

  const text = result.content[0];
  assert.ok(text?.type === 'text');
  const value = JSON.parse(
    text.text.slice(text.text.indexOf('Result:\n') + 'Result:\n'.length)
  ) as {
    total: number;
    remaining: number;
  };
  assert.equal(value.total, 777_000);
  assert.ok(value.remaining > 0 && value.remaining < 777_000, 'the finished agent counted');

  // The text carries the result; the persisted details do not repeat it or the full prompts.
  const details = result.details as WorkflowSnapshot;
  assert.equal(details.result, undefined);
  assert.equal(details.agents.length, 1);
  assert.ok(details.agents[0].prompt.length <= 200);
  assert.ok(details.agents[0].prompt.endsWith('…'));
  for (const update of updates) {
    assert.equal(update.result, undefined);
    for (const agent of update.agents) assert.ok(agent.prompt.length <= 200);
  }
});

test('a failure while acknowledging usage in an in-memory session keeps the finished result', async () => {
  respond(async (prompt) => `done: ${prompt}`);
  host.acknowledgeUsage = async () => {
    throw new Error('storage hiccup');
  };
  const tool = createWorkflowTool({ host, promptContext });
  const context = toolContext() as unknown as {
    sessionManager: { getSessionFile: () => string | undefined };
  };
  context.sessionManager = { getSessionFile: () => undefined };

  const result = await tool.execute(
    'call-mem',
    { script: SCRIPT },
    undefined,
    undefined,
    context as never
  );
  const text = result.content[0];
  assert.ok(text?.type === 'text' && text.text.includes('"a": "done: quick scan"'));
  assert.equal(host.isActive((result.details as WorkflowSnapshot).runId as string), false);
});
