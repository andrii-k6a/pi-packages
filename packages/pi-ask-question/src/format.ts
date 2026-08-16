import type { AskUserQuestionInput } from './schema.js';
import type { Answer, AnswerSelection, DialogResult } from './state.js';

/** Tool result payload. `unavailable` marks non-interactive runs. */
export interface AskUserQuestionDetails extends DialogResult {
  unavailable?: boolean;
}

export const UNAVAILABLE_TEXT =
  'ask_user_question: no UI available in this run mode, so no questions were asked. Proceed with your best judgement and state the assumptions you made.';

export const CANCELLED_TEXT =
  'User dismissed the questionnaire without submitting. No answers were recorded.';

function describeSelections(selections: AnswerSelection[]): string {
  const picked = selections
    .filter((selection) => !selection.custom)
    .map((selection) => `${selection.index}. ${selection.label}`);
  const custom = selections.find((selection) => selection.custom);

  const parts: string[] = [];
  if (picked.length > 0) parts.push(`user selected ${picked.join(', ')}`);
  if (custom)
    parts.push(picked.length > 0 ? `wrote: ${custom.label}` : `user wrote: ${custom.label}`);
  return parts.join('; ');
}

/** One line per answered question, keyed by header. */
export function formatAnswers(answers: Answer[]): string {
  return answers
    .map((answer) => `${answer.header}: ${describeSelections(answer.selections)}`)
    .join('\n');
}

/** Text handed back to the model. */
export function formatDetails(details: AskUserQuestionDetails): string {
  if (details.unavailable) return UNAVAILABLE_TEXT;
  if (details.cancelled) return CANCELLED_TEXT;
  if (details.answers.length === 0) return CANCELLED_TEXT;
  return formatAnswers(details.answers);
}

/** Short call summary for the tool call header, e.g. `2 questions (Scope, Library)`. */
export function summarizeCall(input: AskUserQuestionInput | undefined): {
  count: number;
  headers: string;
} {
  const questions = Array.isArray(input?.questions) ? input.questions : [];
  return {
    count: questions.length,
    headers: questions
      .map((question) => question?.header)
      .filter((header): header is string => typeof header === 'string' && header.length > 0)
      .join(', ')
  };
}
