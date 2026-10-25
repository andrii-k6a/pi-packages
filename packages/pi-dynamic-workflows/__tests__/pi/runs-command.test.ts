import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import type { ExtensionCommandContext, Theme } from '@earendil-works/pi-coding-agent';
import type { TUI } from '@earendil-works/pi-tui';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { WorkflowHost } from '../../src/durable/host.js';
import type { WorkflowRunReport } from '../../src/durable/report.js';
import type { WorkflowRunIndex } from '../../src/durable/store.js';
import { openWorkflowRuns, WorkflowRunsBrowser } from '../../src/pi/runs-command.js';
import { emptyUsage } from '../../src/shared/usage.js';

vi.mock('node:fs', { spy: true });

beforeEach(() => {
  vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const index: WorkflowRunIndex = {
  version: 1,
  runId: 'run-1',
  name: 'demo',
  description: 'Demo run',
  cwd: '/repo',
  createdAt: 1,
  updatedAt: 2,
  status: 'interrupted',
  attempts: 1,
  agents: { total: 2, done: 1, error: 0, running: 1 }
};

const report: WorkflowRunReport = {
  runId: index.runId,
  run: {
    version: 1,
    runId: index.runId,
    name: index.name,
    description: index.description,
    cwd: index.cwd,
    createdAt: index.createdAt,
    attempts: [1]
  },
  status: 'interrupted',
  attempts: [],
  usage: emptyUsage(),
  active: false
};

function setup(mode: ExtensionCommandContext['mode']) {
  const pi = { sendUserMessage: vi.fn(), sendMessage: vi.fn() };
  const ui = { notify: vi.fn(), custom: vi.fn() };
  const ctx = {
    mode,
    hasUI: mode === 'tui' || mode === 'rpc',
    ui
  } as unknown as ExtensionCommandContext;
  const host = { list: vi.fn(() => [index]), report: vi.fn(async () => report) };
  const open = (args = '') => openWorkflowRuns(pi, ctx, host as unknown as WorkflowHost, args);
  const output = (type: 'info' | 'error' = 'info', runId?: string): string => {
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(ui.custom).not.toHaveBeenCalled();
    if (mode === 'print') {
      expect(pi.sendMessage).not.toHaveBeenCalled();
      expect(ui.notify).not.toHaveBeenCalled();
      expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
      const [fd, text] = vi.mocked(fs.writeFileSync).mock.calls[0];
      assert.equal(fd, type === 'error' ? 2 : 1);
      assert.equal(typeof text, 'string');
      assert.ok(String(text).endsWith('\n'));
      return String(text).slice(0, -1);
    }
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    if (mode === 'rpc') {
      expect(pi.sendMessage).not.toHaveBeenCalled();
      expect(ui.notify).toHaveBeenCalledTimes(1);
      const [text, tone] = ui.notify.mock.calls[0];
      assert.equal(tone, type);
      return text;
    }
    expect(ui.notify).not.toHaveBeenCalled();
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    const [message, options] = pi.sendMessage.mock.calls[0];
    assert.equal(message.customType, 'workflow-runs');
    assert.equal(message.display, true);
    assert.deepEqual(message.details, { ...(runId ? { runId } : {}), isError: type === 'error' });
    assert.deepEqual(options, { triggerTurn: false });
    return message.content;
  };
  return { pi, ui, host, open, output };
}

test.each(['print', 'json', 'rpc'] as const)(
  '/workflows lists runs in %s mode without invoking the model',
  async (mode) => {
    const mocked = setup(mode);
    await mocked.open();
    assert.match(mocked.output(), /demo · interrupted · 1\/2 agents.*run-1$/);
    expect(mocked.host.report).not.toHaveBeenCalled();
  }
);

test.each(['print', 'json', 'rpc'] as const)(
  '/workflows reports an empty list in %s mode',
  async (mode) => {
    const mocked = setup(mode);
    mocked.host.list.mockReturnValue([]);
    await mocked.open();
    assert.equal(mocked.output(), 'No workflow runs yet.');
  }
);

test.each(['print', 'json', 'rpc'] as const)(
  '/workflows <runId> outputs details in %s mode',
  async (mode) => {
    const mocked = setup(mode);
    await mocked.open('  run-1  ');
    const text = mocked.output('info', 'run-1');
    assert.match(text, /demo — Demo run/);
    assert.match(text, /status interrupted/);
    assert.match(text, /cwd \/repo/);
    expect(mocked.host.report).toHaveBeenCalledWith('run-1');
    expect(mocked.host.list).not.toHaveBeenCalled();
  }
);

test.each(['print', 'json', 'rpc'] as const)(
  '/workflows makes inspection errors visible in %s mode',
  async (mode) => {
    const mocked = setup(mode);
    mocked.host.report.mockRejectedValue(new Error('unknown workflow run missing'));
    await mocked.open('missing');
    assert.equal(mocked.output('error', 'missing'), 'unknown workflow run missing');
  }
);

test.each(['print', 'json', 'rpc'] as const)(
  '/workflows makes listing errors visible in %s mode',
  async (mode) => {
    const mocked = setup(mode);
    mocked.host.list.mockImplementation(() => {
      throw new Error('listing failed');
    });
    await mocked.open();
    assert.equal(mocked.output('error'), 'listing failed');
  }
);

test('/workflows still uses the browser in TUI mode', async () => {
  const mocked = setup('tui');
  await mocked.open();
  expect(mocked.ui.custom).toHaveBeenCalledTimes(1);
  expect(mocked.ui.notify).not.toHaveBeenCalled();
  expect(mocked.pi.sendMessage).not.toHaveBeenCalled();
  expect(fs.writeFileSync).not.toHaveBeenCalled();
});

test.each([18, 24, 40])(
  'the inspector keeps selected agent details visible in a %i-line terminal during a large fan-out',
  async (terminalRows) => {
    const largeReport: WorkflowRunReport = {
      ...report,
      attempts: [
        {
          number: 1,
          taskId: 1,
          status: 'failed',
          script: '',
          scriptHash: 'test',
          startedAt: 1,
          phases: ['Scan'],
          logs: ['Scanning'],
          agents: Object.fromEntries(
            Array.from({ length: 30 }, (_, i) => [
              `agent-${i}`,
              {
                key: `agent-${i}`,
                index: i + 1,
                label: `Agent ${i + 1}`,
                phase: 'Scan',
                status: 'error',
                conversationId: i + 1,
                model: 'faux/faux-1',
                prompt: `Prompt ${i + 1}`,
                preview: `Result ${i + 1}`,
                error: `Failure ${i + 1}`
              }
            ])
          ),
          compactionFailures: Object.fromEntries(
            Array.from({ length: 30 }, (_, i) => [i + 1, `Compaction ${i + 1}`])
          )
        }
      ]
    };
    const browser = new WorkflowRunsBrowser(
      { terminal: { rows: terminalRows }, requestRender() {} } as unknown as TUI,
      { fg: (_color, value) => value, bold: (value) => value } as Theme,
      { list: () => [], report: async () => largeReport } as unknown as WorkflowHost,
      () => {},
      async () => {},
      report.runId
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    for (let i = 1; i <= 30; i++) {
      const lines = browser.render(120);
      assert.ok(lines.length <= terminalRows, 'the inspector must fit the terminal');
      assert.ok(lines.some((line) => line.startsWith(`>   #${i} `)));
      assert.ok(lines.includes('   model faux/faux-1'));
      assert.ok(lines.includes(`   prompt Prompt ${i}`));
      assert.ok(lines.includes(`   result Result ${i}`));
      assert.ok(lines.includes(`   error Failure ${i}`));
      assert.ok(lines.includes(`   warning: compaction failed: Compaction ${i}`));
      browser.handleInput('j');
    }
  }
);

function transcriptBrowser(viewInEditor: (text: string, filename: string) => Promise<void>) {
  const withTranscript: WorkflowRunReport = {
    ...report,
    attempts: [
      {
        number: 1,
        taskId: 1,
        status: 'completed',
        script: '',
        scriptHash: 'test',
        startedAt: 1,
        phases: ['Scan'],
        logs: [],
        agents: {
          a: {
            key: 'a',
            index: 1,
            label: 'scan',
            phase: 'Scan',
            status: 'done',
            conversationId: 7,
            prompt: 'Prompt',
            preview: 'Result'
          }
        }
      }
    ]
  };
  const transcript = vi.fn(async () => [
    { role: 'user' as const, text: 'Prompt' },
    { role: 'tool-result' as const, toolName: 'bash', text: 'y'.repeat(6000) }
  ]);
  const browser = new WorkflowRunsBrowser(
    { terminal: { rows: 24 }, requestRender() {} } as unknown as TUI,
    { fg: (_color, value) => value, bold: (value) => value } as Theme,
    { list: () => [], report: async () => withTranscript, transcript } as unknown as WorkflowHost,
    () => {},
    viewInEditor,
    report.runId
  );
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  return { browser, settle, transcript };
}

test('e in a transcript opens the whole transcript in the editor', async () => {
  const viewed: Array<{ text: string; filename: string }> = [];
  const { browser, settle } = transcriptBrowser(async (text, filename) => {
    viewed.push({ text, filename });
  });
  await settle();
  browser.handleInput('\r');
  await settle();
  browser.handleInput('e');
  await settle();
  assert.equal(viewed.length, 1);
  assert.equal(viewed[0].filename, 'run-1-transcript.md');
  assert.ok(viewed[0].text.startsWith('# run-1 · #1 scan'));
  assert.ok(viewed[0].text.includes('y'.repeat(6000)), 'the editor gets the untruncated text');
  assert.ok(!browser.render(100).join('\n').includes('Could not open'));
});

test('a failure to start the editor is shown and does not break the browser', async () => {
  const view = vi.fn().mockRejectedValueOnce(new Error('spawn nvim ENOENT'));
  const { browser, settle } = transcriptBrowser(view);
  await settle();
  browser.handleInput('\r');
  await settle();
  browser.handleInput('e');
  await settle();
  assert.match(browser.render(100).join('\n'), /Could not open the editor: spawn nvim ENOENT/);
  view.mockResolvedValueOnce(undefined);
  browser.handleInput('e');
  assert.equal(view.mock.calls.length, 2);
});

test('a second e while the editor is open does not start another editor', async () => {
  const view = vi.fn(() => new Promise<void>(() => {}));
  const { browser, settle } = transcriptBrowser(view);
  await settle();
  browser.handleInput('\r');
  await settle();
  browser.handleInput('e');
  browser.handleInput('e');
  assert.equal(view.mock.calls.length, 1);
});
