import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type JsonObject,
  type TranscriptContext
} from '@earendil-works/pi-ai';
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  SessionManager
} from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { WorkflowHost } from '../../src/durable/host.js';
import { WorkflowBackgroundRuns } from '../../src/pi/background.js';
import { registerSdlcCommand } from '../../src/pi/sdlc-command.js';
import { createWorkflowRunBinding, createWorkflowTool } from '../../src/pi/workflow-tool.js';
import { SDLC_SCRIPT } from '../../src/workflow/builtins/sdlc.js';

const exec = promisify(execFile);
const promptContext = async () => ({ contextFiles: [], skills: '', append: '' });
let directory: string;
let host: WorkflowHost;
let background: WorkflowBackgroundRuns;
let ctx: ExtensionCommandContext;
let command: Parameters<ExtensionAPI['registerCommand']>[1];
let faux: ReturnType<typeof fauxProvider>;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'sdlc-adapters-'));
  await exec('git', ['init', '-q', directory]);
  // Worktree branch creation writes reflogs. Pin identity so Git does not resolve the machine
  // hostname in concurrent writers (which can stall on machines without a global identity).
  await exec('git', ['-C', directory, 'config', 'user.name', 'Test']);
  await exec('git', ['-C', directory, 'config', 'user.email', 'test@example.com']);
  await writeFile(join(directory, 'code.txt'), 'unchanged source\n');
  await exec('git', ['add', '.'], { cwd: directory });
  await exec('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'base'], {
    cwd: directory
  });
  // Keep durable storage outside the observed workspace.
  host = new WorkflowHost({ runsRoot: join(directory, '.git', 'runs'), watchIntervalMs: 5 });
  faux = fauxProvider({ models: [{ id: 'faux-1' }] });
  faux.setResponses(
    Array.from({ length: 20 }, () =>
      fauxAssistantMessage(
        [
          fauxToolCall('structured_output', {
            summary: 'Inspected the authorized goal',
            artifacts: [],
            limitations: []
          })
        ],
        { stopReason: 'toolUse' }
      )
    )
  );
  const models = createModels();
  models.setProvider(faux.provider);
  const session = SessionManager.inMemory(directory);
  ctx = {
    cwd: directory,
    mode: 'rpc',
    hasUI: true,
    model: faux.getModel(),
    thinkingLevel: 'off',
    scopedModels: [],
    isProjectTrusted: () => false,
    isIdle: () => true,
    sessionManager: session,
    modelRegistry: {
      runtime: models,
      find: () => faux.getModel(),
      getAvailable: () => [faux.getModel()]
    },
    ui: { notify: vi.fn(), setWidget: vi.fn(), select: vi.fn() }
  } as unknown as ExtensionCommandContext;
  const pi = {
    registerCommand(_name, definition) {
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
  } satisfies Pick<ExtensionAPI, 'registerCommand' | 'appendEntry' | 'sendMessage'>;
  background = new WorkflowBackgroundRuns(pi, host);
  registerSdlcCommand(pi, { host, backgroundRuns: background, promptContext });
});

afterEach(async () => {
  // Capture this test's resources: a slow close must never delete the next test's directory.
  const owned = { background, ctx, directory };
  try {
    await owned.background.close(owned.ctx);
  } finally {
    await rm(owned.directory, { recursive: true, force: true });
  }
});

test('foreground SDLC command waits, reports the destination, and reuses deferred result delivery without dummy agents', async () => {
  const start = host.start.bind(host);
  const destination = await realpath(directory);
  vi.spyOn(host, 'start').mockImplementation((...args) => {
    assert.ok(
      vi
        .mocked(ctx.ui.notify)
        .mock.calls.some(([text]) => text.includes(`SDLC destination: ${destination}`)),
      'the existing target must be announced before the host opens work'
    );
    return start(...args);
  });
  await command.handler(
    '{"goal":"No requested changes remain","noWork":{"confirmed":true,"reason":"Caller verified empty scope"}}',
    ctx
  );
  const run = host.list()[0];
  assert.ok(run);
  assert.equal(
    host.isActive(run.runId),
    false,
    'foreground command waits until the owned handle closes'
  );
  assert.equal(faux.state.callCount, 0);
  const notices = vi
    .mocked(ctx.ui.notify)
    .mock.calls.map(([text]) => text)
    .join('\n');
  assert.match(notices, /SDLC destination:.*Existing checkout/);
  assert.ok(
    ctx.sessionManager
      .getEntries()
      .some(
        (entry) =>
          entry.type === 'custom_message' && entry.customType === 'workflow-background-ready'
      )
  );
  const result = await createWorkflowTool({ host, promptContext }).execute(
    'collect',
    { result: run.runId },
    undefined,
    undefined,
    ctx as never
  );
  assert.match(JSON.stringify(result.content), /no-work/);
});

const ANNOUNCED_ISOLATION =
  /SDLC destination: (.+?)\. Operation-owned isolated checkout, branch (\S+)\./;

/** Records what was observable at the instant an exact isolated destination was announced. */
function isolatedAnnouncement(text: string) {
  const match = ANNOUNCED_ISOLATION.exec(text);
  if (!match) return undefined;
  const [, path, branch] = match;
  return {
    path,
    branch,
    pathExisted: existsSync(path),
    registered: execFileSync('git', ['-C', directory, 'worktree', 'list', '--porcelain'], {
      encoding: 'utf8'
    }).includes(path),
    modelCalls: faux.state.callCount
  };
}

function assertAnnouncedBeforeEffects(
  announcements: NonNullable<ReturnType<typeof isolatedAnnouncement>>[],
  recorded: { cwd: string; branch?: string; mode: string }
) {
  assert.equal(announcements.length, 1, 'the exact destination is announced exactly once');
  const [announced] = announcements;
  assert.equal(announced.path, recorded.cwd, 'the announced path is the durable destination');
  assert.equal(announced.branch, recorded.branch);
  assert.equal(recorded.mode, 'isolated');
  assert.equal(announced.pathExisted, false, 'announcement precedes checkout creation');
  assert.equal(announced.registered, false, 'announcement precedes Git worktree registration');
  assert.equal(announced.modelCalls, 0, 'announcement precedes any scheduled model work');
  assert.notEqual(announced.path, directory, 'the source checkout is not the destination');
}

test('a tool start announces the exact recorded isolated checkout before setup or scheduling', async () => {
  const announcements: NonNullable<ReturnType<typeof isolatedAnnouncement>>[] = [];
  const notices: string[] = [];
  const result = await createWorkflowTool({ host, promptContext }).execute(
    'isolated-tool',
    {
      name: 'sdlc',
      args: {
        goal: 'Inspect the isolated destination announcement',
        workspace: { mode: 'isolated' },
        checks: [],
        policy: { limits: { maxTasks: 1, correctionRounds: 0 } }
      }
    },
    undefined,
    (update) => {
      const text = update.content.map((part) => ('text' in part ? part.text : '')).join('');
      notices.push(text);
      const announced = isolatedAnnouncement(text);
      if (announced) announcements.push(announced);
    },
    ctx as never
  );
  const state = await host.inspectSdlc((result.details as { runId: string }).runId);
  assertAnnouncedBeforeEffects(announcements, state.workspace);
  assert.match(notices[0], /SDLC isolation:.*announce its exact destination before setup/);
  assert.ok(existsSync(state.workspace.cwd), 'the announced checkout is created later');
  assert.equal(faux.state.callCount, 1);
  assert.equal(await readFile(join(directory, 'code.txt'), 'utf8'), 'unchanged source\n');
});

test('the command announces the exact recorded isolated checkout before setup or scheduling', async () => {
  const announcements: NonNullable<ReturnType<typeof isolatedAnnouncement>>[] = [];
  vi.mocked(ctx.ui.notify).mockImplementation((text: string) => {
    const announced = isolatedAnnouncement(text);
    if (announced) announcements.push(announced);
  });
  await command.handler(
    '{"goal":"Inspect the isolated destination announcement","workspace":{"mode":"isolated"},"checks":[],"policy":{"limits":{"maxTasks":1,"correctionRounds":0}}}',
    ctx
  );
  const run = host.list()[0];
  assert.ok(run);
  const state = await host.inspectSdlc(run.runId);
  assertAnnouncedBeforeEffects(announcements, state.workspace);
  assert.match(
    vi
      .mocked(ctx.ui.notify)
      .mock.calls.map(([text]) => text)
      .join('\n'),
    /SDLC isolation:.*announce its exact destination before setup/
  );
  assert.ok(existsSync(state.workspace.cwd));
});

test.each(['tool', 'command'] as const)(
  '%s continuation announces the retained isolated destination once before more generation',
  async (adapter) => {
    const tool = createWorkflowTool({ host, promptContext });
    const initial = await tool.execute(
      'waiting',
      {
        name: 'sdlc',
        args: {
          goal: 'Implement the selected ordering',
          workspace: { mode: 'isolated' },
          checks: [],
          questions: [{ id: 'direction', text: 'Ascending or descending?', affectedTasks: [] }],
          policy: { limits: { maxTasks: 1 } }
        }
      },
      undefined,
      undefined,
      ctx as never
    );
    const runId = (initial.details as { runId: string }).runId;
    const before = await host.inspectSdlc(runId);
    assert.equal(before.outcome, 'needs-input');
    assert.equal(faux.state.callCount, 0);
    await host.answerSdlc(runId, {
      questionId: 'direction',
      briefRevision: before.questions[0].briefRevision,
      answer: 'ascending'
    });
    const announcements: NonNullable<ReturnType<typeof isolatedAnnouncement>>[] = [];
    const observe = (text: string) => {
      const announced = isolatedAnnouncement(text);
      if (announced) announcements.push(announced);
    };
    if (adapter === 'tool') {
      await tool.execute(
        'continue',
        { continue: runId },
        undefined,
        (update) =>
          observe(update.content.map((part) => ('text' in part ? part.text : '')).join('')),
        ctx as never
      );
    } else {
      vi.mocked(ctx.ui.notify).mockImplementation(observe);
      await command.handler(`continue ${runId}`, ctx);
    }
    const after = await host.inspectSdlc(runId);
    assert.equal(announcements.length, 1, 'only the host callback announces the destination');
    assert.equal(announcements[0].path, before.workspace.cwd);
    assert.equal(announcements[0].branch, before.workspace.branch);
    assert.equal(announcements[0].pathExisted, true, 'continuation retains its owned checkout');
    assert.equal(announcements[0].modelCalls, 0, 'announcement precedes resumed generation');
    assert.deepEqual(after.workspace, before.workspace);
    assert.equal(faux.state.callCount, 1);
    assert.equal(after.outcome, 'incomplete', 'a completed worker is not acceptance');
  }
);

test('noninteractive questions remain pending, explicit answers persist without generation, and continuation is not resume', async () => {
  const tool = createWorkflowTool({ host, promptContext });
  const initial = await tool.execute(
    'start',
    {
      name: 'sdlc',
      args: {
        goal: 'Implement the selected ordering',
        questions: [
          { id: 'direction', text: 'Ascending or descending?', affectedTasks: ['implement'] }
        ],
        policy: { limits: { maxTasks: 1 } }
      }
    },
    undefined,
    undefined,
    ctx as never
  );
  const runId = (initial.details as { runId: string }).runId;
  assert.match(JSON.stringify(initial.content), /needs-input/);
  assert.equal(faux.state.callCount, 0);
  const binding = createWorkflowRunBinding(ctx, { promptContext });
  const pending = await host.inspectSdlc(runId, binding);
  assert.equal(pending.questions[0].answer, undefined);
  const status = await tool.execute('status', { status: runId }, undefined, undefined, {
    ...ctx,
    model: undefined
  } as never);
  assert.match(JSON.stringify(status.content), /direction.*brief revision 1/);
  await tool.execute(
    'answer',
    { answer: { runId, questionId: 'direction', briefRevision: 1, answer: 'ascending' } },
    undefined,
    undefined,
    { ...ctx, model: undefined } as never
  );
  assert.equal(faux.state.callCount, 0, 'answering must not generate or continue work');
  assert.equal((await host.inspectSdlc(runId, binding)).questions[0].answer, 'ascending');
  await assert.rejects(
    tool.execute(
      'duplicate',
      { answer: { runId, questionId: 'direction', briefRevision: 1, answer: 'descending' } },
      undefined,
      undefined,
      ctx as never
    ),
    /already has an answer|Stale/
  );
  const stored = await tool.execute(
    'resume',
    { resume: runId },
    undefined,
    undefined,
    ctx as never
  );
  assert.match(JSON.stringify(stored.content), /stored result/);
  assert.equal(faux.state.callCount, 0);
  const continued = await tool.execute(
    'continue',
    { continue: runId },
    undefined,
    undefined,
    ctx as never
  );
  assert.equal((continued.details as { runId: string }).runId, runId);
  assert.equal(faux.state.callCount, 1);
  assert.ok(continued.usage?.totalTokens, 'new work retains its native usage');
  assert.match(JSON.stringify(continued.content), /incomplete/);
  assert.equal((await host.inspectSdlc(runId, binding)).consumed.tasks, 1);
});

test('a plain ambiguous goal can produce a durable implementer question without an analyst or mutation', async () => {
  const structured = (value: Parameters<typeof fauxToolCall>[1]) =>
    fauxAssistantMessage([fauxToolCall('structured_output', value)], { stopReason: 'toolUse' });
  faux.setResponses([
    structured({
      summary: 'Direction is material',
      artifacts: [],
      limitations: [],
      questions: [
        {
          id: 'direction',
          text: 'Ascending or descending?',
          choices: ['ascending', 'descending'],
          affectedTasks: []
        }
      ]
    }),
    structured({ summary: 'Used the recorded direction', artifacts: [], limitations: [] })
  ]);
  const tool = createWorkflowTool({ host, promptContext });
  const initial = await tool.execute(
    'ambiguous',
    {
      name: 'sdlc',
      args: {
        goal: 'Implement the intended ordering',
        policy: { limits: { maxTasks: 2 } }
      }
    },
    undefined,
    undefined,
    ctx as never
  );
  const runId = (initial.details as { runId: string }).runId;
  assert.match(JSON.stringify(initial.content), /needs-input/);
  const state = await host.inspectSdlc(runId);
  assert.equal(state.questions[0].id, 'direction');
  assert.equal(state.questions[0].answer, undefined);
  assert.equal(
    state.tasks.some((task) => task.kind === 'analysis'),
    false
  );
  assert.equal(faux.state.callCount, 1);
  assert.equal(await readFile(join(directory, 'code.txt'), 'utf8'), 'unchanged source\n');
  await tool.execute(
    'answer',
    {
      answer: {
        runId,
        questionId: 'direction',
        briefRevision: state.questions[0].briefRevision,
        answer: 'ascending'
      }
    },
    undefined,
    undefined,
    ctx as never
  );
  await tool.execute('continue', { continue: runId }, undefined, undefined, ctx as never);
  const continued = await host.inspectSdlc(runId);
  assert.equal(continued.brief.clarifications[0].answer, 'ascending');
  assert.equal(continued.consumed.tasks, 2);
  assert.equal(
    faux.state.callCount,
    2,
    'only the clarified worker runs within the retained allowance'
  );
});

test('an implementer can decompose a plain goal into isolated parallel writers that integrate into the selected target', async () => {
  const respond = (context: TranscriptContext) => {
    const message = context.messages.find((message) => message.role === 'user');
    const content = message?.content;
    const prompt =
      typeof content === 'string'
        ? content
        : (content ?? []).map((part) => ('text' in part ? part.text : '')).join('\n');
    const data = JSON.parse(prompt.split('Task input (data):\n')[1]);
    const id: string = data.assignment.id;
    if (id.endsWith('-implement')) {
      const tasks = ['left', 'right'].map((name) => ({
        id: name,
        title: `Write ${name}`,
        outcome: `Create ${name}.txt`,
        dependsOn: [],
        writes: [`${name}.txt`],
        inputs: [],
        checks: [],
        questionIds: []
      }));
      return fauxAssistantMessage(
        [
          fauxToolCall('structured_output', {
            summary: 'Independent interfaces permit parallel writers',
            artifacts: [],
            limitations: [],
            plan: { reason: 'Two independent files with disjoint ownership', tasks }
          })
        ],
        { stopReason: 'toolUse' }
      );
    }
    const name = id.endsWith('-left') ? 'left' : 'right';
    if (
      !context.messages.some(
        (message) => message.role === 'toolResult' && message.toolName === 'write'
      )
    ) {
      return fauxAssistantMessage(
        [fauxToolCall('write', { path: `${name}.txt`, content: `${name} output\n` })],
        { stopReason: 'toolUse' }
      );
    }
    return fauxAssistantMessage(
      [
        fauxToolCall('structured_output', {
          summary: `Created ${name}`,
          artifacts: [],
          limitations: []
        })
      ],
      { stopReason: 'toolUse' }
    );
  };
  faux.setResponses(Array.from({ length: 12 }, () => respond));
  const tool = createWorkflowTool({ host, promptContext });
  const result = await tool.execute(
    'parallel',
    {
      name: 'sdlc',
      args: {
        goal: 'Create independent left and right outputs and integrate both',
        checks: [],
        policy: { limits: { maxTasks: 3, concurrency: 2 } }
      }
    },
    undefined,
    undefined,
    ctx as never
  );
  const state = await host.inspectSdlc((result.details as { runId: string }).runId);
  assert.equal(state.plans.at(-1)?.shape, 'parallel');
  assert.equal(
    state.tasks.some((task) => task.kind === 'analysis'),
    false
  );
  assert.equal(await readFile(join(directory, 'left.txt'), 'utf8'), 'left output\n');
  assert.equal(await readFile(join(directory, 'right.txt'), 'utf8'), 'right output\n');
  const children = state.tasks.filter(
    (task) => task.id.endsWith('-left') || task.id.endsWith('-right')
  );
  assert.equal(children.length, 2);
  assert.notEqual(children[0].workspace?.cwd, children[1].workspace?.cwd);
  assert.ok(children.every((task) => task.integration?.status === 'completed'));
  assert.equal(
    state.outcome,
    'incomplete',
    'integrated tasks alone do not imply independent acceptance'
  );
});

test('named SDLC imports a real structured review attempt as historical evidence with separate spend', async () => {
  const candidate = {
    file: 'code.txt',
    line: 1,
    summary: 'Required warning marker is absent',
    evidence: 'The file contains only the unchanged source line',
    priority: 2,
    scenario: 'A reader cannot see the required warning marker',
    alternative: '',
    references: [{ file: 'code.txt', line: 1, observation: 'No warning marker exists' }]
  };
  const structured = (value: Parameters<typeof fauxToolCall>[1]) =>
    fauxAssistantMessage([fauxToolCall('structured_output', value)], { stopReason: 'toolUse' });
  faux.setResponses([
    ...Array.from({ length: 3 }, () => structured({ candidates: [candidate], limitations: [] })),
    structured({
      ...candidate,
      verdict: 'CONFIRMED',
      reason: 'The required marker is absent',
      counterevidence: '',
      limitations: []
    }),
    structured({ summary: 'Historical claim inspected', artifacts: [], limitations: [] })
  ]);
  const tool = createWorkflowTool({ host, promptContext });
  const source = await tool.execute(
    'source-review',
    {
      name: 'code-review',
      args: {
        mode: 'files',
        path: 'code.txt',
        goal: 'Find whether the required warning marker is missing'
      }
    },
    undefined,
    undefined,
    ctx as never
  );
  const sourceId = (source.details as { runId: string }).runId;
  await writeFile(join(directory, 'code.txt'), 'source changed since review\n');
  const result = await tool.execute(
    'import',
    {
      name: 'sdlc',
      args: {
        goal: 'Add the required warning marker after verifying the imported claim against current source',
        evidence: [{ kind: 'code-review', runId: sourceId, attempt: 1 }],
        policy: { limits: { maxTasks: 1 } }
      }
    },
    undefined,
    undefined,
    ctx as never
  );
  const state = await host.inspectSdlc((result.details as { runId: string }).runId);
  assert.equal(state.importedFindings.length, 1);
  assert.ok(state.importedFindings[0].id.startsWith(`${sourceId}:a1:`));
  assert.ok(state.importedUsage.totalTokens > 0);
  assert.ok(state.usage.totalTokens > 0);
  assert.equal(
    state.outcome,
    'incomplete',
    'a historical verdict cannot establish candidate acceptance'
  );
  assert.match(
    state.evidence.find((item) => item.kind === 'import')?.limitations.join(' ') ?? '',
    /Historical.*not fresh/
  );
});

test('tool continuation adds real observable evidence without revising or weakening the goal', async () => {
  const respond = (context: TranscriptContext) => {
    const message = context.messages.find((message) => message.role === 'user');
    const content = message?.content;
    const prompt =
      typeof content === 'string'
        ? content
        : (content ?? []).map((part) => ('text' in part ? part.text : '')).join('\n');
    const data = JSON.parse(prompt.split('Task input (data):\n')[1]);
    const integrated = (data.checks ?? []).filter(
      (item: { id: string; result: { status: string } }) =>
        item.id.startsWith('integration:') && item.result.status === 'passed'
    );
    const output: Parameters<typeof fauxToolCall>[1] = prompt.startsWith('Independently inspect')
      ? {
          goalRevision: data.brief.goalRevision,
          candidateRevision: data.candidateRevision,
          codeReview: { verdict: 'pass', findings: [], limitations: [] },
          outcomes: data.brief.acceptance.map((requirement: { id: string }) => ({
            id: requirement.id,
            status: integrated.length ? 'met' : 'unverified',
            evidenceIds: integrated.map((item: { id: string }) => item.id),
            observations: [],
            reason: integrated.length
              ? 'The authorized command observed source contents'
              : 'Observable verification is missing'
          })),
          findingDispositions: [],
          coverageGaps: []
        }
      : { summary: 'Source is unchanged', artifacts: [], limitations: [] };
    return fauxAssistantMessage([fauxToolCall('structured_output', output)], {
      stopReason: 'toolUse'
    });
  };
  faux.setResponses(Array.from({ length: 10 }, () => respond));
  const tool = createWorkflowTool({ host, promptContext });
  const initial = await tool.execute(
    'initial',
    {
      name: 'sdlc',
      args: {
        goal: 'Verify that code.txt contains the unchanged source line',
        checks: [],
        policy: { limits: { correctionRounds: 0 } }
      }
    },
    undefined,
    undefined,
    ctx as never
  );
  const runId = (initial.details as { runId: string }).runId;
  assert.match(JSON.stringify(initial.content), /incomplete/);
  const before = await host.inspectSdlc(runId);
  const check = {
    id: 'source-observation',
    kind: 'check' as const,
    outcomes: ['goal'],
    argv: [
      process.execPath,
      '-e',
      "require('node:assert/strict').equal(require('node:fs').readFileSync('code.txt','utf8'),'unchanged source\\n')"
    ]
  };
  const result = await tool.execute(
    'evidence',
    { continue: runId, continueOptions: { checks: [check] } },
    undefined,
    undefined,
    ctx as never
  );
  assert.match(JSON.stringify(result.content), /accepted/);
  const after = await host.inspectSdlc(runId);
  assert.deepEqual(after.brief, before.brief);
  assert.equal(after.operationId, before.operationId);
  assert.equal(
    after.tasks.filter((task) => task.kind === 'implementation').length,
    1,
    'verification does not create a dummy implementation task'
  );
  assert.ok(
    after.checks.some((item) => item.phase === 'integration' && item.result?.status === 'passed')
  );
  await assert.rejects(
    tool.execute(
      'weaken',
      {
        continue: runId,
        continueOptions: {
          checks: [{ ...check, argv: [process.execPath, '-e', 'process.exit(0)'] }]
        }
      },
      undefined,
      undefined,
      ctx as never
    ),
    /cannot replace or weaken/
  );
});

test('configured tool concurrency is a start default, not an SDLC resume update', async () => {
  const tool = createWorkflowTool({ host, concurrency: 2, promptContext });
  await tool.execute(
    'start-empty',
    {
      name: 'sdlc',
      args: {
        goal: 'Already complete',
        noWork: { confirmed: true, reason: 'Caller verified empty scope' }
      }
    },
    undefined,
    undefined,
    ctx as never
  );
  const runId = host.list()[0].runId;
  const before = await host.inspectSdlc(runId);
  const result = await tool.execute(
    'resume-empty',
    { resume: runId },
    undefined,
    undefined,
    ctx as never
  );
  assert.match(JSON.stringify(result.content), /no-work/);
  assert.equal((await host.inspectSdlc(runId)).limits.concurrency, before.limits.concurrency);
  assert.equal(faux.state.callCount, 0);
});

test('tool recovery preserves recorded SDLC concurrency after an interrupted provider request', async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  faux.setResponses([
    async (_context, options) => {
      entered();
      await new Promise<void>((_resolve, reject) =>
        options?.signal?.addEventListener('abort', () => reject(new Error('interrupted request')), {
          once: true
        })
      );
      return fauxAssistantMessage([{ type: 'text', text: 'Stopped' }]);
    }
  ]);
  const first = await host.start(
    {
      script: SDLC_SCRIPT,
      args: {
        goal: 'Document the source',
        acceptance: [{ description: 'Source is documented', verification: 'inspection' }],
        policy: { limits: { concurrency: 1 } }
      },
      cwd: directory
    },
    createWorkflowRunBinding(ctx, { promptContext })
  );
  await started;
  await first.close();
  faux.setResponses(
    Array.from({ length: 20 }, () => (context: TranscriptContext) => {
      if (context.messages.some((message) => message.role === 'toolResult'))
        return fauxAssistantMessage([{ type: 'text', text: 'Done' }]);
      const prompt = context.messages
        .filter((message) => message.role === 'user')
        .map((message) =>
          typeof message.content === 'string'
            ? message.content
            : message.content.map((part) => ('text' in part ? part.text : '')).join('')
        )
        .join('\n');
      const data = JSON.parse(prompt.split('Task input (data):\n')[1]);
      const result: JsonObject = prompt.includes('Independently inspect the assembled')
        ? {
            goalRevision: data.brief.goalRevision,
            candidateRevision: data.candidateRevision,
            codeReview: { verdict: 'pass', findings: [], limitations: [] },
            outcomes: data.brief.acceptance.map((item: { id: string }) => ({
              id: item.id,
              status: 'met',
              evidenceIds: [],
              observations: [
                { file: 'code.txt', line: 1, observation: 'The documented source is present' }
              ],
              reason: 'Inspected the source'
            })),
            findingDispositions: [],
            coverageGaps: []
          }
        : { summary: 'Documented source', artifacts: [], limitations: [] };
      return fauxAssistantMessage([fauxToolCall('structured_output', result)], {
        stopReason: 'toolUse'
      });
    })
  );
  const result = await createWorkflowTool({ host, concurrency: 2, promptContext }).execute(
    'recover',
    { resume: first.runId },
    undefined,
    undefined,
    ctx as never
  );
  assert.match(JSON.stringify(result.content), /accepted/);
  assert.equal((await host.inspectSdlc(first.runId)).limits.concurrency, 1);
});
