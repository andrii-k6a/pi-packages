import { type Static, Type } from 'typebox';

/** Hard limits mirrored in the JSON schema so the model sees them up front. */
export const MIN_QUESTIONS = 1;
export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_HEADER_LENGTH = 16;
export const MAX_LABEL_LENGTH = 60;
export const MAX_QUESTION_LENGTH = 1000;
export const MAX_DESCRIPTION_LENGTH = 500;
export const MAX_PREVIEW_LENGTH = 4000;

/** Label of the free-text row appended to every question. */
export const CUSTOM_OPTION_LABEL = 'Type something.';

const OptionSchema = Type.Object({
  label: Type.String({
    minLength: 1,
    maxLength: MAX_LABEL_LENGTH,
    description: `MAX ${MAX_LABEL_LENGTH} CHARACTERS. The display text for this option. Should be concise (1-5 words) and clearly describe the choice.`
  }),
  description: Type.String({
    minLength: 1,
    maxLength: MAX_DESCRIPTION_LENGTH,
    description:
      'Explanation of what this option means or what will happen if chosen. Useful for conveying trade-offs.'
  }),
  preview: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: MAX_PREVIEW_LENGTH,
      description:
        'Optional markdown preview shown beside the options when this one is focused. Use for mockups, code snippets, diagrams, or configs that are easier to compare visually.'
    })
  )
});

const QuestionSchema = Type.Object({
  question: Type.String({
    minLength: 1,
    maxLength: MAX_QUESTION_LENGTH,
    description:
      'The complete question to ask the user. Should be clear, specific, and end with a question mark.'
  }),
  header: Type.String({
    minLength: 1,
    maxLength: MAX_HEADER_LENGTH,
    description: `MAX ${MAX_HEADER_LENGTH} CHARACTERS. Very short tab label for this question, e.g. "Auth method", "Library", "Approach". Must be unique across questions.`
  }),
  multiSelect: Type.Optional(
    Type.Boolean({
      description:
        'Set to true to let the user pick several options instead of one. Use when the choices are not mutually exclusive. Default: false.'
    })
  ),
  options: Type.Array(OptionSchema, {
    minItems: MIN_OPTIONS,
    maxItems: MAX_OPTIONS,
    description: `The available choices for this question (${MIN_OPTIONS}-${MAX_OPTIONS}). A "${CUSTOM_OPTION_LABEL}" free-text row is appended automatically, so never author it yourself.`
  })
});

export const AskUserQuestionParams = Type.Object({
  questions: Type.Array(QuestionSchema, {
    minItems: MIN_QUESTIONS,
    maxItems: MAX_QUESTIONS,
    description: `Questions to ask the user (${MIN_QUESTIONS}-${MAX_QUESTIONS}).`
  })
});

export type AskUserQuestionInput = Static<typeof AskUserQuestionParams>;
export type QuestionInput = Static<typeof QuestionSchema>;
export type OptionInput = Static<typeof OptionSchema>;

/** An option after validation: trimmed, with blank previews dropped. */
export interface NormalizedOption {
  label: string;
  description: string;
  preview?: string;
}

/** A question after validation: trimmed, with `multiSelect` defaulted. */
export interface NormalizedQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: NormalizedOption[];
}
