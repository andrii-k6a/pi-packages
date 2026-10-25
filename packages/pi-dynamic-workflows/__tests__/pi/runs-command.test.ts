import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import type { ExtensionCommandContext, Theme } from '@earendil-works/pi-coding-agent';
import {
  type KeybindingsConfig,
  KeybindingsManager,
  type TUI,
  TUI_KEYBINDINGS
} from '@earendil-works/pi-tui';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { WorkflowHost } from '../../src/durable/host.js';
import type { FollowedTranscript, WorkflowRunReport } from '../../src/durable/report.js';
import type { WorkflowRunIndex } from '../../src/durable/store.js';
import {
  openWorkflowRuns,
  renderRunDetailLines,
  WorkflowRunsBrowser
} from '../../src/pi/runs-command.js';
import { emptyUsage } from '../../src/shared/usage.js';

vi.mock('node:fs', { spy: true });

beforeEach(() => {
  vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Pi's own manager also knows its application actions. This one adds the one the inspector reads.
const piKeys = (user: KeybindingsConfig = {}) =>
  new KeybindingsManager(
    {
      ...TUI_KEYBINDINGS,
      'app.message.dequeue': { defaultKeys: 'alt+up', description: 'Restore queued messages' }
    } as never,
    user
  );
const defaultKeys = piKeys();
// A user's fullscreen scroll bindings, as configured in keybindings.json.
const userKeys = piKeys({
  'tui.altScreen.pageUp': 'ctrl+shift+k',
  'tui.altScreen.pageDown': 'ctrl+shift+j',
  'tui.altScreen.top': 'ctrl+shift+h',
  'tui.altScreen.bottom': 'ctrl+shift+l'
});
const chord = (letter: string) => `\u001b[${letter.charCodeAt(0)};6u`;

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
  expect(mocked.ui.custom.mock.calls[0][1]).toMatchObject({
    overlay: true,
    overlayOptions: { anchor: 'top-left' }
  });
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
      defaultKeys,
      { list: () => [], report: async () => largeReport } as unknown as WorkflowHost,
      () => {},
      async () => {},
      report.runId
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    for (let i = 1; i <= 30; i++) {
      const lines = browser.render(120);
      assert.equal(
        lines.length,
        Math.min(terminalRows, Math.max(18, terminalRows - 14)),
        'the inspector leaves 14 rows to the parent session, but never fewer than 18 rows for itself'
      );
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
    defaultKeys,
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

function liveBrowser(options: { follow?: 'reject'; keybindings?: KeybindingsManager } = {}) {
  const keybindings = options.keybindings ?? defaultKeys;
  const running: WorkflowRunReport = {
    ...report,
    status: 'running',
    active: true,
    attempts: [
      {
        number: 1,
        taskId: 1,
        status: 'running',
        script: '',
        scriptHash: 'test',
        startedAt: 1,
        phases: [],
        logs: [],
        agents: {
          a: {
            key: 'a',
            index: 3,
            label: 'audit',
            status: 'running',
            conversationId: 7,
            prompt: 'Prompt'
          }
        }
      }
    ]
  };
  const stop = vi.fn();
  const sink: { push?: (followed: FollowedTranscript) => void } = {};
  const host = {
    list: () => [],
    report: async () => running,
    isActive: () => true,
    follow: vi.fn(
      async (_runId: string, _id: number, listener: (f: FollowedTranscript) => void) => {
        if (options.follow === 'reject') throw new Error('run closed');
        sink.push = listener;
        return stop;
      }
    ),
    transcript: vi.fn(async () => [{ role: 'user' as const, text: 'from snapshot' }]),
    steer: vi.fn(async () => {}),
    withdrawSteers: vi.fn(async (): Promise<string[]> => []),
    pauseAgent: vi.fn(async () => ({ paused: true, withdrawn: [] as string[] })),
    resumeAgent: vi.fn(async () => {}),
    cancelAgent: vi.fn(async () => {})
  };
  const browser = new WorkflowRunsBrowser(
    { terminal: { rows: 38 }, requestRender() {} } as unknown as TUI,
    { fg: (_color, value) => value, bold: (value) => value } as Theme,
    keybindings,
    host as unknown as WorkflowHost,
    () => {},
    async () => {},
    report.runId
  );
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  const type = (text: string) => {
    for (const char of text) browser.handleInput(char);
  };
  const lines = (count: number, busy = true): FollowedTranscript => ({
    busy,
    queued: 0,
    paused: false,
    items: Array.from({ length: count }, (_, i) => ({
      role: 'assistant' as const,
      text: `line ${i}`
    }))
  });
  const text = () => browser.render(140).join('\n');
  const follow = async () => {
    await settle();
    browser.handleInput('\r');
    await settle();
  };
  return { browser, host, stop, sink, settle, type, lines, text, follow };
}

test('following a running agent streams its transcript, stays at the tail, and stops on leaving', async () => {
  const { browser, stop, sink, lines, text, follow } = liveBrowser();
  await follow();
  sink.push?.(lines(30));
  assert.match(text(), /● live/);
  assert.match(text(), /line 29/);
  assert.doesNotMatch(text(), /line 0\b/);

  sink.push?.(lines(31));
  assert.match(text(), /line 30/, 'new output scrolls into view while following');

  browser.handleInput('k');
  sink.push?.(lines(33));
  assert.doesNotMatch(text(), /line 32/, 'scrolling up stops following');
  browser.handleInput('\u001b[1;5F');
  assert.match(text(), /line 32/, 'ctrl+end, the default bottom binding, resumes following');

  sink.push?.(lines(33, false));
  assert.match(text(), /finished/);
  browser.handleInput('\u001b');
  expect(stop).toHaveBeenCalledTimes(1);
});

test('m sends a steer to the followed agent, and Esc abandons the message', async () => {
  const { browser, host, sink, lines, text, type, settle, follow } = liveBrowser();
  await follow();
  sink.push?.(lines(2));

  browser.handleInput('m');
  type('Use pnpm');
  assert.match(text(), /steer ▸ .*Use pnpm/);
  browser.handleInput('\u001b');
  expect(host.steer).not.toHaveBeenCalled();
  assert.doesNotMatch(text(), /steer ▸/);

  browser.handleInput('m');
  type('  Use pnpm  ');
  browser.handleInput('\r');
  await settle();
  expect(host.steer).toHaveBeenCalledWith('run-1', 7, 'Use pnpm');
  assert.match(text(), /Sent\./);
});

test('m is refused when the agent is idle or the transcript is only a snapshot', async () => {
  const live = liveBrowser();
  await live.follow();
  live.sink.push?.(live.lines(2, false));
  live.browser.handleInput('m');
  assert.match(live.text(), /not working right now/);

  const snapshot = liveBrowser({ follow: 'reject' });
  await snapshot.follow();
  await snapshot.settle();
  snapshot.browser.handleInput('m');
  assert.match(snapshot.text(), /Only an agent running in this session can be steered/);
  expect(snapshot.host.steer).not.toHaveBeenCalled();
});

test('x cancels the followed agent only when pressed twice in a row', async () => {
  const { browser, host, sink, lines, text, settle, follow } = liveBrowser();
  await follow();
  sink.push?.(lines(2));

  browser.handleInput('x');
  assert.match(text(), /Press x again to cancel #3 audit/);
  browser.handleInput('j');
  browser.handleInput('x');
  expect(host.cancelAgent).not.toHaveBeenCalled();

  browser.handleInput('x');
  await settle();
  expect(host.cancelAgent).toHaveBeenCalledWith('run-1', 7);
  assert.match(text(), /Cancelled #3 audit/);
});

test('x on a running agent in the run view cancels it after confirmation', async () => {
  const { browser, host, text, settle } = liveBrowser();
  await settle();
  browser.handleInput('x');
  browser.handleInput('x');
  await settle();
  expect(host.cancelAgent).toHaveBeenCalledWith('run-1', 7);
  assert.match(text(), /Cancelled #3 audit/);
});

test('an agent that cannot be followed falls back to its stored transcript', async () => {
  const { browser, host, settle, follow } = liveBrowser({ follow: 'reject' });
  await follow();
  await settle();
  expect(host.transcript).toHaveBeenCalledWith('run-1', 7);
  assert.match(browser.render(100).join('\n'), /from snapshot/);
  assert.doesNotMatch(browser.render(100).join('\n'), /● live/);
});

const wheel = (wheelDelta: number) =>
  ({ type: 'wheel', button: 'none', wheelDelta }) as unknown as Parameters<
    WorkflowRunsBrowser['handleMouse']
  >[0];

test('the mouse wheel scrolls a live transcript, leaves the tail, and returns to it at the bottom', async () => {
  const { browser, sink, lines, text, follow } = liveBrowser();
  await follow();
  sink.push?.(lines(30));
  assert.doesNotMatch(text(), /line 23\b/);

  assert.deepEqual(browser.handleMouse(wheel(-3)), { handled: true });
  assert.match(text(), /line 23\b/);
  assert.doesNotMatch(text(), /line 29\b/);

  sink.push?.(lines(31));
  assert.doesNotMatch(text(), /line 30\b/, 'scrolled away from the tail, new output stays below');

  browser.handleMouse(wheel(100));
  assert.match(text(), /line 30\b/);
  sink.push?.(lines(32));
  assert.match(text(), /line 31\b/, 'the tail is followed again');
});

test('the mouse wheel scrolls a snapshot transcript and is ignored outside transcripts', async () => {
  const { browser, settle } = transcriptBrowser(async () => {});
  await settle();
  assert.equal(browser.handleMouse(wheel(-1)), undefined, 'the run view does not scroll');
  browser.handleInput('\r');
  await settle();
  assert.match(browser.render(100).join('\n'), /^ user$/m);
  assert.deepEqual(browser.handleMouse(wheel(2)), { handled: true });
  assert.doesNotMatch(browser.render(100).join('\n'), /^ user$/m);
  assert.equal(
    browser.handleMouse({ type: 'click', button: 'left' } as unknown as Parameters<
      WorkflowRunsBrowser['handleMouse']
    >[0]),
    undefined
  );
});

test("the user's fullscreen scroll bindings scroll a live transcript, and bottom follows it again", async () => {
  const { sink, lines, text, follow, browser } = liveBrowser({ keybindings: userKeys });
  await follow();
  sink.push?.(lines(30));
  assert.match(text(), /line 29\b/);

  browser.handleInput(chord('h'));
  assert.match(text(), /line 0\b/);
  assert.doesNotMatch(text(), /line 29\b/);

  const body = () => browser.render(100).slice(3, 21);
  const firstPage = body();
  browser.handleInput(chord('j'));
  assert.deepEqual(
    body().slice(0, 4),
    firstPage.slice(-4),
    'a page keeps the last 4 lines of the previous one, as in Pi'
  );
  assert.doesNotMatch(text(), /line 0\b/);

  browser.handleInput(chord('l'));
  assert.match(text(), /line 29\b/);
  sink.push?.(lines(31));
  assert.match(text(), /line 30\b/, 'bottom resumes following');

  browser.handleInput(chord('k'));
  sink.push?.(lines(33));
  assert.doesNotMatch(text(), /line 32\b/, 'page up leaves the tail');
});

test('scroll bindings that are not configured do nothing', async () => {
  const { sink, lines, text, follow, browser } = liveBrowser();
  await follow();
  sink.push?.(lines(30));
  browser.handleInput(chord('h'));
  assert.match(text(), /line 29\b/);
});

test('transcripts follow the keys bound in Pi: half pages, lines, and no key that Pi has unbound', async () => {
  const keys = piKeys({
    ...userKeys.getUserBindings(),
    'tui.altScreen.pageUp': [],
    'tui.altScreen.halfPageDown': 'ctrl+d',
    'tui.altScreen.lineDown': 'ctrl+n'
  });
  const { browser, sink, lines, text, follow } = liveBrowser({ keybindings: keys });
  await follow();
  sink.push?.(lines(30));
  browser.handleInput(chord('h'));
  const firstLine = () => browser.render(100)[3];
  assert.equal(firstLine(), ' assistant');

  browser.handleInput('\u0004');
  assert.doesNotMatch(text(), /line 2\b/, 'half a page is 9 lines');
  assert.match(text(), /line 3\b/);

  browser.handleInput(chord('h'));
  browser.handleInput('\u000e');
  assert.equal(firstLine(), '   line 0', 'one line down');

  browser.handleInput('\u001b[5~');
  assert.equal(firstLine(), '   line 0', 'PgUp is not bound to anything any more');
});

test('ctrl+up and ctrl+down jump between user messages, as in the parent session', async () => {
  const { browser, sink, text, follow } = liveBrowser();
  await follow();
  const assistant = (count: number, from: number) =>
    Array.from({ length: count }, (_, i) => ({
      role: 'assistant' as const,
      text: `step ${from + i}`
    }));
  sink.push?.({
    busy: true,
    queued: 0,
    paused: false,
    items: [
      { role: 'user', text: 'first prompt' },
      ...assistant(10, 0),
      { role: 'user', text: 'second prompt' },
      ...assistant(10, 10)
    ]
  });
  assert.doesNotMatch(text(), /second prompt/);

  browser.handleInput('\u001b[1;5A');
  assert.match(text(), /second prompt/, 'previous message from the tail');
  assert.doesNotMatch(text(), /first prompt/);
  browser.handleInput('\u001b[1;5A');
  assert.match(text(), /first prompt/);
  browser.handleInput('\u001b[1;5A');
  assert.match(text(), /first prompt/, 'nothing earlier: stays');
  browser.handleInput('\u001b[1;5B');
  assert.match(text(), /second prompt/);
});

test('the footer shows the keys bound in Pi', async () => {
  const user = liveBrowser({ keybindings: userKeys });
  await user.follow();
  user.sink.push?.(user.lines(2));
  assert.match(user.text(), /ctrl\+shift\+k\/j page/);
  assert.match(user.text(), /ctrl\+shift\+h\/l top\/bottom/);

  const partial = liveBrowser({
    keybindings: piKeys({ 'tui.altScreen.pageUp': [] })
  });
  await partial.follow();
  partial.sink.push?.(partial.lines(2));
  assert.match(partial.text(), /• pageDown page •/, 'a half-bound pair still shows its key');

  const defaults = liveBrowser();
  await defaults.follow();
  defaults.sink.push?.(defaults.lines(2));
  assert.match(defaults.text(), /^ Esc back • /m, 'the way out comes first, so it is never cut');
  assert.match(defaults.text(), /pageUp\/pageDown page/);
  assert.match(defaults.text(), /ctrl\+home\/end top\/bottom/);
});

function queuedBrowser(withdrawn: string[]) {
  const mocked = liveBrowser();
  mocked.host.withdrawSteers.mockResolvedValue(withdrawn);
  return mocked;
}

const ALT_UP = '\u001b[1;3A';

test('a queued steer shows as such, with the key that takes it back', async () => {
  const { sink, text, follow } = liveBrowser();
  await follow();
  sink.push?.({
    busy: true,
    queued: 1,
    paused: false,
    items: [
      { role: 'user', text: 'first prompt' },
      { role: 'user', text: 'Use pnpm', queued: true }
    ]
  });
  assert.match(text(), /^ user \(queued\)$/m);
  assert.match(text(), /alt\+up edit queued/);

  sink.push?.({
    busy: true,
    queued: 0,
    paused: false,
    items: [{ role: 'user', text: 'first prompt' }]
  });
  assert.doesNotMatch(text(), /edit queued/);
});

test('the dequeue key takes the queued message back to edit and send again', async () => {
  const { browser, host, sink, text, type, settle, follow } = queuedBrowser(['Use pnpm']);
  await follow();
  sink.push?.({
    busy: true,
    queued: 1,
    paused: false,
    items: [{ role: 'user', text: 'Use pnpm', queued: true }]
  });

  browser.handleInput(ALT_UP);
  await settle();
  expect(host.withdrawSteers).toHaveBeenCalledWith('run-1', 7);
  assert.match(text(), /steer ▸ .*Use pnpm/);

  type(' not npm');
  browser.handleInput('\r');
  await settle();
  expect(host.steer).toHaveBeenCalledWith('run-1', 7, 'Use pnpm not npm');
});

test('Esc after the dequeue key discards the withdrawn message', async () => {
  const { browser, host, text, settle, follow } = queuedBrowser(['Use pnpm']);
  await follow();
  browser.handleInput(ALT_UP);
  await settle();
  assert.match(text(), /Use pnpm/);
  browser.handleInput('\u001b');
  assert.doesNotMatch(text(), /steer ▸/);
  expect(host.steer).not.toHaveBeenCalled();
});

test('the dequeue key says so when the agent has already read everything', async () => {
  const { browser, host, text, settle, follow } = queuedBrowser([]);
  await follow();
  browser.handleInput(ALT_UP);
  await settle();
  expect(host.withdrawSteers).toHaveBeenCalledTimes(1);
  assert.match(text(), /Nothing queued/);
  assert.doesNotMatch(text(), /steer ▸/);
});

const pausedState = (paused: boolean): FollowedTranscript => ({
  busy: !paused,
  queued: 0,
  paused,
  items: [{ role: 'user', text: 'first prompt' }]
});

test('p interrupts the followed agent, and the title and footer show the pause', async () => {
  const { browser, host, sink, text, settle, follow } = liveBrowser();
  await follow();
  sink.push?.(pausedState(false));
  assert.match(text(), /● live/);
  assert.match(text(), /p pause • m steer/);

  browser.handleInput('p');
  await settle();
  expect(host.pauseAgent).toHaveBeenCalledWith('run-1', 7);
  assert.match(text(), /Paused\. Press m to send a message/);

  sink.push?.(pausedState(true));
  assert.match(text(), /⏸ paused/);
  browser.handleInput('j');
  assert.match(text(), /p resume • m send & resume/);
});

test('p on a paused agent resumes it without a message', async () => {
  const { browser, host, sink, text, settle, follow } = liveBrowser();
  await follow();
  sink.push?.(pausedState(true));
  browser.handleInput('p');
  await settle();
  expect(host.resumeAgent).toHaveBeenCalledWith('run-1', 7);
  expect(host.pauseAgent).not.toHaveBeenCalled();
  assert.match(text(), /Resumed\./);
});

test('a message to a paused agent sends it and resumes in one step', async () => {
  const { browser, host, sink, text, type, settle, follow } = liveBrowser();
  await follow();
  sink.push?.(pausedState(true));

  browser.handleInput('m');
  assert.match(text(), /steer ▸/, 'a paused agent can be written to even though it is not working');
  type('Stop, do X');
  browser.handleInput('\r');
  await settle();
  expect(host.resumeAgent).toHaveBeenCalledWith('run-1', 7, 'Stop, do X');
  expect(host.steer).not.toHaveBeenCalled();
});

test('steers withdrawn by the pause come back to the input to edit or discard', async () => {
  const { browser, host, sink, text, type, settle, follow } = liveBrowser();
  host.pauseAgent.mockResolvedValue({ paused: true, withdrawn: ['Use pnpm'] });
  await follow();
  sink.push?.(pausedState(false));

  browser.handleInput('p');
  await settle();
  assert.match(text(), /steer ▸ .*Use pnpm/);
  assert.doesNotMatch(text(), /steer ▸ >/, 'one prompt, not two');
  type(' please');
  browser.handleInput('\r');
  await settle();
  expect(host.resumeAgent).toHaveBeenCalledWith('run-1', 7, 'Use pnpm please');
});

test('p says so when the agent finished its step before it could be paused', async () => {
  const { browser, host, sink, text, settle, follow } = liveBrowser();
  host.pauseAgent.mockResolvedValue({ paused: false, withdrawn: [] });
  await follow();
  sink.push?.(pausedState(false));
  browser.handleInput('p');
  await settle();
  assert.match(text(), /finished its step before it could be paused/);
  assert.doesNotMatch(text(), /⏸ paused/);
});

test('x cancels a paused agent, which is not busy', async () => {
  const { browser, host, sink, settle, follow } = liveBrowser();
  await follow();
  sink.push?.(pausedState(true));
  browser.handleInput('x');
  browser.handleInput('x');
  await settle();
  expect(host.cancelAgent).toHaveBeenCalledWith('run-1', 7);
});

test('the run view marks a paused agent', () => {
  const lines = renderRunDetailLines(
    {
      ...report,
      attempts: [
        {
          number: 1,
          taskId: 1,
          status: 'running',
          script: '',
          scriptHash: 'x',
          startedAt: 1,
          phases: [],
          logs: [],
          agents: {
            a: {
              key: 'a',
              index: 1,
              label: 'worker',
              status: 'running',
              prompt: 'p',
              conversationId: 7,
              paused: true
            }
          }
        }
      ]
    },
    0,
    0,
    10
  );
  assert.ok(lines.some((line) => /#1 ⏸ worker/.test(line)));
});
