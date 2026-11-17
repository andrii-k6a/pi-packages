import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createWorkflowRoleServices } from '../../src/durable/roles.js';
import {
  applySdlcAnswers,
  applySdlcContinuation,
  initialSdlcState,
  runSdlcController,
  type SdlcControllerServices,
  sdlcIdentity
} from '../../src/durable/sdlc.js';
import type { SdlcCheckResult } from '../../src/durable/sdlc-state.js';
import { emptyUsage } from '../../src/shared/usage.js';
import type { WorkflowAgentRunOptions } from '../../src/workflow/contracts.js';
import type { SdlcArgs, SdlcReview, SdlcTaskContract } from '../../src/workflow/sdlc/contracts.js';

const completed = { summary: 'Assigned work complete', artifacts: [], limitations: [] };
const args: SdlcArgs = {
  goal: 'Deliver both documented outcomes',
  acceptance: [
    { description: 'Documentation accurately describes source', verification: 'inspection' }
  ]
};
const task = (id: string, writes = ['*'], dependsOn: string[] = []): SdlcTaskContract => ({
  id,
  writes,
  dependsOn,
  title: id,
  outcome: id,
  inputs: [],
  checks: [],
  questionIds: []
});
const data = (prompt: string) => JSON.parse(prompt.split('Task input (data):\n')[1]);
function reviewed(input: ReturnType<typeof data>, status: 'met' | 'not-met' = 'met'): SdlcReview {
  return {
    goalRevision: input.brief.goalRevision,
    candidateRevision: input.candidateRevision,
    codeReview: { verdict: 'pass', findings: [], limitations: [] },
    outcomes: input.brief.acceptance.map((outcome: { id: string }) => ({
      id: outcome.id,
      status,
      evidenceIds: (input.checks ?? [])
        .filter((item: { result: SdlcCheckResult }) => item.result.status === 'passed')
        .map((item: { id: string }) => item.id),
      observations: [
        { file: 'api.ts', line: 1, observation: 'Checked the requested source behavior' }
      ],
      reason:
        status === 'met' ? 'Supported by current evidence' : 'The requested behavior is missing'
    })),
    findingDispositions: [],
    coverageGaps: []
  };
}
function harness(input: SdlcArgs = args) {
  const files: Record<string, string> = { 'api.ts': 'initial' };
  const workspace = {
    operationId: 'review',
    owner: 'review',
    sourceCwd: '/project',
    cwd: '/project',
    storageDir: '/storage',
    sourceRevision: sdlcIdentity(files),
    mode: 'existing' as const
  };
  let state = initialSdlcState('review', input, workspace);
  const calls: WorkflowAgentRunOptions[] = [];
  let respond = async (prompt: string, options: WorkflowAgentRunOptions): Promise<unknown> =>
    options.phase === 'reviewer' ? reviewed(data(prompt)) : completed;
  const services: SdlcControllerServices = {
    state,
    save: async (next) => {
      state = structuredClone(next);
    },
    agent: {
      run: async (prompt, options) => {
        calls.push(options);
        return respond(prompt, options);
      }
    },
    resolveRole: createWorkflowRoleServices({
      projectRoot: '/project',
      agentDir: '/nonexistent-sdlc-review-fixture',
      extensions: () => []
    }).resolve,
    usage: async () => ({ ...emptyUsage(), totalTokens: calls.length * 100 }),
    now: () => 1,
    signal: new AbortController().signal,
    phase: () => {},
    acquire: () => () => {},
    ensure: async () => {},
    inspect: async () => ({
      revision: sdlcIdentity(files),
      changedFiles: Object.keys(files).filter(
        (path) => path !== 'api.ts' || files[path] !== 'initial'
      )
    }),
    observe: async () => ({ ...files }),
    fork: async () => {
      throw new Error('Unexpected fork');
    },
    integrate: async () => {
      throw new Error('Unexpected integration');
    },
    check: async (id, selected, evidenceId, candidateRevision) => ({
      id: evidenceId,
      command: state.args.checks!.find((check) => check.id === id)!,
      cwd: selected.cwd,
      environment: 'injected',
      candidateRevision,
      startedAt: 1,
      endedAt: 2,
      status: files['api.ts'] === 'broken' ? 'failed' : 'passed',
      exitCode: files['api.ts'] === 'broken' ? 1 : 0,
      testCount: 1,
      output: files['api.ts'] === 'broken' ? 'Behavioral assertion failed' : '1 passing',
      truncated: false
    })
  };
  return {
    get state() {
      return state;
    },
    files,
    calls,
    services,
    respond(next: typeof respond) {
      respond = next;
    },
    async run() {
      services.state = state;
      return runSdlcController(services);
    }
  };
}

test.each(['analyst', 'implementer'] as const)(
  'invalid %s plans fail recoverably instead of wedging completed decisions',
  async (stage) => {
    const h = harness({
      ...args,
      ...(stage === 'analyst' ? { planning: 'investigate' as const } : {})
    });
    let invalid = true;
    h.respond(async (prompt, options) => {
      if (options.phase === 'reviewer') return reviewed(data(prompt));
      const plan = { reason: 'Overlapping writers are invalid', tasks: [task('a'), task('b')] };
      if (options.phase === 'analyst')
        return {
          ...plan,
          tasks: invalid ? plan.tasks : [task('valid')],
          assumptions: [],
          requirements: [],
          questions: [],
          artifacts: []
        };
      return stage === 'implementer' && invalid ? { ...completed, plan } : completed;
    });
    assert.notEqual((await h.run()).outcome, 'accepted');
    assert.equal(h.state.tasks[0].status, 'failed');
    invalid = false;
    applySdlcContinuation(h.state, {}, 2);
    assert.equal((await h.run()).outcome, 'accepted');
  }
);

test.each([false, true])(
  'failing host checks schedule correction even with verbose output (%s)',
  async (verbose) => {
    const h = harness({
      goal: verbose
        ? 'Deliver the observed behavior'.padEnd(30_000, '.')
        : 'Deliver the observed behavior',
      checks: [{ id: 'behavior', argv: ['node', '--test'], kind: 'test', outcomes: ['goal'] }]
    });
    const check = h.services.check;
    const log = 'Assertion failed\n'.repeat(3000).slice(0, 50_000);
    h.services.check = async (...params) => {
      const result = await check(...params);
      return verbose && result.status === 'failed' ? { ...result, output: log } : result;
    };
    const cache = new Map<string, unknown>();
    h.services.artifact = async (item) => {
      cache.set(item.id, item.result);
      return `/evidence/${item.id}.json`;
    };
    let implementations = 0;
    h.respond(async (prompt, options) => {
      if (options.phase === 'reviewer') {
        assert.equal(
          h.files['api.ts'],
          'fixed',
          'Do not ask a reviewer to compensate for a known failing check'
        );
        return reviewed(data(prompt));
      }
      if (implementations && verbose) {
        const input = data(prompt);
        assert.ok(input.assignment.outcome.length <= 30_000);
        assert.equal(input.assignment.outcome, h.state.brief.goal);
        assert.ok(!prompt.includes(log));
        const failure = input.relevantEvidence.find((item: { id: string }) =>
          input.assignment.inputs.includes(item.id)
        );
        assert.ok(failure?.path, 'correction must have a retrievable failure record');
        assert.equal((cache.get(failure.id) as SdlcCheckResult).output, log);
      }
      h.files['api.ts'] = ++implementations === 1 ? 'broken' : 'fixed';
      return completed;
    });
    assert.equal((await h.run()).outcome, 'accepted');
    assert.equal(implementations, 2);
  }
);

test('a question-only handoff preserves its declared scope and dependency inputs', async () => {
  const delegated = {
    ...task('b', ['b.ts'], ['a']),
    inputs: ['interface-evidence'],
    outcome: 'Document the interface response',
    checks: ['scope-check']
  };
  const h = harness({
    ...args,
    checks: [{ id: 'scope-check', argv: ['node', 'verify.js'], kind: 'check', outcomes: ['goal'] }],
    plan: {
      reason: 'Coupled interface followed by a scoped writer',
      tasks: [task('a', ['a.ts']), delegated]
    }
  });
  h.respond(async (_prompt, options) =>
    options.label === 'p1-b'
      ? { ...completed, questions: [{ id: 'naming', text: 'Which name?', affectedTasks: [] }] }
      : completed
  );
  assert.equal((await h.run()).outcome, 'needs-input');
  const replacement = h.state.tasks.find((item) => item.status === 'pending');
  assert.ok(replacement);
  assert.deepEqual(replacement.writes, ['b.ts']);
  assert.deepEqual(replacement.inputs, ['interface-evidence']);
  assert.deepEqual(replacement.checks, delegated.checks);
  assert.equal(replacement.outcome, delegated.outcome);
  assert.ok(replacement.dependsOn.includes('p1-a'));
  applySdlcAnswers(
    h.state,
    [{ questionId: 'naming', briefRevision: h.state.brief.revision, answer: 'canonical' }],
    2
  );
  applySdlcContinuation(h.state, {}, 3);
  h.respond(async (prompt, options) =>
    options.phase === 'reviewer' ? reviewed(data(prompt)) : completed
  );
  assert.equal((await h.run()).outcome, 'accepted');
});

test('a goal revision rejects missing check references before more work is admitted', () => {
  const h = harness();
  const before = structuredClone(h.state);
  assert.throws(
    () =>
      applySdlcContinuation(
        h.state,
        {
          goalRevision: 1,
          goal: 'Revised goal',
          acceptance: [
            { description: 'Observe the required behavior', checkIds: ['missing-check'] }
          ]
        },
        2
      ),
    /Unknown required SDLC check/
  );
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.state, before);
});

test('continued allowance permits the first correction after a fresh review of the unchanged candidate', async () => {
  const h = harness({ ...args, policy: { limits: { correctionRounds: 0 } } });
  let reviews = 0;
  h.respond(async (prompt, options) => {
    if (options.phase === 'reviewer')
      return reviewed(data(prompt), ++reviews < 3 ? 'not-met' : 'met');
    if (reviews) h.files['api.ts'] = 'fixed';
    return completed;
  });
  assert.equal((await h.run()).outcome, 'incomplete');
  applySdlcContinuation(
    h.state,
    {
      limits: { correctionRounds: 1 },
      checks: [
        { id: 'new-evidence', argv: ['node', 'verify.js'], kind: 'check', outcomes: ['goal'] }
      ]
    },
    2
  );
  assert.equal((await h.run()).outcome, 'accepted');
  assert.equal(h.state.consumed.corrections, 1);
});

const defect = (summary = 'The final page is dropped') => ({
  id: 'F1',
  file: 'api.ts',
  line: 1,
  summary,
  evidence: 'The loop exits before reading the last cursor',
  priority: 2,
  scenario: 'A client reads three pages and loses the third',
  alternative: 'Read until no cursor remains',
  references: [{ file: 'api.ts', line: 1, observation: 'The loop exits early' }],
  verdict: 'CONFIRMED' as const,
  reason: 'The cursor is checked before the page is consumed',
  counterevidence: '',
  limitations: []
});

test('large review evidence still schedules a bounded, retrievable correction', async () => {
  const h = harness({
    ...args,
    acceptance: Array.from({ length: 8 }, (_, index) => ({
      description: `Document outcome ${index}`,
      verification: 'inspection' as const
    }))
  });
  const cache = new Map<string, unknown>();
  h.services.artifact = async (item) => {
    cache.set(item.id, item.result);
    return `/evidence/${item.id}.json`;
  };
  let implementations = 0;
  const reason = 'Missing required documentation. '.repeat(120);
  h.respond(async (prompt, options) => {
    const input = data(prompt);
    if (options.phase === 'reviewer') {
      const result = reviewed(input, implementations === 1 ? 'not-met' : 'met');
      if (implementations === 1) for (const outcome of result.outcomes) outcome.reason = reason;
      return result;
    }
    if (++implementations > 1) {
      assert.ok(input.assignment.outcome.length < 30_000);
      assert.ok(!prompt.includes(reason));
      const review = input.relevantEvidence.find((item: { id: string }) =>
        input.assignment.inputs.includes(item.id)
      );
      assert.ok(review?.path, 'correction must reference the saved assessment');
      assert.equal((cache.get(review.id) as SdlcReview).outcomes[0].reason, reason);
    }
    h.files['api.ts'] = `documentation-${implementations}`;
    return completed;
  });
  const result = await h.run();
  assert.equal(result.outcome, 'accepted', result.unresolvedWork.join('; '));
  assert.equal(implementations, 2);
});

test.each([
  { changed: false, supported: true, allowance: 0, file: 'api.ts' },
  { changed: false, supported: true, allowance: 1, file: 'api.ts' },
  { changed: true, supported: true, allowance: 0, file: 'api.ts' },
  { changed: true, supported: true, allowance: 0, file: 'nested/../api.ts' },
  { changed: false, supported: false, allowance: 0, file: 'api.ts' }
])(
  'unrelated operation finding deferral respects source changes and support: %j',
  async ({ changed, supported, allowance, file }) => {
    const h = harness({ ...args, policy: { limits: { correctionRounds: allowance } } });
    h.respond(async (prompt, options) => {
      if (options.phase !== 'reviewer') {
        h.files['docs.md'] = 'Requested documentation';
        if (changed) h.files['api.ts'] = 'newly broken code';
        return completed;
      }
      const result = reviewed(data(prompt));
      result.codeReview.findings = [
        {
          ...defect(),
          file,
          references: [{ file, line: 1, observation: 'The old loop exits early' }]
        }
      ];
      result.findingDispositions = [
        {
          id: 'F1',
          disposition: 'deferred',
          reason: 'Pre-existing pagination bug outside this documentation goal',
          ...(supported
            ? {
                observations: [
                  {
                    file,
                    line: 1,
                    observation:
                      'The old loop is unchanged and unrelated to the requested documentation'
                  }
                ]
              }
            : {})
        }
      ];
      return result;
    });
    const result = await h.run();
    assert.equal(
      result.outcome,
      !changed && supported ? 'accepted' : 'incomplete',
      result.unresolvedWork.join('; ')
    );
    assert.equal(h.state.consumed.corrections, 0);
    if (result.outcome === 'accepted')
      assert.match(JSON.stringify(result.findingDispositions), /review-1-c0:F1.*deferred/);
  }
);

test('a correction review can defer a retained unrelated claim without changing the affected code', async () => {
  const h = harness({ ...args, policy: { limits: { correctionRounds: 1 } } });
  let implementations = 0;
  h.respond(async (prompt, options) => {
    if (options.phase !== 'reviewer') {
      h.files['docs.md'] = `documentation-${++implementations}`;
      return completed;
    }
    const input = data(prompt);
    const result = reviewed(input, implementations === 1 ? 'not-met' : 'met');
    if (implementations === 1) result.codeReview.findings = [defect()];
    else
      result.findingDispositions = [
        {
          id: input.pendingFindings[0].id,
          disposition: 'deferred',
          reason: 'The old loop is outside the documentation goal',
          observations: [
            {
              file: 'api.ts',
              line: 1,
              observation: 'The loop is unchanged and unrelated to the requested documentation'
            }
          ]
        }
      ];
    return result;
  });
  const result = await h.run();
  assert.equal(result.outcome, 'accepted', result.unresolvedWork.join('; '));
  assert.equal(implementations, 2);
  assert.equal(h.files['api.ts'], 'initial');
  assert.equal(h.state.consumed.corrections, 1);
  assert.equal(result.findingDispositions[0].id, 'review-1-c0:F1');
});

test.each([false, true])(
  'prior findings cannot disappear after correction (changed=%s)',
  async (changed) => {
    const h = harness();
    let reviews = 0;
    let pending: unknown;
    h.respond(async (prompt, options) => {
      if (options.phase !== 'reviewer') {
        if (reviews && changed) h.files['api.ts'] = 'another candidate';
        return completed;
      }
      const input = data(prompt);
      if (++reviews > 1) pending = input.pendingFindings;
      const next = reviewed(input);
      return reviews === 1
        ? {
            ...next,
            codeReview: { verdict: 'changes-requested', findings: [defect()], limitations: [] }
          }
        : next;
    });
    const result = await h.run();
    assert.notEqual(result.outcome, 'accepted', 'omitting a finding is not independent closure');
    assert.match(JSON.stringify(pending), /The final page is dropped/);
    assert.match(result.unresolvedWork.join(' '), /F1/);
  }
);

test.each([false, true])(
  'invalidated closures reopen findings after a later correction (supported=%s)',
  async (supported) => {
    const h = harness({ ...args, policy: { limits: { correctionRounds: 2 } } });
    let reviews = 0;
    let firstId = '';
    let secondId = '';
    let finalPending: string[] = [];
    const close = (id: string) => ({
      id,
      disposition: 'resolved' as const,
      reason: 'Checked the corrected source',
      observations: [{ file: 'api.ts', line: 1, observation: 'The cursor is consumed' }]
    });
    h.respond(async (prompt, options) => {
      if (options.phase !== 'reviewer') {
        h.files['api.ts'] = `candidate-${reviews}`;
        return completed;
      }
      const input = data(prompt);
      const next = reviewed(input);
      if (++reviews === 1)
        return {
          ...next,
          codeReview: { verdict: 'changes-requested', findings: [defect()], limitations: [] }
        };
      firstId ||= input.pendingFindings[0].id;
      if (reviews === 2)
        return {
          ...next,
          codeReview: {
            verdict: 'changes-requested',
            findings: [{ ...defect('A distinct defect requires another correction'), id: 'F2' }],
            limitations: []
          },
          findingDispositions: [close(firstId)]
        };
      finalPending = input.pendingFindings.map((finding: { id: string }) => finding.id);
      secondId = input.pendingFindings.find((finding: { id: string }) =>
        finding.id.endsWith(':F2')
      ).id;
      return {
        ...next,
        findingDispositions: [close(secondId), ...(supported ? [close(firstId)] : [])]
      };
    });
    const result = await h.run();
    assert.equal(result.outcome, supported ? 'accepted' : 'incomplete');
    assert.ok(finalPending.includes(firstId), 'the invalidated closure must not hide F1');
    assert.ok(finalPending.includes(secondId));
    assert.equal(h.state.consumed.corrections, 2);
    if (!supported) assert.match(result.unresolvedWork.join(' '), /F1/);
  }
);

test.each(['resolved', 'refuted'] as const)(
  'imported %s findings need current source observations',
  async (disposition) => {
    const h = harness();
    h.state.importedFindings = [{ ...defect(), id: 'source:attempt-1:F1' }];
    let supported = false;
    h.respond(async (prompt, options) =>
      options.phase !== 'reviewer'
        ? completed
        : {
            ...reviewed(data(prompt)),
            findingDispositions: [
              {
                id: 'source:attempt-1:F1',
                disposition,
                reason: 'The cursor loop was checked',
                ...(supported
                  ? {
                      observations: [
                        { file: 'api.ts', line: 1, observation: 'The final cursor is consumed' }
                      ]
                    }
                  : {})
              }
            ]
          }
    );
    const first = await h.run();
    assert.equal(first.outcome, 'incomplete');
    assert.match(first.unresolvedWork.join(' '), /source:attempt-1:F1/);
    supported = true;
    applySdlcContinuation(h.state, {}, 2);
    assert.equal((await h.run()).outcome, 'accepted');
    assert.equal(h.state.consumed.corrections, 0, 'missing evidence must not trigger edits');
  }
);

test('reviewer-local IDs are distinct before synthesis can close a claim', async () => {
  const h = harness({ ...args, policy: { limits: { correctionRounds: 0 } } });
  let ids: string[] = [];
  h.respond(async (prompt, options) => {
    if (options.phase !== 'reviewer') return completed;
    const input = data(prompt);
    const next = reviewed(input);
    if (input.reviewContext?.purpose === 'synthesis') {
      ids = input.sourceReviews.flatMap((source: { result: SdlcReview }) =>
        source.result.codeReview.findings.map((finding) => finding.id)
      );
      return {
        ...next,
        findingDispositions: [
          {
            id: ids[0],
            disposition: 'refuted',
            reason: 'The primary trigger cannot occur',
            observations: [
              { file: 'api.ts', line: 1, observation: 'The primary path checks its cursor' }
            ]
          }
        ]
      };
    }
    return {
      ...next,
      codeReview: {
        verdict: 'changes-requested',
        findings: [defect(input.reviewContext ? 'Unrelated specialist defect' : 'Primary defect')],
        limitations: []
      },
      ...(input.reviewContext
        ? {}
        : { reviewRequests: [{ scope: 'Other API', reason: 'Independent contract' }] })
    };
  });
  const result = await h.run();
  assert.equal(new Set(ids).size, 2, 'independent F1 claims require distinct producing identities');
  assert.notEqual(result.outcome, 'accepted');
  assert.match(result.unresolvedWork.join(' '), /Unrelated specialist defect/);
});

test('duplicate finding IDs are rejected within a review response', async () => {
  const h = harness();
  h.respond(async (prompt, options) =>
    options.phase !== 'reviewer'
      ? completed
      : {
          ...reviewed(data(prompt)),
          codeReview: {
            verdict: 'changes-requested',
            findings: [defect(), defect('Another defect')],
            limitations: []
          }
        }
  );
  const result = await h.run();
  assert.match(result.unresolvedWork.join(' '), /Duplicate SDLC finding/);
  assert.equal(h.state.consumed.corrections, 0);
});

test('large check logs stay retrievable without overflowing or undercounting review context', async () => {
  const h = harness({
    ...args,
    checks: Array.from({ length: 6 }, (_, i) => ({
      id: `check-${i}`,
      argv: ['node', '--test'],
      kind: 'test' as const,
      outcomes: ['goal']
    }))
  });
  const log = 'large-check-output-'.repeat(2800).slice(0, 50_000);
  const check = h.services.check;
  h.services.check = async (...params) => ({ ...(await check(...params)), output: log });
  const cache = new Map<string, unknown>();
  h.services.artifact = async (item) => {
    cache.set(item.id, item.result);
    return `/evidence/${item.id}.json`;
  };
  let reviewerPrompt = '';
  let reviewerInput: ReturnType<typeof data>;
  h.respond(async (prompt, options) => {
    if (options.phase !== 'reviewer') return completed;
    reviewerPrompt = prompt;
    reviewerInput = data(prompt);
    return reviewed(reviewerInput);
  });
  assert.equal((await h.run()).outcome, 'accepted');
  assert.ok(
    reviewerPrompt.length / 4 + 12_000 < 64_000,
    'review must fit the configured half-window target'
  );
  assert.ok(
    reviewerInput.contextAllocation.estimatedInputTokens >=
      Math.ceil(reviewerPrompt.length / 4) + 12_000,
    'estimate includes the complete assembled prompt and reserved headroom'
  );
  assert.ok(!reviewerPrompt.includes(log));
  for (const item of reviewerInput.checks) {
    assert.ok(item.path, 'check evidence has a selective retrieval path');
    assert.equal((cache.get(item.id) as SdlcCheckResult).output, log);
  }
});

test.each([false, true])(
  'continuation closes a retained claim only with current source support (%s)',
  async (supported) => {
    const h = harness({ ...args, policy: { limits: { correctionRounds: 0 } } });
    let reviews = 0;
    let claimId = '';
    h.respond(async (prompt, options) => {
      if (options.phase !== 'reviewer') {
        if (reviews) h.files['api.ts'] = 'corrected cursor';
        return completed;
      }
      const input = data(prompt);
      const next = reviewed(input);
      if (++reviews === 1)
        return {
          ...next,
          codeReview: { verdict: 'changes-requested', findings: [defect()], limitations: [] }
        };
      claimId = input.pendingFindings[0].id;
      return {
        ...next,
        findingDispositions: [
          {
            id: claimId,
            disposition: 'resolved',
            reason: 'The loop now consumes the final cursor',
            ...(supported
              ? {
                  observations: [
                    {
                      file: 'api.ts',
                      line: 1,
                      observation: 'The loop consumes each page before checking termination'
                    }
                  ]
                }
              : {})
          }
        ]
      };
    });
    assert.equal((await h.run()).outcome, 'incomplete');
    applySdlcContinuation(h.state, { limits: { correctionRounds: 1 } }, 2);
    const result = await h.run();
    assert.equal(result.outcome, supported ? 'accepted' : 'incomplete');
    assert.match(claimId, /^review-1-c0:F1$/);
    assert.equal(h.state.continuation, 1);
    assert.ok(
      h.state.tasks.some((task) => task.status === 'invalidated' && task.kind === 'review')
    );
    if (supported) assert.equal(result.findingDispositions[0].id, claimId);
  }
);

test('oversized non-brief inputs stop before generation instead of underreporting context', async () => {
  const h = harness({
    ...args,
    constraints: ['a'.repeat(30_000), 'b'.repeat(30_000), 'c'.repeat(30_000)],
    policy: { contextWindowTokens: 32_000 }
  });
  const result = await h.run();
  assert.equal(result.outcome, 'incomplete');
  assert.match(result.unresolvedWork.join(' '), /Assembled SDLC input exceeds/);
  assert.equal(h.calls.length, 0);
});
