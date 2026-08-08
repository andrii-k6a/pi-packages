import assert from 'node:assert/strict';
import { test } from 'vitest';
import tmuxBranchExtension from '../src/tmux-branch.js';

test('tmux branch command does not split panes outside tui mode', async () => {
  let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  let execCalled = false;
  const pi = {
    registerCommand(name: string, options: { handler: typeof handler }) {
      if (name === 'tmux-branch-right') handler = options.handler;
    },
    registerShortcut() {},
    async exec() {
      execCalled = true;
      return { code: 0, stdout: '', stderr: '', killed: false };
    }
  };

  tmuxBranchExtension(pi as never);
  assert.ok(handler);

  const notifications: Array<{ message: string; level: string }> = [];

  await handler('', {
    mode: 'rpc',
    hasUI: true,
    cwd: process.cwd(),
    waitForIdle: async () => {},
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      }
    },
    sessionManager: {}
  });

  assert.equal(execCalled, false);
  assert.deepEqual(notifications.at(-1), {
    message: 'Branch panes require the interactive Pi UI',
    level: 'error'
  });
});
