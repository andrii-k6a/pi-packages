import assert from 'node:assert/strict';
import type { EntryRecord, LiveState, ToolRegistration } from '@earendil-works/pi-durable';
import { test } from 'vitest';
import type { WorkflowAttemptState } from '../../src/durable/docs.js';
import {
  attemptSnapshot,
  liveActivity,
  runIndex,
  transcriptItems,
  type WorkflowRunReport
} from '../../src/durable/report.js';
import { renderWorkflowLines } from '../../src/pi/display.js';
import {
  renderRunDetailLines,
  renderTranscriptLines,
  renderTranscriptText,
  resumeInstruction,
  runListLine
} from '../../src/pi/runs-command.js';
import { emptyUsage } from '../../src/shared/usage.js';

const usage = (tokens: number, cost = 0) => ({
  ...emptyUsage(),
  totalTokens: tokens,
  cost: { ...emptyUsage().cost, total: cost }
});

function attempt(overrides: Partial<WorkflowAttemptState> = {}): WorkflowAttemptState {
  return {
    number: 2,
    taskId: 9,
    status: 'running',
    scriptHash: 'h',
    startedAt: 1_000,
    phases: ['Scan'],
    currentPhase: 'Scan',
    logs: ['scanning'],
    agents: {
      b: {
        key: 'b',
        index: 2,
        label: 'beta',
        phase: 'Scan',
        prompt: 'scan beta',
        status: 'running',
        conversationId: 7,
        model: 'faux/m',
        startedAt: 2_000
      },
      a: {
        key: 'a',
        index: 1,
        label: 'alpha',
        phase: 'Scan',
        prompt: 'scan alpha',
        status: 'done',
        reusedFrom: 1,
        usage: usage(500, 0.5),
        preview: '"found"',
        startedAt: 1_500,
        endedAt: 1_500
      }
    },
    ...overrides
  };
}

const run = { runId: 'r-1', name: 'demo', description: 'Demo run' };

test('attemptSnapshot orders agents, adds live activity, and counts only this attempt’s spend', () => {
  const live: LiveState = {
    tools: [{ callId: 'c', name: 'bash', status: 'running', output: 'line 1\nnpm test\n' }]
  };
  const snapshot = attemptSnapshot(
    run,
    attempt(),
    5_000,
    new Map([[7, { state: live, usage: usage(120, 0.01) }]])
  );

  assert.deepEqual(
    snapshot.agents.map((agent) => [agent.id, agent.label, agent.status]),
    [
      [1, 'alpha', 'done'],
      [2, 'beta', 'running']
    ]
  );
  assert.equal(snapshot.agents[1].activity, 'bash: npm test');
  assert.equal(snapshot.agents[1].durationMs, 3_000);
  assert.equal(snapshot.agents[1].tokens, 120);
  assert.equal(snapshot.agents[0].reusedFrom, 1);
  // Reused results were paid for by attempt 1.
  assert.equal(snapshot.usage?.totalTokens, 120);
  assert.equal(snapshot.durationMs, 4_000);

  const lines = renderWorkflowLines(snapshot);
  assert.ok(lines.some((line) => line.includes('#1 ↺ alpha · reused from attempt 1 · 500 tok')));
  assert.ok(lines.some((line) => line.includes('#2 ● beta · 3s · 120 tok — bash: npm test')));
  assert.ok(lines.at(-1)?.includes('run r-1 · attempt 2 · 4s · 120 tok · $0.01'));
});

test('liveActivity describes generation, retries, compaction, and tools', () => {
  assert.equal(liveActivity({}), undefined);
  assert.equal(liveActivity({ generation: { attempt: 1 } }), 'waiting for model');
  assert.equal(
    liveActivity({ generation: { attempt: 2, retry: { at: 1, error: '429 rate limited' } } }),
    'retrying (attempt 2): 429 rate limited'
  );
  assert.equal(
    liveActivity({
      generation: {
        attempt: 1,
        message: { content: [{ type: 'thinking', thinking: '…' }] } as never
      }
    }),
    'thinking'
  );
  assert.equal(
    liveActivity({
      generation: {
        attempt: 1,
        message: { content: [{ type: 'toolCall', name: 'read', arguments: {} }] } as never
      }
    }),
    'calling read'
  );
  assert.equal(
    liveActivity({
      compactions: [{ taskId: 1 as never, reason: 'threshold', blocking: true, attempt: 1 }]
    }),
    'compacting context'
  );
  assert.equal(
    liveActivity({
      tools: [
        { callId: 'a', name: 'read', status: 'running' },
        { callId: 'b', name: 'bash', status: 'running' }
      ]
    }),
    'read, bash'
  );
});

test('liveActivity shows nested work rather than just its orchestrator', () => {
  const live: LiveState = {
    tools: [{ taskId: 1 as never, callId: 'c', name: 'codemode', status: 'running' }],
    nestedTools: [
      {
        taskId: 2 as never,
        parentTaskId: 1 as never,
        callId: 'c/1',
        parentCallId: 'c',
        name: 'read',
        arguments: {},
        status: 'done'
      },
      {
        taskId: 3 as never,
        parentTaskId: 1 as never,
        callId: 'c/2',
        parentCallId: 'c',
        name: 'bash',
        arguments: {},
        status: 'running',
        output: 'testing\n3 passed\n'
      }
    ]
  };
  assert.equal(liveActivity(live), 'codemode → bash: 3 passed');
  live.tools?.push({ callId: 'other', name: 'edit', status: 'running' });
  assert.equal(liveActivity(live), 'edit, codemode → bash');
  if (live.nestedTools) live.nestedTools[1].status = 'done';
  assert.equal(liveActivity(live), 'codemode, edit');
});

test('compaction failures remain visible for finished agents without hiding current activity', () => {
  const state = attempt();
  state.agents.a.conversationId = 8;
  const failure: LiveState = {
    compactionFailure: {
      taskId: 99 as never,
      reason: 'threshold',
      error: 'summary provider unavailable'
    }
  };
  const snapshot = attemptSnapshot(
    run,
    state,
    5_000,
    new Map([
      [7, { state: { ...failure, generation: { attempt: 1 } } }],
      [8, { state: failure }]
    ])
  );
  assert.equal(snapshot.agents[1].activity, 'waiting for model');
  assert.ok(
    snapshot.agents.every(
      (agent) => agent.warning === 'compaction failed: summary provider unavailable'
    )
  );
  assert.ok(
    renderWorkflowLines(snapshot).some((line) =>
      line.includes('⚠ compaction failed: summary provider unavailable')
    )
  );
  snapshot.agents[0].warning = 'compaction failed: \u001b]0;untrusted\u0007';
  for (const line of renderWorkflowLines(snapshot)) assert.doesNotMatch(line, /\p{Cc}/u);
  assert.ok(
    attemptSnapshot(run, state, 5_000).agents.every((agent) => agent.warning === undefined)
  );
});

test('transcriptItems maps durable entries to readable roles', () => {
  const entries = [
    { id: 1, conversationId: 2, kind: 'pi.user', model: [{ role: 'user', content: 'do it' }] },
    { id: 2, conversationId: 2, kind: 'pi.system', model: [{ role: 'system', content: '' }] },
    {
      id: 3,
      conversationId: 2,
      kind: 'pi.assistant',
      model: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'plan' },
            { type: 'text', text: 'Reading.' },
            { type: 'toolCall', id: 'c', name: 'read', arguments: { path: 'a.ts' } }
          ]
        }
      ]
    },
    {
      id: 4,
      conversationId: 2,
      kind: 'pi.tool-result',
      model: [
        {
          role: 'toolResult',
          toolName: 'read',
          isError: true,
          content: [{ type: 'text', text: 'ENOENT' }]
        }
      ]
    },
    {
      id: 5,
      conversationId: 2,
      kind: 'pi.assistant',
      model: [{ role: 'assistant', content: [], stopReason: 'error', errorMessage: 'overloaded' }]
    }
  ] as unknown as EntryRecord[];

  assert.deepEqual(transcriptItems(entries), [
    { role: 'user', text: 'do it' },
    { role: 'thinking', text: 'plan' },
    { role: 'assistant', text: 'Reading.' },
    { role: 'tool-call', toolName: 'read', text: '{"path":"a.ts"}' },
    { role: 'tool-result', toolName: 'read', isError: true, text: 'ENOENT' },
    { role: 'note', text: '[error] overloaded' }
  ]);
});

test('runIndex summarizes the latest attempt for listings', () => {
  const index = runIndex(
    {
      version: 1,
      runId: 'r-1',
      name: 'demo',
      description: 'Demo run',
      cwd: '/repo',
      createdAt: 1,
      attempts: [3, 9]
    },
    attempt({ status: 'failed', error: 'boom' }),
    42
  );
  assert.deepEqual(index, {
    version: 1,
    runId: 'r-1',
    name: 'demo',
    description: 'Demo run',
    cwd: '/repo',
    createdAt: 1,
    updatedAt: 42,
    status: 'failed',
    attempts: 2,
    agents: { total: 2, done: 1, error: 0, running: 1 },
    error: 'boom'
  });
  assert.match(
    runListLine({ ...index, createdAt: 0 }, 3 * 60 * 60 * 1000),
    /^✗ demo · failed · 1\/2 agents · 2 attempts · 3h ago · r-1$/
  );
});

test('renderRunDetailLines shows attempts, phases, the selected agent, and sanitizes model text', () => {
  const report: WorkflowRunReport = {
    runId: 'r-1',
    run: {
      version: 1,
      runId: 'r-1',
      name: 'demo',
      description: 'Demo \u001b[31mrun',
      cwd: '/repo',
      createdAt: 0,
      attempts: [3, 9]
    },
    status: 'interrupted',
    attempts: [
      { ...attempt({ number: 1, taskId: 3, status: 'aborted', endedAt: 1_200 }), script: 'v1' },
      { ...attempt(), script: 'v2', compactionFailures: { '7': 'summary \u001b[31mfailed' } }
    ],
    usage: usage(1500, 0.25),
    active: false
  };
  const lines = renderRunDetailLines(report, 1, 1, 10_000);
  const text = lines.join('\n');

  assert.match(text, /demo — Demo run/);
  assert.equal(text.includes(String.fromCharCode(27)), false);
  assert.match(text, /status interrupted · 2 attempt\(s\)/);
  assert.match(text, /spend 1\.5k tok · \$0\.25/);
  assert.match(text, /Attempt 2\/2 · running · 9s/);
  assert.ok(lines.includes('  Scan'));
  assert.ok(lines.some((line) => line.startsWith('>') && line.includes('#2 ● beta · 8s')));
  assert.ok(
    lines.some((line) => line.includes('#1 ↺ alpha · reused from attempt 1 · 500 tok · $0.50'))
  );
  assert.match(text, /model faux\/m/);
  assert.match(text, /prompt scan beta/);
  assert.match(text, /warning: compaction failed: summary failed/);
});

test('renderTranscriptLines labels items, wraps text, and keeps line breaks', () => {
  const lines = renderTranscriptLines(
    [
      { role: 'user', text: 'first line\nsecond line' },
      { role: 'tool-result', toolName: 'bash', isError: true, text: 'x'.repeat(50) }
    ],
    30
  );
  assert.deepEqual(lines.slice(0, 4), [' user', '   first line', '   second line', '']);
  assert.equal(lines[4], ' ← bash (error)');
  assert.ok(lines.slice(5).filter((line) => line.startsWith('   x')).length >= 2);
});

test('renderTranscriptText keeps the full text for an editor, one heading per item', () => {
  const long = `${'x'.repeat(5000)}\n\u001b[31mred\u001b[0m`;
  const text = renderTranscriptText('run-1 · #1 scan', [
    { role: 'user', text: 'first\nsecond' },
    { role: 'tool-call', toolName: 'bash', text: '{"command":"ls"}' },
    { role: 'tool-result', toolName: 'bash', isError: true, text: long }
  ]);
  assert.equal(
    text
      .split('\n')
      .filter((line) => line.startsWith('## '))
      .join('|'),
    '## 1. user|## 2. → bash|## 3. ← bash (error)'
  );
  assert.ok(text.startsWith('# run-1 · #1 scan\n\n## 1. user\n\nfirst\nsecond\n'));
  assert.ok(text.includes('x'.repeat(5000)), 'long tool results are not truncated');
  assert.ok(text.includes('\nred'), 'terminal escapes are removed');
  assert.ok(!text.includes('\u001b'));
  assert.match(renderTranscriptText('t', []), /\(empty transcript\)/);
});

test('resumeInstruction asks the model to resume through the workflow tool', () => {
  assert.equal(
    resumeInstruction('r-1'),
    'Resume the durable workflow run r-1: call the workflow tool with { "resume": "r-1" }. Completed agent results are reused.'
  );
});

test('subagents replay interrupted reads but never writes, edits, or shell commands', async () => {
  const { createRegistry } = await import('@earendil-works/pi-durable');
  const { CodingTools } = await import('@earendil-works/pi-durable/tools');
  const { SubagentExtension } = await import('../../src/durable/tasks/agent.js');
  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(SubagentExtension);
  const tools = Object.fromEntries(
    registry
      .snapshot()
      .tools()
      .map(({ tool }) => [tool.name, tool])
  );
  const wrap = SubagentExtension.wraps?.find((item) => 'tool' in item && item.tool === 'read');
  assert.ok(wrap && 'wrap' in wrap);
  assert.equal((wrap.wrap(tools.read as never) as ToolRegistration).replay, 'safe');
  for (const name of ['write', 'edit', 'bash']) assert.notEqual(tools[name].replay, 'safe');
});
