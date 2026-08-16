import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ToolDefinition
} from '@earendil-works/pi-coding-agent';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { type Component, type TUI, visibleWidth } from '@earendil-works/pi-tui';
import { beforeAll, describe, expect, it } from 'vitest';
import askQuestion from '../src/ask-question.js';
import { type AskUserQuestionDetails, CANCELLED_TEXT, UNAVAILABLE_TEXT } from '../src/format.js';
import type { AskUserQuestionInput, AskUserQuestionParams } from '../src/schema.js';
import { plainTheme } from './helpers.js';

type AskTool = ToolDefinition<typeof AskUserQuestionParams, AskUserQuestionDetails>;

const KEY = {
  enter: '\r',
  escape: '\u001b',
  space: ' ',
  tab: '\t',
  down: '\u001b[B'
};

function loadTool(): AskTool {
  let captured: AskTool | undefined;
  const pi = {
    registerTool: (definition: unknown) => {
      captured = definition as AskTool;
    }
  } as unknown as ExtensionAPI;

  askQuestion(pi);
  if (!captured) throw new Error('registerTool was not called');
  return captured;
}

/** Fake TUI context that exposes the mounted component for keyboard driving. */
function tuiHarness() {
  let component: (Component & { handleInput?(data: string): void }) | undefined;
  const tui = { requestRender: () => {} } as unknown as TUI;

  const ctx = {
    mode: 'tui',
    hasUI: true,
    ui: {
      custom: (
        factory: (
          tui: TUI,
          theme: Theme,
          keybindings: unknown,
          done: (result: unknown) => void
        ) => Component
      ) =>
        new Promise((resolve) => {
          component = factory(tui, plainTheme as unknown as Theme, {}, resolve);
        })
    }
  } as unknown as ExtensionContext;

  return {
    ctx,
    send(...chunks: string[]) {
      for (const chunk of chunks) component?.handleInput?.(chunk);
    },
    render(width = 100): string[] {
      return component?.render(width) ?? [];
    }
  };
}

function singleQuestion(): AskUserQuestionInput {
  return {
    questions: [
      {
        question: 'Which approach?',
        header: 'Approach',
        options: [
          { label: 'Incremental', description: 'Smaller diffs' },
          { label: 'Rewrite', description: 'Faster end state' }
        ]
      }
    ]
  };
}

function twoQuestions(): AskUserQuestionInput {
  return {
    questions: [
      {
        question: 'Which approach?',
        header: 'Approach',
        options: [
          { label: 'Incremental', description: 'Smaller diffs' },
          { label: 'Rewrite', description: 'Faster end state' }
        ]
      },
      {
        question: 'Which checks?',
        header: 'Checks',
        multiSelect: true,
        options: [
          { label: 'Lint', description: 'Biome' },
          { label: 'Typecheck', description: 'tsc' }
        ]
      }
    ]
  };
}

beforeAll(() => {
  // getMarkdownTheme() reads the global theme when rendering option previews.
  initTheme('dark');
});

describe('registration', () => {
  it('registers a single sequential tool named ask_user_question', () => {
    const tool = loadTool();

    expect(tool.name).toBe('ask_user_question');
    expect(tool.label).toBe('Ask User Question');
    expect(tool.executionMode).toBe('sequential');
    expect(tool.promptSnippet).toBeTruthy();
    expect(tool.promptGuidelines?.length).toBeGreaterThan(0);
    for (const guideline of tool.promptGuidelines ?? []) {
      expect(guideline).toContain('ask_user_question');
    }
  });

  it('describes the limits and the reserved free-text row', () => {
    const tool = loadTool();

    expect(tool.description).toContain('at most 4 questions');
    expect(tool.description).toContain('2-4 written-out options');
    expect(tool.description).toContain('Type something.');
  });
});

describe('execute guards', () => {
  it('reports that no UI is available outside TUI mode', async () => {
    const tool = loadTool();
    const ctx = { mode: 'print' } as unknown as ExtensionContext;

    const result = await tool.execute('call-1', singleQuestion(), undefined, undefined, ctx);

    expect(result.details).toEqual({ cancelled: true, answers: [], unavailable: true });
    expect(result.content).toEqual([{ type: 'text', text: UNAVAILABLE_TEXT }]);
  });

  it('throws a descriptive error for a reserved option label', async () => {
    const tool = loadTool();
    const params = {
      questions: [
        {
          question: 'Which approach?',
          header: 'Approach',
          options: [
            { label: 'Incremental', description: 'Smaller diffs' },
            { label: 'Other', description: 'Something else' }
          ]
        }
      ]
    } as AskUserQuestionInput;

    await expect(
      tool.execute('call-2', params, undefined, undefined, tuiHarness().ctx)
    ).rejects.toThrow(/ask_user_question: questions\[0\]\.options\[1\]\.label "Other" is reserved/);
  });
});

describe('execute dialog flow', () => {
  it('returns the picked option for a single question', async () => {
    const tool = loadTool();
    const harness = tuiHarness();

    const pending = tool.execute('call-3', singleQuestion(), undefined, undefined, harness.ctx);
    harness.send(KEY.down, KEY.enter);
    const result = await pending;

    expect(result.details).toEqual({
      cancelled: false,
      answers: [
        {
          header: 'Approach',
          question: 'Which approach?',
          multiSelect: false,
          selections: [{ index: 2, label: 'Rewrite', custom: false }]
        }
      ]
    });
    expect(result.content[0]).toEqual({
      type: 'text',
      text: 'Approach: user selected 2. Rewrite'
    });
  });

  it('collects multi-select toggles and typed free text across questions', async () => {
    const tool = loadTool();
    const harness = tuiHarness();

    const pending = tool.execute('call-4', twoQuestions(), undefined, undefined, harness.ctx);

    // Q1: pick option 1, which advances to Q2.
    harness.send(KEY.enter);
    // Q2: toggle "Lint", move to the free-text row, type an extra answer.
    harness.send(KEY.space, KEY.down, KEY.down, KEY.space, 'and a smoke test', KEY.enter);
    // Confirm Q2, then submit from the Submit tab.
    harness.send(KEY.enter, KEY.enter);

    const result = await pending;

    expect(result.details?.cancelled).toBe(false);
    expect(result.details?.answers).toEqual([
      {
        header: 'Approach',
        question: 'Which approach?',
        multiSelect: false,
        selections: [{ index: 1, label: 'Incremental', custom: false }]
      },
      {
        header: 'Checks',
        question: 'Which checks?',
        multiSelect: true,
        selections: [
          { index: 1, label: 'Lint', custom: false },
          { index: null, label: 'and a smoke test', custom: true }
        ]
      }
    ]);
    expect(result.content[0]).toEqual({
      type: 'text',
      text: 'Approach: user selected 1. Incremental\nChecks: user selected 1. Lint; wrote: and a smoke test'
    });
  });

  it('reports a dismissed dialog without answers', async () => {
    const tool = loadTool();
    const harness = tuiHarness();

    const pending = tool.execute('call-5', singleQuestion(), undefined, undefined, harness.ctx);
    harness.send(KEY.escape);
    const result = await pending;

    expect(result.details).toEqual({ cancelled: true, answers: [] });
    expect(result.content[0]).toEqual({ type: 'text', text: CANCELLED_TEXT });
  });

  it('closes the dialog when the tool call is aborted', async () => {
    const tool = loadTool();
    const harness = tuiHarness();
    const controller = new AbortController();

    const pending = tool.execute(
      'call-6',
      singleQuestion(),
      controller.signal,
      undefined,
      harness.ctx
    );
    controller.abort();
    const result = await pending;

    expect(result.details).toEqual({ cancelled: true, answers: [] });
  });

  it('does not open a dialog when the signal is already aborted', async () => {
    const tool = loadTool();
    const harness = tuiHarness();

    const result = await tool.execute(
      'call-7',
      singleQuestion(),
      AbortSignal.abort(),
      undefined,
      harness.ctx
    );

    expect(result.details).toEqual({ cancelled: true, answers: [] });
  });
});

describe('mounted component rendering', () => {
  it('renders questions, options and a markdown preview', async () => {
    const tool = loadTool();
    const harness = tuiHarness();
    const params = {
      questions: [
        {
          question: 'Which library?',
          header: 'Library',
          options: [
            {
              label: 'date-fns',
              description: 'Tree-shakeable',
              preview: '# Snippet\n\n- immutable helpers'
            },
            { label: 'Luxon', description: 'Rich time zones' }
          ]
        }
      ]
    } as AskUserQuestionInput;

    const pending = tool.execute('call-8', params, undefined, undefined, harness.ctx);
    const output = harness.render(100).join('\n');

    expect(output).toContain('Which library?');
    expect(output).toContain('1. date-fns');
    expect(output).toContain('3. Type something.');
    expect(output).toContain('Snippet');
    expect(output).toContain('immutable helpers');
    expect(output).toContain('Enter select');

    harness.send(KEY.escape);
    await pending;
  });

  it('keeps every rendered line within the requested width', async () => {
    const tool = loadTool();
    const harness = tuiHarness();

    const pending = tool.execute('call-9', twoQuestions(), undefined, undefined, harness.ctx);

    for (const width of [24, 48, 76, 100]) {
      for (const line of harness.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }

    harness.send(KEY.tab, KEY.escape);
    await pending;
  });
});
