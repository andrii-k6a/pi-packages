import assert from 'node:assert/strict';
import type { Usage } from '@earendil-works/pi-ai';
import {
  createAgentSession,
  DefaultResourceLoader,
  SettingsManager
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { beforeEach, test, vi } from 'vitest';
import { WorkflowAgent } from '../src/agent.js';
import { createStructuredOutputTool } from '../src/structured-output.js';
import { emptyUsage } from '../src/usage.js';

const state = vi.hoisted(() => ({
  session: null as unknown,
  loaderOptions: null as unknown,
  events: [] as string[],
  settings: { fake: true }
}));

vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@earendil-works/pi-coding-agent')>()),
  createAgentSession: vi.fn(async () => {
    state.events.push('create');
    return { session: state.session };
  }),
  DefaultResourceLoader: class {
    constructor(options: unknown) {
      state.loaderOptions = options;
    }
    async reload() {
      state.events.push('reload');
    }
  },
  SettingsManager: { create: vi.fn(() => state.settings) },
  getAgentDir: () => '/tmp/agent'
}));

function fakeSession(
  active: string[] = [],
  registered: string[] = [],
  messages: unknown[] = [{ role: 'assistant', content: [{ type: 'text', text: 'done' }] }]
) {
  return {
    messages,
    sessionManager: {
      getEntries: () => messages.map((message) => ({ type: 'message', message }))
    },
    prompt: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    dispose: vi.fn(),
    getActiveToolNames: vi.fn(() => active),
    getAllTools: vi.fn(() => registered.map((name) => ({ name }))),
    setActiveToolsByName: vi.fn()
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.events = [];
  state.loaderOptions = null;
  state.session = fakeSession();
});

function sessionOptions() {
  const options = vi.mocked(createAgentSession).mock.calls[0]?.[0];
  assert.ok(options, 'expected createAgentSession to be called');
  return options;
}

test('subagents always exclude workflow and preserve other excluded tools without duplicates', async () => {
  await new WorkflowAgent({ tools: [] }).run('task');
  assert.deepEqual(sessionOptions().excludeTools, ['workflow']);

  vi.mocked(createAgentSession).mockClear();
  await new WorkflowAgent({
    tools: [],
    session: { excludeTools: ['bash', 'workflow', 'read', 'bash'] }
  }).run('task');
  assert.deepEqual(sessionOptions().excludeTools, ['workflow', 'bash', 'read']);
});

test('codemode defaults off without a custom loader or tool activation', async () => {
  const session = fakeSession([], ['codemode']);
  state.session = session;
  const result = await new WorkflowAgent({ tools: [] }).run('task');

  assert.equal(result, 'done');
  assert.equal(sessionOptions().resourceLoader, undefined);
  assert.equal(state.loaderOptions, null);
  assert.equal(session.setActiveToolsByName.mock.calls.length, 0);
  assert.equal(session.dispose.mock.calls.length, 1);
});

test('codemode loads before session creation with shared settings and activates when available', async () => {
  const session = fakeSession(['read'], ['codemode', 'read']);
  state.session = session;
  await new WorkflowAgent({ cwd: '/tmp/project', tools: [], codemode: true }).run('task');

  assert.deepEqual(state.events, ['reload', 'create']);
  const loader = state.loaderOptions as {
    cwd: string;
    agentDir: string;
    settingsManager: unknown;
    extensionFactories: Array<{ name: string; factory: unknown; replaceable: boolean }>;
  };
  assert.equal(loader.cwd, '/tmp/project');
  assert.equal(loader.agentDir, '/tmp/agent');
  assert.equal(loader.settingsManager, state.settings);
  assert.deepEqual(
    loader.extensionFactories.map(({ name, replaceable }) => ({ name, replaceable })),
    [{ name: 'codemode', replaceable: true }]
  );
  assert.equal(typeof loader.extensionFactories[0].factory, 'function');
  assert.equal(sessionOptions().settingsManager, state.settings);
  assert.ok(sessionOptions().resourceLoader instanceof DefaultResourceLoader);
  assert.equal(vi.mocked(SettingsManager.create).mock.calls.length, 1);
  assert.deepEqual(session.setActiveToolsByName.mock.calls, [[['read', 'codemode']]]);
  assert.equal(session.dispose.mock.calls.length, 1);
});

test('session path overrides are shared by settings, resource loader, and session', async () => {
  await new WorkflowAgent({
    cwd: '/tmp/project',
    tools: [],
    codemode: true,
    session: { cwd: '/tmp/override-project', agentDir: '/tmp/override-agent' }
  }).run('task');

  assert.deepEqual(vi.mocked(SettingsManager.create).mock.calls, [
    ['/tmp/override-project', '/tmp/override-agent']
  ]);
  const loader = state.loaderOptions as { cwd: string; agentDir: string };
  assert.equal(loader.cwd, '/tmp/override-project');
  assert.equal(loader.agentDir, '/tmp/override-agent');
  assert.equal(sessionOptions().cwd, loader.cwd);
  assert.equal(sessionOptions().agentDir, loader.agentDir);
  assert.equal(sessionOptions().sessionManager?.getCwd(), loader.cwd);
});

test('codemode does not activate when already active or not registered', async () => {
  for (const [active, registered] of [
    [['codemode'], ['codemode']],
    [[], []]
  ]) {
    const session = fakeSession(active, registered);
    state.session = session;
    await new WorkflowAgent({ tools: [], codemode: true }).run('task');
    assert.equal(session.setActiveToolsByName.mock.calls.length, 0);
    assert.equal(session.dispose.mock.calls.length, 1);
  }
});

test('codemode respects a caller-supplied resource loader', async () => {
  const resourceLoader = { reload: vi.fn() };
  await new WorkflowAgent({
    tools: [],
    codemode: true,
    session: { resourceLoader: resourceLoader as never }
  }).run('task');

  assert.equal(state.loaderOptions, null);
  assert.equal(sessionOptions().resourceLoader, resourceLoader);
  assert.equal(resourceLoader.reload.mock.calls.length, 0);
  assert.equal(sessionOptions().settingsManager, state.settings);
});

test('codemode shares a caller-supplied settings manager with the loader and session', async () => {
  const settingsManager = { caller: true };
  await new WorkflowAgent({
    tools: [],
    codemode: true,
    session: { settingsManager: settingsManager as never }
  }).run('task');

  assert.equal(vi.mocked(SettingsManager.create).mock.calls.length, 0);
  assert.equal(
    (state.loaderOptions as { settingsManager: unknown }).settingsManager,
    settingsManager
  );
  assert.equal(sessionOptions().settingsManager, settingsManager);
});

test('subagent session is disposed after prompt or activation fails', async () => {
  const promptFailure = fakeSession();
  promptFailure.prompt.mockRejectedValueOnce(new Error('prompt failed'));
  state.session = promptFailure;
  await assert.rejects(new WorkflowAgent({ tools: [] }).run('task'), /prompt failed/);
  assert.equal(promptFailure.dispose.mock.calls.length, 1);

  const activationFailure = fakeSession([], ['codemode']);
  activationFailure.setActiveToolsByName.mockImplementationOnce(() => {
    throw new Error('activation failed');
  });
  state.session = activationFailure;
  await assert.rejects(
    new WorkflowAgent({ tools: [], codemode: true }).run('task'),
    /activation failed/
  );
  assert.equal(activationFailure.dispose.mock.calls.length, 1);
});

test('onUsage reports assistant and tool spend exactly once for a structured success', async () => {
  const first: Usage = { ...emptyUsage(), input: 7, totalTokens: 7 };
  const nested: Usage = {
    ...emptyUsage(),
    output: 3,
    totalTokens: 3,
    cost: { ...emptyUsage().cost, total: 0.5 }
  };
  const session = fakeSession([], [], []);
  state.session = session;
  session.prompt.mockImplementationOnce(async () => {
    session.messages.push(
      { role: 'assistant', usage: first },
      { role: 'toolResult', usage: nested },
      { role: 'user', usage: { ...emptyUsage(), totalTokens: 100 } }
    );
    const tool = sessionOptions().customTools?.find((item) => item.name === 'structured_output');
    assert.ok(tool);
    await tool.execute('id', { result: 'ok' }, undefined, undefined, {} as never);
  });
  const seen: Usage[] = [];
  const result = await new WorkflowAgent({ tools: [] }).run('task', {
    schema: Type.Object({ result: Type.String() }),
    onUsage: (usage) => seen.push(usage)
  });

  assert.deepEqual(result, { result: 'ok' });
  assert.deepEqual(seen, [
    {
      ...emptyUsage(),
      input: 7,
      output: 3,
      totalTokens: 10,
      cost: { ...emptyUsage().cost, total: 0.5 }
    }
  ]);
  assert.equal(session.dispose.mock.calls.length, 1);
});

test('onUsage reports spend on missing structured_output and aborted sessions', async () => {
  const session = fakeSession([], [], []);
  state.session = session;
  session.prompt.mockImplementationOnce(async () => {
    session.messages.push({ role: 'assistant', usage: { ...emptyUsage(), totalTokens: 12 } });
  });
  const seen: Usage[] = [];
  await assert.rejects(
    new WorkflowAgent({ tools: [] }).run('task', {
      schema: Type.Object({ result: Type.String() }),
      onUsage: (usage) => seen.push(usage)
    }),
    /without calling structured_output/
  );
  assert.deepEqual(seen, [{ ...emptyUsage(), totalTokens: 12 }]);
  assert.equal(session.dispose.mock.calls.length, 1);

  const controller = new AbortController();
  const aborted = fakeSession([], [], []);
  aborted.prompt.mockImplementationOnce(async () => {
    aborted.messages.push({
      role: 'assistant',
      usage: { ...emptyUsage(), totalTokens: 2 }
    });
    controller.abort();
  });
  state.session = aborted;
  await assert.rejects(
    new WorkflowAgent({ tools: [] }).run('task', {
      signal: controller.signal,
      onUsage: (usage) => seen.push(usage)
    }),
    /Subagent was aborted/
  );
  assert.deepEqual(seen[1], { ...emptyUsage(), totalTokens: 2 });
  assert.equal(aborted.dispose.mock.calls.length, 1);
});

test('onUsage excludes entries that predate the run', async () => {
  const session = fakeSession(
    [],
    [],
    [{ role: 'assistant', usage: { ...emptyUsage(), input: 100, totalTokens: 100 } }]
  );
  session.prompt.mockImplementationOnce(async () => {
    session.messages.push({
      role: 'assistant',
      content: [{ type: 'text', text: 'new result' }],
      usage: { ...emptyUsage(), output: 5, totalTokens: 5 }
    });
  });
  state.session = session;
  const seen: Usage[] = [];

  const result = await new WorkflowAgent({ tools: [] }).run('task', {
    onUsage: (usage) => seen.push(usage)
  });

  assert.equal(result, 'new result');
  assert.deepEqual(seen, [{ ...emptyUsage(), output: 5, totalTokens: 5 }]);
});

test('throwing onUsage still removes the abort listener and disposes the session', async () => {
  const session = fakeSession();
  state.session = session;
  const signal = new AbortController().signal;
  const remove = vi.spyOn(signal, 'removeEventListener');
  let calls = 0;
  await assert.rejects(
    new WorkflowAgent({ tools: [] }).run('task', {
      signal,
      onUsage() {
        calls++;
        throw new Error('usage callback failed');
      }
    }),
    /usage callback failed/
  );
  assert.equal(calls, 1);
  assert.equal(remove.mock.calls.length, 1);
  assert.equal(remove.mock.calls[0][0], 'abort');
  assert.equal(session.dispose.mock.calls.length, 1);
});

test('structured_output is model-only so it can terminate a codemode subagent', () => {
  const tool = createStructuredOutputTool({
    schema: Type.Object({ result: Type.String() }),
    capture: { called: false, value: undefined }
  });
  assert.equal(tool.exposure, 'model-only');
});
