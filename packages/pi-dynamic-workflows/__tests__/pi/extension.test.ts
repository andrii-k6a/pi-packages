import assert from 'node:assert/strict';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { WorkflowHost } from '../../src/durable/host.js';
import * as mcpConfig from '../../src/durable/mcp/config.js';
import type { WorkflowRunIndex } from '../../src/durable/store.js';
import extension from '../../src/dynamic-workflows.js';
import * as profilesConfig from '../../src/profiles/config.js';

vi.mock('../../src/durable/mcp/config.js', { spy: true });
vi.mock('../../src/profiles/config.js', { spy: true });

beforeEach(() => {
  vi.mocked(mcpConfig.loadWorkflowMcpAllowlist).mockReturnValue({ servers: {} });
  vi.mocked(profilesConfig.loadWorkflowProfiles).mockReturnValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function setup(run: WorkflowRunIndex) {
  vi.spyOn(WorkflowHost.prototype, 'list').mockReturnValue([run]);
  const handlers = new Map<string, unknown>();
  const pi: Pick<
    ExtensionAPI,
    'registerTool' | 'registerCommand' | 'getActiveTools' | 'setActiveTools' | 'on'
  > = {
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    getActiveTools: vi.fn(() => ['workflow']),
    setActiveTools: vi.fn(),
    on: vi.fn((event: string, handler: unknown) => {
      handlers.set(event, handler);
      return () => {
        handlers.delete(event);
      };
    })
  };
  // The factory only needs registration APIs; command-only APIs are never invoked here.
  extension(pi as ExtensionAPI);
  const start = handlers.get('session_start');
  assert.ok(typeof start === 'function', 'The extension must register a session_start handler');
  const notify = vi.fn<ExtensionContext['ui']['notify']>();
  return {
    notify,
    start(hasUI = true) {
      start({ type: 'session_start' }, { cwd: run.cwd, hasUI, ui: { notify } });
    }
  };
}

const interrupted: WorkflowRunIndex = {
  version: 1,
  runId: 'run-1',
  name: 'audit',
  description: 'Audit the project',
  cwd: '/repo',
  createdAt: 1,
  updatedAt: 2,
  status: 'interrupted',
  attempts: 1,
  agents: { total: 2, done: 1, error: 0, running: 1 }
};

test.each([
  '\u001b[31maudit\u001b[0m\u0007\nnext\tphase',
  'audit\u009d0;title\u009c\u202e\nnext\tphase'
])('startup notification sanitizes the interrupted workflow name: %j', (name) => {
  const run = { ...interrupted, name };
  const before = structuredClone(run);
  const mocked = setup(run);
  mocked.start();

  assert.equal(mocked.notify.mock.calls.length, 1);
  const [message, tone] = mocked.notify.mock.calls[0];
  assert.equal(
    message,
    'Workflow audit next phase was interrupted (1/2 agents done, run run-1). Use /workflows to inspect or resume it.'
  );
  assert.equal(tone, 'warning');
  assert.doesNotMatch(message, /[\p{Cc}\u202e]/u);
  assert.deepEqual(run, before);
});

test('startup without UI does not emit an interrupted workflow notification', () => {
  const mocked = setup(interrupted);
  mocked.start(false);
  assert.equal(mocked.notify.mock.calls.length, 0);
});

test('a malformed PI_WORKFLOW_MAX_AGENTS stops the extension from loading, like other configuration', () => {
  vi.stubEnv('PI_WORKFLOW_MAX_AGENTS', 'lots');
  try {
    assert.throws(() => setup(interrupted), /PI_WORKFLOW_MAX_AGENTS must be/);
  } finally {
    vi.unstubAllEnvs();
  }
  vi.stubEnv('PI_WORKFLOW_MAX_AGENTS', '25');
  try {
    assert.doesNotThrow(() => setup(interrupted));
  } finally {
    vi.unstubAllEnvs();
  }
});
