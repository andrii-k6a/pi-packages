import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { runQuestionDialog } from './dialog.js';
import {
  type AskUserQuestionDetails,
  formatDetails,
  summarizeCall,
  UNAVAILABLE_TEXT
} from './format.js';
import {
  AskUserQuestionParams,
  CUSTOM_OPTION_LABEL,
  MAX_OPTIONS,
  MAX_QUESTIONS,
  MIN_OPTIONS
} from './schema.js';
import { normalizeQuestions } from './validate.js';

const DESCRIPTION = `Ask the user one or more structured questions in a terminal dialog and get their choices back. Use when:
1. The request is underspecified and you need concrete decisions before continuing
2. Clarifying ambiguous instructions
3. Gathering preferences or requirements
4. Offering choices about which direction to take

Usage notes:
- Ask at most ${MAX_QUESTIONS} questions per call, each with ${MIN_OPTIONS}-${MAX_OPTIONS} written-out options.
- Every option needs a short label and a description explaining the choice or its trade-offs.
- A "${CUSTOM_OPTION_LABEL}" free-text row is appended to every question automatically, and the user can dismiss the dialog entirely. Never author "Other" or "${CUSTOM_OPTION_LABEL}" options yourself; they are rejected.
- Set multiSelect: true when several answers are valid.
- Add an option preview (markdown: mockups, code snippets, diagrams, configs) when options are easier to compare visually. The focused option's preview renders beside the option list.
- Group all clarifying questions into one call instead of asking repeatedly.
- If you recommend an option, make it first and append "(Recommended)" to its label.`;

export default function askQuestion(pi: ExtensionAPI): void {
  pi.registerTool<typeof AskUserQuestionParams, AskUserQuestionDetails>({
    name: 'ask_user_question',
    label: 'Ask User Question',
    description: DESCRIPTION,
    promptSnippet: `Ask the user up to ${MAX_QUESTIONS} multiple-choice questions and get structured answers back`,
    promptGuidelines: [
      'Use ask_user_question instead of guessing when a request is underspecified and you cannot proceed without concrete decisions.',
      `ask_user_question accepts at most ${MAX_QUESTIONS} questions with ${MIN_OPTIONS}-${MAX_OPTIONS} options each; every option needs a concise label and a description.`,
      `Do not author "Other" or "${CUSTOM_OPTION_LABEL}" options for ask_user_question; a free-text row is appended to every question automatically.`,
      'Group all clarifying ask_user_question questions into one call rather than asking several times in a row.'
    ],
    parameters: AskUserQuestionParams,
    // Takes over the editor, so it must not run alongside other tool calls.
    executionMode: 'sequential',

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const questions = normalizeQuestions(params);

      if (ctx.mode !== 'tui') {
        const details: AskUserQuestionDetails = {
          cancelled: true,
          answers: [],
          unavailable: true
        };
        return { content: [{ type: 'text', text: UNAVAILABLE_TEXT }], details };
      }

      const result = await runQuestionDialog(ctx, questions, signal);
      return { content: [{ type: 'text', text: formatDetails(result) }], details: result };
    },

    renderCall(args, theme) {
      const { count, headers } = summarizeCall(args);
      let text = theme.fg('toolTitle', theme.bold('ask_user_question '));
      text += theme.fg('muted', `${count} question${count === 1 ? '' : 's'}`);
      if (headers) text += theme.fg('dim', ` (${headers})`);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const details = result.details;
      if (!details) {
        const block = result.content[0];
        return new Text(block?.type === 'text' ? block.text : '', 0, 0);
      }
      if (details.unavailable) {
        return new Text(theme.fg('warning', 'No UI in this run mode — not asked'), 0, 0);
      }
      if (details.cancelled || details.answers.length === 0) {
        return new Text(theme.fg('warning', 'Dismissed'), 0, 0);
      }

      const lines = details.answers.map((answer) => {
        const picked = answer.selections.map((selection) =>
          selection.custom
            ? `${theme.fg('muted', '(wrote) ')}${selection.label}`
            : `${selection.index}. ${selection.label}`
        );
        return `${theme.fg('success', '✓ ')}${theme.fg('accent', answer.header)}: ${picked.join(', ')}`;
      });
      return new Text(lines.join('\n'), 0, 0);
    }
  });
}
