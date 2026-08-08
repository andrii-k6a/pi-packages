import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  applyVerificationError,
  applyVerifierReport,
  blockGoal,
  branchContainsLeaf,
  claimGoalDone,
  clearGoal,
  createGoal,
  extractDoneCriteria,
  getBudgetExhaustion,
  limitBudget,
  pauseGoal,
  pauseRestoredGoal,
  resumeGoal,
  summarizeStatusBehavior
} from '../src/state.js';
import { ids, MutableClock } from './helpers.js';

function newGoal() {
  const clock = new MutableClock();
  const state = createGoal({
    objective: 'Fix tests\n\nDone when:\n- npm test passes',
    branchAnchorId: 'leaf-1',
    ids: ids('goal-1'),
    clock
  });
  return { state, clock };
}

describe('goal state reducer helpers', () => {
  test('creates active goal with done criteria and default budgets', () => {
    const { state } = newGoal();

    assert.equal(state.id, 'goal-1');
    assert.equal(state.status, 'active');
    assert.equal(state.generation, 0);
    assert.equal(state.tokenBudget, 10_000_000);
    assert.equal(state.timeBudgetMs, 3_600_000);
    assert.deepEqual(state.doneCriteria, ['npm test passes']);
  });

  test('accepts token budget override for new goals', () => {
    const clock = new MutableClock();
    const state = createGoal({
      objective: 'Fix tests',
      branchAnchorId: 'leaf-1',
      ids: ids('goal-1'),
      clock,
      tokenBudget: 50_000
    });

    assert.equal(state.tokenBudget, 50_000);
  });

  test('extracts markdown checklist criteria before Done when fallback', () => {
    assert.deepEqual(extractDoneCriteria('- [ ] build passes\n- [x] docs updated'), [
      'build passes',
      'docs updated'
    ]);
  });

  test('pause accumulates active time and invalidates generation', () => {
    const { state, clock } = newGoal();
    clock.advance(5_000);

    const paused = pauseGoal(state, clock, 'user');

    assert.equal(paused.status, 'paused');
    assert.equal(paused.generation, 1);
    assert.equal(paused.elapsedActiveMs, 5_000);
    assert.equal(paused.activeStartedAt, undefined);
  });

  test('resume keeps id and budgets but increments generation', () => {
    const { state, clock } = newGoal();
    const paused = pauseGoal(state, clock, 'user');
    clock.advance(1_000);

    const resumed = resumeGoal(paused, clock);

    assert.equal(resumed.id, state.id);
    assert.equal(resumed.status, 'active');
    assert.equal(resumed.generation, 2);
    assert.equal(resumed.elapsedActiveMs, paused.elapsedActiveMs);
    assert.equal(resumed.activeStartedAt, clock.nowIso());
  });

  test('budget-limited goals cannot resume', () => {
    const { state, clock } = newGoal();
    const limited = limitBudget(state, clock, 'tokens');

    assert.throws(() => resumeGoal(limited, clock), /Budget-limited/);
  });

  test('claim transitions active to verifying and cannot complete directly', () => {
    const { state, clock } = newGoal();
    const result = claimGoalDone(state, clock, ids('claim-1', 'attempt-1'), {
      summary: 'All tests pass',
      evidence: 'Ran npm test',
      changed_files: ['src/a.ts'],
      checks: [{ command: 'npm test', exit_code: 0, output_excerpt: 'passed' }]
    });

    assert.equal(result.state.status, 'verifying');
    assert.equal(result.state.pendingClaim?.claim_id, 'claim-1');
    assert.equal(result.claim.verifier_attempt_id, 'attempt-1');
    assert.notEqual(result.state.status as string, 'complete');
  });

  test('claim requires evidence and active state', () => {
    const { state, clock } = newGoal();
    assert.throws(
      () =>
        claimGoalDone(state, clock, ids('claim-1', 'attempt-1'), {
          summary: 'done',
          evidence: '   '
        }),
      /evidence/
    );
    assert.throws(
      () =>
        claimGoalDone(pauseGoal(state, clock, 'user'), clock, ids('claim-2', 'attempt-2'), {
          summary: 'done',
          evidence: 'proof'
        }),
      /active goal/
    );
  });

  test('blocker transitions active to blocked', () => {
    const { state, clock } = newGoal();
    clock.advance(2000);

    const blocked = blockGoal(state, clock, 'Need credentials', 'Login required');

    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.blockedReason, 'Need credentials');
    assert.equal(blocked.elapsedActiveMs, 2000);
  });

  test('verifier pass completes and fail returns active with new generation', () => {
    const { state, clock } = newGoal();
    const { state: verifying, claim } = claimGoalDone(state, clock, ids('claim-1', 'attempt-1'), {
      summary: 'done',
      evidence: 'proof'
    });

    const pass = applyVerifierReport(verifying, clock, {
      goal_id: state.id,
      generation: state.generation,
      claim_id: claim.claim_id,
      verifier_attempt_id: claim.verifier_attempt_id,
      verdict: 'pass',
      rationale: 'evidence supports completion',
      evidence_reviewed: ['proof'],
      createdAt: clock.nowIso()
    });
    assert.equal(pass.status, 'complete');
    assert.equal(pass.pendingClaim, undefined);

    const fail = applyVerifierReport(verifying, clock, {
      goal_id: state.id,
      generation: state.generation,
      claim_id: claim.claim_id,
      verifier_attempt_id: claim.verifier_attempt_id,
      verdict: 'fail',
      rationale: 'missing test output',
      evidence_reviewed: ['proof'],
      missing_evidence: ['test output'],
      next_action: 'run tests',
      createdAt: clock.nowIso()
    });
    assert.equal(fail.status, 'active');
    assert.equal(fail.generation, verifying.generation + 1);
    assert.equal(fail.lastVerification?.verdict, 'fail');
  });

  test('uncertain and verifier error block safely', () => {
    const { state, clock } = newGoal();
    const { state: verifying, claim } = claimGoalDone(state, clock, ids('claim-1', 'attempt-1'), {
      summary: 'done',
      evidence: 'proof'
    });

    const uncertain = applyVerifierReport(verifying, clock, {
      goal_id: state.id,
      generation: state.generation,
      claim_id: claim.claim_id,
      verifier_attempt_id: claim.verifier_attempt_id,
      verdict: 'uncertain',
      rationale: 'needs human confirmation',
      evidence_reviewed: ['proof'],
      next_action: 'ask user',
      createdAt: clock.nowIso()
    });
    assert.equal(uncertain.status, 'blocked');

    const error = applyVerificationError(verifying, clock);
    assert.equal(error.status, 'blocked');
    assert.equal(error.blockedReason, 'verification_error');
  });

  test('stale verifier report is rejected', () => {
    const { state, clock } = newGoal();
    const { state: verifying, claim } = claimGoalDone(state, clock, ids('claim-1', 'attempt-1'), {
      summary: 'done',
      evidence: 'proof'
    });

    assert.throws(
      () =>
        applyVerifierReport(verifying, clock, {
          goal_id: state.id,
          generation: 999,
          claim_id: claim.claim_id,
          verifier_attempt_id: claim.verifier_attempt_id,
          verdict: 'pass',
          rationale: 'ok',
          evidence_reviewed: ['proof'],
          createdAt: clock.nowIso()
        }),
      /stale/
    );
  });

  test('budget and branch helpers are deterministic', () => {
    const { state, clock } = newGoal();
    assert.equal(getBudgetExhaustion({ ...state, tokensUsed: state.tokenBudget }, clock), 'tokens');
    clock.advance(state.timeBudgetMs);
    assert.equal(getBudgetExhaustion(state, clock), 'time');
    assert.equal(branchContainsLeaf([{ id: 'a' }, { id: 'b' }], 'b'), true);
    assert.equal(branchContainsLeaf([{ id: 'a' }, { id: 'b' }], 'c'), false);
  });

  test('restore pause does not count offline time and clears pending claim', () => {
    const { state, clock } = newGoal();
    const { state: verifying } = claimGoalDone(state, clock, ids('claim-1', 'attempt-1'), {
      summary: 'done',
      evidence: 'proof'
    });
    clock.advance(86_400_000);

    const paused = pauseRestoredGoal(verifying, clock, 'reload');

    assert.equal(paused.status, 'paused');
    assert.equal(paused.elapsedActiveMs, 0);
    assert.equal(paused.pendingClaim, undefined);
  });

  test('status behavior table essentials', () => {
    assert.deepEqual(summarizeStatusBehavior('active'), {
      autoContinue: true,
      verifierMayRun: false,
      resumable: false,
      clearIsNoop: false,
      replaceNeedsConfirmation: true
    });
    assert.equal(summarizeStatusBehavior('verifying').verifierMayRun, true);
    assert.equal(summarizeStatusBehavior('budget_limited').resumable, false);
    assert.equal(summarizeStatusBehavior('complete').replaceNeedsConfirmation, false);
    assert.equal(clearGoal(newGoal().state, new MutableClock()).status, 'cleared');
  });
});
