import type { NormalizedQuestion } from './schema.js';

/** Semantic keys the dialog understands, decoded from raw terminal input. */
export type DialogAction =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'tab'
  | 'shiftTab'
  | 'enter'
  | 'space'
  | 'escape';

/** One chosen option, or free text the user typed. */
export interface AnswerSelection {
  /** 1-based option number, or null when the user typed their own answer. */
  index: number | null;
  /** Option label, or the typed text. */
  label: string;
  custom: boolean;
}

export interface Answer {
  header: string;
  question: string;
  multiSelect: boolean;
  selections: AnswerSelection[];
}

export interface DialogResult {
  cancelled: boolean;
  /** Answered questions only, in question order. */
  answers: Answer[];
}

export interface QuestionViewState {
  answered: boolean;
  /** 0-based option indexes, ascending. */
  selected: number[];
  customText?: string;
}

/** Plain snapshot consumed by the renderer, so rendering stays pure. */
export interface DialogSnapshot {
  isMulti: boolean;
  tabIndex: number;
  onSubmitTab: boolean;
  cursor: number;
  rowCount: number;
  inputMode: boolean;
  questions: QuestionViewState[];
  allAnswered: boolean;
  unansweredHeaders: string[];
}

/**
 * Keyboard-driven questionnaire state.
 *
 * Single-select: Enter picks the focused option and advances.
 * Multi-select: Space toggles the focused option, Enter confirms the question.
 * The last row of every question is the free-text row; choosing it opens an
 * editor, whose text arrives via {@link DialogState.submitCustomText}.
 */
export class DialogState {
  readonly #questions: NormalizedQuestion[];
  readonly #onDone: (result: DialogResult) => void;
  readonly #cursors: number[];
  readonly #selected: Set<number>[];
  readonly #customText: (string | undefined)[];
  #tabIndex = 0;
  #inputMode = false;
  #finished = false;

  constructor(questions: NormalizedQuestion[], onDone: (result: DialogResult) => void) {
    if (questions.length === 0) {
      throw new Error('DialogState requires at least one question');
    }
    this.#questions = questions;
    this.#onDone = onDone;
    this.#cursors = questions.map(() => 0);
    this.#selected = questions.map(() => new Set<number>());
    this.#customText = questions.map(() => undefined);
  }

  get isMulti(): boolean {
    return this.#questions.length > 1;
  }

  /** Index of the trailing Submit tab, or -1 for a single question. */
  get submitTabIndex(): number {
    return this.isMulti ? this.#questions.length : -1;
  }

  get onSubmitTab(): boolean {
    return this.#tabIndex === this.submitTabIndex;
  }

  /** Index of the question in view, or undefined on the Submit tab. */
  currentQuestionIndex(): number | undefined {
    return this.onSubmitTab ? undefined : this.#tabIndex;
  }

  /** Free-text row index for a question (always last). */
  customRowIndex(questionIndex: number): number {
    return this.#questions[questionIndex].options.length;
  }

  rowCount(questionIndex: number): number {
    return this.#questions[questionIndex].options.length + 1;
  }

  /** Text typed for the question in view, used to prefill the editor. */
  customTextForCurrent(): string | undefined {
    const index = this.currentQuestionIndex();
    return index === undefined ? undefined : this.#customText[index];
  }

  allAnswered(): boolean {
    return this.#questions.every((_question, index) => this.#isAnswered(index));
  }

  unansweredHeaders(): string[] {
    return this.#questions
      .filter((_question, index) => !this.#isAnswered(index))
      .map((question) => question.header);
  }

  handleAction(action: DialogAction): void {
    if (this.#finished) return;

    if (this.#inputMode) {
      // While typing, all other input belongs to the editor.
      if (action === 'escape') this.cancelCustomInput();
      return;
    }

    if (this.isMulti && (action === 'tab' || action === 'right')) {
      this.#moveTab(1);
      return;
    }
    if (this.isMulti && (action === 'shiftTab' || action === 'left')) {
      this.#moveTab(-1);
      return;
    }
    if (action === 'escape') {
      this.#finish(true);
      return;
    }

    if (this.onSubmitTab) {
      if (action === 'enter' && this.allAnswered()) this.#finish(false);
      return;
    }

    const questionIndex = this.#tabIndex;
    if (action === 'up') {
      this.#cursors[questionIndex] = Math.max(0, this.#cursors[questionIndex] - 1);
      return;
    }
    if (action === 'down') {
      this.#cursors[questionIndex] = Math.min(
        this.rowCount(questionIndex) - 1,
        this.#cursors[questionIndex] + 1
      );
      return;
    }

    const cursor = this.#cursors[questionIndex];
    const onCustomRow = cursor === this.customRowIndex(questionIndex);

    if (this.#questions[questionIndex].multiSelect) {
      if (action === 'space') {
        if (onCustomRow) {
          // Toggle typed text off, or open the editor to add it.
          if (this.#customText[questionIndex] !== undefined) {
            this.#customText[questionIndex] = undefined;
          } else {
            this.#inputMode = true;
          }
          return;
        }
        const selected = this.#selected[questionIndex];
        if (selected.has(cursor)) selected.delete(cursor);
        else selected.add(cursor);
        return;
      }
      if (action === 'enter' && this.#isAnswered(questionIndex)) this.#advance();
      return;
    }

    if (action === 'enter' || action === 'space') {
      if (onCustomRow) {
        this.#inputMode = true;
        return;
      }
      this.#selected[questionIndex] = new Set([cursor]);
      this.#customText[questionIndex] = undefined;
      this.#advance();
    }
  }

  /** Record editor text for the question in view. Empty text records nothing. */
  submitCustomText(text: string): void {
    if (this.#finished || !this.#inputMode) return;
    const questionIndex = this.currentQuestionIndex();
    if (questionIndex === undefined) return;

    this.#inputMode = false;
    const trimmed = text.trim();
    if (trimmed.length === 0) return;

    this.#customText[questionIndex] = trimmed;
    if (this.#questions[questionIndex].multiSelect) return;

    // Free text replaces any earlier single-select pick.
    this.#selected[questionIndex] = new Set();
    this.#advance();
  }

  /** Leave the editor without recording anything. */
  cancelCustomInput(): void {
    this.#inputMode = false;
  }

  /** Abandon the questionnaire, e.g. when the tool call is aborted. */
  cancel(): void {
    if (this.#finished) return;
    this.#finish(true);
  }

  snapshot(): DialogSnapshot {
    const onSubmitTab = this.onSubmitTab;
    return {
      isMulti: this.isMulti,
      tabIndex: this.#tabIndex,
      onSubmitTab,
      cursor: onSubmitTab ? 0 : this.#cursors[this.#tabIndex],
      rowCount: onSubmitTab ? 0 : this.rowCount(this.#tabIndex),
      inputMode: this.#inputMode,
      questions: this.#questions.map((_question, index) => {
        const customText = this.#customText[index];
        const state: QuestionViewState = {
          answered: this.#isAnswered(index),
          selected: [...this.#selected[index]].sort((a, b) => a - b)
        };
        if (customText !== undefined) state.customText = customText;
        return state;
      }),
      allAnswered: this.allAnswered(),
      unansweredHeaders: this.unansweredHeaders()
    };
  }

  buildAnswers(): Answer[] {
    const answers: Answer[] = [];
    this.#questions.forEach((question, index) => {
      if (!this.#isAnswered(index)) return;
      const selections: AnswerSelection[] = [...this.#selected[index]]
        .sort((a, b) => a - b)
        .map((optionIndex) => ({
          index: optionIndex + 1,
          label: question.options[optionIndex].label,
          custom: false
        }));
      const customText = this.#customText[index];
      if (customText !== undefined) {
        selections.push({ index: null, label: customText, custom: true });
      }
      answers.push({
        header: question.header,
        question: question.question,
        multiSelect: question.multiSelect,
        selections
      });
    });
    return answers;
  }

  #isAnswered(questionIndex: number): boolean {
    return this.#selected[questionIndex].size > 0 || this.#customText[questionIndex] !== undefined;
  }

  #advance(): void {
    if (!this.isMulti) {
      this.#finish(false);
      return;
    }
    this.#tabIndex =
      this.#tabIndex < this.#questions.length - 1 ? this.#tabIndex + 1 : this.submitTabIndex;
  }

  #moveTab(delta: number): void {
    const total = this.#questions.length + 1;
    this.#tabIndex = (this.#tabIndex + delta + total) % total;
  }

  #finish(cancelled: boolean): void {
    this.#finished = true;
    this.#onDone({ cancelled, answers: this.buildAnswers() });
  }
}
