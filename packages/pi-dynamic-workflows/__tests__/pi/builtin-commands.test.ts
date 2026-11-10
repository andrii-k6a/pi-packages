import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import type { JsonValue } from '@earendil-works/chord';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall
} from '@earendil-works/pi-ai';
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionCommandContext,
  ModelRuntime,
  SessionManager,
  SettingsManager
} from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { WorkflowHost } from '../../src/durable/host.js';
import { WorkflowBackgroundRuns } from '../../src/pi/background.js';
import { registerBuiltinWorkflowCommands } from '../../src/pi/builtin-commands.js';
import { createWorkflowTool } from '../../src/pi/workflow-tool.js';
import { MAX_REVIEW_DIFF_CHARS } from '../../src/workflow/builtins/code-review.js';
import type { CodeReviewArgs } from '../../src/workflow/builtins/code-review-input.js';
import { resolveBuiltinWorkflow } from '../../src/workflow/builtins.js';

const exec = promisify(execFile);
const filename = 'review [x];file.ts';
let directory: string;
let cwd: string;
let host: WorkflowHost;
let background: WorkflowBackgroundRuns;
let session: SessionManager;
let ctx: ExtensionCommandContext;
let command: Parameters<ExtensionAPI['registerCommand']>[1];
let pi: Pick<ExtensionAPI, 'registerCommand' | 'appendEntry' | 'sendMessage'>;
let releaseReview: () => void;
let faux: ReturnType<typeof fauxProvider>;
const promptContext = async () => ({ contextFiles: [], skills: '', append: '' });

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'workflow-builtin-command-'));
  cwd = join(directory, 'repo');
  await exec('git', ['init', '-q', cwd]);
  await writeFile(join(cwd, filename), 'const value = 1;\n');
  await writeFile(join(cwd, 'other.ts'), 'const other = 1;\n');
  await exec('git', ['add', '.'], { cwd });
  await exec(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-qm',
      'base'
    ],
    { cwd }
  );
  host = new WorkflowHost({ runsRoot: join(directory, 'runs'), watchIntervalMs: 5 });
  session = SessionManager.create(cwd, join(directory, 'parents'));
  const reviewGate = new Promise<void>((resolve) => {
    releaseReview = resolve;
  });
  faux = fauxProvider({ models: [{ id: 'faux-1' }] });
  faux.setResponses(
    Array.from({ length: 30 }, () => async () => {
      await reviewGate;
      return fauxAssistantMessage(
        [fauxToolCall('structured_output', { candidates: [], limitations: [] })],
        {
          stopReason: 'toolUse'
        }
      );
    })
  );
  const models = createModels();
  models.setProvider(faux.provider);
  ctx = {
    cwd,
    mode: 'tui',
    hasUI: true,
    model: { provider: 'faux', id: 'faux-1' },
    thinkingLevel: 'off',
    scopedModels: [],
    isProjectTrusted: () => false,
    isIdle: () => true,
    sessionManager: session,
    modelRegistry: {
      runtime: models,
      find: (provider: string, id: string) =>
        provider === 'faux' && id === 'faux-1' ? faux.getModel() : undefined,
      getAvailable: () => [faux.getModel()]
    },
    ui: { notify: vi.fn(), setWidget: vi.fn() }
  } as unknown as ExtensionCommandContext;
  pi = {
    registerCommand(name, definition) {
      assert.equal(name, 'code-review');
      command = definition;
    },
    appendEntry: (name, data) => {
      session.appendCustomEntry(name, data);
    },
    sendMessage: (message) => {
      session.appendCustomMessageEntry(
        message.customType,
        message.content,
        message.display,
        message.details
      );
    }
  };
  background = new WorkflowBackgroundRuns(pi, host);
  registerBuiltinWorkflowCommands(pi, { host, backgroundRuns: background, promptContext });
});

afterEach(async () => {
  releaseReview();
  await background.close(ctx);
  await host.closeAll();
  await rm(directory, { recursive: true, force: true });
});

test.each([
  { path: '', priorConversation: false },
  { path: `"${filename}"`, priorConversation: true }
])(
  'command captures tracked changes with $path (prior conversation: $priorConversation) and delivers usage once',
  async ({ path, priorConversation }) => {
    if (priorConversation) {
      session.appendMessage({ role: 'user', content: 'Review my changes', timestamp: 1 });
    }
    await writeFile(join(cwd, filename), 'const value = 2;\n');
    await exec('git', ['add', '--', filename], { cwd });
    await writeFile(join(cwd, 'other.ts'), 'const other = 3;\n');
    await writeFile(join(cwd, 'untracked.ts'), 'const addition = true;\n');
    await command.handler(path, ctx);
    const run = host.list()[0];
    assert.ok(run);
    assert.equal(host.isActive(run.runId), true, 'the command does not wait for completion');
    const requests = session
      .getEntries()
      .flatMap((entry) =>
        entry.type === 'message' && entry.message.role === 'user' ? [entry.message.content] : []
      );
    assert.deepEqual(requests, [priorConversation ? 'Review my changes' : '/code-review']);
    const saved = await host.report(run.runId);
    const args = saved.attempts[0].args as {
      diff: string;
      diffSource: string;
      baseCommit: string;
      goal?: string;
    };
    const base = (await exec('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();
    assert.equal(args.baseCommit, base);
    assert.ok(args.diffSource.startsWith(`git diff ${base}`));
    assert.equal(args.goal, undefined, 'the command does not invent a goal');
    assert.match(args.diff, /const value = 2/);
    assert.equal(args.diff.includes('const other = 3'), path === '');
    assert.equal(args.diff.includes('const addition = true'), path === '');
    assert.equal(saved.attempts[0].script, resolveBuiltinWorkflow('code-review', args));
    assert.ok(
      session
        .getEntries()
        .some((entry) => entry.type === 'custom' && entry.customType === 'workflow-background')
    );
    assert.match(
      vi.mocked(ctx.ui.notify).mock.calls.at(-1)?.[0] ?? '',
      /started in the background/
    );

    releaseReview();
    await vi.waitFor(() => assert.equal(host.isActive(run.runId), false));
    assert.ok(
      session
        .getEntries()
        .some(
          (entry) =>
            entry.type === 'custom_message' && entry.customType === 'workflow-background-ready'
        )
    );
    const tool = createWorkflowTool({ host, backgroundRuns: background, promptContext });
    const result = await tool.execute(
      'collect',
      { result: run.runId },
      undefined,
      undefined,
      ctx as never
    );
    assert.match(JSON.stringify(result.content), /No actionable findings/);
    assert.ok(result.usage?.totalTokens);
    session.appendMessage({
      ...result,
      details: result.details as JsonValue,
      role: 'toolResult',
      toolName: 'workflow',
      toolCallId: 'collect',
      isError: false,
      timestamp: 2
    });
    await host.settleDeliveries(session.getSessionFile());
    const again = await tool.execute(
      'again',
      { result: run.runId },
      undefined,
      undefined,
      ctx as never
    );
    assert.equal(again.usage, undefined, 'command-launched spend is delivered only once');
  }
);

test('a first-command review persists ownership before completion and recovers after restart', async () => {
  const sessionFile = session.getSessionFile() as string;
  assert.equal(existsSync(sessionFile), false);
  await writeFile(join(cwd, filename), 'const value = 2;\n');
  const runtime = await ModelRuntime.create({
    authPath: join(directory, 'auth.json'),
    modelsPath: null,
    modelsStorePath: join(directory, 'models-cache'),
    refreshOnCreate: false
  });
  runtime.registerNativeProvider(faux.provider);
  const settings = SettingsManager.inMemory({ cacheWarming: 'off' });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: directory,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [
      (api) =>
        registerBuiltinWorkflowCommands(api, {
          host,
          backgroundRuns: background,
          promptContext
        })
    ]
  });
  await loader.reload();
  const { session: live } = await createAgentSession({
    cwd,
    agentDir: directory,
    modelRuntime: runtime,
    model: faux.getModel(),
    resourceLoader: loader,
    settingsManager: settings,
    sessionManager: session,
    noTools: 'builtin'
  });
  try {
    await live.bindExtensions({ mode: 'rpc' });
    await live.prompt('/code-review');
    assert.equal(live.isStreaming, false, 'recording initiation must not start a parent turn');
    assert.deepEqual(
      session
        .getEntries()
        .flatMap((entry) => (entry.type === 'message' ? [entry.message.role] : [])),
      ['user']
    );
  } finally {
    live.dispose();
  }
  const run = host.list()[0];
  assert.ok(run);
  assert.equal(host.isActive(run.runId), true);
  assert.equal(run.parentSessionFile, sessionFile);
  assert.equal(
    existsSync(sessionFile),
    true,
    'the first slash command must persist the parent session before detaching'
  );
  const reopened = SessionManager.open(sessionFile);
  assert.equal(reopened.getSessionId(), session.getSessionId());
  assert.ok(
    reopened
      .getEntries()
      .some(
        (entry) =>
          entry.type === 'custom' &&
          entry.customType === 'workflow-background' &&
          (entry.data as { runId?: string }).runId === run.runId
      )
  );

  await background.close(ctx);
  host = new WorkflowHost({ runsRoot: join(directory, 'runs'), watchIntervalMs: 5 });
  session = reopened;
  ctx = { ...ctx, sessionManager: session };
  background = new WorkflowBackgroundRuns(pi, host);
  const callsBeforeRecovery = faux.state.callCount;
  await background.recover(ctx);
  assert.equal(faux.state.callCount, callsBeforeRecovery);
  const ready = reopened
    .getEntries()
    .find(
      (entry) => entry.type === 'custom_message' && entry.customType === 'workflow-background-ready'
    );
  assert.ok(ready?.type === 'custom_message');
  assert.match(String(ready.content), /interrupted/);
  assert.match(String(ready.content), new RegExp(run.runId));
  assert.equal(host.isActive(run.runId), false, 'recovery must not resume agents automatically');
});

test('slash cancellation during prompt discovery prevents admission and background launch', async () => {
  const controller = new AbortController();
  const context = { ...ctx, signal: controller.signal };
  registerBuiltinWorkflowCommands(pi, {
    host,
    backgroundRuns: background,
    promptContext: async () => {
      controller.abort();
      return promptContext();
    }
  });
  await command.handler('--files .', context);
  assert.equal(host.list().length, 0);
  assert.equal(faux.state.callCount, 0);
  assert.match(vi.mocked(ctx.ui.notify).mock.calls.at(-1)?.[0] ?? '', /aborted/i);
  assert.ok(
    !vi
      .mocked(ctx.ui.notify)
      .mock.calls.some(([message]) => message.includes('started in the background'))
  );
});

test('slash cancellation after admission aborts and closes the run instead of detaching it', async () => {
  const controller = new AbortController();
  const start = host.start.bind(host);
  vi.spyOn(host, 'start').mockImplementation(async (...args) => {
    const handle = await start(...args);
    controller.abort();
    return handle;
  });
  await command.handler('--files .', { ...ctx, signal: controller.signal });
  const run = host.list()[0];
  assert.ok(run);
  assert.equal(background.snapshot(run.runId), undefined);
  assert.equal(host.isActive(run.runId), false);
  assert.equal((await host.report(run.runId)).status, 'aborted');
  assert.match(vi.mocked(ctx.ui.notify).mock.calls.at(-1)?.[0] ?? '', /aborted/i);
});

test('a failure to persist command initiation prevents background launch', async () => {
  const parents = join(directory, 'parents');
  await rm(parents, { recursive: true });
  await writeFile(parents, 'not a directory');
  await writeFile(join(cwd, filename), 'const value = 2;\n');

  await command.handler('', ctx);
  assert.equal(host.list().length, 0);
  const [message, tone] = vi.mocked(ctx.ui.notify).mock.calls[0];
  assert.match(message, /ENOTDIR/);
  assert.equal(tone, 'error');
});

test.each([false, true])(
  'diff capture pins resolved commits even if refs move (branch comparison: %s)',
  async (branch) => {
    const base = (await exec('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();
    await writeFile(join(cwd, filename), 'const value = 2;\n');
    await exec('git', ['add', '.'], { cwd });
    await exec(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        '-c',
        'core.hooksPath=/dev/null',
        'commit',
        '-qm',
        'next'
      ],
      { cwd }
    );
    const next = (await exec('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();
    await exec('git', ['reset', '--mixed', base], { cwd });
    if (branch) {
      await exec('git', ['branch', 'review-base', base], { cwd });
      await exec('git', ['update-ref', 'HEAD', next], { cwd });
    }
    const git = (await exec('which', ['git'])).stdout.trim();
    const bin = join(directory, 'bin');
    await mkdir(bin);
    await writeFile(
      join(bin, 'git'),
      `#!${process.execPath}\n` +
        `const { execFileSync } = require('node:child_process');\n` +
        `const args = process.argv.slice(2);\n` +
        `const env = { ...process.env, PATH: ${JSON.stringify(process.env.PATH)} };\n` +
        `if (args.includes(${JSON.stringify(branch ? 'merge-base' : 'diff')})) execFileSync(${JSON.stringify(git)}, ['update-ref', ${JSON.stringify(branch ? 'refs/heads/review-base' : 'HEAD')}, ${JSON.stringify(next)}], { env });\n` +
        `process.stdout.write(execFileSync(${JSON.stringify(git)}, args, { env }));\n`,
      { mode: 0o755 }
    );
    vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH}`);
    try {
      await command.handler(`${branch ? '--base review-base ' : ''}"${filename}"`, ctx);
    } finally {
      vi.unstubAllEnvs();
    }
    const run = host.list()[0];
    assert.ok(run, 'using the moved HEAD would produce an empty diff');
    const saved = await host.report(run.runId);
    const args = saved.attempts[0].args as CodeReviewArgs;
    assert.equal(args.baseCommit, base);
    if (branch) assert.equal(args.capture?.comparison?.baseTipCommit, base);
    assert.match(args.diff ?? '', /-const value = 1;\n\+const value = 2;/);
    assert.equal((await exec('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim(), next);
  }
);

test.each([
  { worktree: false, mode: 'changes' },
  { worktree: true, mode: 'changes' },
  { worktree: false, mode: 'files' }
])(
  'slash/tool preparation agrees from a subdirectory ($mode, worktree: $worktree)',
  async ({ worktree, mode }) => {
    const root = worktree ? join(directory, 'worktree') : cwd;
    if (worktree) await exec('git', ['worktree', 'add', '--detach', root, 'HEAD'], { cwd });
    const subdirectory = join(root, 'source [x];dir');
    await mkdir(subdirectory);
    await writeFile(join(subdirectory, 'new.ts'), 'selected addition\n');
    await writeFile(join(root, 'outside.ts'), 'outside selection\n');
    const goal = 'Review "XYZ"; $(touch nope)\nand failure handling';
    const profiles = [
      {
        name: 'thorough',
        description: 'Deep review',
        model: 'faux-1',
        thinkingLevel: 'off' as const
      }
    ];
    registerBuiltinWorkflowCommands(pi, {
      host,
      backgroundRuns: background,
      promptContext,
      profiles
    });
    const context = { ...ctx, cwd: subdirectory };
    const selector = mode === 'files' ? '--files' : '--base HEAD';
    await command.handler(
      `${selector} --goal ${JSON.stringify(goal)} --profile thorough .`.replace('\\n', '\n'),
      context
    );
    const first = host.list()[0];
    assert.ok(first);
    const args =
      mode === 'files'
        ? { mode: 'files', path: '.', goal, profile: 'thorough' }
        : { base: 'HEAD', path: '.', goal, profile: 'thorough' };
    const result = await createWorkflowTool({
      host,
      backgroundRuns: background,
      promptContext,
      profiles
    }).execute(
      'equivalent',
      { name: 'code-review', args, background: true },
      undefined,
      undefined,
      context as never
    );
    const second = (result.details as { runId: string }).runId;
    const slash = await host.report(first.runId);
    const tool = await host.report(second);
    assert.deepEqual(tool.attempts[0].args, slash.attempts[0].args);
    assert.equal(tool.run.cwd, slash.run.cwd);
    assert.equal(tool.run.cwd, mode === 'files' ? subdirectory : await realpath(root));
    const prepared = tool.attempts[0].args as CodeReviewArgs;
    assert.equal(prepared.goal, goal);
    assert.equal(prepared.profile, 'thorough');
    if (mode === 'changes') {
      assert.match(prepared.diff ?? '', /selected addition/);
      assert.doesNotMatch(prepared.diff ?? '', /outside selection/);
      assert.equal(prepared.capture?.target, 'source [x];dir');
    }
    assert.equal(existsSync(join(subdirectory, 'nope')), false);
  }
);

test.each([undefined, {}, { mode: 'changes' }])(
  'named default requests automatically capture once: %j',
  async (args) => {
    await writeFile(join(cwd, filename), 'const value = 2;\n');
    const tool = createWorkflowTool({ host, backgroundRuns: background, promptContext });
    const request = {
      name: 'code-review',
      ...(args === undefined ? {} : { args }),
      background: true
    };
    assert.deepEqual(tool.prepareArguments?.(request), request);
    assert.equal(host.list().length, 0, 'argument preparation has no execution side effects');
    const result = await tool.execute('default', request, undefined, undefined, ctx as never);
    const saved = await host.report((result.details as { runId: string }).runId);
    assert.match((saved.attempts[0].args as CodeReviewArgs).diff ?? '', /const value = 2/);
  }
);

test.each([undefined, 'HEAD'])(
  'empty slash/tool comparisons start no run (base: %s)',
  async (base) => {
    await command.handler(base ? `--base ${base}` : '', ctx);
    const result = await createWorkflowTool({ host, promptContext }).execute(
      'empty',
      { name: 'code-review', args: base ? { base } : {} },
      undefined,
      undefined,
      ctx as never
    );
    const text = JSON.stringify(result.content);
    assert.match(text, /No review run was started/);
    assert.doesNotMatch(text, /completed|Run id/);
    if (base) assert.match(text, /merge base/);
    assert.equal(host.list().length, 0);
    assert.equal(faux.state.callCount, 0);
    assert.deepEqual(result.details, { noRunStarted: true });
  }
);

test('saved capture and completed results survive file/ref changes; a new start captures newer edits', async () => {
  const context = { ...ctx, sessionManager: SessionManager.inMemory(cwd) };
  await exec('git', ['branch', 'review-base'], { cwd });
  await writeFile(join(cwd, filename), 'const value = 2;\n');
  releaseReview();
  const tool = createWorkflowTool({ host, promptContext });
  const first = await tool.execute(
    'initial',
    { name: 'code-review', args: { base: 'review-base', goal: 'Check the value' } },
    undefined,
    undefined,
    context as never
  );
  const runId = (first.details as { runId: string }).runId;
  const recorded = (await host.report(runId)).attempts[0];
  await exec('git', ['add', '.'], { cwd });
  await exec(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-qm',
      'next'
    ],
    { cwd }
  );
  await exec('git', ['update-ref', 'refs/heads/review-base', 'HEAD'], { cwd });
  await writeFile(join(cwd, filename), 'const value = 3;\n');
  const calls = faux.state.callCount;
  await host.closeAll();
  host = new WorkflowHost({ runsRoot: join(directory, 'runs'), watchIntervalMs: 5 });
  const reopened = createWorkflowTool({ host, promptContext });
  for (const action of [{ resume: runId }, { result: runId }]) {
    const reused = await reopened.execute('reuse', action, undefined, undefined, context as never);
    const text = reused.content[0];
    assert.ok(text?.type === 'text');
    assert.deepEqual(JSON.parse(text.text.split('\n\nResult:\n')[1]), recorded.result);
    assert.equal(faux.state.callCount, calls);
    const saved = (await host.report(runId)).attempts[0];
    assert.deepEqual(saved.args, recorded.args);
    assert.equal(saved.script, recorded.script);
  }
  await assert.rejects(
    reopened.execute(
      'invalid-resume',
      { resume: runId, args: { base: 'review-base' } },
      undefined,
      undefined,
      context as never
    ),
    /prepared inputs/
  );
  const next = await reopened.execute(
    'new',
    { name: 'code-review', args: { base: 'review-base' } },
    undefined,
    undefined,
    context as never
  );
  const latest = (await host.report((next.details as { runId: string }).runId)).attempts[0]
    .args as CodeReviewArgs;
  assert.match(latest.diff ?? '', /-const value = 2;\n\+const value = 3;/);
  assert.notEqual(latest.baseCommit, (recorded.args as CodeReviewArgs).baseCommit);
  assert.equal(faux.state.callCount, calls + 3);
});

test('missing refs, literal option-like refs, unrelated histories, and invalid profiles fail before review', async () => {
  const tree = (await exec('git', ['rev-parse', 'HEAD^{tree}'], { cwd })).stdout.trim();
  const unrelated = (
    await exec(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit-tree',
        tree,
        '-m',
        'unrelated'
      ],
      { cwd }
    )
  ).stdout.trim();
  await exec('git', ['update-ref', 'refs/heads/unrelated', unrelated], { cwd });
  const tool = createWorkflowTool({ host, promptContext });
  for (const base of ['missing;$(touch nope)', '--help', 'unrelated']) {
    await command.handler(`--base ${JSON.stringify(base)}`, ctx);
    await assert.rejects(
      tool.execute(
        'bad-base',
        { name: 'code-review', args: { base } },
        undefined,
        undefined,
        ctx as never
      ),
      /Cannot capture changes.*(?:merge base|HEAD)/i
    );
  }
  await command.handler('--profile missing --base missing', { ...ctx, cwd: directory });
  assert.match(vi.mocked(ctx.ui.notify).mock.calls.at(-1)?.[0] ?? '', /not approved/);
  await assert.rejects(
    tool.execute(
      'profile',
      { name: 'code-review', args: { profile: 'missing', base: 'missing' } },
      undefined,
      undefined,
      { ...ctx, cwd: directory } as never
    ),
    /not approved/
  );
  assert.equal(host.list().length, 0);
  assert.equal(faux.state.callCount, 0);
  assert.equal(existsSync(join(cwd, 'nope')), false);
});

test('ambiguous merge bases fail without selecting an arbitrary ancestor', async () => {
  const initial = (await exec('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();
  const tree = (await exec('git', ['rev-parse', 'HEAD^{tree}'], { cwd })).stdout.trim();
  const commit = async (message: string, ...parents: string[]) =>
    (
      await exec(
        'git',
        [
          '-c',
          'user.name=Test',
          '-c',
          'user.email=test@example.com',
          'commit-tree',
          tree,
          ...parents.flatMap((parent) => ['-p', parent]),
          '-m',
          message
        ],
        { cwd }
      )
    ).stdout.trim();
  const left = await commit('left', initial);
  const right = await commit('right', initial);
  const head = await commit('head merge', left, right);
  const base = await commit('base merge', right, left);
  await exec('git', ['update-ref', 'HEAD', head], { cwd });
  await exec('git', ['update-ref', 'refs/heads/ambiguous', base], { cwd });
  await command.handler('--base ambiguous', ctx);
  assert.match(vi.mocked(ctx.ui.notify).mock.calls[0][0], /no unique usable merge base/i);
  await assert.rejects(
    createWorkflowTool({ host, promptContext }).execute(
      'ambiguous',
      { name: 'code-review', args: { base: 'ambiguous' } },
      undefined,
      undefined,
      ctx as never
    ),
    /no unique usable merge base/i
  );
  assert.equal(host.list().length, 0);
  assert.equal(faux.state.callCount, 0);
});

test('cancellation stops automatic capture before creating a review run', async () => {
  const marker = join(directory, 'capturing');
  const bin = join(directory, 'bin');
  await mkdir(bin);
  await writeFile(
    join(bin, 'git'),
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started');\nsetInterval(() => {}, 1000);\n`,
    { mode: 0o755 }
  );
  const controller = new AbortController();
  vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH}`);
  try {
    const execution = createWorkflowTool({ host, promptContext }).execute(
      'capture',
      { name: 'code-review' },
      controller.signal,
      undefined,
      ctx as never
    );
    await vi.waitFor(() => assert.ok(existsSync(marker)));
    controller.abort();
    await assert.rejects(execution, /aborted/i);
  } finally {
    controller.abort();
    vi.unstubAllEnvs();
  }
  assert.equal(host.list().length, 0);
  assert.equal(faux.state.callCount, 0);
});

test('an empty diff reports no tracked changes without starting agents', async () => {
  await command.handler('', ctx);
  assert.equal(host.list().length, 0);
  assert.match(
    vi.mocked(ctx.ui.notify).mock.calls[0][0],
    /No changes.*eligible untracked additions/
  );
});

test.each([MAX_REVIEW_DIFF_CHARS + 1, MAX_REVIEW_DIFF_CHARS * 4 + 1])(
  'oversized diffs never start a partial review (%i characters)',
  async (size) => {
    await writeFile(join(cwd, filename), 'x'.repeat(size));
    await command.handler('', ctx);
    assert.equal(host.list().length, 0);
    const [message, tone] = vi.mocked(ctx.ui.notify).mock.calls[0];
    assert.match(message, /capture limit|at most 200000/);
    assert.equal(tone, 'error');
  }
);

test('Git capture failures surface without creating a run', async () => {
  await command.handler('', { ...ctx, cwd: directory });
  assert.equal(host.list().length, 0);
  const [message, tone] = vi.mocked(ctx.ui.notify).mock.calls[0];
  assert.match(message, /not a git repository/i);
  assert.doesNotMatch(message, /Diff output format options/);
  assert.equal(tone, 'error');
});

test.each([
  { args: '--files', inRepository: true, gitAvailable: true },
  { args: '--files', inRepository: false, gitAvailable: false },
  { args: '--files "other.ts"', inRepository: true, gitAvailable: true }
])(
  'explicit file command starts in a clean checkout or without Git: $args, $inRepository, $gitAvailable',
  async ({ args, inRepository, gitAvailable }) => {
    const targetCwd = inRepository ? cwd : directory;
    if (!gitAvailable) vi.stubEnv('PATH', '');
    try {
      await command.handler(args, { ...ctx, cwd: targetCwd });
    } finally {
      vi.unstubAllEnvs();
    }
    const run = host.list()[0];
    assert.ok(run);
    const saved = await host.report(run.runId);
    assert.deepEqual(saved.attempts[0].args, {
      mode: 'files',
      path: args.includes('other.ts') ? 'other.ts' : '.'
    });
    assert.equal(saved.run.cwd, targetCwd);
  }
);

test.each([
  '--files missing',
  '--files --tracked-only',
  '--profile missing',
  '--profile',
  '--unknown'
])('invalid commands fail clearly without starting reviewers: %s', async (args) => {
  await command.handler(args, ctx);
  assert.equal(host.list().length, 0);
  assert.equal(faux.state.callCount, 0);
  assert.equal(vi.mocked(ctx.ui.notify).mock.calls[0][1], 'error');
});

test('profile completion offers enabled approved names without selecting a default', async () => {
  registerBuiltinWorkflowCommands(pi, {
    host,
    backgroundRuns: background,
    promptContext,
    profiles: [
      { name: 'thorough', description: 'Deep review', model: 'faux-1', thinkingLevel: 'off' },
      {
        name: 'disabled',
        description: 'Disabled',
        model: 'faux-1',
        thinkingLevel: 'off',
        enabled: false
      }
    ]
  });
  const items = await command.getArgumentCompletions?.('--files --profile ');
  assert.deepEqual(
    items?.map((item) => item.label),
    ['thorough']
  );
  assert.equal(await command.getArgumentCompletions?.('--files'), null);
});

test('non-interactive commands reject with foreground guidance rather than losing a background result', async () => {
  await assert.rejects(
    command.handler('', { ...ctx, mode: 'print', hasUI: false }),
    /requires TUI or RPC.*foreground/
  );
  assert.equal(host.list().length, 0);
});
