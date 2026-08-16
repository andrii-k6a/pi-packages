import {
  type ExtensionContext,
  getMarkdownTheme,
  type Theme
} from '@earendil-works/pi-coding-agent';
import {
  type Component,
  Editor,
  type EditorTheme,
  type Focusable,
  Key,
  Markdown,
  matchesKey,
  type TUI
} from '@earendil-works/pi-tui';
import { renderDialog } from './render.js';
import type { NormalizedQuestion } from './schema.js';
import { type DialogAction, type DialogResult, DialogState } from './state.js';

/** Map raw terminal input to a semantic dialog action. */
export function decodeAction(data: string): DialogAction | undefined {
  if (matchesKey(data, Key.up)) return 'up';
  if (matchesKey(data, Key.down)) return 'down';
  if (matchesKey(data, Key.shift('tab'))) return 'shiftTab';
  if (matchesKey(data, Key.tab)) return 'tab';
  if (matchesKey(data, Key.left)) return 'left';
  if (matchesKey(data, Key.right)) return 'right';
  if (matchesKey(data, Key.enter)) return 'enter';
  if (matchesKey(data, Key.space)) return 'space';
  if (matchesKey(data, Key.escape)) return 'escape';
  return undefined;
}

function editorTheme(theme: Theme): EditorTheme {
  return {
    borderColor: (text: string) => theme.fg('accent', text),
    selectList: {
      selectedPrefix: (text: string) => theme.fg('accent', text),
      selectedText: (text: string) => theme.fg('accent', text),
      description: (text: string) => theme.fg('muted', text),
      scrollInfo: (text: string) => theme.fg('dim', text),
      noMatch: (text: string) => theme.fg('warning', text)
    }
  };
}

class AskQuestionDialog implements Component, Focusable {
  readonly #tui: TUI;
  readonly #theme: Theme;
  readonly #questions: NormalizedQuestion[];
  readonly #state: DialogState;
  readonly #editor: Editor;
  readonly #previewCache = new Map<string, string[]>();
  #cachedLines: string[] | undefined;
  #cachedWidth: number | undefined;
  #focusedState = false;

  constructor(
    tui: TUI,
    theme: Theme,
    questions: NormalizedQuestion[],
    done: (result: DialogResult) => void
  ) {
    this.#tui = tui;
    this.#theme = theme;
    this.#questions = questions;
    this.#state = new DialogState(questions, done);
    this.#editor = new Editor(tui, editorTheme(theme));
    this.#editor.onSubmit = (value: string) => {
      this.#state.submitCustomText(value);
      this.#editor.setText('');
      this.#refresh();
    };
  }

  // Propagated to the editor so IME candidate windows are positioned correctly.
  get focused(): boolean {
    return this.#focusedState;
  }

  set focused(value: boolean) {
    this.#focusedState = value;
    this.#editor.focused = value;
  }

  /** Abandon the dialog from the outside, e.g. when the tool call is aborted. */
  cancel(): void {
    this.#state.cancel();
  }

  handleInput(data: string): void {
    if (this.#state.snapshot().inputMode) {
      if (matchesKey(data, Key.escape)) {
        this.#state.cancelCustomInput();
        this.#editor.setText('');
        this.#refresh();
        return;
      }
      this.#editor.handleInput(data);
      this.#refresh();
      return;
    }

    const action = decodeAction(data);
    if (!action) return;

    this.#state.handleAction(action);
    if (this.#state.snapshot().inputMode) {
      // Entering the editor: prefill with text already recorded for this question.
      this.#editor.setText(this.#state.customTextForCurrent() ?? '');
    }
    this.#refresh();
  }

  render(width: number): string[] {
    if (this.#cachedLines && this.#cachedWidth === width) return this.#cachedLines;
    const lines = renderDialog(this.#questions, this.#state.snapshot(), this.#theme, width, {
      renderPreview: (markdown, innerWidth) => this.#renderPreview(markdown, innerWidth),
      renderEditor: (editorWidth) => this.#editor.render(editorWidth)
    });
    this.#cachedLines = lines;
    this.#cachedWidth = width;
    return lines;
  }

  invalidate(): void {
    this.#cachedLines = undefined;
    this.#cachedWidth = undefined;
    // Markdown output bakes in theme colors, so it must be rebuilt too.
    this.#previewCache.clear();
    this.#editor.invalidate();
  }

  #renderPreview(markdown: string, innerWidth: number): string[] {
    const key = `${innerWidth}\u0000${markdown}`;
    const cached = this.#previewCache.get(key);
    if (cached) return cached;
    const lines = new Markdown(markdown, 0, 0, getMarkdownTheme()).render(innerWidth);
    this.#previewCache.set(key, lines);
    return lines;
  }

  #refresh(): void {
    this.#cachedLines = undefined;
    this.#cachedWidth = undefined;
    this.#tui.requestRender();
  }
}

/** Open the questionnaire and resolve once the user submits or dismisses it. */
export function runQuestionDialog(
  ctx: ExtensionContext,
  questions: NormalizedQuestion[],
  signal?: AbortSignal
): Promise<DialogResult> {
  return ctx.ui.custom<DialogResult>((tui, theme, _keybindings, done) => {
    let settled = false;
    const dialog = new AskQuestionDialog(tui, theme, questions, (result) => {
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      done(result);
    });

    function onAbort(): void {
      if (!settled) dialog.cancel();
    }

    if (signal?.aborted) dialog.cancel();
    else signal?.addEventListener('abort', onAbort, { once: true });

    return dialog;
  });
}
