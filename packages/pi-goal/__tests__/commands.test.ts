import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  canReplaceWithoutConfirmation,
  compactStatus,
  formatGoalStatus,
  parseGoalCommand
} from '../src/commands.js';
import { createGoal, limitBudget, pauseGoal } from '../src/state.js';
import { ids, MutableClock } from './helpers.js';

function goal() {
  const clock = new MutableClock();
  const state = createGoal({
    objective: 'Ship feature',
    branchAnchorId: 'leaf',
    ids: ids('goal-1'),
    clock
  });
  return { state, clock };
}

describe('goal command helpers', () => {
  test('parses exact subcommands only', () => {
    assert.deepEqual(parseGoalCommand(''), { type: 'status' });
    assert.deepEqual(parseGoalCommand('status'), { type: 'status' });
    assert.deepEqual(parseGoalCommand('pause'), { type: 'pause' });
    assert.deepEqual(parseGoalCommand('resume'), { type: 'resume' });
    assert.deepEqual(parseGoalCommand('clear'), { type: 'clear' });
    assert.deepEqual(parseGoalCommand('pause the flaky migration'), {
      type: 'create',
      objective: 'pause the flaky migration'
    });
  });

  test('parses leading token budget option for created goals', () => {
    assert.deepEqual(parseGoalCommand('--tokens 50k Ship feature'), {
      type: 'create',
      objective: 'Ship feature',
      tokenBudget: 50_000
    });
    assert.deepEqual(parseGoalCommand('--tokens=100k Ship feature'), {
      type: 'create',
      objective: 'Ship feature',
      tokenBudget: 100_000
    });
    assert.deepEqual(parseGoalCommand('--tokens 1M Ship feature'), {
      type: 'create',
      objective: 'Ship feature',
      tokenBudget: 1_000_000
    });
    assert.deepEqual(parseGoalCommand('--tokens=10M Ship feature'), {
      type: 'create',
      objective: 'Ship feature',
      tokenBudget: 10_000_000
    });
    assert.deepEqual(parseGoalCommand('--tokens 12345 Ship feature'), {
      type: 'create',
      objective: 'Ship feature',
      tokenBudget: 12_345
    });
    assert.deepEqual(parseGoalCommand('Ship --tokens 1M'), {
      type: 'create',
      objective: 'Ship --tokens 1M'
    });
  });

  test('rejects invalid token budget option', () => {
    assert.throws(() => parseGoalCommand('--tokens Ship feature'), /Invalid token budget/);
    assert.throws(() => parseGoalCommand('--tokens 0 Ship feature'), /Invalid token budget/);
    assert.throws(() => parseGoalCommand('--tokens -1 Ship feature'), /Invalid token budget/);
    assert.throws(() => parseGoalCommand('--tokens 1.5M Ship feature'), /Invalid token budget/);
    assert.throws(() => parseGoalCommand('--tokens nope Ship feature'), /Invalid token budget/);
    assert.throws(() => parseGoalCommand('--tokens 1M --tokens 2M Ship feature'), /Duplicate/);
    assert.throws(() => parseGoalCommand('--tokens 1M'), /objective/);
  });

  test('formats required status debugging fields', () => {
    const { state, clock } = goal();
    const status = formatGoalStatus(state, clock);

    assert.match(status, /Goal goal-1/);
    assert.match(status, /status: active/);
    assert.match(status, /generation: 0/);
    assert.match(status, /tokens: 0\/10000000/);
    assert.match(status, /active time:/);
    assert.match(status, /updated:/);
  });

  test('replacement confirmation is required only for non-closed goals', () => {
    const { state, clock } = goal();
    assert.equal(canReplaceWithoutConfirmation(undefined), true);
    assert.equal(canReplaceWithoutConfirmation(state), false);
    assert.equal(canReplaceWithoutConfirmation(pauseGoal(state, clock, 'user')), false);
    assert.equal(canReplaceWithoutConfirmation(limitBudget(state, clock, 'tokens')), false);
    assert.equal(canReplaceWithoutConfirmation({ ...state, status: 'complete' }), true);
    assert.equal(canReplaceWithoutConfirmation({ ...state, status: 'cleared' }), true);
  });

  test('compact status reflects active and stopped states', () => {
    const { state, clock } = goal();
    assert.match(compactStatus(state, clock) ?? '', /goal 0\/10\.0m/);
    assert.match(compactStatus(pauseGoal(state, clock, 'user'), clock) ?? '', /paused/);
  });
});
