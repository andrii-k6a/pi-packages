import assert from 'node:assert/strict';
import type { Usage } from '@earendil-works/pi-ai';
import { test } from 'vitest';
import {
  addUsage,
  emptyUsage,
  hasUsage,
  subtractUsage,
  sumUsageState
} from '../../src/shared/usage.js';

function usage(input: number, output: number): Usage {
  return {
    ...emptyUsage(),
    input,
    output,
    totalTokens: input + output,
    cost: { input: input / 10, output: output / 10, cacheRead: 0, cacheWrite: 0, total: 1 }
  };
}

test('emptyUsage returns independent zeroed values with no optional fields', () => {
  const first = emptyUsage();
  assert.deepEqual(first, {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  });
  assert.notEqual(first.cost, emptyUsage().cost);
  assert.equal(hasUsage(first), false);
  assert.equal(hasUsage({ ...first, cost: { ...first.cost, total: 0.5 } }), true);
  assert.equal(hasUsage({ ...first, reasoning: 1 }), true);
});

test('addUsage sums every field, preserves optional field presence, and does not mutate inputs', () => {
  const left: Usage = {
    ...usage(10, 4),
    cacheRead: 3,
    cacheWrite: 2,
    cacheWrite1h: 0,
    cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 }
  };
  const right: Usage = {
    ...usage(5, 6),
    cacheRead: 7,
    cacheWrite: 8,
    reasoning: 2,
    cost: { input: 5, output: 6, cacheRead: 7, cacheWrite: 8, total: 26 }
  };
  const originalLeft = structuredClone(left);
  const originalRight = structuredClone(right);

  assert.deepEqual(addUsage(left, right), {
    input: 15,
    output: 10,
    cacheRead: 10,
    cacheWrite: 10,
    cacheWrite1h: 0,
    reasoning: 2,
    totalTokens: 25,
    cost: { input: 6, output: 8, cacheRead: 10, cacheWrite: 12, total: 36 }
  });
  assert.deepEqual(addUsage(usage(1, 2), usage(3, 4)), {
    input: 4,
    output: 6,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 10,
    cost: { input: 0.1 + 0.3, output: 0.2 + 0.4, cacheRead: 0, cacheWrite: 0, total: 2 }
  });
  assert.deepEqual(left, originalLeft);
  assert.deepEqual(right, originalRight);
});

test('subtractUsage returns the unreported remainder, floored at zero', () => {
  const total: Usage = { ...usage(10, 5), reasoning: 3 };
  const reported: Usage = { ...usage(4, 7), cost: { ...usage(4, 7).cost, total: 0.25 } };

  assert.deepEqual(subtractUsage(total, reported), {
    input: 6,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 3,
    totalTokens: 4,
    cost: { input: 1 - 0.4, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.75 }
  });
  assert.equal(hasUsage(subtractUsage(reported, reported)), false);
});

test('sumUsageState adds every model and tool bucket and ignores malformed buckets', () => {
  const state = {
    models: { 'faux/a': usage(10, 2), 'faux/b': usage(1, 1) },
    tools: { search: { output: 3, cacheWrite1h: 1, cost: { total: 0.25 } }, broken: null }
  };

  assert.deepEqual(sumUsageState(state as never), {
    input: 11,
    output: 6,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite1h: 1,
    totalTokens: 14,
    cost: { input: 1.1, output: 0.30000000000000004, cacheRead: 0, cacheWrite: 0, total: 2.25 }
  });
  assert.deepEqual(sumUsageState(undefined), emptyUsage());
});
