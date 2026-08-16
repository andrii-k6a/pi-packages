import { describe, expect, it } from 'vitest';
import {
  type AskUserQuestionInput,
  MAX_DESCRIPTION_LENGTH,
  MAX_HEADER_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_PREVIEW_LENGTH,
  MAX_QUESTION_LENGTH
} from '../src/schema.js';
import { AskUserQuestionValidationError, normalizeQuestions } from '../src/validate.js';

function input(questions: unknown): AskUserQuestionInput {
  return { questions } as AskUserQuestionInput;
}

function question(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    question: 'Which approach?',
    header: 'Approach',
    options: [
      { label: 'Incremental', description: 'Smaller diffs' },
      { label: 'Rewrite', description: 'Faster end state' }
    ],
    ...overrides
  };
}

describe('normalizeQuestions', () => {
  it('normalizes a valid call and defaults multiSelect to false', () => {
    const result = normalizeQuestions(input([question()]));

    expect(result).toEqual([
      {
        question: 'Which approach?',
        header: 'Approach',
        multiSelect: false,
        options: [
          { label: 'Incremental', description: 'Smaller diffs' },
          { label: 'Rewrite', description: 'Faster end state' }
        ]
      }
    ]);
  });

  it('trims surrounding whitespace and drops blank previews', () => {
    const result = normalizeQuestions(
      input([
        question({
          question: '  Which approach?  ',
          header: '  Approach  ',
          options: [
            { label: '  A  ', description: '  first  ', preview: '   ' },
            { label: 'B', description: 'second', preview: '# Title' }
          ]
        })
      ])
    );

    expect(result[0].question).toBe('Which approach?');
    expect(result[0].header).toBe('Approach');
    expect(result[0].options[0]).toEqual({ label: 'A', description: 'first' });
    expect(result[0].options[1].preview).toBe('# Title');
  });

  it.each([
    ['a number', 42],
    ['an object', {}]
  ])('rejects %s as a preview', (_label, preview) => {
    const questions = [
      question({
        options: [
          { label: 'A', description: 'first', preview },
          { label: 'B', description: 'second' }
        ]
      })
    ];

    expect(() => normalizeQuestions(input(questions))).toThrow(
      /questions\[0\]\.options\[0\]\.preview must be a string/
    );
  });

  it('enforces length limits before trimming whitespace', () => {
    const questions = [question({ question: ` ${'x'.repeat(MAX_QUESTION_LENGTH)} ` })];

    expect(() => normalizeQuestions(input(questions))).toThrow(
      /questions\[0\]\.question is 1002 characters \(max 1000\)/
    );
  });

  it('keeps multiSelect when requested', () => {
    const result = normalizeQuestions(input([question({ multiSelect: true })]));
    expect(result[0].multiSelect).toBe(true);
  });

  it.each([
    ['no questions', []],
    ['a non-array', undefined]
  ])('rejects %s', (_label, questions) => {
    expect(() => normalizeQuestions(input(questions))).toThrow(AskUserQuestionValidationError);
    expect(() => normalizeQuestions(input(questions))).toThrow(/at least 1 question/);
  });

  it('rejects more than four questions', () => {
    const questions = ['A', 'B', 'C', 'D', 'E'].map((header) => question({ header }));
    expect(() => normalizeQuestions(input(questions))).toThrow(/questions has 5 entries \(max 4\)/);
  });

  it('rejects fewer than two options', () => {
    const questions = [question({ options: [{ label: 'Only', description: 'one' }] })];
    expect(() => normalizeQuestions(input(questions))).toThrow(
      /questions\[0\]\.options has 1 entry \(min 2\)/
    );
  });

  it('rejects more than four options', () => {
    const options = ['A', 'B', 'C', 'D', 'E'].map((label) => ({ label, description: 'x' }));
    expect(() => normalizeQuestions(input([question({ options })]))).toThrow(
      /questions\[0\]\.options has 5 entries \(max 4\)/
    );
  });

  it.each([
    [
      'question',
      question({ question: 'x'.repeat(MAX_QUESTION_LENGTH) }),
      question({ question: 'x'.repeat(MAX_QUESTION_LENGTH + 1) }),
      /questions\[0\]\.question is 1001 characters \(max 1000\)/
    ],
    [
      'header',
      question({ header: 'x'.repeat(MAX_HEADER_LENGTH) }),
      question({ header: 'x'.repeat(MAX_HEADER_LENGTH + 1) }),
      /questions\[0\]\.header is 17 characters \(max 16\)/
    ],
    [
      'option label',
      question({
        options: [
          { label: 'x'.repeat(MAX_LABEL_LENGTH), description: 'ok' },
          { label: 'B', description: 'ok' }
        ]
      }),
      question({
        options: [
          { label: 'x'.repeat(MAX_LABEL_LENGTH + 1), description: 'ok' },
          { label: 'B', description: 'ok' }
        ]
      }),
      /questions\[0\]\.options\[0\]\.label is 61 characters \(max 60\)/
    ],
    [
      'option description',
      question({
        options: [
          { label: 'A', description: 'x'.repeat(MAX_DESCRIPTION_LENGTH) },
          { label: 'B', description: 'ok' }
        ]
      }),
      question({
        options: [
          { label: 'A', description: 'x'.repeat(MAX_DESCRIPTION_LENGTH + 1) },
          { label: 'B', description: 'ok' }
        ]
      }),
      /questions\[0\]\.options\[0\]\.description is 501 characters \(max 500\)/
    ],
    [
      'option preview',
      question({
        options: [
          { label: 'A', description: 'ok', preview: 'x'.repeat(MAX_PREVIEW_LENGTH) },
          { label: 'B', description: 'ok' }
        ]
      }),
      question({
        options: [
          { label: 'A', description: 'ok', preview: 'x'.repeat(MAX_PREVIEW_LENGTH + 1) },
          { label: 'B', description: 'ok' }
        ]
      }),
      /questions\[0\]\.options\[0\]\.preview is 4001 characters \(max 4000\)/
    ]
  ])('accepts an exact maximum-length %s and rejects one character over', (_field, atMaximum, overMaximum, expected) => {
    expect(() => normalizeQuestions(input([atMaximum]))).not.toThrow();
    expect(() => normalizeQuestions(input([overMaximum]))).toThrow(expected);
  });

  it.each([
    'Other',
    'other',
    'Type something.',
    'type something',
    'Something else'
  ])('rejects the reserved label %s', (label) => {
    const questions = [
      question({
        options: [
          { label: 'Real choice', description: 'ok' },
          { label, description: 'reserved' }
        ]
      })
    ];
    expect(() => normalizeQuestions(input(questions))).toThrow(/is reserved/);
  });

  it('preserves a preview on a multiSelect question', () => {
    const result = normalizeQuestions(
      input([
        question({
          multiSelect: true,
          options: [
            { label: 'A', description: 'first', preview: '# Preview' },
            { label: 'B', description: 'second' }
          ]
        })
      ])
    );

    expect(result[0].multiSelect).toBe(true);
    expect(result[0].options[0]).toEqual({
      label: 'A',
      description: 'first',
      preview: '# Preview'
    });
  });

  it('rejects duplicate headers regardless of case', () => {
    const questions = [question({ header: 'Scope' }), question({ header: 'scope' })];
    expect(() => normalizeQuestions(input(questions))).toThrow(
      /questions\[1\]\.header "scope" duplicates questions\[0\]\.header/
    );
  });

  it.each([
    ['question', { question: '   ' }, /questions\[0\]\.question must be a non-empty string/],
    ['header', { header: '' }, /questions\[0\]\.header must be a non-empty string/]
  ])('rejects a blank %s', (_field, overrides, expected) => {
    expect(() => normalizeQuestions(input([question(overrides)]))).toThrow(expected);
  });

  it('rejects a blank option description', () => {
    const questions = [
      question({
        options: [
          { label: 'A', description: '  ' },
          { label: 'B', description: 'ok' }
        ]
      })
    ];
    expect(() => normalizeQuestions(input(questions))).toThrow(
      /questions\[0\]\.options\[0\]\.description must be a non-empty string/
    );
  });

  it('prefixes errors with the tool name', () => {
    expect(() => normalizeQuestions(input([]))).toThrow(/^ask_user_question: /);
  });
});
