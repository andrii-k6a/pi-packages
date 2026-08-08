import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { buildContinuationPrompt } from '../src/prompts.js';
import { claimGoalDone, createGoal } from '../src/state.js';
import { buildVerifierTask, VERIFIER_SYSTEM_PROMPT } from '../src/verifier-prompt.js';
import { ids, MutableClock } from './helpers.js';

describe('goal prompts', () => {
  test('continuation prompt names claim tool as non-final completion path', () => {
    const clock = new MutableClock();
    const state = createGoal({
      objective: 'Ship',
      branchAnchorId: 'leaf',
      ids: ids('goal'),
      clock
    });
    const prompt = buildContinuationPrompt(state, clock);

    assert.match(prompt, /pi_goal_claim_done/);
    assert.match(prompt, /does not finalize/);
    assert.match(prompt, /untrusted user task data/);
    assert.match(prompt, /pi_goal_blocked/);
  });

  test('continuation prompt includes verifier failure feedback', () => {
    const clock = new MutableClock();
    const state = createGoal({
      objective: 'Ship',
      branchAnchorId: 'leaf',
      ids: ids('goal'),
      clock
    });
    const prompt = buildContinuationPrompt(
      {
        ...state,
        lastVerification: {
          goal_id: 'goal',
          generation: 0,
          claim_id: 'claim',
          verifier_attempt_id: 'attempt',
          verdict: 'fail',
          rationale: 'missing tests',
          evidence_reviewed: ['claim'],
          missing_evidence: ['test output'],
          next_action: 'run npm test',
          createdAt: clock.nowIso()
        }
      },
      clock
    );

    assert.match(prompt, /Previous verifier feedback/);
    assert.match(prompt, /missing tests/);
    assert.match(prompt, /run npm test/);
  });

  test('verifier task includes bounded claim context, rubric, ids, and strict JSON instruction', () => {
    const clock = new MutableClock();
    const state = createGoal({
      objective: 'Ship',
      branchAnchorId: 'leaf',
      ids: ids('goal'),
      clock
    });
    const { claim } = claimGoalDone(state, clock, ids('claim', 'attempt'), {
      summary: 'done',
      evidence: 'proof',
      changed_files: ['src/a.ts']
    });
    const task = buildVerifierTask({
      state: { ...state, pendingClaim: claim },
      claim,
      launchLeafId: 'leaf',
      cwd: '/repo'
    });

    assert.match(task, /goal_id: goal/);
    assert.match(task, /claim_id: claim/);
    assert.match(task, /Changed files claimed/);
    assert.match(task, /Rubric/);
    assert.match(task, /Return exactly one JSON object/);
    assert.doesNotMatch(VERIFIER_SYSTEM_PROMPT, /sandboxed/i);
    assert.match(VERIFIER_SYSTEM_PROMPT, /not proof of global correctness/);
  });
});
