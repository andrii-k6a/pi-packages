import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';
import { MAX_PREVIEW_LINES } from '../src/layout.js';
import { helpText, type RenderDeps, renderDialog } from '../src/render.js';
import type { NormalizedQuestion } from '../src/schema.js';
import type { DialogAction, DialogSnapshot } from '../src/state.js';
import { harness, makeQuestion, plainTheme } from './helpers.js';

const deps: RenderDeps = {
  renderPreview: (markdown, innerWidth) =>
    markdown.split('\n').map((line) => line.slice(0, innerWidth)),
  renderEditor: (width) => [`editor:${width}`]
};

function render(
  questions: NormalizedQuestion[],
  snap: DialogSnapshot,
  width = 100,
  overrides: Partial<RenderDeps> = {}
): string[] {
  return renderDialog(questions, snap, plainTheme, width, { ...deps, ...overrides });
}

describe('renderDialog', () => {
  it('shows the question, options, descriptions and the free-text row', () => {
    const questions = [makeQuestion()];
    const output = render(questions, harness(questions).state.snapshot()).join('\n');

    expect(output).toContain('Which approach?');
    expect(output).toContain('1. Incremental');
    expect(output).toContain('Smaller diffs');
    expect(output).toContain('2. Rewrite');
    expect(output).toContain('3. Type something.');
  });

  it('marks the focused row with a caret', () => {
    const questions = [makeQuestion()];
    const { state, press } = harness(questions);
    press('down');

    const lines = render(questions, state.snapshot());

    expect(lines.some((line) => line.startsWith('> 2. Rewrite'))).toBe(true);
    expect(lines.some((line) => line.startsWith('  1. Incremental'))).toBe(true);
  });

  it('renders a focused preview alongside checkbox selections for multiSelect questions', () => {
    const questions = [
      makeQuestion({
        multiSelect: true,
        options: [
          { label: 'Incremental', description: 'Smaller diffs', preview: 'PREVIEW-BODY' },
          { label: 'Rewrite', description: 'Faster end state' }
        ]
      })
    ];
    const { state, press } = harness(questions);
    press('space');

    const wideOutput = render(questions, state.snapshot()).join('\n');
    const narrowLines = render(questions, state.snapshot(), 60);
    const narrowPreviewRow = narrowLines.find((line) => line.includes('PREVIEW-BODY'));

    expect(wideOutput).toContain('[x] 1. Incremental');
    expect(wideOutput).toContain('[ ] 2. Rewrite');
    expect(wideOutput).toContain('PREVIEW-BODY');
    expect(narrowPreviewRow).toBeDefined();
    expect(narrowPreviewRow).not.toContain('Smaller diffs');
  });

  it.each([false, true])('aligns descriptions under the label (multiSelect: %s)', (multiSelect) => {
    const questions = [makeQuestion({ multiSelect })];
    const lines = render(questions, harness(questions).state.snapshot());
    const labelLine = lines.find((line) => line.includes('1. Incremental')) ?? '';
    const descriptionLine = lines.find((line) => line.includes('Smaller diffs')) ?? '';

    const indent = descriptionLine.length - descriptionLine.trimStart().length;
    expect(indent).toBe(labelLine.indexOf('Incremental'));
  });

  it('marks a chosen single-select option when revisited', () => {
    const questions = [makeQuestion({ header: 'A' }), makeQuestion({ header: 'B' })];
    const { state, press } = harness(questions);
    press('enter', 'shiftTab');

    expect(render(questions, state.snapshot()).join('\n')).toContain('1. Incremental ✓');
  });

  it('renders a tab bar with answered markers only for multiple questions', () => {
    const single = [makeQuestion()];
    expect(render(single, harness(single).state.snapshot()).join('\n')).not.toContain('Submit');

    const questions = [makeQuestion({ header: 'Scope' }), makeQuestion({ header: 'Library' })];
    const { state, press } = harness(questions);
    press('enter');
    const output = render(questions, state.snapshot()).join('\n');

    expect(output).toContain('■ Scope');
    expect(output).toContain('□ Library');
    expect(output).toContain('✓ Submit');
  });

  it('summarizes answers on the submit tab', () => {
    const questions = [makeQuestion({ header: 'Scope' }), makeQuestion({ header: 'Library' })];
    const { state, press } = harness(questions);
    press('enter', 'enter');

    const output = render(questions, state.snapshot()).join('\n');

    expect(output).toContain('Ready to submit');
    expect(output).toContain('Scope: Incremental');
    expect(output).toContain('Press Enter to submit');
  });

  it('lists unanswered headers when the submit tab is reached early', () => {
    const questions = [makeQuestion({ header: 'Scope' }), makeQuestion({ header: 'Library' })];
    const { state, press } = harness(questions);
    press('tab', 'tab');

    expect(render(questions, state.snapshot()).join('\n')).toContain('Unanswered: Scope, Library');
  });

  it('renders the editor and hides the preview while typing', () => {
    const questions = [
      makeQuestion({
        options: [
          { label: 'A', description: 'first', preview: 'PREVIEW-BODY' },
          { label: 'B', description: 'second' }
        ]
      })
    ];
    const { state, press } = harness(questions);
    press('down', 'down', 'enter');

    const output = render(questions, state.snapshot()).join('\n');

    expect(output).toContain('Your answer:');
    expect(output).toContain('editor:98');
    expect(output).toContain('Type something. ✎');
    expect(output).not.toContain('PREVIEW-BODY');
  });
});

describe('renderDialog previews', () => {
  const questions = [
    makeQuestion({
      options: [
        { label: 'A', description: 'first', preview: 'PREVIEW-A' },
        { label: 'B', description: 'second' }
      ]
    })
  ];

  it('places the preview beside the options on wide terminals', () => {
    const lines = render(questions, harness(questions).state.snapshot(), 100);
    const optionRow = lines.find((line) => line.includes('1. A'));
    const previewRow = lines.find((line) => line.includes('PREVIEW-A'));

    // The box opens on the first option row, so its content shares the next one.
    expect(optionRow).toContain('┌');
    expect(previewRow).toContain('first');
    expect(previewRow).toContain('│');
  });

  it('stacks the preview under the options on narrow terminals', () => {
    const lines = render(questions, harness(questions).state.snapshot(), 60);
    const optionRow = lines.find((line) => line.includes('1. A'));
    const previewRow = lines.find((line) => line.includes('PREVIEW-A'));

    expect(optionRow).not.toContain('┌');
    expect(previewRow).toBeDefined();
    expect(previewRow).not.toContain('first');
  });

  it('shows no preview pane when the focused option has none', () => {
    const { state, press } = harness(questions);
    press('down');

    expect(render(questions, state.snapshot()).join('\n')).not.toContain('PREVIEW-A');
  });

  it('clips long previews and notes how many lines were hidden', () => {
    const long = Array.from({ length: MAX_PREVIEW_LINES + 10 }, (_v, i) => `line${i}`).join('\n');
    const withLongPreview = [
      makeQuestion({
        options: [
          { label: 'A', description: 'first', preview: long },
          { label: 'B', description: 'second' }
        ]
      })
    ];

    const output = render(withLongPreview, harness(withLongPreview).state.snapshot()).join('\n');

    expect(output).toContain('… 11 more lines');
    expect(output).not.toContain('line33');
  });
});

describe('renderDialog width safety', () => {
  const questions = [
    makeQuestion({
      header: 'Scope',
      question: 'A deliberately long question that has to wrap across several terminal lines?',
      options: [
        {
          label: 'An option label that is quite long indeed',
          description: 'A long description that also needs to wrap somewhere sensible',
          preview: 'PREVIEW line one\nPREVIEW line two that is fairly long as well'
        },
        { label: 'Short', description: 'Brief' }
      ]
    }),
    makeQuestion({ header: 'Library', question: 'Which library?', multiSelect: true })
  ];

  it.each([20, 40, 60, 76, 80, 100, 160])('never exceeds width %i', (width) => {
    const { state, press } = harness(questions);

    // Walk the dialog: focused option with preview, second question, toggle, submit tab.
    const snapshots: DialogSnapshot[] = [state.snapshot()];
    for (const action of ['down', 'tab', 'space', 'tab'] satisfies DialogAction[]) {
      press(action);
      snapshots.push(state.snapshot());
    }

    for (const snapshot of snapshots) {
      for (const line of render(questions, snapshot, width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});

describe('helpText', () => {
  it('describes single-select navigation', () => {
    const questions = [makeQuestion()];
    expect(helpText(questions[0], harness(questions).state.snapshot())).toBe(
      '↑↓ navigate • Enter select • Esc cancel'
    );
  });

  it('mentions question navigation when there are several questions', () => {
    const questions = [makeQuestion({ header: 'A' }), makeQuestion({ header: 'B' })];
    expect(helpText(questions[0], harness(questions).state.snapshot())).toContain('Tab/←→');
  });

  it('nudges multiSelect questions with no selection yet', () => {
    const questions = [makeQuestion({ multiSelect: true })];
    const { state, press } = harness(questions);

    expect(helpText(questions[0], state.snapshot())).toContain('Space select at least one');

    press('space');
    expect(helpText(questions[0], state.snapshot())).toContain('Enter confirm');
  });

  it('switches to editor hints while typing', () => {
    const questions = [makeQuestion()];
    const { state, press } = harness(questions);
    press('down', 'down', 'enter');

    expect(helpText(questions[0], state.snapshot())).toBe('Enter submit • Esc back to options');
  });
});
