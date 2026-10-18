import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type TranscriptContext,
  Type
} from '@earendil-works/pi-ai';
import {
  defineExtension,
  defineTool,
  type Storage,
  type ToolTaskInput
} from '@earendil-works/pi-durable';
import * as sqlite from '@earendil-works/pi-durable/storage/sqlite/node';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { WorkflowHost, type WorkflowRunBinding } from '../../src/durable/host.js';
import { runDatabasePath, runLockOwner } from '../../src/durable/store.js';
import { workflowFailureMessage } from '../../src/pi/workflow-tool.js';

vi.mock('@earendil-works/pi-durable/storage/sqlite/node', { spy: true });
const { openNodeSqliteStorage } = await vi.importActual<typeof sqlite>(
  '@earendil-works/pi-durable/storage/sqlite/node'
);

const context = BACKGROUND_CONTEXT;
const SCRIPT = `export const meta = { name: 'recovery', description: 'Recover committed work' }
const a = await agent('alpha', { label: 'alpha' })
const b = await agent('beta', { label: 'beta' })
return [a, b]`;
let directory: string;
let hosts: WorkflowHost[];
let faux: ReturnType<typeof fauxProvider>;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pi-workflow-compat-'));
  hosts = [];
  faux = fauxProvider();
});

afterEach(async () => {
  await Promise.all(hosts.map((host) => host.closeAll()));
  vi.mocked(sqlite.openNodeSqliteStorage).mockImplementation(openNodeSqliteStorage);
  await rm(directory, { recursive: true, force: true });
});

function binding(): WorkflowRunBinding {
  const models = createModels();
  models.setProvider(faux.provider);
  return {
    models,
    route: { provider: 'faux', modelId: 'faux-1', thinkingLevel: 'off' },
    resolveProfile() {
      throw new Error('no profiles');
    },
    promptContext: async () => ({ contextFiles: [], skills: '', append: '' })
  };
}

function host(options: ConstructorParameters<typeof WorkflowHost>[0] = {}) {
  const value = new WorkflowHost({
    runsRoot: join(directory, 'runs'),
    watchIntervalMs: 10,
    ...options
  });
  hosts.push(value);
  return value;
}

function respond(
  step: (
    ctx: TranscriptContext,
    options?: { signal?: AbortSignal }
  ) => ReturnType<typeof fauxAssistantMessage> | Promise<ReturnType<typeof fauxAssistantMessage>>
) {
  faux.setResponses(Array.from({ length: 30 }, () => step));
}

function prompt(ctx: TranscriptContext) {
  return ctx.messages.find((message) => message.role === 'user')?.content;
}

function until(check: () => boolean | Promise<boolean>) {
  return expect.poll(check, { timeout: 5000, interval: 10 }).toBeTruthy();
}

/** Use real SQLite, injecting failures only at the Storage boundary. */
function interceptStorage(wrap: (storage: Storage) => void) {
  vi.mocked(sqlite.openNodeSqliteStorage).mockImplementation(async (...args) => {
    const storage = await openNodeSqliteStorage(...args);
    wrap(storage);
    return storage;
  });
}

test.each(['before', 'after'] as const)(
  'a %s-commit storage failure interrupts instead of losing the run or retrying in-process',
  async (when) => {
    let armed = false;
    let failed = false;
    let commitsAfterFailure = 0;
    interceptStorage((storage) => {
      const commit = storage.commit.bind(storage);
      storage.commit = async (writes, ctx) => {
        if (failed) commitsAfterFailure++;
        if (
          armed &&
          !failed &&
          writes.some((write) => write.type === 'entry' && write.value.kind === 'pi.assistant')
        ) {
          if (when === 'after') await commit(writes, ctx);
          failed = true;
          throw new Error('injected disk failure');
        }
        return commit(writes, ctx);
      };
    });
    const seen: unknown[] = [];
    respond((ctx) => {
      seen.push(prompt(ctx));
      if (prompt(ctx) === 'beta') armed = true;
      return fauxAssistantMessage(`answer ${prompt(ctx)}`);
    });
    const reports: unknown[] = [];
    const runs = host({ onReport: (error) => reports.push(error) });
    const handle = await runs.start({ script: SCRIPT, cwd: directory }, binding());
    const outcome = await handle.wait();
    assert.equal(outcome.status, 'interrupted');
    if (outcome.status !== 'interrupted') return;
    assert.match(outcome.error, /injected disk failure/);
    assert.equal(outcome.snapshot.status, 'interrupted');
    assert.match(workflowFailureMessage(outcome, handle.runId), /injected disk failure/);
    assert.ok(
      workflowFailureMessage(outcome, handle.runId).includes(`"resume": "${handle.runId}"`)
    );
    await until(() => !runs.isActive(handle.runId));
    assert.equal(runLockOwner(runs.runsRoot, handle.runId), undefined);
    assert.equal(commitsAfterFailure, 0);
    assert.equal(reports.length, 1);
    assert.match(
      await readFile(join(runs.runsRoot, handle.runId, 'reports.log'), 'utf8'),
      /injected disk failure/
    );

    vi.mocked(sqlite.openNodeSqliteStorage).mockImplementation(openNodeSqliteStorage);
    seen.length = 0;
    const resumed = await host().resume(handle.runId, {}, binding());
    assert.equal(resumed.mode, 'continued');
    assert.equal(resumed.attemptNumber, 1);
    const result = await resumed.wait();
    assert.equal(result.status, 'completed');
    if (result.status === 'completed')
      assert.deepEqual(result.value, ['answer alpha', 'answer beta']);
    assert.deepEqual(seen, when === 'before' ? ['beta'] : []);
    await resumed.close();
  }
);

test('a read failure closes providers and releases the lease even without a waiter', async () => {
  let failReads = false;
  interceptStorage((storage) => {
    const task = storage.task.bind(storage);
    storage.task = async (...args) => {
      if (failReads) throw new Error('injected read failure');
      return task(...args);
    };
  });
  let running = false;
  let providerClosed = false;
  let wasAborted = false;
  respond(async (ctx, options) => {
    if (prompt(ctx) === 'alpha') return fauxAssistantMessage('answer alpha');
    running = true;
    await new Promise<void>((_resolve, reject) => {
      options?.signal?.addEventListener(
        'abort',
        () => {
          wasAborted = true;
          reject(new Error('aborted'));
        },
        { once: true }
      );
    });
    return fauxAssistantMessage('unreachable');
  });
  const runs = host({
    providers: [
      {
        name: 'fixture',
        open: async () => ({
          extensions: [],
          notes: [],
          close: async () => {
            assert.ok(wasAborted, 'provider must outlive in-flight calls');
            providerClosed = true;
          }
        })
      }
    ]
  });
  const handle = await runs.start({ script: SCRIPT, cwd: directory }, binding());
  let doneCount = 0;
  const stopWatching = handle.watch((snapshot) => {
    doneCount = snapshot.doneCount;
  });
  await until(() => running && doneCount === 1);
  failReads = true;
  await assert.rejects(runs.report(handle.runId), /injected read failure|Session failed/i);
  await until(() => !runs.isActive(handle.runId));
  assert.ok(providerClosed);
  assert.equal(runLockOwner(runs.runsRoot, handle.runId), undefined);
  const outcome = await handle.wait();
  assert.equal(outcome.status, 'interrupted');
  if (outcome.status === 'interrupted') assert.match(outcome.error, /injected read failure/);
  assert.equal(outcome.snapshot.doneCount, 1);
  assert.equal(outcome.snapshot.name, 'recovery');
  stopWatching();
});

test.each(['shutdown', 'storage failure'] as const)(
  'provider leases acquired during %s are released exactly once',
  async (reason) => {
    let failStorage = false;
    let storageClosed = false;
    interceptStorage((storage) => {
      const close = storage.close.bind(storage);
      storage.close = async (...args) => {
        await close(...args);
        storageClosed = true;
      };
      const commit = storage.commit.bind(storage);
      storage.commit = async (...args) => {
        if (failStorage) throw new Error('failure during provider acquisition');
        return commit(...args);
      };
    });
    let opening = false;
    let finishOpening!: () => void;
    const pending = new Promise<void>((resolve) => {
      finishOpening = resolve;
    });
    const closedAfterSession: boolean[] = [];
    const fastClose = vi.fn(async () => {
      closedAfterSession.push(storageClosed);
    });
    const lateClose = vi.fn(async () => {
      closedAfterSession.push(storageClosed);
    });
    const runs = host({
      providers: [
        {
          name: 'fast',
          open: async () => ({ extensions: [], notes: [], close: fastClose })
        },
        {
          name: 'pending',
          open: async () => {
            opening = true;
            await pending;
            return { extensions: [], notes: [], close: lateClose };
          }
        }
      ]
    });
    const starting = runs.start({ script: SCRIPT, cwd: directory }, binding());
    const rejected = assert.rejects(
      starting,
      reason === 'shutdown' ? /closed/ : /Workflow storage failed/
    );
    await until(() => opening);
    const runId = (await readdir(runs.runsRoot)).find((name) => name !== '.locks');
    assert.ok(runId);
    if (reason === 'storage failure') {
      failStorage = true;
      await assert.rejects(
        runs.acknowledgeUsage(runId, 'missing-receipt'),
        /failure during provider acquisition/
      );
      await until(() => !runs.isActive(runId));
    } else {
      await runs.closeAll();
    }
    assert.equal(runLockOwner(runs.runsRoot, runId), undefined);
    const fastClosedAtShutdown = fastClose.mock.calls.length;
    assert.equal(lateClose.mock.calls.length, 0);

    finishOpening();
    await rejected;
    assert.equal(fastClosedAtShutdown, 1);
    assert.equal(lateClose.mock.calls.length, 1);
    assert.deepEqual(closedAfterSession, [true, true], 'providers must outlive the Session');
    await runs.closeAll();
    assert.equal(fastClose.mock.calls.length, 1);
    assert.equal(lateClose.mock.calls.length, 1);
  }
);

test('an uncertain initial commit never deletes a run that SQLite admitted', async () => {
  interceptStorage((storage) => {
    const commit = storage.commit.bind(storage);
    storage.commit = async (writes, ctx) => {
      const seq = await commit(writes, ctx);
      if (writes.some((write) => write.type === 'task' && write.value.kind === 'workflow.run')) {
        throw new Error('lost commit acknowledgement');
      }
      return seq;
    };
  });
  const runs = host();
  await assert.rejects(
    runs.start({ script: SCRIPT, cwd: directory }, binding()),
    /Workflow storage failed \(run /
  );
  const [index] = runs.list();
  assert.ok(index, 'the run must remain discoverable without an index cache');
  vi.mocked(sqlite.openNodeSqliteStorage).mockImplementation(openNodeSqliteStorage);
  respond((ctx) => fauxAssistantMessage(`answer ${prompt(ctx)}`));
  const resumed = await host().resume(index.runId, {}, binding());
  assert.equal((await resumed.wait()).status, 'completed');
  await resumed.close();
});

test.each(['before', 'after'] as const)(
  'a %s-commit receipt failure preserves the result and unreported spend',
  async (when) => {
    interceptStorage((storage) => {
      const commit = storage.commit.bind(storage);
      storage.commit = async (writes, ctx) => {
        if (
          writes.some(
            (write) => write.type === 'document.create' && write.record.kind === 'workflow.billing'
          )
        ) {
          if (when === 'after') await commit(writes, ctx);
          throw new Error('receipt storage failed');
        }
        return commit(writes, ctx);
      };
    });
    respond((ctx) => fauxAssistantMessage(`answer ${prompt(ctx)}`));
    const first = host();
    const handle = await first.start({ script: SCRIPT, cwd: directory }, binding());
    const interrupted = await handle.wait();
    assert.equal(interrupted.status, 'interrupted');
    assert.equal(interrupted.snapshot.doneCount, 2);
    await handle.close();
    vi.mocked(sqlite.openNodeSqliteStorage).mockImplementation(openNodeSqliteStorage);
    respond(() => {
      throw new Error('completed agents must not run again');
    });
    const second = host();
    const resumed = await second.resume(handle.runId, {}, binding());
    assert.equal(resumed.mode, 'completed');
    const outcome = await resumed.wait();
    assert.equal(outcome.status, 'completed');
    if (outcome.status !== 'completed') return;
    assert.deepEqual(outcome.value, ['answer alpha', 'answer beta']);
    assert.ok(outcome.unreportedUsage.totalTokens > 0);
    assert.ok(outcome.usageReceipt);
    await resumed.acknowledgeUsage(outcome.usageReceipt.id);
    await resumed.close();
    const again = await second.resume(handle.runId, {}, binding());
    const delivered = await again.wait();
    assert.equal(delivered.status, 'completed');
    if (delivered.status === 'completed') assert.equal(delivered.unreportedUsage.totalTokens, 0);
    await again.close();
  }
);

test.each(['safe', 'unsafe'] as const)(
  'live 1.1 pi.tool records migrate with their %s replay policy intact',
  async (replay) => {
    let executions = 0;
    let ready = false;
    const Probe = defineExtension({
      name: 'probe',
      tools: [
        defineTool({
          name: 'probe',
          description: 'Probe migration',
          parameters: Type.Object({}),
          replay,
          execute: async (_args, _api, ctx) => {
            executions++;
            if (!ready)
              await new Promise<void>((_resolve, reject) => {
                ctx.abortSignal?.addEventListener('abort', () => reject(new Error('closing')), {
                  once: true
                });
              });
            return { output: [{ type: 'text', text: 'probe output' }] };
          }
        })
      ]
    });
    respond((ctx) => {
      const result = ctx.messages.find((message) => message.role === 'toolResult');
      return result
        ? fauxAssistantMessage(JSON.stringify(result))
        : fauxAssistantMessage(fauxToolCall('probe', {}), { stopReason: 'toolUse' });
    });
    const first = host({ extensions: [Probe] });
    const handle = await first.start(
      {
        script: `export const meta = { name: 'legacy', description: 'd' }; return await agent('work')`,
        cwd: directory
      },
      binding()
    );
    await until(() => executions === 1);
    await handle.close();

    // pi.tool v1 has the same model-call checkpoint, but no input/result discriminant. Store that
    // legacy wire shape rather than retaining a second runtime dependency just for this fixture.
    const storage = await sqlite.openNodeSqliteStorage(
      runDatabasePath(first.runsRoot, handle.runId)
    );
    try {
      const tasks = await storage.scanTasks({ kind: 'pi.tool' }, 100, undefined, context);
      assert.equal(tasks.items.length, 1);
      const record = tasks.items[0];
      const input = record.input as ToolTaskInput;
      assert.equal(input.kind, 'model');
      if (input.kind !== 'model') return;
      await storage.commit(
        [
          {
            type: 'task',
            value: {
              ...record,
              version: 1,
              input: { assistant: input.assistant, callId: input.callId }
            }
          }
        ],
        context
      );
    } finally {
      await storage.close(context);
    }
    ready = true;
    const resumed = await host({ extensions: [Probe] }).resume(handle.runId, {}, binding());
    const outcome = await resumed.wait();
    assert.equal(outcome.status, 'completed');
    assert.equal(executions, replay === 'safe' ? 2 : 1);
    if (outcome.status === 'completed') {
      assert.match(String(outcome.value), replay === 'safe' ? /probe output/ : /interrupted/i);
    }
    await resumed.close();
  }
);
