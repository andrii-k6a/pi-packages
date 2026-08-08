import assert from 'node:assert/strict';
import { test } from 'vitest';
import reviewFeedbackExtension from '../src/feedback.js';

test('feedback command does not open custom TUI outside tui mode', async () => {
  let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const pi = {
    registerCommand(name: string, options: { handler: typeof handler }) {
      if (name === 'feedback') handler = options.handler;
    },
    on() {},
    appendEntry() {}
  };

  reviewFeedbackExtension(pi as never);
  assert.ok(handler);

  let customCalled = false;
  const notifications: Array<{ message: string; level: string }> = [];

  await handler('', {
    mode: 'rpc',
    hasUI: true,
    waitForIdle: async () => {},
    ui: {
      custom: async () => {
        customCalled = true;
      },
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
      setEditorText() {}
    },
    sessionManager: {
      getBranch: () => [
        {
          type: 'message',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'assistant response' }]
          }
        }
      ],
      getSessionDir: () => '/tmp/pi-feedback-test',
      getSessionId: () => 'session',
      getSessionFile: () => undefined
    }
  });

  assert.equal(customCalled, false);
  assert.deepEqual(notifications.at(-1), {
    message: '/feedback requires interactive mode',
    level: 'error'
  });
});
