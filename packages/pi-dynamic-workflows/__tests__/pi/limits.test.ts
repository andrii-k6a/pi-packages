import assert from 'node:assert/strict';
import { test } from 'vitest';
import { loadWorkflowMaxAgents, WORKFLOW_MAX_AGENTS_ENV } from '../../src/pi/limits.js';

const env = (value?: string) => (value === undefined ? {} : { [WORKFLOW_MAX_AGENTS_ENV]: value });

test('the agent-call cap comes from PI_WORKFLOW_MAX_AGENTS, and unset keeps the default', () => {
  assert.equal(loadWorkflowMaxAgents(env()), undefined);
  assert.equal(loadWorkflowMaxAgents(env('')), undefined);
  assert.equal(loadWorkflowMaxAgents(env('  ')), undefined);
  assert.equal(loadWorkflowMaxAgents(env('1200')), 1200);
  assert.equal(loadWorkflowMaxAgents(env(' 7 ')), 7);
  assert.equal(loadWorkflowMaxAgents(env('unlimited')), Number.POSITIVE_INFINITY);
  assert.equal(loadWorkflowMaxAgents(env('UNLIMITED')), Number.POSITIVE_INFINITY);
});

test('a malformed agent-call cap fails loudly instead of being ignored', () => {
  for (const value of ['0', '-5', '1.5', 'many', '1e3', '12 34', '9999999999']) {
    assert.throws(() => loadWorkflowMaxAgents(env(value)), /PI_WORKFLOW_MAX_AGENTS must be/, value);
  }
});
