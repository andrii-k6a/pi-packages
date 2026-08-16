import { describe, expect, it } from 'vitest';
import {
  type AskUserQuestionDetails,
  CANCELLED_TEXT,
  formatAnswers,
  formatDetails,
  summarizeCall,
  UNAVAILABLE_TEXT
} from '../src/format.js';
import type { AskUserQuestionInput } from '../src/schema.js';
import type { Answer } from '../src/state.js';

function answer(overrides: Partial<Answer> = {}): Answer {
  return {
    header: 'Approach',
    question: 'Which approach?',
    multiSelect: false,
    selections: [{ index: 1, label: 'Incremental', custom: false }],
    ...overrides
  };
}

describe('formatAnswers', () => {
  it('reports a single-select pick with its number', () => {
    expect(formatAnswers([answer()])).toBe('Approach: user selected 1. Incremental');
  });

  it('reports several picks for a multiSelect question', () => {
    const text = formatAnswers([
      answer({
        header: 'Features',
        multiSelect: true,
        selections: [
          { index: 1, label: 'Lint', custom: false },
          { index: 3, label: 'Test', custom: false }
        ]
      })
    ]);

    expect(text).toBe('Features: user selected 1. Lint, 3. Test');
  });

  it('reports free text on its own', () => {
    const text = formatAnswers([
      answer({ selections: [{ index: null, label: 'use a flag', custom: true }] })
    ]);

    expect(text).toBe('Approach: user wrote: use a flag');
  });

  it('reports picks combined with free text', () => {
    const text = formatAnswers([
      answer({
        header: 'Features',
        multiSelect: true,
        selections: [
          { index: 2, label: 'Typecheck', custom: false },
          { index: null, label: 'plus docs', custom: true }
        ]
      })
    ]);

    expect(text).toBe('Features: user selected 2. Typecheck; wrote: plus docs');
  });

  it('puts each question on its own line', () => {
    const text = formatAnswers([answer({ header: 'Scope' }), answer({ header: 'Library' })]);

    expect(text.split('\n')).toHaveLength(2);
  });
});

describe('formatDetails', () => {
  it('explains a non-interactive run', () => {
    const details: AskUserQuestionDetails = { cancelled: true, answers: [], unavailable: true };
    expect(formatDetails(details)).toBe(UNAVAILABLE_TEXT);
  });

  it.each([
    ['dismissed', { cancelled: true, answers: [answer()] }],
    ['submitted with nothing', { cancelled: false, answers: [] }]
  ])('reports %s as cancelled', (_label, details) => {
    expect(formatDetails(details as AskUserQuestionDetails)).toBe(CANCELLED_TEXT);
  });

  it('formats submitted answers', () => {
    expect(formatDetails({ cancelled: false, answers: [answer()] })).toContain('user selected 1.');
  });
});

describe('summarizeCall', () => {
  it('counts questions and lists headers', () => {
    const input = {
      questions: [{ header: 'Scope' }, { header: 'Library' }]
    } as AskUserQuestionInput;

    expect(summarizeCall(input)).toEqual({ count: 2, headers: 'Scope, Library' });
  });

  it('tolerates missing or malformed input', () => {
    expect(summarizeCall(undefined)).toEqual({ count: 0, headers: '' });
    expect(summarizeCall({ questions: [{}] } as AskUserQuestionInput)).toEqual({
      count: 1,
      headers: ''
    });
  });
});
