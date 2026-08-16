import type { Theme, ThemeColor } from '@earendil-works/pi-coding-agent';
import { truncateToWidth } from '@earendil-works/pi-tui';
import {
  boxLines,
  clampLines,
  computePreviewLayout,
  joinColumns,
  MAX_PREVIEW_LINES,
  padToWidth,
  wrapWithPrefix
} from './layout.js';
import { CUSTOM_OPTION_LABEL, type NormalizedQuestion } from './schema.js';
import type { DialogSnapshot, QuestionViewState } from './state.js';

/** Subset of the interactive theme the dialog needs. */
export type ThemeLike = Pick<Theme, 'fg' | 'bg' | 'bold'>;

export interface RenderDeps {
  /** Render markdown preview content to at most `innerWidth` columns. */
  renderPreview(markdown: string, innerWidth: number): string[];
  /** Render the free-text editor to at most `width` columns. */
  renderEditor(width: number): string[];
}

export function helpText(question: NormalizedQuestion | undefined, snap: DialogSnapshot): string {
  if (snap.inputMode) return 'Enter submit • Esc back to options';
  if (snap.onSubmitTab) return 'Tab/←→ navigate • Enter submit • Esc cancel';

  const navigate = snap.isMulti ? 'Tab/←→ questions • ↑↓ move' : '↑↓ navigate';
  if (question?.multiSelect) {
    const state = snap.questions[snap.tabIndex];
    if (state && !state.answered) return `${navigate} • Space select at least one • Esc cancel`;
    return `${navigate} • Space toggle • Enter confirm • Esc cancel`;
  }
  return `${navigate} • Enter select • Esc cancel`;
}

function renderTabBar(
  questions: NormalizedQuestion[],
  snap: DialogSnapshot,
  theme: ThemeLike,
  width: number
): string[] {
  const cells: string[] = ['← '];
  questions.forEach((question, index) => {
    const answered = snap.questions[index]?.answered === true;
    const text = ` ${answered ? '■' : '□'} ${question.header} `;
    cells.push(
      index === snap.tabIndex
        ? `${theme.bg('selectedBg', theme.fg('text', text))} `
        : `${theme.fg(answered ? 'success' : 'muted', text)} `
    );
  });

  const submitText = ' ✓ Submit ';
  cells.push(
    snap.onSubmitTab
      ? `${theme.bg('selectedBg', theme.fg('text', submitText))} →`
      : `${theme.fg(snap.allAnswered ? 'success' : 'dim', submitText)} →`
  );

  return wrapWithPrefix(' ', cells.join(''), width);
}

function optionRowColor(focused: boolean, chosen: boolean): ThemeColor {
  if (focused) return 'accent';
  return chosen ? 'success' : 'text';
}

function renderOptionRows(
  question: NormalizedQuestion,
  state: QuestionViewState,
  snap: DialogSnapshot,
  theme: ThemeLike,
  width: number
): string[] {
  const customRow = question.options.length;
  const lines: string[] = [];

  for (let row = 0; row <= customRow; row += 1) {
    const isCustomRow = row === customRow;
    const focused = row === snap.cursor;
    const chosen = isCustomRow ? state.customText !== undefined : state.selected.includes(row);

    const prefix = focused ? theme.fg('accent', '> ') : '  ';
    const marker = question.multiSelect ? (chosen ? '[x] ' : '[ ] ') : '';
    const label = isCustomRow ? CUSTOM_OPTION_LABEL : question.options[row].label;
    // Line up descriptions under the label: cursor + checkbox + "N. ".
    const descriptionIndent = ' '.repeat(2 + marker.length + 3);

    let suffix = '';
    if (isCustomRow && snap.inputMode) suffix = ' ✎';
    else if (chosen && !question.multiSelect) suffix = ' ✓';

    lines.push(
      ...wrapWithPrefix(
        prefix,
        theme.fg(optionRowColor(focused, chosen), `${marker}${row + 1}. ${label}${suffix}`),
        width
      )
    );

    const description = isCustomRow ? state.customText : question.options[row].description;
    if (description) {
      lines.push(...wrapWithPrefix(descriptionIndent, theme.fg('muted', description), width));
    }
  }

  return lines;
}

function renderPreviewBox(
  markdown: string,
  innerWidth: number,
  theme: ThemeLike,
  deps: RenderDeps
): string[] {
  const content = clampLines(
    deps.renderPreview(markdown, innerWidth),
    MAX_PREVIEW_LINES,
    (hidden) => theme.fg('dim', `… ${hidden} more line${hidden === 1 ? '' : 's'}`)
  );
  return boxLines(content, innerWidth, (text) => theme.fg('borderMuted', text));
}

function renderSummary(
  questions: NormalizedQuestion[],
  snap: DialogSnapshot,
  theme: ThemeLike,
  width: number
): string[] {
  const lines = wrapWithPrefix(' ', theme.fg('accent', theme.bold('Ready to submit')), width);
  lines.push('');

  questions.forEach((question, index) => {
    const state = snap.questions[index];
    if (!state?.answered) return;
    const picked = state.selected.map((option) => question.options[option].label);
    if (state.customText !== undefined) picked.push(`(wrote) ${state.customText}`);
    lines.push(
      ...wrapWithPrefix(
        ' ',
        `${theme.fg('muted', `${question.header}: `)}${theme.fg('text', picked.join(', '))}`,
        width
      )
    );
  });

  lines.push('');
  lines.push(
    ...wrapWithPrefix(
      ' ',
      snap.allAnswered
        ? theme.fg('success', 'Press Enter to submit')
        : theme.fg('warning', `Unanswered: ${snap.unansweredHeaders.join(', ')}`),
      width
    )
  );
  return lines;
}

/** Render the whole dialog. Every returned line fits within `width`. */
export function renderDialog(
  questions: NormalizedQuestion[],
  snap: DialogSnapshot,
  theme: ThemeLike,
  width: number,
  deps: RenderDeps
): string[] {
  const renderWidth = Math.max(1, width);
  const rule = theme.fg('accent', '─'.repeat(renderWidth));
  const lines: string[] = [rule];

  if (snap.isMulti) {
    lines.push(...renderTabBar(questions, snap, theme, renderWidth));
    lines.push('');
  }

  if (snap.onSubmitTab) {
    lines.push(...renderSummary(questions, snap, theme, renderWidth));
  } else {
    const question = questions[snap.tabIndex];
    const state = snap.questions[snap.tabIndex];
    lines.push(...wrapWithPrefix(' ', theme.fg('text', question.question), renderWidth));
    lines.push('');

    // The focused option's preview yields the pane to the editor while typing.
    const focusedPreview = snap.inputMode ? undefined : question.options[snap.cursor]?.preview;
    const layout = focusedPreview ? computePreviewLayout(renderWidth) : undefined;

    if (focusedPreview && layout) {
      lines.push(
        ...joinColumns(
          renderOptionRows(question, state, snap, theme, layout.leftWidth),
          renderPreviewBox(focusedPreview, layout.previewInnerWidth, theme, deps),
          layout.leftWidth
        )
      );
    } else {
      lines.push(...renderOptionRows(question, state, snap, theme, renderWidth));
      if (focusedPreview) {
        lines.push('');
        lines.push(
          ...renderPreviewBox(focusedPreview, Math.max(1, renderWidth - 2), theme, deps).map(
            (line) => padToWidth(line, renderWidth).replace(/ +$/, '')
          )
        );
      }
    }

    if (snap.inputMode) {
      lines.push('');
      lines.push(...wrapWithPrefix(' ', theme.fg('muted', 'Your answer:'), renderWidth));
      for (const line of deps.renderEditor(Math.max(1, renderWidth - 2))) {
        lines.push(` ${line}`);
      }
    }
  }

  lines.push('');
  lines.push(
    ...wrapWithPrefix(' ', theme.fg('dim', helpText(questions[snap.tabIndex], snap)), renderWidth)
  );
  lines.push(rule);

  return lines.map((line) => truncateToWidth(line, renderWidth));
}
