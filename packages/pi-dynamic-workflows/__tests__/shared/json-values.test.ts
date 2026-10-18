import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  jsonValue,
  jsonWorkflowResult,
  optionalJsonArgument
} from '../../src/shared/json-values.js';

test('JSON conversions distinguish omitted arguments from null workflow results', () => {
  assert.equal(optionalJsonArgument(undefined), undefined);
  assert.equal(optionalJsonArgument(null), null);
  assert.equal(jsonWorkflowResult(undefined), null);
  assert.equal(jsonWorkflowResult(null), null);
  assert.deepEqual(jsonValue({ omitted: undefined, retained: null }), { retained: null });
});

test('JSON conversions preserve serialization failures rather than silently changing their meaning', () => {
  assert.throws(() => jsonValue(1n), /BigInt/);
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  assert.throws(() => optionalJsonArgument(cyclic), /circular/i);
  assert.throws(() => jsonWorkflowResult(cyclic), /circular/i);
});
