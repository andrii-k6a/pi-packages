import { describe, expect, it } from 'vitest';
import {
  formatRunResult,
  type GraphifyStatus,
  parseGraphifyCommand,
  splitArgs,
  statusText,
  truncateOutput
} from '../src/graphify.js';

const baseStatus: GraphifyStatus = {
  outDir: '/repo/graphify-out',
  graphJson: '/repo/graphify-out/graph.json',
  report: '/repo/graphify-out/GRAPH_REPORT.md',
  wikiIndex: '/repo/graphify-out/wiki/index.md',
  html: '/repo/graphify-out/graph.html',
  hasGraph: true,
  graphSize: 1024,
  hasReport: true,
  hasWiki: false,
  hasHtml: true,
  cliAvailable: true
};

describe('parseGraphifyCommand', () => {
  it('defaults empty input to status', () => {
    expect(parseGraphifyCommand('')).toEqual({ kind: 'status' });
  });

  it('parses explicit status', () => {
    expect(parseGraphifyCommand('status')).toEqual({ kind: 'status' });
  });

  it('parses query with the full question', () => {
    expect(parseGraphifyCommand('query What are the main modules?')).toEqual({
      kind: 'query',
      question: 'What are the main modules?'
    });
  });

  it('parses explain', () => {
    expect(parseGraphifyCommand('explain extract')).toEqual({
      kind: 'explain',
      concept: 'extract'
    });
  });

  it('parses path as first token plus remaining text', () => {
    expect(parseGraphifyCommand('path detect build')).toEqual({
      kind: 'path',
      from: 'detect',
      to: 'build'
    });
  });

  it('defaults update path to dot', () => {
    expect(parseGraphifyCommand('update')).toEqual({ kind: 'update', path: '.' });
  });

  it('parses extract path', () => {
    expect(parseGraphifyCommand('extract src')).toEqual({ kind: 'extract', path: 'src' });
  });

  it('parses quoted path endpoints', () => {
    expect(parseGraphifyCommand('path "Auth Module" "Database Layer"')).toEqual({
      kind: 'path',
      from: 'Auth Module',
      to: 'Database Layer'
    });
  });

  it('parses unknown subcommands', () => {
    expect(parseGraphifyCommand('nonsense')).toEqual({ kind: 'unknown', subcommand: 'nonsense' });
  });
});

describe('splitArgs', () => {
  it('keeps quoted strings together', () => {
    expect(splitArgs('path "Auth Module" "Database Layer"')).toEqual([
      'path',
      'Auth Module',
      'Database Layer'
    ]);
  });

  it('supports single quotes', () => {
    expect(splitArgs("explain 'Auth Module'")).toEqual(['explain', 'Auth Module']);
  });
});

describe('truncateOutput', () => {
  it('truncates long output and includes a notice', () => {
    const output = Array.from({ length: 2100 }, (_, index) => `line ${index}`).join('\n');
    const truncated = truncateOutput(output);

    expect(truncated).toContain('[Output truncated:');
    expect(truncated).toContain('showing first');
  });
});

describe('statusText', () => {
  it('renders present and missing artifacts', () => {
    const text = statusText(baseStatus);

    expect(text).toContain('- CLI: available');
    expect(text).toContain('- graph.json: present (1.0KB)');
    expect(text).toContain('- wiki/index.md: missing');
    expect(text).toContain('- graph.html: present');
  });
});

describe('formatRunResult', () => {
  it('renders missing CLI errors consistently', () => {
    expect(
      formatRunResult({
        ok: false,
        stdout: '',
        stderr: 'spawn graphify ENOENT',
        code: 1,
        errorCode: 'ENOENT'
      })
    ).toBe('Graphify CLI not found. Install with: `uv tool install graphifyy`.');
  });
});
