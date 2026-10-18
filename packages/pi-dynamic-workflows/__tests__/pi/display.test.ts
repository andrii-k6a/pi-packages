import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  createToolUpdateWorkflowDisplay,
  createWidgetWorkflowDisplay,
  renderWorkflowLines,
  renderWorkflowText
} from '../../src/pi/display.js';
import {
  createWorkflowSnapshot,
  recomputeWorkflowSnapshot,
  type WorkflowAgentSnapshot,
  type WorkflowSnapshot
} from '../../src/workflow/snapshot.js';

function snapshot(overrides: Partial<WorkflowSnapshot> = {}): WorkflowSnapshot {
  return recomputeWorkflowSnapshot({
    name: 'demo_workflow',
    phases: [],
    logs: [],
    agents: [],
    agentCount: 0,
    runningCount: 0,
    doneCount: 0,
    errorCount: 0,
    ...overrides
  });
}

function agent(overrides: Partial<WorkflowAgentSnapshot> = {}): WorkflowAgentSnapshot {
  return {
    id: 1,
    label: 'scan repo',
    phase: 'Scan',
    prompt: 'Scan the repo',
    status: 'done',
    ...overrides
  };
}

test('createWorkflowSnapshot does not pre-render declared phases', () => {
  const value = createWorkflowSnapshot({
    name: 'demo_workflow',
    description: 'A useful workflow',
    phases: [{ title: 'Scan' }, { title: 'Review' }]
  });

  assert.deepEqual(value.phases, []);
});

test('renderWorkflowLines hides empty phase rows', () => {
  const lines = renderWorkflowLines(
    snapshot({
      phases: ['Scan', 'Review'],
      agents: [agent()]
    })
  );

  assert.ok(lines.some((line) => line.includes('Scan 1/1')));
  assert.ok(!lines.some((line) => line.includes('Review 0/0')));
});

test('renderWorkflowLines keeps the current empty phase visible', () => {
  const lines = renderWorkflowLines(
    snapshot({
      phases: ['Scan'],
      currentPhase: 'Scan'
    })
  );

  assert.ok(lines.some((line) => line.includes('▶ Scan 0/0')));
});

test('renderWorkflowLines groups agents by phase even when the phase was not pre-recorded', () => {
  const lines = renderWorkflowLines(
    snapshot({
      phases: ['Scan'],
      agents: [agent({ id: 2, label: 'review diff', phase: 'Review' })]
    })
  );

  assert.ok(lines.some((line) => line.includes('Review 1/1')));
  assert.ok(!lines.some((line) => line.trim() === 'Unphased'));
});

test('renderWorkflowLines renders runtime-created phases from the phase list', () => {
  const lines = renderWorkflowLines(
    snapshot({
      phases: ['Inspect API'],
      agents: [agent({ label: 'inspect api', phase: 'Inspect API' })]
    })
  );

  assert.ok(lines.some((line) => line.includes('Inspect API 1/1')));
});

test('renderWorkflowText respects log limits', () => {
  const text = renderWorkflowText(
    snapshot({
      logs: ['first', 'second', 'third']
    }),
    true,
    { maxLogs: 1 }
  );

  assert.doesNotMatch(text, /log: first/);
  assert.doesNotMatch(text, /log: second/);
  assert.match(text, /log: third/);
});

test('renderWorkflowLines shows the selected profile on an agent row', () => {
  const lines = renderWorkflowLines(snapshot({ agents: [agent({ profile: 'fast' })] }));

  assert.ok(lines.some((line) => line.includes('#1 ✓ scan repo · profile: fast')));
});

test('renderWorkflowLines separates logs from progress', () => {
  const lines = renderWorkflowLines(
    snapshot({
      agents: [agent()],
      logs: ['finished scan']
    })
  );

  const logIndex = lines.findIndex((line) => line.includes('log: finished scan'));
  assert.ok(logIndex > 0);
  assert.equal(lines[logIndex - 1], '');
});

test('tool updates are forwarded only when the rendered progress changed', () => {
  const sent: string[] = [];
  const display = createToolUpdateWorkflowDisplay(
    (update) => sent.push(update.content[0].text),
    undefined,
    { streamToolUpdates: true }
  );
  const base = snapshot({ agents: [agent({ status: 'running' })] });

  display.update(base);
  display.update({ ...base, durationMs: 1 });
  display.update(structuredClone(base));
  assert.equal(sent.length, 1, 'identical pictures are not resent');

  display.update(snapshot({ agents: [agent({ status: 'done' })] }));
  assert.equal(sent.length, 2, 'a changed picture is sent');

  display.complete(snapshot({ agents: [agent({ status: 'done' })] }));
  assert.equal(sent.length, 3, 'completion is always sent');
});

test('the widget is redrawn only when its lines changed', () => {
  const widgets: unknown[] = [];
  const ui = {
    setWidget: (_key: string, lines: unknown) => widgets.push(lines),
    setStatus: () => {}
  };
  const display = createWidgetWorkflowDisplay({ hasUI: true, ui } as never);
  const value = snapshot({ agents: [agent()] });

  display.update(value);
  display.update(structuredClone(value));
  assert.equal(widgets.length, 1);
  display.update(snapshot({ agents: [agent(), agent({ id: 2, label: 'second' })] }));
  assert.equal(widgets.length, 2);
  display.clear();
  display.update(value);
  assert.equal(widgets.length, 4, 'clear() resets the widget, so the next picture is drawn');
});
