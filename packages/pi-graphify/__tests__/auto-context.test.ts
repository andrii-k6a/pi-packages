import { describe, expect, it } from 'vitest';
import {
  appendTextHint,
  buildSessionHintText,
  buildToolResultHintText,
  classifyPromptIntent,
  classifyToolIntent,
  makeDedupeKey,
  summarizeToolSignal
} from '../src/auto-context.js';
import { DEFAULT_CONFIG } from '../src/config.js';

describe('auto-context pure helpers', () => {
  it('detects architecture prompt intent', () => {
    expect(classifyPromptIntent('Explain module dependencies', ['dependency', 'module'])).toBe(
      'architecture-question'
    );
    expect(classifyPromptIntent('Fix typo', ['dependency'])).toBe('none');
  });

  it('builds session hint with configured outputDir', () => {
    const hint = buildSessionHintText({ outputDir: 'custom-out', hasWiki: true, hasReport: false });

    expect(hint).toContain('custom-out/graph.json');
    expect(hint).toContain('custom-out/wiki/index.md');
    expect(hint).not.toContain('GRAPH_REPORT.md');
  });

  it('summarizes tool signal from text content and input', () => {
    const signal = summarizeToolSignal({
      toolName: 'bash',
      input: { command: 'rg dependency src' },
      content: [{ type: 'text', text: 'src/a.ts:1\nsrc/b.ts:2' }]
    });

    expect(signal.target).toBe('rg dependency src');
    expect(signal.lineCount).toBe(2);
  });

  it('classifies broad search and docs results', () => {
    const broad = summarizeToolSignal({
      toolName: 'bash',
      input: { command: 'rg dependency src' },
      content: [
        { type: 'text', text: Array.from({ length: 10 }, (_, i) => `src/f${i}.ts`).join('\n') }
      ]
    });
    expect(classifyToolIntent(broad, 'none', DEFAULT_CONFIG.autoContext)).toBe(
      'architecture-question'
    );

    const docs = summarizeToolSignal({
      toolName: 'read',
      input: { path: 'docs/plan.md' },
      content: [{ type: 'text', text: 'short' }]
    });
    expect(classifyToolIntent(docs, 'none', DEFAULT_CONFIG.autoContext)).toBe('docs-or-plan');
  });

  it('builds bounded tool result hints', () => {
    const hint = buildToolResultHintText({
      intent: 'multi-file-result',
      target: 'src',
      budget: 1200,
      maxChars: 80
    });

    expect(hint).toBeDefined();
    expect(hint?.length).toBeLessThanOrEqual(80);
  });

  it('dedupes with normalized keys and appends text hints', () => {
    const signal = { toolName: 'read', target: ' README.md ', haystack: '', lineCount: 1 };

    expect(makeDedupeKey('overview-file', signal)).toBe('read|overview-file|readme.md');
    expect(appendTextHint([{ type: 'text', text: 'original' }], 'hint')).toEqual([
      { type: 'text', text: 'original' },
      { type: 'text', text: 'hint' }
    ]);
  });
});
