import assert from 'node:assert/strict';
import { test } from 'vitest';
import { outcomeMessage } from '../../../src/durable/tasks/outcome.js';

test('task outcome messages share the authoritative failure/recovery vocabulary', () => {
  assert.equal(outcomeMessage({ status: 'completed', result: null }), 'completed');
  assert.equal(
    outcomeMessage({ status: 'failed', error: { message: 'failed request' } }),
    'failed request'
  );
  assert.equal(
    outcomeMessage({ status: 'faulted', error: { message: 'uncaught fault' } }),
    'uncaught fault'
  );
  assert.equal(outcomeMessage({ status: 'aborted' }), 'aborted');
  assert.equal(outcomeMessage({ status: 'aborted', reason: 'cancelled' }), 'cancelled');
  assert.equal(outcomeMessage({ status: 'orphaned', reason: 'owner missing' }), 'owner missing');
});
