import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { SdlcState } from '../../src/durable/sdlc-state.js';
import {
  compactSdlc,
  renderSdlcStatusLines,
  sdlcWorkspaceNotice
} from '../../src/pi/sdlc-display.js';
import { DEFAULT_SDLC_LIMITS } from '../../src/workflow/sdlc/contracts.js';

function state(): SdlcState {
  return {
    operationId: 'run-1',
    activity: 'Waiting for input\u001b[2J',
    outcome: 'needs-input',
    brief: { revision: 3, goalRevision: 2 },
    workspace: { cwd: '/actual/checkout', mode: 'isolated', branch: 'pi/sdlc/run-1' },
    questions: Array.from({ length: 8 }, (_, index) => ({
      id: `q-${index}`,
      briefRevision: 3,
      text: 'Choose behavior',
      choices: ['keep', 'replace']
    })),
    limits: { ...DEFAULT_SDLC_LIMITS },
    consumed: { tasks: 5, corrections: 1, replans: 0, failedTasks: 1 },
    usage: { totalTokens: 1200, cost: { total: 0.12 } },
    importedUsage: { totalTokens: 400, cost: { total: 0.04 } },
    result: { unresolvedWork: ['Need an explicit API decision'] }
  } as SdlcState;
}

test('SDLC status exposes workspace, question revision, finite limits and cumulative spend separately from source review', () => {
  const source = state();
  const summary = compactSdlc(source);
  const text = renderSdlcStatusLines(summary).join('\n');
  assert.match(text, /needs-input.*Waiting for input.*goal revision 2/);
  assert.match(text, /\/actual\/checkout.*isolated.*pi\/sdlc\/run-1/);
  assert.match(text, /Question q-0 \(brief revision 3\)/);
  assert.match(text, /tasks 5\/24, corrections 1\/3, replans 0\/2/);
  assert.match(text, /1\.2k\/500k tokens.*soft allowance.*\$0\.12/);
  assert.match(text, /Imported review usage \(separate\): 400 tokens.*\$0\.04/);
  assert.match(text, /3 more pending questions/);
  assert.match(text, /Unanswered questions are not approval/);
  assert.match(text, /Resume returns stored results/);
  assert.equal(text.includes('\u001b'), false);
  assert.equal(summary.pendingQuestions.length, 5);
  assert.equal(source.questions.length, 8, 'rendering does not mutate durable state');
});

test('answered questions disappear from the pending projection without implying approval of other questions', () => {
  const source = state();
  source.questions[0].answer = 'keep';
  const summary = compactSdlc(source);
  assert.equal(summary.pendingQuestionCount, 7);
  assert.ok(summary.pendingQuestions.every((question) => question.id !== 'q-0'));
});

test('destination notices distinguish existing mutation from retained isolated output', () => {
  assert.match(
    sdlcWorkspaceNotice({ cwd: '/chosen', mode: 'existing', branch: undefined }),
    /\/chosen.*Existing checkout.*changes this directory/
  );
  assert.match(
    sdlcWorkspaceNotice({ cwd: '/owned', mode: 'isolated', branch: 'pi/sdlc/one' }),
    /\/owned.*Operation-owned isolated checkout.*source checkout is not the target/
  );
});
