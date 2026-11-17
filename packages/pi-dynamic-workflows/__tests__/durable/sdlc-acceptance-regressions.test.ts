import assert from 'node:assert/strict';
import { test } from 'vitest';
import { assessSdlc, initialSdlcState } from '../../src/durable/sdlc.js';
import type { SdlcCheckResult } from '../../src/durable/sdlc-state.js';
import type { SdlcReview } from '../../src/workflow/sdlc/contracts.js';

function fixture() {
  const command = {
    id: 'behavior',
    argv: ['node', '--test'],
    kind: 'test' as const,
    outcomes: ['goal']
  };
  const state = initialSdlcState(
    'acceptance',
    { goal: 'Deliver the requested behavior', checks: [command] },
    {
      operationId: 'acceptance',
      owner: 'acceptance',
      sourceCwd: '/source',
      cwd: '/source',
      mode: 'existing',
      storageDir: '/storage',
      sourceRevision: 'candidate-1'
    }
  );
  const id = 'integration:assembled:behavior:candidate-1:c0';
  const result: SdlcCheckResult = {
    id,
    command,
    cwd: '/source',
    environment: 'node:local',
    candidateRevision: 'candidate-1',
    startedAt: 1,
    endedAt: 2,
    status: 'passed',
    exitCode: 0,
    testCount: 1,
    output: '# tests 1',
    truncated: false
  };
  state.checks.push({
    id,
    phase: 'integration',
    taskId: 'assembled',
    candidateRevision: 'candidate-1',
    status: 'completed',
    result
  });
  state.evidence.push({
    id,
    kind: 'check',
    producingTask: 'assembled',
    briefRevision: 1,
    goalRevision: 1,
    inputRevision: 'check-input',
    candidateRevision: 'candidate-1',
    scope: ['goal'],
    dependencies: [],
    result: { status: 'passed' },
    limitations: []
  });
  const review: SdlcReview = {
    goalRevision: 1,
    candidateRevision: 'candidate-1',
    codeReview: { verdict: 'pass', findings: [], limitations: [] },
    outcomes: [
      {
        id: 'goal',
        status: 'met',
        evidenceIds: [id],
        observations: [],
        reason: 'Behavior observed'
      }
    ],
    findingDispositions: [],
    coverageGaps: []
  };
  return { state, review, result };
}

test('clean code and passing checks do not accept an independently unmet original goal', () => {
  const { state, review } = fixture();
  assert.equal(assessSdlc(state, review, 'review').accepted, true);
  review.outcomes[0].status = 'not-met';
  review.outcomes[0].reason = 'The task plan omitted the requested behavior';
  const assessment = assessSdlc(state, review, 'review');
  assert.equal(assessment.accepted, false);
  assert.equal(assessment.outcomes[0].status, 'not-met');
});

test.each(['missing', 'empty', 'supported', 'refuted-finding', 'deferred'] as const)(
  'imported finding closure requires current support while preserving %s disposition behavior',
  (closure) => {
    const { state, review } = fixture();
    const finding = {
      id: 'source:attempt-1:F1',
      file: 'api.ts',
      line: 1,
      summary: 'The final page is dropped',
      evidence: 'The loop exits before consuming the cursor',
      priority: 2,
      scenario: 'Clients lose their final page',
      alternative: 'Consume every page',
      references: [{ file: 'api.ts', line: 1, observation: 'The loop exits early' }],
      verdict: 'CONFIRMED' as const,
      reason: 'The final cursor is skipped',
      counterevidence: '',
      limitations: []
    };
    state.importedFindings.push(finding);
    if (closure === 'refuted-finding')
      review.codeReview.findings.push({
        ...finding,
        verdict: 'REFUTED',
        references: [{ file: 'api.ts', line: 1, observation: 'Current source consumes all pages' }]
      });
    else
      review.findingDispositions.push({
        id: finding.id,
        disposition: closure === 'deferred' ? 'deferred' : 'resolved',
        reason: closure === 'deferred' ? 'Unrelated to this goal' : 'The loop was checked',
        ...(closure === 'missing'
          ? {}
          : {
              observations:
                closure === 'supported'
                  ? [{ file: 'api.ts', line: 1, observation: 'Current source consumes all pages' }]
                  : []
            })
      });
    const assessment = assessSdlc(state, review, 'review');
    assert.equal(assessment.accepted, !['missing', 'empty'].includes(closure));
    if (!assessment.accepted)
      assert.ok(assessment.coverageGaps.some((gap) => gap.includes(finding.id)));
  }
);

test('fabricated or invalidated evidence cannot establish acceptance', () => {
  const { state, review } = fixture();
  review.outcomes[0].evidenceIds = ['made-up-check'];
  assert.equal(assessSdlc(state, review, 'review').outcomes[0].status, 'unverified');
  review.outcomes[0].evidenceIds = [state.evidence[0].id];
  state.evidence[0].invalidatedBy = 'changed dependency';
  assert.equal(assessSdlc(state, review, 'review').accepted, false);
});

test.each(['passed', 'failed', 'empty', 'unknown', 'stale', 'invalidated', 'fabricated'] as const)(
  'review check associations still require fresh passing evidence (%s)',
  (status) => {
    const { state, review, result } = fixture();
    result.command.outcomes = [];
    review.outcomes[0].checkIds = ['behavior'];
    if (['failed', 'empty', 'unknown'].includes(status))
      result.status = status as 'failed' | 'empty' | 'unknown';
    if (status === 'stale') state.evidence[0].candidateRevision = 'older';
    if (status === 'invalidated') state.evidence[0].invalidatedBy = 'changed';
    if (status === 'fabricated') review.outcomes[0].evidenceIds = ['made-up-check'];
    assert.equal(assessSdlc(state, review, 'review').accepted, status === 'passed');
  }
);

test('older candidate or goal judgments remain unacceptable even when checks passed', () => {
  const { state, review } = fixture();
  review.candidateRevision = 'older-candidate';
  assert.equal(assessSdlc(state, review, 'review').accepted, false);
  review.candidateRevision = state.candidateRevision;
  review.goalRevision = 0;
  assert.equal(assessSdlc(state, review, 'review').accepted, false);
});

test.each(['failed', 'unavailable', 'empty', 'unknown', 'interrupted'] as const)(
  '%s validation preserves a coverage gap instead of accepting schema-valid completion',
  (status) => {
    const { state, review, result } = fixture();
    result.status = status;
    result.testCount = status === 'empty' ? 0 : undefined;
    const assessment = assessSdlc(state, review, 'review');
    assert.equal(assessment.accepted, false);
    assert.equal(assessment.outcomes[0].status, 'unverified');
    assert.ok(
      assessment.coverageGaps.some((gap) => gap.includes(`Required check behavior: ${status}`))
    );
  }
);
