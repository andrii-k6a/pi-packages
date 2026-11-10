import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type TranscriptContext
} from '@earendil-works/pi-ai';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { WorkflowHost } from '../../src/durable/host.js';
import {
  createWorkflowRunBinding,
  createWorkflowTool,
  workflowFailureMessage
} from '../../src/pi/workflow-tool.js';
import { resolveBuiltinWorkflow } from '../../src/workflow/builtins.js';
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

test.each([
  [
    'OAuth refresh failed: SSO cookies expired. Run /login faux again.',
    'authentication',
    /Pi \/login before resuming/
  ],
  ['429 {"error":{"type":"budget_exceeded"}}', 'quota', /Wait for quota to reset/],
  ['unexpected provider payload', 'unknown', /cause is not classified/]
] as const)(
  'tool and status expose %s with saved work and route diagnostics',
  async (cause, kind, guidance) => {
    host = new WorkflowHost({
      runsRoot: join(directory, 'runs'),
      watchIntervalMs: 5,
      settings: { retry: { enabled: false } }
    });
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    respond(async (prompt) => {
      if (prompt === 'broken') throw new Error(cause);
      await ready;
      return 'preserved result';
    });
    const tool = createWorkflowTool({
      host,
      promptContext,
      profiles: [
        {
          name: 'hard',
          description: 'Review',
          provider: 'faux',
          model: 'faux-1',
          thinkingLevel: 'off'
        }
      ]
    });
    let observed = false;
    await assert.rejects(
      tool.execute(
        'failure',
        {
          script: `export const meta = { name: 'diagnostic', description: 'Check diagnostics', profile: 'hard' }
phase('Verify')
const results = await parallel(['broken', 'sibling'].map(label => () => agent(label, { label })))
if (results.includes(null)) throw new Error('A verifier failed')
return results`
        },
        undefined,
        (update) => {
          if ((update.details as WorkflowSnapshot).errorCount > 0) {
            observed = true;
            assert.match(update.content[0].type === 'text' ? update.content[0].text : '', guidance);
            release();
          }
        },
        toolContext()
      ),
      (error) => {
        assert.match(String(error), new RegExp(kind));
        assert.match(String(error), /Verify: broken \[profile hard, faux\/faux-1\]/);
        assert.match(String(error), /1 completed reusable agent result/);
        assert.match(String(error), guidance);
        return true;
      }
    );
    assert.equal(observed, true, 'failure becomes visible while the sibling is still running');
    const runId = host.list()[0].runId;
    const status = await tool.execute(
      'status',
      { status: runId },
      undefined,
      undefined,
      toolContext()
    );
    assert.equal(status.content[0].type, 'text');
    assert.match(status.content[0].type === 'text' ? status.content[0].text : '', guidance);
    assert.equal(faux.state.callCount, 2);
  }
);

test.each(['disabled', 'missing', 'unavailable', 'out-of-scope'] as const)(
  'a %s recovery profile launches no new agents',
  async (scenario) => {
    respond(async (prompt) => {
      if (prompt === 'slow scan') throw new Error('quota_exceeded');
      return 'saved';
    });
    const initial = createWorkflowTool({ host, promptContext });
    await assert.rejects(
      initial.execute(
        'start',
        {
          script: SCRIPT.replace(
            'return { a, b }',
            "if (b === null) throw new Error('unfinished'); return { a, b }"
          )
        },
        undefined,
        undefined,
        toolContext()
      ),
      /unfinished/
    );
    const id = host.list()[0].runId;
    const tool = createWorkflowTool({
      host,
      promptContext,
      profiles:
        scenario === 'missing'
          ? []
          : [
              {
                name: 'recovery',
                description: 'Recovery',
                provider: 'faux',
                model: scenario === 'unavailable' ? 'faux-fast' : 'faux-1',
                thinkingLevel: 'off',
                enabled: scenario !== 'disabled'
              }
            ]
    });
    const ctx =
      scenario === 'out-of-scope'
        ? ({
            ...(toolContext() as object),
            scopedModels: [{ model: { provider: 'faux', id: 'another' } }]
          } as never)
        : toolContext();
    const before = faux.state.callCount;
    await assert.rejects(
      tool.execute('recover', { resume: id, resumeProfile: 'recovery' }, undefined, undefined, ctx),
      /Cannot route workflow profile/
    );
    assert.equal(faux.state.callCount, before);
    assert.equal((await host.report(id)).attempts.length, 1);
  }
);

test('resumeProfile arguments are explicit, exclusive recovery requests', () => {
  const tool = createWorkflowTool({ host, promptContext });
  for (const input of [
    { resumeProfile: 'basic' },
    { resume: 'run-1', resumeProfile: ' ' },
    ...['args', 'script', 'name', 'status', 'result', 'cancel'].map((key) => ({
      resume: 'run-1',
      resumeProfile: 'basic',
      [key]: key === 'args' ? {} : 'value'
    }))
  ])
    assert.throws(() => tool.prepareArguments?.(input), /resumeProfile|cannot be combined/);
  assert.deepEqual(
    tool.prepareArguments?.({ resume: 'run-1', resumeProfile: 'basic', background: true }),
    { resume: 'run-1', resumeProfile: 'basic', background: true }
  );
  assert.match(
    tool.promptGuidelines?.join('\n') ?? '',
    /workflow directly.*unavailable inside codemode/s
  );
});

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
  const theme = { fg: (_: string, value: string) => value } as never;
  const collapsed =
    tool
      .renderResult?.(result, { expanded: false, isPartial: false }, theme, {} as never)
      ?.render(120)
      .join('\n') ?? '';
  const expanded =
    tool
      .renderResult?.(result, { expanded: true, isPartial: false }, theme, {} as never)
      ?.render(120)
      .join('\n') ?? '';
  assert.doesNotMatch(collapsed, /done: quick scan/);
  assert.match(collapsed, new RegExp(`/workflows ${runId} --report`));
  assert.match(expanded, /"a": "done: quick scan"/);
  assert.equal(faux.state.callCount, 2);
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

test('workflow tool requires a name, script, or resume run id, and rejects unknown runs', async () => {
  const tool = createWorkflowTool({ host, promptContext });
  assert.throws(() => tool.prepareArguments?.({}), /requires `name`, `script`, or `resume`/);
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

test('named code review persists its resolved script and resumes without repeating completed review work', async () => {
  let finders = 0;
  let verifiers = 0;
  const candidate = {
    file: 'service.ts',
    line: 4,
    summary: 'The error is lost',
    evidence: 'The caller ignores failure',
    priority: 2,
    scenario: 'A failed request reports success',
    alternative: '',
    references: [{ file: 'service.ts', line: 4, observation: 'Failure reports success' }]
  };
  faux.setResponses(
    Array.from({ length: 50 }, () => async (context: TranscriptContext) => {
      const user = context.messages.find((message) => message.role === 'user');
      const prompt = typeof user?.content === 'string' ? user.content : '';
      const verifying = prompt.includes('Evaluate this candidate as a hypothesis');
      if (verifying) {
        verifiers++;
        if (verifiers === 1) {
          return fauxAssistantMessage([], { stopReason: 'error', errorMessage: 'provider down' });
        }
      } else finders++;
      return fauxAssistantMessage(
        [
          fauxToolCall(
            'structured_output',
            verifying
              ? {
                  ...candidate,
                  summary: 'Surface request failures',
                  verdict: 'CONFIRMED',
                  reason: 'The caller loses the error',
                  counterevidence: 'No caller guard handles it',
                  limitations: []
                }
              : { candidates: [candidate], limitations: [] }
          )
        ],
        { stopReason: 'toolUse' }
      );
    })
  );
  const args = { diff: '-old\n+new', diffSource: 'test diff' };
  const tool = createWorkflowTool({ host, promptContext });
  await assert.rejects(
    tool.execute('review-1', { name: 'code-review', args }, undefined, undefined, toolContext()),
    /code review verifier failed/
  );
  const runId = host.list()[0].runId;
  const saved = await host.report(runId);
  assert.equal(saved.attempts[0].script, resolveBuiltinWorkflow('code-review', args));
  assert.deepEqual(saved.attempts[0].args, args);
  assert.equal(finders, 3);
  assert.equal(verifiers, 1);

  await host.closeAll();
  host = new WorkflowHost({ runsRoot: join(directory, 'runs'), watchIntervalMs: 10 });
  const resumed = await createWorkflowTool({ host, promptContext }).execute(
    'review-2',
    { resume: runId },
    undefined,
    undefined,
    toolContext()
  );
  assert.equal(finders, 3);
  assert.equal(verifiers, 2);
  assert.ok(resumed.usage?.totalTokens);
  const text = resumed.content[0];
  assert.ok(text?.type === 'text');
  assert.match(text.text, /3 reused from earlier attempts/);
  assert.match(text.text, /Surface request failures/);
  const expanded =
    tool
      .renderResult?.(resumed, { expanded: true, isPartial: false }, {} as never, {} as never)
      ?.render(120)
      .join('\n') ?? '';
  assert.match(expanded, /# Code review/);
  assert.match(expanded, /Surface request failures/);
  assert.doesNotMatch(expanded, /"report":/);
  assert.equal(verifiers, 2, 'expansion must not regenerate the report');
});

test('named workflow arguments reject ambiguous actions and invalid built-ins before creating a run', async () => {
  const tool = createWorkflowTool({ host, promptContext });
  for (const input of [
    { name: 'code-review', script: SCRIPT },
    { name: 'code-review', resume: 'run-1' },
    { name: 'code-review', status: 'run-1' },
    { name: 'code-review', result: 'run-1' },
    { name: 'code-review', cancel: 'run-1' },
    { name: '' },
    { name: 5 }
  ]) {
    assert.throws(
      () => tool.prepareArguments?.(input),
      /cannot be combined|must be used alone|non-empty built-in/
    );
  }
  assert.deepEqual(tool.prepareArguments?.({ name: ' code-review ', args: { diff: 'x' } }), {
    name: 'code-review',
    args: { diff: 'x' }
  });
  for (const input of [{ name: 'missing' }, { name: 'code-review', args: { diff: ' ' } }]) {
    await assert.rejects(
      tool.execute('bad-review', input, undefined, undefined, toolContext()),
      /Unknown built-in|args.diff/
    );
  }
  assert.equal(host.list().length, 0);
  const name = tool.parameters.properties.name as { description?: string };
  assert.match(
    name.description ?? '',
    /code-review.*behavior, architecture, and maintainability.*args:.*diff: string.*goal.*baseCommit/s
  );
});

test.each(['files', 'supplied'])(
  'goal reaches finders and independent verification without Git (%s)',
  async (mode) => {
    await writeFile(join(cwd, 'service.ts'), 'export const success = () => true;\n');
    await writeFile(join(cwd, 'unrelated.ts'), 'must not be added to supplied patches\n');
    const goal = 'Audit "errors"; $(touch nope)\nwithout inventing requirements';
    const candidate = {
      file: 'service.ts',
      line: 1,
      summary: 'Failures report success',
      evidence: 'The result is always true',
      priority: 2,
      scenario: 'A failed request is reported as successful',
      alternative: '',
      references: [{ file: 'service.ts', line: 1, observation: 'No failure path' }]
    };
    let finders = 0;
    let verifiers = 0;
    faux.setResponses(
      Array.from({ length: 20 }, () => async (context: TranscriptContext) => {
        const user = context.messages.find((message) => message.role === 'user');
        const prompt = typeof user?.content === 'string' ? user.content : '';
        assert.ok(
          prompt.includes(JSON.stringify(goal)),
          'goal must arrive unchanged, not summarized'
        );
        const verifying = prompt.includes('Evaluate this candidate as a hypothesis');
        if (verifying) verifiers++;
        else finders++;
        return fauxAssistantMessage(
          [
            fauxToolCall(
              'structured_output',
              verifying
                ? {
                    ...candidate,
                    verdict: 'CONFIRMED',
                    reason: 'Failure is not propagated',
                    counterevidence: 'No caller guard',
                    limitations: []
                  }
                : { candidates: [candidate], limitations: [] }
            )
          ],
          { stopReason: 'toolUse' }
        );
      })
    );
    const args =
      mode === 'files'
        ? { mode: 'files', path: '.', goal }
        : {
            mode: 'changes',
            diff: '-old\n+new',
            diffSource: 'prepared patch',
            baseCommit: 'HEAD',
            goal
          };
    vi.stubEnv('PATH', '');
    try {
      const result = await createWorkflowTool({ host, promptContext }).execute(
        'goal',
        { name: 'code-review', args },
        undefined,
        undefined,
        toolContext()
      );
      assert.match(JSON.stringify(result.content), /Failures report success/);
      const saved = await host.report((result.details as { runId: string }).runId);
      assert.deepEqual(saved.attempts[0].args, args, 'prepared inputs remain authoritative');
      assert.equal(finders, 3);
      assert.equal(verifiers, 1);
    } finally {
      vi.unstubAllEnvs();
    }
  }
);

test('invalid capture forms fail before Git or model work, including explicit invalid diffs', async () => {
  const tool = createWorkflowTool({ host, promptContext });
  for (const args of [
    { diff: undefined },
    { diff: null },
    { diff: 1 },
    { diff: '' },
    { diff: 'patch', base: 'main' },
    { diff: 'patch', path: 'src' },
    { diff: 'patch', trackedOnly: false },
    { mode: 'files', path: '.', diff: undefined },
    { mode: 'files', path: '.', base: 'main' },
    { mode: 'files', path: '.', trackedOnly: false },
    { mode: 'files' },
    { mode: 'wrong' },
    { base: '' },
    { base: 1 },
    { trackedOnly: 'true' },
    { path: '' },
    { goal: 1 },
    { diffSource: 'prepared' },
    { baseCommit: 'HEAD' },
    { capture: {} }
  ]) {
    await assert.rejects(
      tool.execute('bad', { name: 'code-review', args }, undefined, undefined, toolContext()),
      /Code review/,
      JSON.stringify(args)
    );
  }
  await assert.rejects(
    tool.execute(
      'profile',
      { name: 'code-review', args: { profile: 'missing' } },
      undefined,
      undefined,
      toolContext()
    ),
    /not approved/
  );
  assert.equal(host.list().length, 0);
  assert.equal(faux.state.callCount, 0);
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

test('Pi bindings revalidate a saved profile on its original provider after the session provider changes', () => {
  const context = toolContext() as { model: { provider: string; id: string } };
  const binding = createWorkflowRunBinding(context as never, {
    profiles: [{ name: 'fast', description: 'Fast', model: 'faux-1', thinkingLevel: 'off' }]
  });
  const pinned = binding.resolveProfile('fast');
  context.model = { provider: 'different', id: 'other' };
  assert.deepEqual(binding.resolveProfile('fast', pinned), pinned);
  assert.throws(() => binding.resolveProfile('fast'), /does not expose/);
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
  const snapshot = { name: 'demo', doneCount: 2, agents: [] } as unknown as WorkflowSnapshot;
  assert.match(
    workflowFailureMessage({ status: 'failed', error: 'boom', snapshot }, 'run-1'),
    /failed \(run run-1\)\.\nboom\n2 completed reusable agent result\(s\) saved[\s\S]*cause is not classified[\s\S]*\{ "resume": "run-1" \}[\s\S]*resumeProfile/
  );
  assert.match(
    workflowFailureMessage({ status: 'interrupted', error: 'x', snapshot }, 'run-1'),
    /interrupted \(run run-1\)\. Committed progress is saved\.\nx/
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
  assert.match(guidance, /Use background: true if other work can proceed; else wait for it/);
  assert.match(guidance, /First statement: `export const meta =/);
  assert.match(guidance, /Date\.now\(\).*Math\.random\(\)/);
  assert.ok(
    guidance.includes("await parallel(items.map(item => () => agent('...', { label: '...' })))")
  );
  assert.ok(guidance.includes('await parallel(items.map(item => agent(...)))'));
  assert.match(guidance, /check for nulls/i);
  assert.match(guidance, /plain JSON Schema via opts\.schema/);
  assert.match(guidance, /Subagents cannot start workflows themselves/);
  assert.match(guidance, /Use isolation: "worktree" for independent editing agents/);
  assert.match(guidance, /retains a HEAD checkout without parent edits/);
  assert.match(guidance, /Give self-contained tasks and relative paths/);
  assert.match(guidance, /Ask isolated agents for branch, checkout path, and verification results/);
  assert.match(guidance, /Later agents do not automatically see their edits/);
  assert.match(guidance, /Git errors fail/);
  assert.match(guidance, /Not a sandbox/);
  assert.match(guidance, /Inspect via \/workflows/);
  assert.match(guidance, /Merge\/remove manually/);
  assert.doesNotMatch(guidance, /prompt hint/);
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
