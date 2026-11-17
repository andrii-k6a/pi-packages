import { expect, test } from 'vitest';
import { createWorkflowRoleServices } from '../../src/durable/roles.js';
import {
  applySdlcAnswers,
  applySdlcContinuation,
  initialSdlcState,
  runSdlcController,
  type SdlcControllerServices,
  sdlcIdentity
} from '../../src/durable/sdlc.js';
import { observedTestCount } from '../../src/durable/sdlc-checks.js';
import type { SdlcCheckResult, SdlcState } from '../../src/durable/sdlc-state.js';
import type { SdlcWorkspace } from '../../src/durable/sdlc-workspace.js';
import { emptyUsage } from '../../src/shared/usage.js';
import type { WorkflowAgentRunOptions } from '../../src/workflow/contracts.js';
import type { SdlcArgs, SdlcReview } from '../../src/workflow/sdlc/contracts.js';
import { ownsPath, validatePlan, validateSdlcArgs } from '../../src/workflow/sdlc/validation.js';

const implementation = { summary: 'Implemented assigned behavior', artifacts: [], limitations: [] };
const inspection: SdlcArgs = {
  goal: 'Document the supported API',
  acceptance: [{ description: 'API documentation matches source', verification: 'inspection' }]
};
const behavioral: SdlcArgs = {
  goal: 'Preserve falsy hits',
  checks: [{ id: 'tests', argv: ['node', 'tests.js'], kind: 'test', outcomes: ['goal'] }]
};
function contract(
  id: string,
  writes = ['*'],
  dependsOn: string[] = [],
  questionIds: string[] = []
) {
  return {
    id,
    title: id,
    outcome: `Deliver ${id}`,
    writes,
    dependsOn,
    questionIds,
    checks: [],
    inputs: []
  };
}
function input(prompt: string) {
  return JSON.parse(prompt.split('Task input (data):\n')[1]);
}
function assignmentEvidence(data: ReturnType<typeof input>): string {
  const records = data.relevantEvidence.filter((item: { id: string }) =>
    data.assignment.inputs.includes(item.id)
  );
  expect(records.length, 'the assignment must reference its correction evidence').toBeGreaterThan(
    0
  );
  return JSON.stringify(records);
}
function review(
  data: ReturnType<typeof input>,
  status: 'met' | 'not-met' | 'unverified' = 'met'
): SdlcReview {
  return {
    goalRevision: data.brief.goalRevision,
    candidateRevision: data.candidateRevision,
    codeReview: { verdict: 'pass', findings: [], limitations: [] },
    outcomes: data.brief.acceptance.map((requirement: { id: string; verification: string }) => ({
      id: requirement.id,
      status,
      evidenceIds:
        requirement.verification === 'behavioral'
          ? data.checks
              .filter((check: { result: SdlcCheckResult }) => check.result.status === 'passed')
              .map((check: { id: string }) => check.id)
          : [],
      observations: [
        { file: 'api.ts', line: 1, observation: 'Inspected the complete requested behavior' }
      ],
      reason:
        status === 'met'
          ? 'Behavior and original goal are supported'
          : 'Required outcome still needs work'
    })),
    findingDispositions: [],
    coverageGaps: []
  };
}
function fixture(args: SdlcArgs = inspection) {
  const files = new Map<string, Record<string, string>>([['/workspace', { 'api.ts': 'initial' }]]);
  let state: SdlcState;
  const events: string[] = [];
  const calls: Array<{ prompt: string; options: WorkflowAgentRunOptions }> = [];
  const revision = (cwd: string) => sdlcIdentity(files.get(cwd));
  const workspace: SdlcWorkspace = {
    operationId: 'test',
    owner: 'test',
    mode: 'existing',
    cwd: '/workspace',
    sourceCwd: '/workspace',
    storageDir: '/storage',
    sourceRevision: revision('/workspace')
  };
  state = initialSdlcState('test', args, workspace);
  const abort = new AbortController();
  let responder = async (prompt: string, options: WorkflowAgentRunOptions): Promise<unknown> =>
    options.phase === 'reviewer' ? review(input(prompt)) : implementation;
  const services: SdlcControllerServices = {
    state,
    save: async (next) => {
      state = structuredClone(next);
    },
    agent: {
      run: async (prompt, options) => {
        calls.push({ prompt, options });
        events.push(`agent:${options.label}`);
        return responder(prompt, options);
      }
    },
    resolveRole: createWorkflowRoleServices({
      projectRoot: '/workspace',
      agentDir: '/nonexistent-pi-sdlc-tests',
      extensions: () => []
    }).resolve,
    usage: async () => ({ ...emptyUsage(), totalTokens: calls.length * 100 }),
    now: () => 1234,
    signal: abort.signal,
    phase: () => {},
    acquire: () => {
      events.push('lease');
      return () => {
        events.push('release');
      };
    },
    ensure: async () => {
      events.push('ensure');
    },
    inspect: async (workspace) => ({
      revision: revision(workspace.cwd),
      changedFiles: Object.keys(files.get(workspace.cwd)!)
    }),
    observe: async (workspace) => ({ ...files.get(workspace.cwd)! }),
    fork: async (workspace, id) => {
      const cwd = `/fork/${id}`;
      files.set(cwd, { ...files.get(workspace.cwd)! });
      events.push(`fork:${id}`);
      return { ...workspace, owner: id, cwd, sourceRevision: revision(cwd) };
    },
    integrate: async (target, child) => {
      events.push(`integrate:${child.owner}`);
      Object.assign(files.get(target.cwd)!, files.get(child.cwd));
      return { revision: revision(target.cwd), changedFiles: Object.keys(files.get(target.cwd)!) };
    },
    check: async (id, workspace, evidenceId, candidateRevision) => {
      events.push(`check:${evidenceId}`);
      return {
        id: evidenceId,
        command: state.args.checks!.find((check) => check.id === id)!,
        cwd: workspace.cwd,
        environment: 'injected',
        candidateRevision,
        startedAt: 1,
        endedAt: 2,
        status: 'passed',
        testCount: 2,
        exitCode: 0,
        output: '2 passing',
        truncated: false
      };
    }
  };
  return {
    get state() {
      return state;
    },
    calls,
    events,
    services,
    abort,
    respond(next: typeof responder) {
      responder = next;
    },
    mutate(cwd: string, path = 'api.ts', value = `changed-${calls.length}`) {
      files.get(cwd)![path] = value;
    },
    async run() {
      services.state = state;
      return runSdlcController(services);
    }
  };
}

test('clear goal uses one implementer and one independent reviewer, with pinned roles and no analyst', async () => {
  const f = fixture();
  f.respond(async (prompt, options) => {
    if (options.phase === 'reviewer') return review(input(prompt));
    expect(f.state.tasks.find((task) => task.id === options.label)?.inputRevision).toBe(
      options.inputRevision
    );
    f.mutate(options.cwd!);
    return implementation;
  });
  expect((await f.run()).outcome).toBe('accepted');
  expect(f.calls.map((call) => call.options.phase)).toEqual(['implementer', 'reviewer']);
  expect(f.calls[1].options.toolset).toBe('review');
  expect(f.calls[0].options.resolvedRole?.definition.id).toBe('implementer');
  expect(f.events[0]).toBe('lease');
  expect(f.events.at(-1)).toBe('release');
});

test.each(['requirement-check', 'default-question-plan', 'artifact'] as const)(
  'invalid analyst %s is failed before completion and recoverable',
  async (invalid) => {
    const f = fixture({ ...inspection, planning: 'investigate' });
    let broken = true;
    f.respond(async (prompt, options) => {
      if (options.phase === 'reviewer') return review(input(prompt));
      if (options.phase === 'implementer') return implementation;
      return {
        reason: 'Investigated the named uncertainty',
        assumptions: [],
        requirements:
          broken && invalid === 'requirement-check'
            ? [
                {
                  description: 'Must be observed',
                  verification: 'behavioral',
                  checkIds: ['missing']
                }
              ]
            : [],
        questions:
          broken && invalid === 'default-question-plan'
            ? [{ id: 'q', text: 'Which scope?', affectedTasks: ['missing-task'] }]
            : [],
        tasks: broken && invalid === 'default-question-plan' ? [] : [contract('implement')],
        artifacts:
          broken && invalid === 'artifact'
            ? [{ name: 'Evidence', content: ' ', references: [] }]
            : []
      };
    });
    expect((await f.run()).outcome).toBe('incomplete');
    expect(f.state.tasks[0].status).toBe('failed');
    expect(f.state.brief.acceptance).toHaveLength(2);
    expect(f.state.questions).toHaveLength(0);
    broken = false;
    applySdlcContinuation(f.state, {}, 1);
    expect((await f.run()).outcome).toBe('accepted');
  }
);

test('ordinary ambiguous goal can hand off durable questions without a mandatory analyst', async () => {
  const f = fixture({ ...inspection, goal: 'Make API names consistent' });
  f.respond(async () => ({
    ...implementation,
    questions: [{ id: 'naming', text: 'Use camelCase or snake_case?', affectedTasks: [] }]
  }));
  const result = await f.run();
  expect(result.outcome).toBe('needs-input');
  expect(result.pendingQuestions[0]).toMatchObject({ id: 'naming', briefRevision: 1 });
  expect(f.calls).toHaveLength(1);
  expect(f.state.decisions.some((decision) => decision.kind === 'handoff-applied')).toBe(true);
  const spent = f.state.consumed.tasks;
  applySdlcAnswers(f.state, [{ questionId: 'naming', briefRevision: 1, answer: 'camelCase' }], 100);
  expect(f.state.consumed.tasks).toBe(spent);
  applySdlcContinuation(f.state, {}, 101);
  f.respond(async (prompt, options) => {
    if (options.phase === 'reviewer') return review(input(prompt));
    expect(input(prompt).brief.clarifications[0].answer).toBe('camelCase');
    f.mutate(options.cwd!);
    return implementation;
  });
  expect((await f.run()).outcome).toBe('accepted');
  expect(f.state.usage.totalTokens).toBe(300);
});

test('handoff decomposition persists graph before independent workers and integrates their outputs', async () => {
  const f = fixture();
  f.state.workspace.repoRoot = '/workspace';
  f.respond(async (prompt, options) => {
    if (options.phase === 'reviewer') return review(input(prompt));
    if (f.calls.length === 1)
      return {
        ...implementation,
        plan: {
          reason: 'Independent literal interfaces need separate contexts',
          tasks: [contract('a', ['a.ts']), contract('b', ['b.ts'])]
        }
      };
    expect(f.state.plans).toHaveLength(2);
    expect(f.state.decisions.some((decision) => decision.kind === 'handoff-applied')).toBe(true);
    f.mutate(options.cwd!, options.label.includes('-a') ? 'a.ts' : 'b.ts');
    return implementation;
  });
  expect((await f.run()).outcome).toBe('accepted');
  expect(f.events.filter((event) => event.startsWith('fork:'))).toHaveLength(2);
  expect(f.events.filter((event) => event.startsWith('integrate:'))).toHaveLength(2);
  expect(f.state.consumed.replans).toBe(1);
});

test('semantic integration conflicts retain worker output and schedule bounded resolution in the target', async () => {
  const f = fixture({
    ...inspection,
    plan: {
      reason: 'Independent interfaces',
      tasks: [
        contract('a', ['a.ts']),
        contract('b', ['b.ts']),
        contract('caller', ['caller.ts'], ['a'])
      ]
    }
  });
  f.state.workspace.repoRoot = '/workspace';
  const integrate = f.services.integrate;
  let conflict = true;
  f.services.integrate = async (...parameters) => {
    if (conflict) {
      conflict = false;
      throw new Error('SDLC integration conflict: retained competing output');
    }
    return integrate(...parameters);
  };
  f.respond(async (prompt, options) => {
    if (options.phase === 'reviewer') return review(input(prompt));
    if (options.label.includes('integration-')) {
      expect(options.cwd).toBe('/workspace');
      expect(input(prompt).assignment.outcome).toContain('Retained output');
      f.mutate(options.cwd!, 'a.ts');
    } else
      f.mutate(
        options.cwd!,
        options.label.includes('-caller')
          ? 'caller.ts'
          : options.label.includes('-a')
            ? 'a.ts'
            : 'b.ts'
      );
    return implementation;
  });
  expect((await f.run()).outcome).toBe('accepted');
  expect(f.state.tasks.find((task) => task.id === 'p1-a')?.integration).toMatchObject({
    status: 'resolved'
  });
  const order = f.calls.map((call) => call.options.label);
  expect(order.findIndex((id) => id.includes('integration-'))).toBeLessThan(
    order.indexOf('p1-caller')
  );
  expect(f.state.consumed.corrections).toBe(1);
});

test('failed semantic integration resolution is replaced and releases its waiting dependents', async () => {
  const f = fixture({
    ...inspection,
    plan: {
      reason: 'Independent files with a caller',
      tasks: [
        contract('a', ['a.ts']),
        contract('b', ['b.ts']),
        contract('caller', ['caller.ts'], ['a'])
      ]
    }
  });
  f.state.workspace.repoRoot = '/workspace';
  const integrate = f.services.integrate;
  let conflict = true;
  f.services.integrate = async (...parameters) => {
    if (conflict) {
      conflict = false;
      throw new Error('SDLC integration conflict: retained competing output');
    }
    return integrate(...parameters);
  };
  let failResolution = true;
  f.respond(async (prompt, options) => {
    if (options.phase === 'reviewer') return review(input(prompt));
    if (options.label.includes('integration-')) {
      if (failResolution) {
        failResolution = false;
        throw new Error('Resolver crashed');
      }
      f.mutate(options.cwd!, 'a.ts');
    } else
      f.mutate(
        options.cwd!,
        options.label.includes('-caller')
          ? 'caller.ts'
          : options.label.includes('-a')
            ? 'a.ts'
            : 'b.ts'
      );
    return implementation;
  });
  expect((await f.run()).outcome).toBe('incomplete');
  const old = f.state.tasks.find((task) => task.id === 'p1-a')!.integration!.resolutionTaskId!;
  expect(f.calls.some((call) => call.options.label === 'p1-caller')).toBe(false);
  applySdlcContinuation(f.state, {}, 9);
  const next = f.state.tasks.find((task) => task.id === 'p1-a')!.integration!.resolutionTaskId!;
  expect(next).not.toBe(old);
  expect((await f.run()).outcome).toBe('accepted');
  expect(f.state.tasks.find((task) => task.id === 'p1-a')?.integration?.status).toBe('resolved');
  const labels = f.calls.map((call) => call.options.label);
  expect(labels.indexOf(next)).toBeLessThan(labels.indexOf('p1-caller'));
});

test('a failed fork check is corrected in its owner before integration or dependent work', async () => {
  const f = fixture({
    ...behavioral,
    plan: {
      reason: 'Independent scoped writers',
      tasks: [
        { ...contract('a', ['a.ts']), checks: ['tests'] },
        contract('b', ['b.ts']),
        contract('caller', ['caller.ts'], ['a'])
      ]
    }
  });
  f.state.workspace.repoRoot = '/workspace';
  const check = f.services.check;
  f.services.check = async (...parameters) => ({
    ...(await check(...parameters)),
    ...(parameters[1].cwd === '/fork/p1-a' && !parameters[2].includes('correct-check')
      ? { status: 'failed' as const, exitCode: 1, output: 'Behavioral assertion failed' }
      : {})
  });
  const integrate = f.services.integrate;
  let corrected = false;
  f.services.integrate = async (...parameters) => {
    if (parameters[1].cwd === '/fork/p1-a') expect(corrected).toBe(true);
    return integrate(...parameters);
  };
  f.respond(async (prompt, options) => {
    const data = input(prompt);
    if (options.phase === 'reviewer') return review(data);
    if (options.label.includes('correct-check')) {
      expect(options.cwd).toBe('/fork/p1-a');
      expect(data.assignment.writes).toEqual(['a.ts']);
      expect(data.assignment.outcome).toBe('Deliver a');
      expect(assignmentEvidence(data)).toContain('Behavioral assertion failed');
      corrected = true;
      f.mutate(options.cwd!, 'a.ts', 'fixed');
    } else {
      if (options.label === 'p1-caller') expect(corrected).toBe(true);
      f.mutate(
        options.cwd!,
        options.label.endsWith('-a') ? 'a.ts' : options.label.endsWith('-b') ? 'b.ts' : 'caller.ts'
      );
    }
    return implementation;
  });
  expect((await f.run()).outcome).toBe('accepted');
  expect(f.state.consumed.corrections).toBe(1);
});

test('question affected task IDs are prefixed, independent work proceeds and dependents resume after answer', async () => {
  const f = fixture({
    ...inspection,
    questions: [{ id: 'direction', text: 'Which direction?', affectedTasks: ['a'] }],
    plan: {
      reason: 'Independent outcomes plus dependent caller',
      tasks: [
        contract('a', ['a.ts']),
        contract('b', ['b.ts']),
        contract('caller', ['caller.ts'], ['a'])
      ]
    }
  });
  f.respond(async (prompt, options) =>
    options.phase === 'reviewer' ? review(input(prompt)) : implementation
  );
  expect((await f.run()).outcome).toBe('needs-input');
  expect(f.calls.map((call) => call.options.label)).toEqual(['p1-b']);
  expect(f.state.questions[0].affectedTasks).toEqual(['p1-a']);
  expect(() =>
    applySdlcAnswers(f.state, [{ questionId: 'direction', briefRevision: 2, answer: 'up' }], 1)
  ).toThrow('Stale');
  applySdlcAnswers(f.state, [{ questionId: 'direction', briefRevision: 1, answer: 'up' }], 1);
  expect(() =>
    applySdlcAnswers(f.state, [{ questionId: 'direction', briefRevision: 1, answer: 'down' }], 1)
  ).toThrow('already');
  applySdlcContinuation(f.state, {}, 2);
  expect((await f.run()).outcome).toBe('accepted');
  expect(f.calls.map((call) => call.options.label)).toEqual([
    'p1-b',
    'p1-a',
    'p1-caller',
    'review-1-c1'
  ]);
});

test('all answers in a batch are validated before a revision changes', () => {
  const f = fixture({
    ...inspection,
    questions: [
      { id: 'a', text: 'A?', affectedTasks: [] },
      { id: 'b', text: 'B?', affectedTasks: [] }
    ]
  });
  expect(() =>
    applySdlcAnswers(
      f.state,
      [
        { questionId: 'a', briefRevision: 1, answer: 'yes' },
        { questionId: 'b', briefRevision: 9, answer: 'no' }
      ],
      1
    )
  ).toThrow('Stale');
  expect(f.state.brief.revision).toBe(1);
  expect(f.state.questions[0].answer).toBeUndefined();
});

test('invalid question task references and overlapping graphs stop before dependent effects', async () => {
  const f = fixture({
    ...inspection,
    questions: [{ id: 'q', text: 'Choose?', affectedTasks: ['typo'] }]
  });
  expect((await f.run()).outcome).toBe('blocked');
  expect(f.calls).toHaveLength(0);
  expect(() =>
    validatePlan(
      { reason: 'bad parallelism', tasks: [contract('a'), contract('b')] },
      new Set(),
      new Set()
    )
  ).toThrow('Overlapping');
  expect(() =>
    validatePlan(
      { reason: 'cycle', tasks: [contract('a', ['a'], ['b']), contract('b', ['b'], ['a'])] },
      new Set(),
      new Set()
    )
  ).toThrow('cycle');
});

test('oversized supplied context uses the user target and heuristic, not billed usage', async () => {
  const f = fixture({
    ...inspection,
    context: ['x'.repeat(20_000)],
    policy: { contextTarget: 0.5, contextWindowTokens: 32_000 }
  });
  f.respond(async (prompt, options) => {
    if (options.phase === 'analyst') {
      expect(input(prompt).contextAllocation.estimatedInputTokens).toBeGreaterThan(16_000);
      return {
        reason: 'Coupled work needs bounded sequential contexts',
        assumptions: [],
        requirements: [],
        questions: [],
        tasks: [contract('interface'), contract('caller', ['*'], ['interface'])],
        artifacts: []
      };
    }
    return options.phase === 'reviewer' ? review(input(prompt)) : implementation;
  });
  expect((await f.run()).outcome).toBe('accepted');
  expect(f.calls.map((call) => call.options.phase)).toEqual([
    'analyst',
    'implementer',
    'implementer',
    'reviewer'
  ]);
});

test('clean code review does not accept missing original behavior and triggers a correction', async () => {
  const f = fixture(behavioral);
  let reviews = 0;
  f.respond(async (prompt, options) => {
    const data = input(prompt);
    if (options.phase === 'reviewer') return review(data, ++reviews === 1 ? 'not-met' : 'met');
    if (reviews) {
      expect(assignmentEvidence(data)).toContain('Required outcome still needs work');
      expect(data.brief.originalGoal).toBe(behavioral.goal);
      expect(data.brief.goal).toBe(behavioral.goal);
    }
    f.mutate(options.cwd!);
    return implementation;
  });
  expect((await f.run()).outcome).toBe('accepted');
  expect(reviews).toBe(2);
  expect(f.state.consumed.corrections).toBe(1);
  const checks = f.state.checks.filter((check) => check.phase === 'integration');
  expect(new Set(checks.map((check) => check.candidateRevision)).size).toBe(2);
});

test('missing evidence schedules bounded verification, not an unnecessary implementation', async () => {
  const f = fixture(behavioral);
  let reviews = 0;
  f.respond(async (prompt, options) =>
    options.phase === 'reviewer'
      ? review(input(prompt), ++reviews === 1 ? 'unverified' : 'met')
      : implementation
  );
  expect((await f.run()).outcome).toBe('accepted');
  expect(f.calls.filter((call) => call.options.phase === 'implementer')).toHaveLength(1);
  expect(f.state.decisions.filter((decision) => decision.kind === 'verification')).toHaveLength(1);
});

test('unavailable evidence stays visible and additive continuation checks can establish acceptance', async () => {
  const f = fixture({ goal: 'Preserve falsy hits' });
  f.respond(async (prompt, options) =>
    options.phase === 'reviewer' ? review(input(prompt)) : implementation
  );
  expect((await f.run()).outcome).toBe('incomplete');
  const consumed = f.state.consumed.tasks;
  applySdlcContinuation(f.state, { checks: behavioral.checks }, 3);
  expect(f.state.consumed.tasks).toBe(consumed);
  expect((await f.run()).outcome).toBe('accepted');
  expect(() =>
    applySdlcContinuation(f.state, { checks: [{ ...behavioral.checks![0], argv: ['true'] }] }, 4)
  ).toThrow('cannot replace or weaken');
  expect(() =>
    applySdlcContinuation(
      f.state,
      { checks: [{ ...behavioral.checks![0], id: 'new', outcomes: ['invented'] }] },
      4
    )
  ).toThrow('Unknown SDLC check outcome');
});

test.each(['empty', 'unknown', 'unavailable', 'failed'] as const)(
  '%s check cannot establish behavioral acceptance',
  async (status) => {
    const f = fixture(behavioral);
    const original = f.services.check;
    f.services.check = async (...args) => ({
      ...(await original(...args)),
      status,
      testCount: status === 'empty' ? 0 : undefined
    });
    expect((await f.run()).outcome).toBe('incomplete');
    expect(f.state.assessments).toHaveLength(0);
    expect(f.calls.filter((call) => call.options.phase === 'reviewer')).toHaveLength(0);
    expect(f.state.result?.unresolvedWork.join(' ')).toContain(status);
  }
);

test.each([0, undefined])(
  'a nominally passing test with count %s stops before paid review',
  async (testCount) => {
    const f = fixture(behavioral);
    const check = f.services.check;
    f.services.check = async (...parameters) => ({ ...(await check(...parameters)), testCount });
    expect((await f.run()).outcome).toBe('incomplete');
    expect(f.calls.map((item) => item.options.phase)).toEqual(['implementer']);
    expect(f.state.checks.at(-1)?.result?.status).toBe(testCount === 0 ? 'empty' : 'unknown');
  }
);

test('stale candidate assessment is rejected instead of accepted', async () => {
  const f = fixture();
  f.respond(async (prompt, options) =>
    options.phase === 'reviewer'
      ? { ...review(input(prompt)), candidateRevision: 'older' }
      : implementation
  );
  expect((await f.run()).outcome).toBe('incomplete');
  expect(f.state.result?.unresolvedWork.join(' ')).toContain('stale');
  expect(f.state.tasks.find((task) => task.kind === 'review')?.status).toBe('failed');
  expect(f.state.assessments).toHaveLength(0);
});

test('failed, malformed or unverified reviews are retried by explicit continuation, not reused', async () => {
  const f = fixture();
  let reviews = 0;
  f.respond(async (prompt, options) => {
    if (options.phase !== 'reviewer') return implementation;
    const next = review(input(prompt));
    reviews++;
    if (reviews === 1) return { ...next, candidateRevision: 'older' };
    if (reviews === 2)
      return { ...next, codeReview: { ...next.codeReview, verdict: 'unverified' } };
    return next;
  });
  expect((await f.run()).outcome).toBe('incomplete');
  applySdlcContinuation(f.state, {}, 1);
  const unverified = await f.run();
  expect(unverified.outcome).toBe('incomplete');
  expect(unverified.unresolvedWork.join(' ')).toContain('unverified');
  applySdlcContinuation(f.state, {}, 2);
  expect((await f.run()).outcome).toBe('accepted');
  expect(f.calls.filter((call) => call.options.phase === 'implementer')).toHaveLength(1);
  expect(reviews).toBe(3);
});

test('a decisive unmet judgment is retained across continuation instead of paying for another review', async () => {
  const f = fixture({ ...inspection, policy: { limits: { correctionRounds: 0 } } });
  let reviews = 0;
  f.respond(async (prompt, options) => {
    if (options.phase !== 'reviewer') return implementation;
    reviews++;
    return review(input(prompt), 'not-met');
  });
  expect((await f.run()).outcome).toBe('incomplete');
  applySdlcContinuation(f.state, { limits: { correctionRounds: 1 } }, 1);
  expect((await f.run()).outcome).toBe('incomplete');
  expect(reviews).toBe(2);
  expect(f.state.consumed.corrections).toBe(1);
});

test('legacy assessments without correction counters do not imply an intervening correction', async () => {
  const f = fixture({ ...inspection, policy: { limits: { correctionRounds: 1 } } });
  f.state.consumed.corrections = 1;
  let reviews = 0;
  f.respond(async (prompt, options) => {
    if (options.phase === 'reviewer')
      return review(input(prompt), ++reviews < 3 ? 'not-met' : 'met');
    if (reviews) f.mutate(options.cwd!);
    return implementation;
  });
  expect((await f.run()).outcome).toBe('incomplete');
  delete f.state.assessments[0].correctionCount;
  applySdlcContinuation(f.state, { limits: { correctionRounds: 2 }, checks: behavioral.checks }, 2);
  expect((await f.run()).outcome).toBe('accepted');
  expect(f.state.consumed.corrections).toBe(2);
});

test('repeated continuations replace each retired assignment once and retry a failed analyst', async () => {
  const f = fixture();
  let failures = 1;
  f.respond(async (prompt, options) => {
    if (options.phase === 'reviewer') return review(input(prompt));
    if (failures-- > 0) throw new Error('quota');
    f.mutate(options.cwd!);
    return implementation;
  });
  expect((await f.run()).outcome).toBe('incomplete');
  applySdlcContinuation(f.state, {}, 1);
  applySdlcContinuation(f.state, { limits: { maxTasks: 8 } }, 2);
  expect(f.state.tasks.filter((task) => task.status === 'pending')).toHaveLength(1);
  expect((await f.run()).outcome).toBe('accepted');
  applySdlcContinuation(f.state, { limits: { maxTasks: 9 } }, 3);
  expect(f.state.tasks.filter((task) => task.id.startsWith('p1-implement'))).toHaveLength(2);
  expect(new Set(f.state.tasks.map((task) => task.id)).size).toBe(f.state.tasks.length);

  const analysis = fixture({ ...inspection, planning: 'investigate' });
  let analysts = 0;
  analysis.respond(async (prompt, options) => {
    if (options.phase === 'analyst') {
      if (++analysts === 1) throw new Error('quota');
      return {
        reason: 'One coupled change',
        assumptions: [],
        requirements: [],
        questions: [],
        tasks: [contract('only')],
        artifacts: []
      };
    }
    return options.phase === 'reviewer' ? review(input(prompt)) : implementation;
  });
  expect((await analysis.run()).outcome).toBe('incomplete');
  applySdlcContinuation(analysis.state, {}, 1);
  expect((await analysis.run()).outcome).toBe('accepted');
  expect(analysis.state.plans.map((plan) => plan.shape)).toEqual([
    'investigation',
    'investigation',
    'single'
  ]);
  expect(analysis.state.consumed.replans).toBe(0);
});

test('an analyst may ask only questions and pause one implementation until they are answered', async () => {
  const f = fixture({ ...inspection, planning: 'investigate' });
  f.respond(async (prompt, options) =>
    options.phase === 'analyst'
      ? {
          reason: 'Planning needs a product decision',
          assumptions: [],
          requirements: [],
          questions: [{ id: 'scope', text: 'Which API surface?', affectedTasks: [] }],
          tasks: [],
          artifacts: []
        }
      : options.phase === 'reviewer'
        ? review(input(prompt))
        : implementation
  );
  expect((await f.run()).outcome).toBe('needs-input');
  expect(f.calls.map((call) => call.options.phase)).toEqual(['analyst']);
  applySdlcAnswers(f.state, [{ questionId: 'scope', briefRevision: 1, answer: 'Public API' }], 1);
  applySdlcContinuation(f.state, {}, 2);
  expect((await f.run()).outcome).toBe('accepted');
  expect(f.calls.map((call) => call.options.phase)).toEqual(['analyst', 'implementer', 'reviewer']);
});

test('correction rounds are not spent as replanning allowance', async () => {
  const f = fixture(behavioral);
  let reviews = 0;
  f.respond(async (prompt, options) => {
    if (options.phase === 'reviewer')
      return review(input(prompt), ++reviews <= 3 ? 'not-met' : 'met');
    f.mutate(options.cwd!);
    return implementation;
  });
  expect((await f.run()).outcome).toBe('accepted');
  expect(f.state.consumed).toMatchObject({ corrections: 3, replans: 0 });
});

test('ready writers wait for remaining allowance and non-Git targets serialize with a recorded reason', async () => {
  const parallel = {
    ...inspection,
    plan: { reason: 'Independent files', tasks: [contract('a', ['a.ts']), contract('b', ['b.ts'])] }
  };
  const respond = (f: ReturnType<typeof fixture>) =>
    f.respond(async (prompt, options) => {
      if (options.phase === 'reviewer') return review(input(prompt));
      f.mutate(options.cwd!, options.label.endsWith('-a') ? 'a.ts' : 'b.ts');
      return implementation;
    });

  const limited = fixture({ ...parallel, policy: { limits: { maxTasks: 1 } } });
  limited.state.workspace.repoRoot = '/workspace';
  respond(limited);
  expect((await limited.run()).outcome).toBe('incomplete');
  expect(limited.calls.map((call) => call.options.label)).toEqual(['p1-a']);
  expect(limited.events.some((event) => event.startsWith('fork:'))).toBe(false);
  expect(limited.state.decisions.find((item) => item.kind === 'throttle')).toMatchObject({
    taskIds: ['p1-b']
  });
  applySdlcContinuation(limited.state, { limits: { maxTasks: 3 } }, 1);
  expect((await limited.run()).outcome).toBe('accepted');
  expect(limited.calls.map((call) => call.options.label)).toEqual(['p1-a', 'p1-b', 'review-1-c1']);

  const nonGit = fixture(parallel);
  respond(nonGit);
  expect((await nonGit.run()).outcome).toBe('accepted');
  expect(nonGit.calls.map((call) => call.options.label)).toEqual(['p1-a', 'p1-b', 'review-1-c0']);
  expect(nonGit.events.some((event) => event.startsWith('fork:'))).toBe(false);
  expect(nonGit.state.decisions.find((item) => item.kind === 'serialize')?.reason).toContain(
    'non-Git'
  );
});

test('replacements keep an unintegrated fork but revise integrated output in the target', async () => {
  const f = fixture({
    ...inspection,
    plan: { reason: 'Independent interfaces', tasks: [contract('a', ['a.ts'])] }
  });
  expect((await f.run()).outcome).toBe('accepted');
  const base = f.state.tasks.find((task) => task.id === 'p1-a')!;
  const fork = { ...f.state.workspace, owner: 'p1-a', cwd: '/fork/p1-a' };
  const retained = { ...base, id: 'p1-failed', status: 'failed' as const, workspace: fork };
  const integrated = {
    ...base,
    id: 'p1-integrated',
    status: 'invalidated' as const,
    workspace: fork,
    integration: { expectedRevision: 'x', status: 'completed' as const }
  };
  f.state.tasks.push(retained, integrated);
  applySdlcContinuation(f.state, {}, 1);
  expect(f.state.tasks.find((task) => task.id === 'p1-failed-r2')?.workspace).toEqual(fork);
  expect(f.state.tasks.find((task) => task.id === 'p1-integrated-r2')?.workspace).toBeUndefined();
  expect(f.state.tasks.find((task) => task.id === 'p1-failed')?.supersededBy).toBe('p1-failed-r2');
});

test('unchanged candidate stops correction loops without weakening criteria', async () => {
  const f = fixture();
  f.respond(async (prompt, options) =>
    options.phase === 'reviewer' ? review(input(prompt), 'not-met') : implementation
  );
  expect((await f.run()).outcome).toBe('incomplete');
  expect(f.calls.filter((call) => call.options.phase === 'implementer')).toHaveLength(2);
  expect(f.state.result?.unresolvedWork.join(' ')).toContain('No credible progress');
});

test('an explicit handoff can use existing dependencies without prefixing them again', async () => {
  const f = fixture({
    ...inspection,
    plan: {
      reason: 'Interface before documentation',
      tasks: [contract('a', ['a.ts']), contract('b', ['b.ts'], ['a'])]
    }
  });
  f.respond(async (prompt, options) => {
    if (options.phase === 'reviewer') return review(input(prompt));
    if (options.label === 'p1-b')
      return {
        ...implementation,
        plan: {
          reason: 'Delegate bounded documentation with the existing interface as input',
          tasks: [contract('delegated', ['b.ts'], ['p1-a'])]
        }
      };
    return implementation;
  });
  expect((await f.run()).outcome).toBe('accepted');
  expect(f.state.tasks.find((task) => task.id === 'p2-delegated')?.dependsOn).toEqual(['p1-a']);
});

test('handoffs cannot depend on an existing downstream consumer and create a cycle', async () => {
  const f = fixture({
    ...inspection,
    plan: {
      reason: 'Ordered files',
      tasks: [contract('a', ['a.ts']), contract('b', ['b.ts'], ['a'])]
    }
  });
  f.respond(async () => ({
    ...implementation,
    plan: {
      reason: 'Invalid back edge',
      tasks: [contract('delegated', ['a.ts'], ['p1-b'])]
    }
  }));
  expect((await f.run()).outcome).toBe('incomplete');
  expect(f.state.tasks[0].status).toBe('failed');
  expect(f.state.tasks[0].error).toContain('cycle');
  expect(f.calls).toHaveLength(1);
});

test('autonomous handoffs consume finite replanning allowance', async () => {
  const f = fixture({ ...inspection, policy: { limits: { replans: 1 } } });
  f.respond(async () => ({
    ...implementation,
    plan: { reason: 'Decompose again', tasks: [contract('next')] }
  }));
  expect((await f.run()).outcome).toBe('incomplete');
  expect(f.calls).toHaveLength(2);
  expect(f.state.consumed.replans).toBe(1);
  expect(f.state.result?.unresolvedWork.join(' ')).toContain('replanning allowance');
});

test('explicit empty scope is the only no-work path and makes no paid dummy call', async () => {
  const f = fixture({
    ...inspection,
    noWork: { confirmed: true, reason: 'The requested scope is already empty' }
  });
  expect((await f.run()).outcome).toBe('no-work');
  expect(f.calls).toHaveLength(0);
  expect(() =>
    validateSdlcArgs({ ...inspection, noWork: { confirmed: false, reason: 'empty' } })
  ).toThrow('confirmed');
  const failed = fixture();
  failed.respond(async () => null);
  expect((await failed.run()).outcome).toBe('incomplete');
});

test('out-of-scope mutation is retained but blocks acceptance, including paths outside selected cwd', async () => {
  expect(ownsPath(['*'], '../outside.ts')).toBe(false);
  const f = fixture();
  f.respond(async (_prompt, options) => {
    f.mutate(options.cwd!, '../outside.ts');
    return implementation;
  });
  expect((await f.run()).outcome).toBe('blocked');
  expect(f.state.result?.unresolvedWork.join(' ')).toContain('../outside.ts');
});

test('check mutation and target drift invalidate acceptance evidence', async () => {
  const f = fixture(behavioral);
  const original = f.services.check;
  f.services.check = async (...args) => {
    f.mutate(args[1].cwd);
    return original(...args);
  };
  expect((await f.run()).outcome).toBe('blocked');
  expect(f.state.result?.unresolvedWork.join(' ')).toContain('changed source inputs');
  expect(f.calls).toHaveLength(0);
});

test('interruption releases the workspace lease and retains the active writer identity', async () => {
  const f = fixture();
  let identity: string | undefined;
  f.respond(async (_prompt, options) => {
    identity = options.inputRevision;
    f.mutate(options.cwd!);
    f.abort.abort();
    throw new Error('closed');
  });
  await expect(f.run()).rejects.toThrow('closed');
  expect(f.events.at(-1)).toBe('release');
  expect(f.state.tasks[0]).toMatchObject({ status: 'running', inputRevision: identity });
  const restarted = new AbortController();
  f.services.signal = restarted.signal;
  f.respond(async (prompt, options) => {
    if (options.phase === 'reviewer') return review(input(prompt));
    expect(options.inputRevision).toBe(identity);
    return implementation;
  });
  expect((await f.run()).outcome).toBe('accepted');
  expect(f.state.consumed.tasks).toBe(2);
});

test('authorized goal revision supersedes pending old work rather than stranding its dependencies', async () => {
  const f = fixture({
    ...inspection,
    questions: [{ id: 'direction', text: 'Choose?', affectedTasks: ['a'] }],
    plan: { reason: 'Dependent change', tasks: [contract('a'), contract('b', ['*'], ['a'])] }
  });
  expect((await f.run()).outcome).toBe('needs-input');
  applySdlcContinuation(
    f.state,
    {
      answers: [
        { questionId: 'direction', briefRevision: 1, answer: 'new goal supersedes this choice' }
      ],
      goalRevision: 1,
      goal: 'Document only the replacement API',
      acceptance: [{ description: 'Replacement API is documented', verification: 'inspection' }]
    },
    3
  );
  expect((await f.run()).outcome).toBe('accepted');
  expect(f.calls.filter((call) => call.options.phase === 'implementer')).toHaveLength(1);
  expect(input(f.calls[0].prompt).assignment.outcome).toBe('Document only the replacement API');
  expect(f.state.brief.originalGoal).toBe(inspection.goal);
  expect(f.state.briefHistory.length).toBeGreaterThan(0);
});

test('soft budget and task allowance include cumulative consumption', async () => {
  const f = fixture({ ...inspection, policy: { limits: { maxTasks: 1 } } });
  expect((await f.run()).outcome).toBe('incomplete');
  expect(f.calls).toHaveLength(1);
  applySdlcContinuation(f.state, { limits: { maxTasks: 2 } }, 1);
  expect((await f.run()).outcome).toBe('accepted');
  expect(f.state.extensions).toHaveLength(1);
  expect(f.state.consumed.tasks).toBe(2);
});

function judged(data: ReturnType<typeof input>, notMet: string[]): SdlcReview {
  const base = review(data);
  return {
    ...base,
    outcomes: base.outcomes.map((item) =>
      notMet.includes(item.id)
        ? { ...item, status: 'not-met', reason: `${item.id} is not delivered` }
        : item
    )
  };
}
const twoOutcomes: SdlcArgs = {
  goal: 'Document both APIs',
  acceptance: [
    { id: 'reads', description: 'Read API documented', verification: 'inspection' },
    { id: 'writes', description: 'Write API documented', verification: 'inspection' }
  ]
};

test('a correction that breaks another required outcome is detected and corrected within limits', async () => {
  const f = fixture(twoOutcomes);
  let reviews = 0;
  f.respond(async (prompt, options) => {
    const data = input(prompt);
    if (options.phase === 'reviewer') return judged(data, [['reads'], ['writes'], []][reviews++]);
    if (reviews) expect(assignmentEvidence(data)).toContain(reviews === 1 ? 'reads' : 'writes');
    f.mutate(options.cwd!);
    return implementation;
  });
  expect((await f.run()).outcome).toBe('accepted');
  expect(f.state.consumed.corrections).toBe(2);
  expect(f.state.assessments.map((item) => item.accepted)).toEqual([false, false, true]);
});

test('oscillating candidates stop instead of consuming every remaining correction', async () => {
  const f = fixture(inspection);
  let reviews = 0;
  let turn = 0;
  f.respond(async (prompt, options) => {
    if (options.phase === 'reviewer') {
      reviews++;
      return review(input(prompt), 'not-met');
    }
    f.mutate(options.cwd!, 'api.ts', ['one', 'two', 'one'][turn++ % 3]);
    return implementation;
  });
  const result = await f.run();
  expect(result.outcome).toBe('incomplete');
  expect(result.unresolvedWork.join(' ')).toContain('No credible progress');
  expect(reviews).toBe(3);
  expect(f.state.consumed.corrections).toBe(2);
});

test('a late answer invalidates only affected dependents and keeps unrelated completed work', async () => {
  const f = fixture({
    ...inspection,
    plan: {
      reason: 'Independent work with a dependent caller',
      tasks: [
        contract('a', ['a.ts']),
        contract('b', ['b.ts']),
        contract('caller', ['caller.ts'], ['a'])
      ]
    }
  });
  f.respond(async (prompt, options) => {
    if (options.phase === 'reviewer') return review(input(prompt));
    f.mutate(options.cwd!, `${options.label.split('-').slice(1, 2)}.ts`, options.label);
    return implementation;
  });
  expect((await f.run()).outcome).toBe('accepted');
  f.state.questions.push({
    id: 'late',
    text: 'Should a.ts keep its old contract?',
    affectedTasks: ['p1-a'],
    briefRevision: f.state.brief.revision
  });
  applySdlcAnswers(f.state, [{ questionId: 'late', briefRevision: 1, answer: 'No' }], 5);
  applySdlcContinuation(f.state, {}, 6);
  f.calls.length = 0;
  expect((await f.run()).outcome).toBe('accepted');
  expect(f.calls.map((call) => call.options.label)).toEqual([
    'p1-a-r2',
    'p1-caller-r2',
    'review-2-c1'
  ]);
  expect(f.state.tasks.find((task) => task.id === 'p1-b')?.status).toBe('completed');
  expect(f.state.tasks.find((task) => task.id === 'p1-caller-r2')?.dependsOn).toEqual(['p1-a-r2']);
});

test('a handoff keeps dependents waiting for the delegated work and its recorded answers', async () => {
  const dependent = {
    ...inspection,
    plan: {
      reason: 'Caller needs the interface',
      tasks: [contract('a', ['a.ts']), contract('caller', ['caller.ts'], ['a'])]
    }
  };
  const asking = fixture(dependent);
  asking.respond(async (prompt, options) =>
    options.phase === 'reviewer'
      ? review(input(prompt))
      : options.label === 'p1-a' && !asking.state.questions.length
        ? {
            ...implementation,
            questions: [{ id: 'shape', text: 'Which interface shape?', affectedTasks: [] }]
          }
        : implementation
  );
  expect((await asking.run()).outcome).toBe('needs-input');
  expect(asking.calls.map((call) => call.options.label)).toEqual(['p1-a']);
  expect(asking.state.tasks.find((task) => task.id === 'p1-caller')?.dependsOn).toEqual([
    'p1-a',
    'p2-clarified'
  ]);
  applySdlcAnswers(asking.state, [{ questionId: 'shape', briefRevision: 1, answer: 'Small' }], 1);
  applySdlcContinuation(asking.state, {}, 2);
  expect((await asking.run()).outcome).toBe('accepted');
  expect(asking.calls.map((call) => call.options.label)).toEqual([
    'p1-a',
    'p2-clarified',
    'p1-caller',
    'review-1-c1'
  ]);

  const split = fixture(dependent);
  split.respond(async (prompt, options) =>
    options.phase === 'reviewer'
      ? review(input(prompt))
      : options.label === 'p1-a'
        ? {
            ...implementation,
            plan: {
              reason: 'Separate contexts',
              tasks: [contract('x', ['x.ts']), contract('y', ['x.ts'], ['x'])]
            }
          }
        : implementation
  );
  expect((await split.run()).outcome).toBe('accepted');
  expect(split.calls.map((call) => call.options.label)).toEqual([
    'p1-a',
    'p2-x',
    'p2-y',
    'p1-caller',
    'review-1-c0'
  ]);
});

const finding = {
  id: 'null-page',
  file: 'api.ts',
  line: 1,
  summary: 'The final page is dropped',
  evidence: 'The loop exits before reading the last cursor',
  priority: 2,
  scenario: 'A client reads three pages and loses the third',
  alternative: 'Read until no cursor remains',
  references: [{ file: 'api.ts', line: 1, observation: 'The loop exits early' }],
  verdict: 'CONFIRMED',
  reason: 'The cursor is checked before the page is consumed',
  counterevidence: '',
  limitations: []
} as const;

test.each(['confirmed', 'uncertain'] as const)(
  'imported %s dispositions without duplicate findings lead to bounded verification/correction',
  async (disposition) => {
    const f = fixture();
    f.state.importedFindings = [
      { ...finding, id: 'source:null-page', references: [...finding.references], limitations: [] }
    ];
    f.state.evidence.push({
      id: 'import:source',
      kind: 'import',
      producingTask: 'source',
      briefRevision: 1,
      goalRevision: 1,
      inputRevision: 'source-review',
      candidateRevision: f.state.candidateRevision,
      scope: ['historical claims'],
      dependencies: [],
      result: { findings: f.state.importedFindings },
      limitations: ['Historical claims require current verification']
    });
    let corrected = false;
    let verified = 0;
    f.respond(async (prompt, options) => {
      const data = input(prompt);
      if (options.phase !== 'reviewer') {
        if (data.assignment.outcome.includes('Correct the failed obligations')) {
          expect(assignmentEvidence(data)).toContain('source:null-page');
          expect(JSON.stringify(data.relevantEvidence)).toContain('The final page is dropped');
          expect(assignmentEvidence(data)).toContain('findingDispositions');
          corrected = true;
        }
        f.mutate(options.cwd!);
        return implementation;
      }
      if (data.reviewContext?.purpose === 'verification') {
        verified++;
        expect(data.sourceFindings[0].id).toBe('source:null-page');
        expect(data.sourceReviews[0].result.findingDispositions[0].disposition).toBe('uncertain');
      }
      return {
        ...review(data),
        findingDispositions: [
          {
            id: 'source:null-page',
            disposition: corrected
              ? 'resolved'
              : data.reviewContext?.purpose === 'verification'
                ? 'confirmed'
                : disposition,
            reason: corrected
              ? 'Checked the corrected cursor loop'
              : 'The cursor is consumed too late',
            ...(corrected
              ? {
                  observations: [
                    { file: 'api.ts', line: 1, observation: 'The loop consumes the final cursor' }
                  ]
                }
              : {})
          }
        ]
      };
    });
    expect((await f.run()).outcome).toBe('accepted');
    expect(corrected).toBe(true);
    expect(verified).toBe(disposition === 'uncertain' ? 1 : 0);
    expect(f.state.consumed.corrections).toBe(1);
  }
);

test('an imported claim still uncertain after one verifier stops without speculative code changes', async () => {
  const f = fixture();
  f.state.importedFindings = [
    { ...finding, id: 'source:null-page', references: [...finding.references], limitations: [] }
  ];
  f.respond(async (prompt, options) =>
    options.phase !== 'reviewer'
      ? implementation
      : {
          ...review(input(prompt)),
          findingDispositions: [
            {
              id: 'source:null-page',
              disposition: 'uncertain',
              reason: 'Essential runtime evidence is unavailable'
            }
          ]
        }
  );
  const result = await f.run();
  expect(result.outcome).toBe('incomplete');
  expect(result.unresolvedWork.join(' ')).toContain('one independent verification');
  expect(
    f.calls.filter((item) => input(item.prompt).reviewContext?.purpose === 'verification')
  ).toHaveLength(1);
  expect(f.calls.filter((item) => item.options.phase === 'implementer')).toHaveLength(1);
  expect(f.state.consumed.corrections).toBe(0);
});

test('a newly authorized check is post-change evidence, not a fabricated failing baseline', async () => {
  const f = fixture();
  f.respond(async (prompt, options) => {
    if (options.phase === 'reviewer') return review(input(prompt));
    f.mutate(options.cwd!, 'api.ts', 'candidate');
    return implementation;
  });
  expect((await f.run()).outcome).toBe('accepted');
  const check = f.services.check;
  f.services.check = async (...parameters) => ({
    ...(await check(...parameters)),
    status: 'failed',
    exitCode: 1
  });
  applySdlcContinuation(f.state, { checks: behavioral.checks, limits: { correctionRounds: 0 } }, 1);
  expect((await f.run()).outcome).toBe('incomplete');
  expect(f.state.checks.some((item) => item.phase === 'baseline')).toBe(false);
  expect(f.state.checks.at(-1)?.result?.classification).toBe('missing-baseline');
  expect(f.calls.filter((item) => item.options.phase === 'reviewer')).toHaveLength(1);
});

test('initial independent review can request bounded specialist inspection followed by synthesis', async () => {
  const f = fixture();
  f.respond(async (prompt, options) => {
    const data = input(prompt);
    if (options.phase !== 'reviewer') return implementation;
    expect(options.toolset).toBe('review');
    if (data.reviewContext?.purpose === 'specialist') {
      expect(data.reviewContext.scope).toContain('Public API compatibility');
      expect(data.sourceReviews).toHaveLength(1);
      return review(data);
    }
    if (data.reviewContext?.purpose === 'synthesis') {
      expect(data.sourceReviews).toHaveLength(2);
      return review(data);
    }
    return {
      ...review(data),
      codeReview: {
        verdict: 'unverified',
        findings: [],
        limitations: ['API compatibility needs a focused inspection']
      },
      reviewRequests: [
        {
          scope: 'Public API compatibility',
          reason: 'Cross-package consumers require a dedicated context'
        }
      ]
    };
  });
  expect((await f.run()).outcome).toBe('accepted');
  expect(
    f.calls.map((item) => input(item.prompt).reviewContext?.purpose ?? item.options.phase)
  ).toEqual(['implementer', 'reviewer', 'specialist', 'synthesis']);
  expect(f.state.decisions.filter((item) => item.kind === 'review-specialist')).toHaveLength(1);
});

test('synthesis cannot silently drop a specialist defect or unavailable inspection evidence', async () => {
  for (const unavailable of [false, true]) {
    const f = fixture();
    let corrected = false;
    f.respond(async (prompt, options) => {
      const data = input(prompt);
      if (options.phase !== 'reviewer') {
        if (data.assignment.outcome.includes('Correct the failed obligations')) {
          corrected = true;
          expect(assignmentEvidence(data)).toContain('The final page is dropped');
          f.mutate(options.cwd!);
        }
        return implementation;
      }
      const next = review(data);
      if (corrected)
        return {
          ...next,
          findingDispositions: [
            {
              id: data.pendingFindings[0].id,
              disposition: 'resolved',
              reason: 'Checked the corrected cursor loop',
              observations: [
                {
                  file: 'api.ts',
                  line: 1,
                  observation: 'The corrected loop consumes the final page'
                }
              ]
            }
          ]
        };
      if (data.reviewContext?.purpose === 'specialist')
        return {
          ...next,
          codeReview: {
            verdict: unavailable ? 'unverified' : 'changes-requested',
            findings: unavailable ? [] : [finding],
            limitations: unavailable ? ['Essential external contract is unavailable'] : []
          }
        };
      if (data.reviewContext?.purpose === 'synthesis') return next;
      return {
        ...next,
        reviewRequests: [{ scope: 'Cursor protocol', reason: 'Cross-package consequence' }]
      };
    });
    expect((await f.run()).outcome).toBe(unavailable ? 'incomplete' : 'accepted');
    expect(corrected).toBe(!unavailable);
  }
});

test('a current uncertain finding is independently verified before correction, without requiring duplicate findings', async () => {
  const f = fixture();
  let corrected = false;
  let verifications = 0;
  f.respond(async (prompt, options) => {
    const data = input(prompt);
    if (options.phase !== 'reviewer') {
      if (data.assignment.outcome.includes('Correct the failed obligations')) {
        corrected = true;
        expect(assignmentEvidence(data)).toContain('The final page is dropped');
        f.mutate(options.cwd!);
      }
      return implementation;
    }
    const next = review(data);
    if (corrected)
      return {
        ...next,
        findingDispositions: [
          {
            id: data.pendingFindings[0].id,
            disposition: 'resolved',
            reason: 'The corrected cursor loop consumes the final page',
            observations: [
              {
                file: 'api.ts',
                line: 1,
                observation: 'The final page is consumed before termination'
              }
            ]
          }
        ]
      };
    if (data.reviewContext?.purpose === 'verification') {
      verifications++;
      return {
        ...next,
        findingDispositions: [
          {
            id: data.reviewContext.findingIds[0],
            disposition: 'confirmed',
            reason: 'Independently reproduced the trigger in source'
          }
        ]
      };
    }
    return {
      ...next,
      codeReview: {
        verdict: 'changes-requested',
        findings: [{ ...finding, verdict: 'UNCERTAIN' }],
        limitations: []
      }
    };
  });
  expect((await f.run()).outcome).toBe('accepted');
  expect(corrected).toBe(true);
  expect(verifications).toBe(1);
});

test('specialist delegation is bounded and unavailable specialist evidence never accepts', async () => {
  const f = fixture();
  f.respond(async (prompt, options) => {
    if (options.phase !== 'reviewer') return implementation;
    return {
      ...review(input(prompt)),
      reviewRequests: [{ scope: 'Inspect compatibility', reason: 'Needs specialist' }]
    };
  });
  const result = await f.run();
  expect(result.outcome).toBe('incomplete');
  expect(result.unresolvedWork.join(' ')).toContain('cannot delegate further');
  expect(f.calls).toHaveLength(3);
  expect(f.state.tasks.at(-1)?.status).toBe('failed');
});

test('materialized context and dependency artifacts are retrieved by path without ballooning prompts', async () => {
  const supplied = 's'.repeat(20_000);
  const artifact = 'a'.repeat(20_000);
  const f = fixture({
    ...inspection,
    context: [supplied],
    policy: { contextWindowTokens: 32_000 },
    plan: {
      reason: 'Producer and dependent consumer',
      tasks: [contract('a'), contract('b', ['*'], ['a'])]
    }
  });
  const cache = new Map<string, unknown>();
  f.services.artifact = async (item) => {
    cache.set(item.id, item.result);
    return `/evidence/${item.id}.json`;
  };
  f.respond(async (prompt, options) => {
    const data = input(prompt);
    expect(data.brief.context[0]).not.toBe(supplied);
    expect(data.brief.context[0]).toContain('/evidence/context-');
    if (options.phase === 'reviewer') return review(data);
    if (options.label === 'p1-a')
      return {
        ...implementation,
        artifacts: [{ name: 'Interface evidence', content: artifact, references: ['api.ts'] }]
      };
    const dependency = data.relevantEvidence.find((item: { path?: string }) =>
      item.path?.includes('p1-a-artifact')
    );
    expect(dependency.path).toContain('/evidence/');
    expect(prompt).not.toContain(artifact);
    expect(cache.size).toBe(2);
    return implementation;
  });
  expect((await f.run()).outcome).toBe('accepted');
  expect(f.state.evidence.filter((item) => item.kind === 'artifact')).toHaveLength(2);
  expect(observedTestCount('\u001b[32mTests 2 passed\u001b[0m')).toBe(2);
});

test('confirmed review findings drive an in-operation correction and keep their closure disposition', async () => {
  const f = fixture();
  let reviews = 0;
  f.respond(async (prompt, options) => {
    const data = input(prompt);
    if (options.phase === 'reviewer') {
      const next = review(data);
      return ++reviews === 1
        ? {
            ...next,
            codeReview: { verdict: 'changes-requested', findings: [finding], limitations: [] }
          }
        : {
            ...next,
            findingDispositions: [
              {
                id: data.pendingFindings[0].id,
                disposition: 'resolved',
                reason: 'Fixed',
                observations: [
                  {
                    file: 'api.ts',
                    line: 1,
                    observation: 'The final page is consumed before termination'
                  }
                ]
              }
            ]
          };
    }
    if (reviews) expect(assignmentEvidence(data)).toContain('The final page is dropped');
    f.mutate(options.cwd!);
    return implementation;
  });
  const result = await f.run();
  expect(result.outcome).toBe('accepted');
  expect(result.findingDispositions).toEqual([
    {
      id: 'review-1-c0:null-page',
      disposition: 'resolved',
      reason: 'Fixed',
      observations: [
        { file: 'api.ts', line: 1, observation: 'The final page is consumed before termination' }
      ]
    }
  ]);
  expect(f.state.consumed.corrections).toBe(1);
});

test('a changes-requested review without an actionable finding is a failed review, not a silent correction', async () => {
  const f = fixture();
  f.respond(async (prompt, options) =>
    options.phase === 'reviewer'
      ? {
          ...review(input(prompt)),
          codeReview: { verdict: 'changes-requested', findings: [], limitations: [] }
        }
      : implementation
  );
  const result = await f.run();
  expect(result.outcome).toBe('incomplete');
  expect(result.unresolvedWork.join(' ')).toContain('actionable finding');
  expect(f.state.consumed.corrections).toBe(0);
});

test('an explicit continuation adopts edits made while paused, but recovery never hides in-flight drift', async () => {
  const f = fixture({
    ...inspection,
    questions: [{ id: 'direction', text: 'Which direction?', affectedTasks: ['a'] }],
    plan: { reason: 'One paused task', tasks: [contract('a', ['a.ts']), contract('b', ['b.ts'])] }
  });
  f.respond(async (prompt, options) => {
    if (options.phase === 'reviewer') {
      expect(input(prompt).changedFiles).toContain('user.md');
      return review(input(prompt));
    }
    f.mutate(options.cwd!, options.label.includes('-a') ? 'a.ts' : 'b.ts');
    return implementation;
  });
  expect((await f.run()).outcome).toBe('needs-input');
  const before = f.state.candidateRevision;
  f.mutate('/workspace', 'user.md', 'written while the operation waited');
  applySdlcAnswers(f.state, [{ questionId: 'direction', briefRevision: 1, answer: 'up' }], 1);
  applySdlcContinuation(f.state, {}, 2);
  expect((await f.run()).outcome).toBe('accepted');
  expect(f.state.candidateRevision).not.toBe(before);
  expect(f.state.decisions.filter((item) => item.kind === 'adopt-target')).toHaveLength(1);
  expect(f.state.adoptedContinuation).toBe(1);

  const active = fixture();
  let identity: string | undefined;
  active.respond(async (_prompt, options) => {
    identity = options.inputRevision;
    active.mutate(options.cwd!);
    active.abort.abort();
    throw new Error('closed');
  });
  await expect(active.run()).rejects.toThrow('closed');
  applySdlcContinuation(active.state, {}, 1);
  active.services.signal = new AbortController().signal;
  active.respond(async (prompt, options) =>
    options.phase === 'reviewer' ? review(input(prompt)) : implementation
  );
  await active.run();
  expect(active.state.decisions.some((item) => item.kind === 'adopt-target')).toBe(false);
  expect(active.state.tasks[0].inputRevision).toBe(identity);
});
