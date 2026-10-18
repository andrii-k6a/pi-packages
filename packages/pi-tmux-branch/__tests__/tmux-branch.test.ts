import assert from 'node:assert/strict';
import { describe, test, vi } from 'vitest';
import tmuxBranchExtension from '../src/tmux-branch.js';

type Handler = (args: string, ctx: unknown) => Promise<void>;
type Completions = (prefix: string) => Array<{ value: string }> | null;

function setup() {
  const commands: Record<string, { handler: Handler; getArgumentCompletions?: Completions }> = {};
  const state = { execCalled: false, execCalls: [] as Array<[string, string[]]> };
  const pi = {
    registerCommand(name: string, options: (typeof commands)[string]) {
      commands[name] = options;
    },
    registerShortcut() {},
    async exec(command: string, args: string[]) {
      state.execCalled = true;
      state.execCalls.push([command, args]);
      return { code: 0, stdout: '', stderr: '', killed: false };
    }
  };

  tmuxBranchExtension(pi as never);
  return { commands, state };
}

function makeCtx(mode: string) {
  const notifications: Array<{ message: string; level: string }> = [];
  const ctx = {
    mode,
    hasUI: true,
    cwd: process.cwd(),
    waitForIdle: async () => {},
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      }
    },
    sessionManager: {}
  };
  return { ctx, notifications };
}

describe('tmux-branch command', () => {
  test('registers a single command', () => {
    const { commands } = setup();
    assert.deepEqual(Object.keys(commands), ['tmux-branch']);
  });

  test('does not split panes outside tui mode', async () => {
    const { commands, state } = setup();
    const { ctx, notifications } = makeCtx('rpc');

    await commands['tmux-branch'].handler('right', ctx);

    assert.equal(state.execCalled, false);
    assert.deepEqual(notifications.at(-1), {
      message: 'Branch panes require the interactive Pi UI',
      level: 'error'
    });
  });

  test('accepts a direction case-insensitively with surrounding whitespace', async () => {
    const { commands, state } = setup();
    const { ctx, notifications } = makeCtx('rpc');

    await commands['tmux-branch'].handler('  Up ', ctx);

    assert.equal(state.execCalled, false);
    assert.equal(notifications.at(-1)?.message, 'Branch panes require the interactive Pi UI');
  });

  test('defaults to right when no direction is given', async () => {
    const { commands, state } = setup();
    const { ctx, notifications } = makeCtx('tui');
    ctx.sessionManager = {
      getSessionFile: () => '/nonexistent/session.jsonl',
      getSessionDir: () => '/nonexistent',
      getLeafId: () => 'leaf'
    } as never;

    vi.stubEnv('TMUX', '/tmp/tmux-test,1,0');
    try {
      await commands['tmux-branch'].handler('  ', ctx);
    } finally {
      vi.unstubAllEnvs();
    }

    assert.equal(notifications.length, 0);
    assert.equal(state.execCalls.length, 1);
    const [command, args] = state.execCalls[0];
    assert.equal(command, 'tmux');
    assert.deepEqual(args.slice(0, 2), ['split-window', '-h']);
    assert.ok(!args.includes('-b'));
  });

  for (const args of ['sideways', 'right left']) {
    test(`shows usage for invalid argument ${JSON.stringify(args)}`, async () => {
      const { commands, state } = setup();
      const { ctx, notifications } = makeCtx('tui');

      await commands['tmux-branch'].handler(args, ctx);

      assert.equal(state.execCalled, false);
      assert.deepEqual(notifications, [
        { message: 'Usage: /tmux-branch [right|left|down|up] (default: right)', level: 'error' }
      ]);
    });
  }

  test('completes directions by prefix', () => {
    const { commands } = setup();
    const complete = commands['tmux-branch'].getArgumentCompletions;
    assert.ok(complete);

    assert.deepEqual(
      complete('')?.map((item) => item.value),
      ['right', 'left', 'down', 'up']
    );
    assert.deepEqual(
      complete('d')?.map((item) => item.value),
      ['down']
    );
    assert.equal(complete('x'), null);
  });
});
