import type { ThemeLike } from '../src/render.js';
import type { NormalizedQuestion } from '../src/schema.js';
import { type DialogAction, type DialogResult, DialogState } from '../src/state.js';

/** Theme stub that returns text unchanged so assertions stay readable. */
export const plainTheme = {
  fg: (_color: unknown, text: string) => text,
  bg: (_color: unknown, text: string) => text,
  bold: (text: string) => text
} as unknown as ThemeLike;

export function makeQuestion(overrides: Partial<NormalizedQuestion> = {}): NormalizedQuestion {
  return {
    question: 'Which approach?',
    header: 'Approach',
    multiSelect: false,
    options: [
      { label: 'Incremental', description: 'Smaller diffs' },
      { label: 'Rewrite', description: 'Faster end state' }
    ],
    ...overrides
  };
}

export interface Harness {
  state: DialogState;
  results: DialogResult[];
  press(...actions: DialogAction[]): void;
}

export function harness(questions: NormalizedQuestion[]): Harness {
  const results: DialogResult[] = [];
  const state = new DialogState(questions, (result) => results.push(result));
  return {
    state,
    results,
    press: (...actions: DialogAction[]) => {
      for (const action of actions) state.handleAction(action);
    }
  };
}
