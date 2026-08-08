import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  getBranchLeafId,
  readLatestGoalState,
  restoreGoalFromBranch,
  STATE_ENTRY
} from '../src/persistence.js';
import { claimGoalDone, createGoal } from '../src/state.js';
import { ids, MutableClock } from './helpers.js';

describe('goal persistence helpers', () => {
  test('restores latest state from current branch only', () => {
    const clock = new MutableClock();
    const older = createGoal({ objective: 'old', branchAnchorId: 'a', ids: ids('old'), clock });
    const newer = createGoal({ objective: 'new', branchAnchorId: 'b', ids: ids('new'), clock });

    const branch = [
      { type: 'custom', customType: STATE_ENTRY, data: { state: older }, id: '1' },
      { type: 'custom', customType: 'other', data: { state: newer }, id: '2' },
      { type: 'custom', customType: STATE_ENTRY, data: { state: newer }, id: '3' }
    ];

    assert.equal(readLatestGoalState(branch)?.id, 'new');
  });

  test('ignores sibling branch entries because caller supplies only branch path', () => {
    const clock = new MutableClock();
    const branchGoal = createGoal({
      objective: 'branch',
      branchAnchorId: 'a',
      ids: ids('branch'),
      clock
    });
    const siblingGoal = createGoal({
      objective: 'sibling',
      branchAnchorId: 'x',
      ids: ids('sibling'),
      clock
    });

    const branch = [
      { type: 'custom', customType: STATE_ENTRY, data: { state: branchGoal }, id: 'a' }
    ];
    const allEntries = [
      ...branch,
      { type: 'custom', customType: STATE_ENTRY, data: { state: siblingGoal }, id: 'x' }
    ];

    assert.equal(readLatestGoalState(branch)?.id, 'branch');
    assert.equal(readLatestGoalState(allEntries)?.id, 'sibling');
  });

  test('restored active and verifying goals pause without counting offline time', () => {
    const clock = new MutableClock();
    const goal = createGoal({ objective: 'verify', branchAnchorId: 'a', ids: ids('goal'), clock });
    const { state: verifying } = claimGoalDone(goal, clock, ids('claim', 'attempt'), {
      summary: 'done',
      evidence: 'proof'
    });
    clock.advance(10_000_000);

    const restored = restoreGoalFromBranch(
      [{ type: 'custom', customType: STATE_ENTRY, data: { state: verifying }, id: 'a' }],
      clock,
      'reload'
    );

    assert.equal(restored.shouldPersistPause, true);
    assert.equal(restored.state?.status, 'paused');
    assert.equal(restored.state?.elapsedActiveMs, 0);
    assert.equal(restored.state?.pendingClaim, undefined);
  });

  test('leaf helper returns latest branch id', () => {
    assert.equal(getBranchLeafId([{ id: 'a' }, { id: 'b' }]), 'b');
    assert.equal(getBranchLeafId([]), null);
  });
});
