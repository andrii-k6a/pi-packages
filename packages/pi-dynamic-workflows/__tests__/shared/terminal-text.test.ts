import assert from 'node:assert/strict';
import { test } from 'vitest';
import { renderWorkflowLines } from '../../src/pi/display.js';
import { terminalInput, terminalLine, terminalMultiline } from '../../src/shared/terminal-text.js';

const hostile = '\u001b[31mname\u001b[0m\u0007\u009b2J\u202e\nnext\tword';

test('terminal policies distinguish input, single-line, and multiline text', () => {
  assert.equal(terminalLine(hostile), 'name next word');
  assert.equal(terminalMultiline(hostile), 'name\nnext  word');
  assert.equal(terminalInput('  a\u0007 b  '), '  a b  ');
  assert.equal(terminalMultiline('a\r\nb\rc'), 'a\nb\nc');
  assert.equal(terminalLine('Quick\u009d0;title\u009c triage'), 'Quick triage');
  assert.equal(terminalLine('\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007'), 'link');
});

test('live renderer sanitizes every model-written field without changing the snapshot', () => {
  const snapshot = {
    name: hostile,
    phases: [hostile],
    currentPhase: hostile,
    logs: [hostile],
    agents: [
      {
        id: 1,
        label: hostile,
        phase: hostile,
        profile: hostile,
        prompt: hostile,
        status: 'running' as const,
        activity: hostile,
        warning: hostile,
        resultPreview: hostile
      }
    ],
    agentCount: 1,
    runningCount: 1,
    doneCount: 0,
    errorCount: 0,
    runId: hostile
  };
  const before = structuredClone(snapshot);
  const lines = renderWorkflowLines(snapshot, { showResultPreviews: true });
  for (const line of lines) {
    assert.doesNotMatch(line, /[\p{Cc}\u202e]/u);
  }
  assert.match(lines.join('\n'), /name next word/);
  assert.deepEqual(snapshot, before);
});
