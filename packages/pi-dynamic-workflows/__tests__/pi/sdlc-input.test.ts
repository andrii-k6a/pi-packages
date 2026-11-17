import assert from 'node:assert/strict';
import { test } from 'vitest';
import { parseSdlcCommand } from '../../src/pi/sdlc-input.js';

test('ordinary SDLC goals stay literal, including quotes and shell-looking text', () => {
  const goal = 'Fix "save"; $(touch nope)\nand preserve existing callers';
  assert.deepEqual(parseSdlcCommand(` ${goal} `), {
    action: 'start',
    args: { goal },
    background: false
  });
  assert.deepEqual(parseSdlcCommand('--background Add pagination'), {
    action: 'start',
    args: { goal: 'Add pagination' },
    background: true
  });
  assert.deepEqual(parseSdlcCommand('-- status should remain visible'), {
    action: 'start',
    args: { goal: 'status should remain visible' },
    background: false
  });
});

test('JSON starts and continuation options are parsed without shell unquoting', () => {
  const args = {
    goal: 'Fix save',
    acceptance: ['existing callers work'],
    workspace: { mode: 'isolated' }
  };
  assert.deepEqual(parseSdlcCommand(JSON.stringify(args)), {
    action: 'start',
    args,
    background: false
  });
  assert.deepEqual(parseSdlcCommand('--background continue run-1 {"limits":{"maxTasks":10}}'), {
    action: 'continue',
    runId: 'run-1',
    options: { limits: { maxTasks: 10 } },
    background: true
  });
  assert.deepEqual(parseSdlcCommand('continue run-1'), {
    action: 'continue',
    runId: 'run-1',
    options: {},
    background: false
  });
});

test('answers require explicit question identity and revision and never imply continuation', () => {
  assert.deepEqual(
    parseSdlcCommand(
      'answer run-1 {"questionId":"q-1","briefRevision":2,"answer":"Keep it local"}'
    ),
    {
      action: 'answer',
      runId: 'run-1',
      questionId: 'q-1',
      briefRevision: 2,
      answer: 'Keep it local'
    }
  );
  for (const value of [
    'answer run-1',
    'answer run-1 {}',
    'answer run-1 {"questionId":"q","briefRevision":0,"answer":"yes"}',
    'answer run-1 {"questionId":"q","briefRevision":1,"answer":""}',
    'answer run-1 {"questionId":"q","briefRevision":1,"answer":"yes","approve":true}',
    '--background answer run-1 {"questionId":"q","briefRevision":1,"answer":"yes"}'
  ])
    assert.throws(() => parseSdlcCommand(value), /answer|JSON/);
});

test('inspection and cancellation accept exactly one run id', () => {
  for (const action of ['status', 'cancel'] as const) {
    assert.deepEqual(parseSdlcCommand(`${action} run-1`), { action, runId: 'run-1' });
    assert.throws(() => parseSdlcCommand(`${action} run-1 extra`), /only a run id/);
    assert.throws(() => parseSdlcCommand(`--background ${action} run-1`), /only a run id/);
  }
});

test('malformed or ambiguous command syntax fails before launching a run', () => {
  for (const value of [
    '',
    '--background',
    '--',
    '--unknown Goal',
    '{} trailing',
    'continue run-1 []',
    'continue run-1 null'
  ]) {
    assert.throws(() => parseSdlcCommand(value), /Usage|goal|option|JSON/);
  }
});
