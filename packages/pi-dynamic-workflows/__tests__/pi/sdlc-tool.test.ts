import assert from 'node:assert/strict';
import { test } from 'vitest';
import { prepareSdlcArgs } from '../../src/pi/sdlc-input.js';
import { createWorkflowTool } from '../../src/pi/workflow-tool.js';

test('SDLC answers are exclusive, revision-bound requests, not automatic continuations', () => {
  const tool = createWorkflowTool();
  const answer = {
    runId: 'run-1',
    questionId: 'q-1',
    briefRevision: 2,
    answer: 'Keep the existing API'
  };
  assert.deepEqual(tool.prepareArguments?.({ answer }), { answer });
  for (const field of [
    'name',
    'script',
    'args',
    'resume',
    'continue',
    'status',
    'result',
    'cancel',
    'background',
    'tokenBudget'
  ]) {
    assert.throws(
      () => tool.prepareArguments?.({ answer, [field]: true }),
      /answer must be used alone/
    );
  }
  for (const invalid of [
    null,
    [],
    {},
    { ...answer, briefRevision: 0 },
    { ...answer, answer: '' },
    { ...answer, approveAll: true }
  ]) {
    assert.throws(() => tool.prepareArguments?.({ answer: invalid }), /answer requires/);
  }
});

test('explicit continuation accepts options and execution mode, but no replacement script or ordinary budget reset', () => {
  const tool = createWorkflowTool();
  assert.deepEqual(
    tool.prepareArguments?.({
      continue: ' run-1 ',
      continueOptions: { limits: { maxTasks: 30 } },
      background: true
    }),
    {
      continue: 'run-1',
      continueOptions: { limits: { maxTasks: 30 } },
      background: true
    }
  );
  for (const field of [
    'name',
    'script',
    'args',
    'resume',
    'resumeProfile',
    'status',
    'result',
    'cancel',
    'tokenBudget'
  ]) {
    assert.throws(
      () => tool.prepareArguments?.({ continue: 'run-1', [field]: 'value' }),
      /continue can only/
    );
  }
  assert.throws(() => tool.prepareArguments?.({ continue: '' }), /non-empty run id/);
  assert.throws(
    () => tool.prepareArguments?.({ continue: 'run-1', continueOptions: [] }),
    /JSON object/
  );
  assert.throws(
    () => tool.prepareArguments?.({ script: 'x', continueOptions: {} }),
    /requires continue/
  );
});

test('continuation schema advertises additive checks and finite explicit limits', () => {
  const schema = createWorkflowTool().parameters;
  const continuation = schema.properties.continueOptions;
  assert.equal(continuation.type, 'object');
  assert.equal(Reflect.get(continuation, 'additionalProperties'), false);
  assert.equal(continuation.properties.checks.items.type, 'object');
  assert.equal(continuation.properties.checks.items.properties.argv.type, 'array');
  assert.equal(Reflect.get(continuation.properties.checks.items, 'additionalProperties'), false);
  assert.match(
    String(Reflect.get(continuation.properties.checks, 'description')),
    /never replaced or weakened/
  );
  assert.equal(
    Reflect.get(continuation.properties.limits.properties.correctionRounds, 'minimum'),
    0
  );
});

test('named SDLC defaults foreground to existing and background to isolated, preserving explicit policy', () => {
  assert.deepEqual(prepareSdlcArgs({ goal: 'Fix save' }).workspace, { mode: 'existing' });
  assert.deepEqual(prepareSdlcArgs({ goal: 'Fix save' }, true).workspace, { mode: 'isolated' });
  assert.deepEqual(
    prepareSdlcArgs({ goal: 'Fix save', workspace: { mode: 'existing', cwd: '/chosen' } }, true)
      .workspace,
    { mode: 'existing', cwd: '/chosen' }
  );
  for (const args of [
    {},
    { goal: '' },
    { goal: 'Fix save', unknown: true },
    { goal: 'Fix save', workspace: { mode: 'silent-fallback' } }
  ]) {
    assert.throws(() => prepareSdlcArgs(args), /SDLC/);
  }
});
