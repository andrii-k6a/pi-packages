import {
  type AskUserQuestionInput,
  CUSTOM_OPTION_LABEL,
  MAX_DESCRIPTION_LENGTH,
  MAX_HEADER_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_OPTIONS,
  MAX_PREVIEW_LENGTH,
  MAX_QUESTION_LENGTH,
  MAX_QUESTIONS,
  MIN_OPTIONS,
  type NormalizedOption,
  type NormalizedQuestion
} from './schema.js';

/**
 * Thrown for malformed calls. Surfaced to the model as a tool error so it can
 * retry with a corrected call.
 */
export class AskUserQuestionValidationError extends Error {
  constructor(message: string) {
    super(`ask_user_question: ${message}`);
    this.name = 'AskUserQuestionValidationError';
  }
}

/** Labels reserved for the automatically appended free-text row. */
const RESERVED_OPTION_LABELS = new Set(['other', 'type something', 'something else']);

function reservedKey(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[.\u2026!?]+$/, '')
    .trim();
}

function requireText(value: unknown, path: string, maxLength?: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AskUserQuestionValidationError(`${path} must be a non-empty string`);
  }
  if (maxLength !== undefined && value.length > maxLength) {
    throw new AskUserQuestionValidationError(
      `${path} is ${value.length} characters (max ${maxLength})`
    );
  }
  return value.trim();
}

function normalizeOption(raw: unknown, path: string): NormalizedOption {
  const option = (raw ?? {}) as { label?: unknown; description?: unknown; preview?: unknown };

  const label = requireText(option.label, `${path}.label`, MAX_LABEL_LENGTH);
  if (RESERVED_OPTION_LABELS.has(reservedKey(label))) {
    throw new AskUserQuestionValidationError(
      `${path}.label "${label}" is reserved; a "${CUSTOM_OPTION_LABEL}" row is appended to every question automatically`
    );
  }

  const description = requireText(
    option.description,
    `${path}.description`,
    MAX_DESCRIPTION_LENGTH
  );

  if (option.preview !== undefined && typeof option.preview !== 'string') {
    throw new AskUserQuestionValidationError(`${path}.preview must be a string`);
  }
  if (typeof option.preview === 'string' && option.preview.length > MAX_PREVIEW_LENGTH) {
    throw new AskUserQuestionValidationError(
      `${path}.preview is ${option.preview.length} characters (max ${MAX_PREVIEW_LENGTH})`
    );
  }
  const preview =
    typeof option.preview === 'string' && option.preview.trim().length > 0
      ? option.preview
      : undefined;
  return preview === undefined ? { label, description } : { label, description, preview };
}

/**
 * Validate and normalize raw tool arguments.
 *
 * Length and cardinality limits are already enforced by the TypeBox schema; this
 * covers the rules the schema cannot express (reserved labels, duplicate headers,
 * whitespace-only strings) and acts as a defensive layer when arguments arrive
 * unvalidated.
 */
export function normalizeQuestions(input: AskUserQuestionInput): NormalizedQuestion[] {
  const questions = (input as { questions?: unknown } | undefined)?.questions;

  if (!Array.isArray(questions) || questions.length === 0) {
    throw new AskUserQuestionValidationError('questions must contain at least 1 question');
  }
  if (questions.length > MAX_QUESTIONS) {
    throw new AskUserQuestionValidationError(
      `questions has ${questions.length} entries (max ${MAX_QUESTIONS})`
    );
  }

  const headerOwners = new Map<string, number>();

  return questions.map((raw, questionIndex) => {
    const path = `questions[${questionIndex}]`;
    const value = (raw ?? {}) as {
      question?: unknown;
      header?: unknown;
      multiSelect?: unknown;
      options?: unknown;
    };

    const question = requireText(value.question, `${path}.question`, MAX_QUESTION_LENGTH);

    const header = requireText(value.header, `${path}.header`, MAX_HEADER_LENGTH);
    const headerKey = header.toLowerCase();
    const owner = headerOwners.get(headerKey);
    if (owner !== undefined) {
      throw new AskUserQuestionValidationError(
        `${path}.header "${header}" duplicates questions[${owner}].header; headers label the tabs and must be distinct`
      );
    }
    headerOwners.set(headerKey, questionIndex);

    const multiSelect = value.multiSelect === true;

    const options = value.options;
    if (!Array.isArray(options) || options.length < MIN_OPTIONS) {
      const count = Array.isArray(options) ? options.length : 0;
      throw new AskUserQuestionValidationError(
        `${path}.options has ${count} ${count === 1 ? 'entry' : 'entries'} (min ${MIN_OPTIONS})`
      );
    }
    if (options.length > MAX_OPTIONS) {
      throw new AskUserQuestionValidationError(
        `${path}.options has ${options.length} entries (max ${MAX_OPTIONS})`
      );
    }

    return {
      question,
      header,
      multiSelect,
      options: options.map((option, optionIndex) =>
        normalizeOption(option, `${path}.options[${optionIndex}]`)
      )
    };
  });
}
