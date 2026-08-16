import { describe, expect, it } from 'vitest';
import { DialogState } from '../src/state.js';
import { harness, makeQuestion } from './helpers.js';

describe('DialogState single question', () => {
  it('submits immediately when an option is picked', () => {
    const { press, results } = harness([makeQuestion()]);

    press('down', 'enter');

    expect(results).toEqual([
      {
        cancelled: false,
        answers: [
          {
            header: 'Approach',
            question: 'Which approach?',
            multiSelect: false,
            selections: [{ index: 2, label: 'Rewrite', custom: false }]
          }
        ]
      }
    ]);
  });

  it('records free text typed in the last row', () => {
    const { state, press, results } = harness([makeQuestion()]);

    press('down', 'down', 'enter');
    expect(state.snapshot().inputMode).toBe(true);

    state.submitCustomText('  use a feature flag  ');

    expect(results[0].answers[0].selections).toEqual([
      { index: null, label: 'use a feature flag', custom: true }
    ]);
  });

  it('returns to the options when free text is empty', () => {
    const { state, results } = harness([makeQuestion()]);

    state.handleAction('down');
    state.handleAction('down');
    state.handleAction('enter');
    state.submitCustomText('   ');

    expect(state.snapshot().inputMode).toBe(false);
    expect(results).toEqual([]);
  });

  it('leaves the editor without recording on escape', () => {
    const { state, results } = harness([makeQuestion()]);

    state.handleAction('down');
    state.handleAction('down');
    state.handleAction('enter');
    state.handleAction('escape');

    expect(state.snapshot().inputMode).toBe(false);
    expect(results).toEqual([]);
  });

  it('cancels with no answers on escape in the option list', () => {
    const { press, results } = harness([makeQuestion()]);

    press('escape');

    expect(results).toEqual([{ cancelled: true, answers: [] }]);
  });

  it('clamps cursor movement at both ends', () => {
    const { state, press } = harness([makeQuestion()]);

    press('up', 'up');
    expect(state.snapshot().cursor).toBe(0);

    press('down', 'down', 'down', 'down');
    expect(state.snapshot().cursor).toBe(2);
  });

  it('ignores tab navigation when there is only one question', () => {
    const { state, press } = harness([makeQuestion()]);

    press('tab', 'right');

    expect(state.snapshot().tabIndex).toBe(0);
    expect(state.snapshot().onSubmitTab).toBe(false);
  });
});

describe('DialogState multi-select', () => {
  it('toggles options with space and confirms with enter', () => {
    const { state, press, results } = harness([
      makeQuestion({
        multiSelect: true,
        options: [
          { label: 'Lint', description: 'a' },
          { label: 'Typecheck', description: 'b' },
          { label: 'Test', description: 'c' }
        ]
      })
    ]);

    press('space', 'down', 'down', 'space');
    expect(state.snapshot().questions[0].selected).toEqual([0, 2]);

    press('enter');
    expect(results[0].answers[0].selections).toEqual([
      { index: 1, label: 'Lint', custom: false },
      { index: 3, label: 'Test', custom: false }
    ]);
  });

  it('unselects on a second space', () => {
    const { state, press } = harness([makeQuestion({ multiSelect: true })]);

    press('space', 'space');

    expect(state.snapshot().questions[0].selected).toEqual([]);
    expect(state.snapshot().questions[0].answered).toBe(false);
  });

  it('ignores enter until something is selected', () => {
    const { press, results } = harness([makeQuestion({ multiSelect: true })]);

    press('enter');

    expect(results).toEqual([]);
  });

  it('keeps toggled options alongside free text', () => {
    const { state, press, results } = harness([makeQuestion({ multiSelect: true })]);

    press('space', 'down', 'down', 'space');
    expect(state.snapshot().inputMode).toBe(true);

    state.submitCustomText('and a fourth thing');
    // Free text does not auto-advance in multi-select; the user confirms.
    expect(state.snapshot().inputMode).toBe(false);
    expect(results).toEqual([]);

    press('enter');
    expect(results[0].answers[0].selections).toEqual([
      { index: 1, label: 'Incremental', custom: false },
      { index: null, label: 'and a fourth thing', custom: true }
    ]);
  });

  it('clears recorded free text when its row is toggled again', () => {
    const { state, press } = harness([makeQuestion({ multiSelect: true })]);

    press('down', 'down', 'space');
    state.submitCustomText('typed');
    expect(state.snapshot().questions[0].customText).toBe('typed');

    press('space');
    expect(state.snapshot().questions[0].customText).toBeUndefined();
  });
});

describe('DialogState multiple questions', () => {
  const questions = [
    makeQuestion({ header: 'Scope' }),
    makeQuestion({ header: 'Library', question: 'Which library?' })
  ];

  it('advances through questions and lands on the submit tab', () => {
    const { state, press, results } = harness(questions);

    press('enter');
    expect(state.snapshot().tabIndex).toBe(1);

    press('enter');
    expect(state.snapshot().onSubmitTab).toBe(true);
    expect(state.snapshot().allAnswered).toBe(true);
    expect(results).toEqual([]);

    press('enter');
    expect(results[0].cancelled).toBe(false);
    expect(results[0].answers.map((answer) => answer.header)).toEqual(['Scope', 'Library']);
  });

  it('will not submit while a question is unanswered', () => {
    const { state, press, results } = harness(questions);

    press('tab', 'tab');
    expect(state.snapshot().onSubmitTab).toBe(true);
    expect(state.snapshot().unansweredHeaders).toEqual(['Scope', 'Library']);

    press('enter');
    expect(results).toEqual([]);
  });

  it('wraps tab navigation in both directions', () => {
    const { state, press } = harness(questions);

    press('shiftTab');
    expect(state.snapshot().onSubmitTab).toBe(true);

    press('tab');
    expect(state.snapshot().tabIndex).toBe(0);
  });

  it('keeps a separate cursor per question', () => {
    const { state, press } = harness(questions);

    press('down');
    press('tab');
    expect(state.snapshot().cursor).toBe(0);

    press('shiftTab');
    expect(state.snapshot().cursor).toBe(1);
  });

  it('replaces an earlier single-select pick when revisited', () => {
    const { state, press, results } = harness(questions);

    press('enter');
    press('enter');
    // Back to the second question from the submit tab, then change the pick.
    press('shiftTab');
    press('down', 'enter');
    press('enter');

    expect(state.snapshot().questions[1].selected).toEqual([1]);
    expect(results[0].answers[1].selections).toEqual([
      { index: 2, label: 'Rewrite', custom: false }
    ]);
  });

  it('reports partial answers when dismissed midway', () => {
    const { press, results } = harness(questions);

    press('enter');
    press('escape');

    expect(results[0].cancelled).toBe(true);
    expect(results[0].answers.map((answer) => answer.header)).toEqual(['Scope']);
  });
});

describe('DialogState lifecycle', () => {
  it('finishes only once', () => {
    const { press, results } = harness([makeQuestion()]);

    press('enter');
    press('enter', 'escape');

    expect(results).toHaveLength(1);
  });

  it('cancels externally when aborted', () => {
    const { state, results } = harness([makeQuestion()]);

    state.cancel();
    state.cancel();

    expect(results).toEqual([{ cancelled: true, answers: [] }]);
  });

  it('requires at least one question', () => {
    expect(() => new DialogState([], () => {})).toThrow(/at least one question/);
  });
});
