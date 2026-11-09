import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonValue } from '@earendil-works/chord';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  type TranscriptContext
} from '@earendil-works/pi-ai';
import {
  type ExtensionAPI,
  type ExtensionContext,
  SessionManager
} from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { WorkflowHost } from '../../src/durable/host.js';
import { WorkflowBackgroundRuns } from '../../src/pi/background.js';
import { createWorkflowRunBinding, createWorkflowTool } from '../../src/pi/workflow-tool.js';
import type { WorkflowSnapshot } from '../../src/workflow/snapshot.js';

let directory: string;
let faux: ReturnType<typeof fauxProvider>;
let models: ReturnType<typeof createModels>;
let session: SessionManager;
let hosts: WorkflowHost[];
let runners: Array<{ background: WorkflowBackgroundRuns; ctx: ExtensionContext }>;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'workflow-background-'));
  session = SessionManager.create(directory, join(directory, 'parents'));
  session.appendMessage({ role: 'user', content: 'Start work', timestamp: 1 });
  hosts = [];
  runners = [];
  faux = fauxProvider({ models: [{ id: 'faux-1' }] });
  models = createModels();
  models.setProvider(faux.provider);
});

afterEach(async () => {
  await Promise.all(runners.map(({ background, ctx }) => background.close(ctx)));
  await Promise.all(hosts.map((host) => host.closeAll()));
  await rm(directory, { recursive: true, force: true });
});

function runtime(parent = session) {
  const host = new WorkflowHost({ runsRoot: join(directory, 'runs'), watchIntervalMs: 5 });
  hosts.push(host);
  const messages: Parameters<ExtensionAPI['sendMessage']>[0][] = [];
  const sendOptions: Parameters<ExtensionAPI['sendMessage']>[1][] = [];
  const widgets = new Map<string, unknown>();
  const pi = {
    appendEntry(customType: string, data: unknown) {
      parent.appendCustomEntry(customType, data);
    },
    sendMessage: ((message, options) => {
      messages.push(message);
      sendOptions.push(options);
      parent.appendCustomMessageEntry(
        message.customType,
        message.content,
        message.display,
        message.details
      );
    }) as ExtensionAPI['sendMessage']
  };
  const ctx = {
    cwd: directory,
    mode: 'tui',
    hasUI: true,
    model: { provider: 'faux', id: 'faux-1' },
    thinkingLevel: 'off',
    scopedModels: [],
    isProjectTrusted: () => false,
    isIdle: () => true,
    sessionManager: parent,
    modelRegistry: { runtime: models },
    ui: {
      setWidget: (key: string, lines: unknown) => {
        if (lines === undefined) widgets.delete(key);
        else widgets.set(key, lines);
      },
      notify: vi.fn()
    }
  } as unknown as ExtensionContext;
  const background = new WorkflowBackgroundRuns(pi, host);
  runners.push({ background, ctx });
  const tool = createWorkflowTool({
    host,
    backgroundRuns: background,
    promptContext: async () => ({ contextFiles: [], skills: '', append: '' })
  });
  const execute = (
    input: Parameters<typeof tool.execute>[1],
    toolCallId = 'call',
    signal?: AbortSignal,
    context = ctx
  ) => tool.execute(toolCallId, input, signal, undefined, context as never);
  const persist = (result: Awaited<ReturnType<typeof execute>>, toolCallId: string) => {
    parent.appendMessage({
      ...result,
      details: result.details as JsonValue,
      role: 'toolResult',
      toolName: 'workflow',
      toolCallId,
      isError: false,
      timestamp: 2
    });
  };
  return { host, background, ctx, execute, messages, sendOptions, widgets, persist, pi };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function respond(handler: (prompt: string, signal?: AbortSignal) => Promise<string>) {
  faux.setResponses(
    Array.from(
      { length: 30 },
      () => async (context: TranscriptContext, options?: { signal?: AbortSignal }) => {
        const user = context.messages.find((message) => message.role === 'user');
        const prompt = typeof user?.content === 'string' ? user.content : '';
        return fauxAssistantMessage([fauxText(await handler(prompt, options?.signal))]);
      }
    )
  );
}

function text(result: { content: unknown }): string {
  return (result.content as Array<{ text: string }>)[0].text;
}

function runId(result: { details: unknown }): string {
  const id = (result.details as WorkflowSnapshot).runId;
  assert.ok(id);
  return id;
}

const SCRIPT = `export const meta = { name: 'background_demo', description: 'Background demo' }
phase('Investigate')
return await agent('slow', { label: 'investigator' })`;

test('background returns before completion, survives the parent signal, and collects usage once', async () => {
  const gate = deferred();
  respond(async () => {
    await gate.promise;
    return 'the result';
  });
  const r = runtime();
  const controller = new AbortController();
  const started = await r.execute({ script: SCRIPT, background: true }, 'start', controller.signal);
  const id = runId(started);
  assert.match(text(started), /started in the background/);
  assert.equal(started.usage, undefined);
  assert.equal(r.messages.length, 0);
  assert.equal(r.host.isActive(id), true);
  await vi.waitFor(() => assert.equal(faux.state.callCount, 1));
  await vi.waitFor(() => assert.equal(r.widgets.size, 1));
  assert.match(JSON.stringify([...r.widgets.values()]), /Investigate/);
  await r.host.settleDeliveries(session.getSessionFile());
  assert.equal(r.host.isActive(id), true, 'the initiating turn cannot settle background spend');
  controller.abort();

  const status = await r.execute({ status: id }, 'status', undefined, {
    ...r.ctx,
    model: undefined
  });
  assert.equal((status.details as WorkflowSnapshot).status, 'running');
  const early = await r.execute({ result: id });
  assert.match(text(early), /running/);
  assert.equal(early.usage, undefined);
  assert.equal(faux.state.callCount, 1);

  gate.resolve();
  await vi.waitFor(() => assert.equal(r.messages.length, 1));
  assert.equal(r.widgets.size, 0);
  assert.equal(r.host.isActive(id), false);
  assert.match(String(r.messages[0].content), new RegExp(`"result":"${id}"`));
  assert.deepEqual(r.sendOptions[0], { triggerTurn: true, deliverAs: 'followUp' });

  const result = await r.execute({ result: id }, 'collect');
  assert.match(text(result), /"the result"/);
  assert.ok(result.usage?.totalTokens);
  assert.ok((result.details as { usageReceipt?: unknown }).usageReceipt);
  assert.equal(r.host.isActive(id), true, 'keep the receipt lease until parent persistence');
  r.persist(result, 'collect');
  await r.host.settleDeliveries(session.getSessionFile());
  const again = await r.execute({ result: id }, 'again');
  assert.equal(again.usage, undefined);
  assert.equal(faux.state.callCount, 1);
});

test('collecting one background run does not stop another run or clear its progress', async () => {
  const firstGate = deferred();
  const secondGate = deferred();
  respond(async (prompt) => {
    await (prompt === 'first' ? firstGate.promise : secondGate.promise);
    return `${prompt} result`;
  });
  const r = runtime();
  const script = SCRIPT.replace("'slow'", 'args.prompt');
  const first = await r.execute({ script, args: { prompt: 'first' }, background: true });
  const second = await r.execute({ script, args: { prompt: 'second' }, background: true });
  await vi.waitFor(() => assert.equal(r.widgets.size, 2));
  firstGate.resolve();
  await vi.waitFor(() => assert.equal(r.messages.length, 1));
  assert.equal(r.widgets.size, 1);
  const result = await r.execute({ result: runId(first) }, 'collect-first');
  r.persist(result, 'collect-first');
  await r.host.settleDeliveries(session.getSessionFile());
  assert.equal(r.host.isActive(runId(second)), true);
  assert.equal(r.widgets.size, 1);
  secondGate.resolve();
  await vi.waitFor(() => assert.equal(r.messages.length, 2));
  assert.equal(r.widgets.size, 0);
});

test('an in-memory background run keeps its spend until result retrieval', async () => {
  respond(async () => 'memory result');
  const r = runtime(SessionManager.inMemory(directory));
  const started = await r.execute({ script: SCRIPT, background: true });
  const id = runId(started);
  await vi.waitFor(() => assert.equal(r.messages.length, 1));
  const result = await r.execute({ result: id });
  assert.ok(result.usage?.totalTokens);
  assert.equal(r.host.isActive(id), false);
  const again = await r.execute({ result: id });
  assert.equal(again.usage, undefined);
  assert.equal(faux.state.callCount, 1);
});

test('pending results recover in their originating session, not a fork, without new agent calls', async () => {
  respond(async () => 'saved result');
  const first = runtime();
  const started = await first.execute({ script: SCRIPT, background: true });
  const id = runId(started);
  await vi.waitFor(() => assert.equal(first.messages.length, 1));
  first.persist(await first.execute({ status: id }, 'status'), 'status');
  await first.background.close(first.ctx);

  const fork = SessionManager.inMemory(directory);
  for (const entry of session.getEntries()) {
    if (entry.type === 'custom') fork.appendCustomEntry(entry.customType, entry.data);
  }
  const other = runtime(fork);
  await other.background.recover(other.ctx);
  assert.equal(other.messages.length, 0);

  const reopened = SessionManager.open(session.getSessionFile() as string);
  const recovered = runtime(reopened);
  await recovered.background.recover(recovered.ctx);
  assert.equal(
    recovered.messages.length,
    1,
    'neither a notification nor a completed status query is result collection'
  );
  const result = await recovered.execute({ result: id }, 'collect');
  assert.match(text(result), /saved result/);
  assert.ok(result.usage?.totalTokens);
  recovered.persist(result, 'collect');
  // Crash after persistence but before acknowledgement. Recovery must not notify or charge again.
  await recovered.background.close(recovered.ctx);
  const last = runtime(SessionManager.open(reopened.getSessionFile() as string));
  await last.background.recover(last.ctx);
  assert.equal(last.messages.length, 0);
  const replay = await last.execute({ result: id });
  assert.equal(replay.usage, undefined);
  assert.equal(faux.state.callCount, 1);
});

test('a lost collection result re-offers usage without rerunning agents', async () => {
  respond(async () => 'result');
  const r = runtime();
  const first = await r.execute({ script: SCRIPT, background: true });
  const id = runId(first);
  await vi.waitFor(() => assert.equal(r.messages.length, 1));
  const lost = await r.execute({ result: id }, 'lost');
  assert.ok(lost.usage?.totalTokens);
  await r.background.close(r.ctx);
  const recovered = runtime(SessionManager.open(session.getSessionFile() as string));
  await recovered.background.recover(recovered.ctx);
  assert.equal(recovered.messages.length, 1);
  const retry = await recovered.execute({ result: id }, 'retry');
  assert.deepEqual(retry.usage, lost.usage);
  assert.equal(faux.state.callCount, 1);
});

test('a notification failure retains the result for recovery', async () => {
  respond(async () => 'saved result');
  const r = runtime();
  vi.spyOn(r.pi, 'sendMessage').mockImplementationOnce(() => {
    throw new Error('delivery unavailable');
  });
  const started = await r.execute({ script: SCRIPT, background: true });
  const id = runId(started);
  await vi.waitFor(() => assert.equal(r.host.isActive(id), false));
  assert.equal(r.messages.length, 0);
  assert.match(String(vi.mocked(r.ctx.ui.notify).mock.calls[0][0]), /delivery is pending/);
  await r.background.recover(r.ctx);
  assert.equal(r.messages.length, 1);
  const result = await r.execute({ result: id });
  assert.match(text(result), /saved result/);
  assert.ok(result.usage?.totalTokens);
});

test('a proposed notification stays pending until session history records it', async () => {
  respond(async () => 'saved result');
  const r = runtime();
  r.ctx.isIdle = () => false;
  await r.execute({ script: SCRIPT, background: true });
  await vi.waitFor(() => assert.equal(r.background.notificationEntries(r.ctx).length, 1));
  assert.equal(r.messages.length, 0);
  const proposed = r.background.notificationEntries(r.ctx);
  r.background.settleNotifications(r.ctx);
  assert.deepEqual(r.background.notificationEntries(r.ctx), proposed);
  const entry = proposed[0];
  session.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
  assert.deepEqual(r.background.notificationEntries(r.ctx), []);
});

test.each(['deliver', 'cancel', 'close'] as const)(
  'a scheduled notification waits for idle and respects %s',
  async (action) => {
    respond(async () => 'saved result');
    const r = runtime();
    r.ctx.isIdle = () => false;
    await r.execute({ script: SCRIPT, background: true });
    await vi.waitFor(() => assert.equal(r.background.notificationEntries(r.ctx).length, 1));
    vi.useFakeTimers();
    try {
      r.background.scheduleNotificationFlush(r.ctx);
      await vi.advanceTimersByTimeAsync(100);
      assert.equal(r.messages.length, 0, 'a completion cannot start a turn while Pi is busy');
      if (action === 'cancel') r.background.cancelNotificationFlush();
      if (action === 'close') await r.background.close(r.ctx);
      r.ctx.isIdle = () => true;
      await vi.advanceTimersByTimeAsync(100);
      assert.equal(r.messages.length, action === 'deliver' ? 1 : 0);
    } finally {
      vi.useRealTimers();
    }
  }
);

test('shutdown interrupts background work without sending into a replacement session', async () => {
  const entered = deferred();
  respond(async (prompt, signal) => {
    if (prompt === 'slow') {
      entered.resolve();
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('interrupted')), { once: true });
      });
    }
    return 'quick result';
  });
  const r = runtime();
  const script = SCRIPT.replace(
    "return await agent('slow', { label: 'investigator' })",
    "const quick = await agent('quick', { label: 'quick' }); const slow = await agent('slow', { label: 'slow' }); return { quick, slow }"
  );
  const started = await r.execute({ script, background: true });
  const id = runId(started);
  await entered.promise;
  await r.background.close(r.ctx);
  assert.equal(r.messages.length, 0);
  assert.equal(r.widgets.size, 0);
  assert.equal(r.host.isActive(id), false);
  assert.equal((await r.host.report(id)).status, 'interrupted');
  await assert.rejects(
    r.host.result(id, createWorkflowRunBinding(r.ctx)),
    /has no completed result/
  );
  assert.equal(r.host.isActive(id), false);
  assert.equal(faux.state.callCount, 2, 'a result lookup cannot schedule interrupted work');

  const resumed = runtime();
  await resumed.background.recover(resumed.ctx);
  assert.match(String(resumed.messages[0].content), /interrupted/);
  assert.equal(faux.state.callCount, 2, 'recovery does not resume agents automatically');
  respond(async () => 'resumed slow result');
  await resumed.execute({ resume: id, background: true });
  await vi.waitFor(() => assert.equal(resumed.messages.length, 2));
  const result = await resumed.execute({ result: id });
  assert.match(text(result), /quick result/);
  assert.match(text(result), /resumed slow result/);
  assert.equal((result.details as WorkflowSnapshot).attempt, 1);
  assert.equal(faux.state.callCount, 3, 'the committed quick agent is not repeated');
});

test('cancel stops a background run, preserves it, and result queries do not retry failures', async () => {
  const entered = deferred();
  respond(async (_prompt, signal) => {
    entered.resolve();
    await new Promise<void>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    return 'unreachable';
  });
  const r = runtime();
  const started = await r.execute({ script: SCRIPT, background: true });
  const id = runId(started);
  await entered.promise;
  const cancelled = await r.execute({ cancel: id });
  assert.match(text(cancelled), /Cancellation requested/);
  await vi.waitFor(() => assert.equal(r.messages.length, 1));
  assert.match(String(r.messages[0].content), /aborted/);
  const result = await r.execute({ result: id });
  assert.equal((result.details as WorkflowSnapshot).status, 'aborted');
  assert.equal(faux.state.callCount, 1);
  assert.equal((await r.host.report(id)).attempts.length, 1);
});

test('script failures are delivered without automatic retries', async () => {
  respond(async () => 'done');
  const r = runtime();
  const started = await r.execute({
    script: `${SCRIPT.replace('return await agent', 'await agent')}; throw new Error('script bug')`,
    background: true
  });
  const id = runId(started);
  await vi.waitFor(() => assert.equal(r.messages.length, 1));
  assert.match(String(r.messages[0].content), /failed.*\n.*script bug/);
  const result = await r.execute({ result: id });
  assert.match(text(result), /failed/);
  assert.equal((await r.host.report(id)).attempts.length, 1);
});

test('background is rejected before starting work in print and JSON modes', async () => {
  const r = runtime();
  for (const mode of ['print', 'json'] as const) {
    await assert.rejects(
      r.execute({ script: SCRIPT, background: true }, 'start', undefined, { ...r.ctx, mode }),
      /Background workflows require TUI or RPC mode/
    );
  }
  assert.equal(r.host.list().length, 0);
});

test('query inputs are exclusive and have usable run ids', () => {
  const tool = createWorkflowTool();
  assert.deepEqual(tool.prepareArguments?.({ result: 'run-1' }), { result: 'run-1' });
  for (const input of [
    { status: 'run-1', script: SCRIPT },
    { result: 'run-1', resume: 'run-1' },
    { cancel: 'run-1', status: 'run-1' },
    { result: 'run-1', background: true }
  ]) {
    assert.throws(() => tool.prepareArguments?.(input), /must be used alone/);
  }
  assert.throws(() => tool.prepareArguments?.({ status: '' }), /non-empty run id/);
  assert.throws(() => tool.prepareArguments?.({ cancel: 42 }), /non-empty run id/);
  assert.throws(
    () => tool.prepareArguments?.({ script: SCRIPT, background: 'yes' }),
    /`background` to be a boolean/
  );
});
