import assert from 'node:assert/strict';
import { test } from 'vitest';
import headExtension from '../src/head.js';

test('head command does not open custom TUI outside tui mode', async () => {
  let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const pi = {
    registerCommand(name: string, options: { handler: typeof handler }) {
      if (name === 'head') handler = options.handler;
    }
  };

  headExtension(pi as never);
  assert.ok(handler);

  let customCalled = false;
  const notifications: Array<{ message: string; level: string }> = [];

  await handler('', {
    mode: 'rpc',
    hasUI: true,
    ui: {
      custom: async () => {
        customCalled = true;
      },
      notify(message: string, level: string) {
        notifications.push({ message, level });
      }
    },
    sessionManager: {
      getBranch: () => [
        {
          type: 'message',
          id: 'entry',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'assistant response' }]
          }
        }
      ]
    }
  });

  assert.equal(customCalled, false);
  assert.deepEqual(notifications.at(-1), {
    message: '/head requires interactive mode',
    level: 'error'
  });
});
