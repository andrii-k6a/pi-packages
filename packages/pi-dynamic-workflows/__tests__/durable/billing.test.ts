import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  type Usage
} from '@earendil-works/pi-ai';
import { afterEach, beforeEach, test } from 'vitest';
import type { WorkflowUsageReceipt } from '../../src/durable/billing.js';
import { WorkflowHost } from '../../src/durable/host.js';
import { createWorkflowRunBinding, createWorkflowTool } from '../../src/pi/workflow-tool.js';

let directory: string;
let parent: string;
let hosts: WorkflowHost[];
let models: ReturnType<typeof createModels>;
let faux: ReturnType<typeof fauxProvider>;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'workflow-billing-'));
  parent = join(directory, 'parent.jsonl');
  await writeFile(parent, `${JSON.stringify({ type: 'session', version: 3, id: 'parent' })}\n`);
  hosts = [];
  faux = fauxProvider({ models: [{ id: 'faux-1' }] });
  faux.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage([fauxText('ok')])));
  models = createModels();
  models.setProvider(faux.provider);
});

afterEach(async () => {
  await Promise.all(hosts.map((host) => host.closeAll()));
  await rm(directory, { recursive: true, force: true });
});

const SCRIPT =
  "export const meta = { name: 'billing', description: 'd' }; return await agent('work')";
const promptContext = async () => ({ contextFiles: [], skills: '', append: '' });

function runtime() {
  const host = new WorkflowHost({ runsRoot: join(directory, 'runs') });
  hosts.push(host);
  const tool = createWorkflowTool({ host, promptContext });
  return { host, tool };
}

function ctx(file = parent) {
  return {
    cwd: directory,
    model: { provider: 'faux', id: 'faux-1' },
    thinkingLevel: 'off',
    scopedModels: [],
    isProjectTrusted: () => false,
    sessionManager: { getSessionFile: () => file },
    modelRegistry: { runtime: models }
  } as never;
}

type Result = {
  details: unknown;
  content: unknown;
  usage?: Usage;
};
function receipt(result: Result): WorkflowUsageReceipt {
  const details = result.details as { usageReceipt?: WorkflowUsageReceipt };
  assert.ok(details.usageReceipt);
  return details.usageReceipt;
}
async function persist(result: Result, toolCallId: string, file = parent) {
  await appendFile(
    file,
    `${JSON.stringify({
      type: 'message',
      id: toolCallId,
      parentId: null,
      message: { ...result, role: 'toolResult', toolName: 'workflow', toolCallId, isError: false }
    })}\n`
  );
}

test('usage is held under the run lease until the parent result is persisted and acknowledged', async () => {
  const { host, tool } = runtime();
  const result = await tool.execute('call-1', { script: SCRIPT }, undefined, undefined, ctx());
  const { runId } = receipt(result);
  assert.ok(result.usage?.totalTokens);
  assert.equal(host.isActive(runId), true);
  const second = runtime();
  await assert.rejects(
    second.host.resume(runId, {}, createWorkflowRunBinding(ctx())),
    /open in another Pi process/
  );

  await persist(result, 'call-1');
  await host.settleDeliveries(parent);
  assert.equal(host.isActive(runId), false);
  const replay = await second.tool.execute(
    'call-2',
    { resume: runId },
    undefined,
    undefined,
    ctx()
  );
  assert.equal(replay.usage, undefined);
  assert.equal(faux.state.callCount, 1);
  assert.equal(second.host.isActive(runId), false);
});

test('an in-memory parent session has no transcript to reconcile, so usage is acknowledged immediately', async () => {
  const { host, tool } = runtime();
  const memory = {
    ...(ctx() as object),
    sessionManager: { getSessionFile: () => undefined }
  } as never;
  const result = await tool.execute('call-1', { script: SCRIPT }, undefined, undefined, memory);
  const { runId } = receipt(result);
  assert.ok(result.usage?.totalTokens);
  // No lease is held waiting for a delivery that can never be observed.
  assert.equal(host.isActive(runId), false);
  const again = await tool.execute('call-2', { resume: runId }, undefined, undefined, memory);
  assert.equal(again.usage, undefined);
  assert.equal(faux.state.callCount, 1);
});

test('a crash before parent persistence re-offers usage without rerunning any subagent', async () => {
  const first = runtime();
  const lost = await first.tool.execute('call-1', { script: SCRIPT }, undefined, undefined, ctx());
  const original = receipt(lost);
  await first.host.closeAll(); // No parent append: same persisted state as a crash before delivery.

  const second = runtime();
  const retry = await second.tool.execute(
    'call-2',
    { resume: original.runId },
    undefined,
    undefined,
    ctx()
  );
  assert.deepEqual(retry.usage, lost.usage);
  assert.notEqual(receipt(retry).id, original.id);
  assert.equal(faux.state.callCount, 1);
  await persist(retry, 'call-2');
  await second.host.settleDeliveries(parent);
  const third = runtime();
  const replay = await third.tool.execute(
    'call-3',
    { resume: original.runId },
    undefined,
    undefined,
    ctx()
  );
  assert.equal(replay.usage, undefined);
});

test('a crash after parent persistence but before acknowledgement is reconciled from raw history', async () => {
  const first = runtime();
  const result = await first.tool.execute(
    'call-1',
    { script: SCRIPT },
    undefined,
    undefined,
    ctx()
  );
  const { runId } = receipt(result);
  await persist(result, 'call-1');
  // Another branch and a torn final append must not hide the already delivered receipt.
  await appendFile(parent, `${JSON.stringify({ type: 'custom', parentId: null })}\n{"type":`);
  await first.host.closeAll();

  // A different session can resume the run: reconcile the ORIGINAL destination, not this one.
  const other = join(directory, 'other.jsonl');
  await writeFile(other, '{"type":"session","id":"other"}\n');
  const second = runtime();
  const replay = await second.tool.execute(
    'call-2',
    { resume: runId },
    undefined,
    undefined,
    ctx(other)
  );
  assert.equal(replay.usage, undefined);
  assert.equal(faux.state.callCount, 1);
});

test('another attempt reports only new spend after reconciling an earlier receipt', async () => {
  const first = runtime();
  const result = await first.tool.execute(
    'call-1',
    { script: SCRIPT },
    undefined,
    undefined,
    ctx()
  );
  const { runId } = receipt(result);
  await persist(result, 'call-1');
  await first.host.closeAll();
  const second = runtime();
  const next = await second.tool.execute(
    'call-2',
    {
      resume: runId,
      script: SCRIPT.replace(
        "return await agent('work')",
        "await agent('work'); return await agent('new work')"
      )
    },
    undefined,
    undefined,
    ctx()
  );
  assert.ok(next.usage?.totalTokens);
  const report = await second.host.report(runId);
  assert.equal(report.usage.totalTokens, (result.usage?.totalTokens ?? 0) + next.usage.totalTokens);
  assert.equal(faux.state.callCount, 2);
  await persist(next, 'call-2');
  await second.host.settleDeliveries(parent);
});

test('a missing parent transcript fails closed instead of guessing whether usage was delivered', async () => {
  const first = runtime();
  const result = await first.tool.execute(
    'call-1',
    { script: SCRIPT },
    undefined,
    undefined,
    ctx()
  );
  const { runId } = receipt(result);
  await persist(result, 'call-1');
  const saved = await readFile(parent, 'utf8');
  await first.host.closeAll();
  await unlink(parent);
  const second = runtime();
  await assert.rejects(
    second.tool.execute('call-2', { resume: runId }, undefined, undefined, ctx()),
    /Cannot reconcile workflow usage receipt/
  );
  assert.equal(second.host.isActive(runId), false);
  await writeFile(parent, saved);
  const replay = await second.tool.execute(
    'call-3',
    { resume: runId },
    undefined,
    undefined,
    ctx()
  );
  assert.equal(replay.usage, undefined);
});

test('reading a library outcome is not an acknowledgement; an explicit durable acknowledgement is idempotent', async () => {
  const { host } = runtime();
  const binding = createWorkflowRunBinding(ctx(), { promptContext });
  const first = await host.start({ script: SCRIPT, cwd: directory }, binding);
  const initial = await first.wait();
  assert.equal(initial.status, 'completed');
  if (initial.status !== 'completed') return;
  assert.ok(initial.usageReceipt);
  await first.close();
  const second = await host.resume(first.runId, {}, binding);
  const retry = await second.wait();
  assert.equal(retry.status, 'completed');
  if (retry.status !== 'completed') return;
  assert.deepEqual(retry.unreportedUsage, initial.unreportedUsage);
  assert.ok(retry.usageReceipt);
  await second.acknowledgeUsage(retry.usageReceipt.id);
  await second.acknowledgeUsage(retry.usageReceipt.id);
  await second.close();
  const third = await host.resume(first.runId, {}, binding);
  const replay = await third.wait();
  assert.equal(replay.status, 'completed');
  if (replay.status === 'completed') assert.equal(replay.unreportedUsage.totalTokens, 0);
  await third.close();
});
