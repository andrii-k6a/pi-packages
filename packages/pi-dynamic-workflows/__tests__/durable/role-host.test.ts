import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall
} from '@earendil-works/pi-ai';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';
import { Type } from 'typebox';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { WorkflowHost, type WorkflowRunBinding } from '../../src/durable/host.js';
import { createWorkflowRoleServices } from '../../src/durable/roles.js';
import { SDLC_SCRIPT } from '../../src/workflow/builtins/sdlc.js';

let directory: string;
let hosts: WorkflowHost[];
let faux: ReturnType<typeof fauxProvider>;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'workflow-role-host-'));
  hosts = [];
  faux = fauxProvider();
});
afterEach(async () => {
  await Promise.all(hosts.map((host) => host.closeAll()));
  await rm(directory, { recursive: true, force: true });
});
function host(options: ConstructorParameters<typeof WorkflowHost>[0] = {}) {
  const value = new WorkflowHost({
    runsRoot: join(directory, 'runs'),
    settings: { retry: { enabled: false } },
    ...options
  });
  hosts.push(value);
  return value;
}
function binding(approved: (name: string) => boolean = () => true): WorkflowRunBinding {
  const models = createModels();
  models.setProvider(faux.provider);
  return {
    models,
    route: { provider: 'faux', modelId: 'faux-1', thinkingLevel: 'off' },
    resolveProfile(name) {
      if (!approved(name)) throw new Error(`profile ${name} revoked`);
      return { provider: 'faux', modelId: 'faux-1', thinkingLevel: 'off' };
    },
    promptContext: async () => ({ contextFiles: [], skills: '', append: '' })
  };
}
const header = "export const meta={name:'role_host',description:'Verify role host boundaries'}\n";

async function customRole() {
  const agentDir = join(directory, 'agent');
  await mkdir(join(agentDir, 'agents'), { recursive: true });
  await writeFile(
    join(agentDir, 'agents/custom.md'),
    '---\nname: custom\ndescription: Test provider role\ntools: [effect]\n---\nPerform the assigned effect.\n'
  );
  return agentDir;
}
function provider(backend: string, effects: string[]) {
  return defineExtension({
    name: 'test-provider',
    tools: [
      defineTool({
        name: 'effect',
        description: 'Record the selected backend',
        parameters: Type.Object({}),
        async execute() {
          effects.push(backend);
          return { output: [] };
        }
      })
    ]
  });
}

test('host blocks revoked generation and propagates permission failure instead of nullable success', async () => {
  const agentDir = await customRole();
  let revoked = false;
  let requests = 0;
  const effects: string[] = [];
  faux.setResponses([
    () => {
      requests++;
      revoked = true;
      return fauxAssistantMessage([fauxToolCall('effect', {})], { stopReason: 'toolUse' });
    },
    () => {
      requests++;
      return fauxAssistantMessage('must not be requested');
    }
  ]);
  const runtime = host({
    extensions: [provider('approved', effects)],
    roles: {
      agentDir,
      toolRevision: () => 'backend-approved',
      revokedRoles: () => (revoked ? ['custom'] : [])
    }
  });
  const handle = await runtime.start(
    {
      script:
        header +
        "const result=await agent('work',{role:'custom'}); return {result,continued:true};",
      cwd: directory
    },
    binding()
  );
  const outcome = await handle.wait();
  assert.equal(outcome.status, 'failed');
  assert.equal(requests, 1);
  assert.deepEqual(effects, []);
  await handle.close();
});

test('completed execution policies do not block later approved routing', async () => {
  let oldApproved = true;
  let requests = 0;
  faux.setResponses([
    () => {
      requests++;
      oldApproved = false;
      return fauxAssistantMessage('first complete');
    },
    () => {
      requests++;
      return fauxAssistantMessage('second complete');
    }
  ]);
  const handle = await host().start(
    {
      script:
        header +
        "const a=await agent('a',{role:'implementer',profile:'old'});const b=await agent('b',{role:'implementer',profile:'new'});return [a,b];",
      cwd: directory
    },
    binding((name) => name !== 'old' || oldApproved)
  );
  const outcome = await handle.wait();
  assert.equal(outcome.status, 'completed');
  if (outcome.status === 'completed')
    assert.deepEqual(outcome.value, ['first complete', 'second complete']);
  assert.equal(requests, 2);
  await handle.close();
});

test('explicit recovery replaces a revoked live profile without changing role permissions', async () => {
  let started = false;
  faux.setResponses([
    async (_request, options) => {
      started = true;
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) resolve();
        else options?.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return fauxAssistantMessage('interrupted');
    }
  ]);
  const original = await host().start(
    {
      script: header + "return await agent('work',{role:'implementer',profile:'old'});",
      cwd: directory
    },
    binding()
  );
  await expect.poll(() => started, { interval: 10 }).toBe(true);
  await original.close();
  faux.setResponses([fauxAssistantMessage('recovered')]);
  const recovered = await host().resume(
    original.runId,
    { resumeProfile: 'new' },
    binding((name) => name === 'new')
  );
  const outcome = await recovered.wait();
  assert.equal(outcome.status, 'completed');
  if (outcome.status === 'completed') {
    assert.equal(outcome.value, 'recovered');
    assert.equal(outcome.snapshot.agents.at(-1)?.profile, 'new');
  }
  await recovered.close();
});

test('expired restored writers stop before another provider request', async () => {
  const cwd = join(directory, 'project');
  await mkdir(cwd);
  await writeFile(join(cwd, 'code.txt'), 'source');
  let now = 10_000;
  let requests = 0;
  faux.setResponses([
    async (_request, options) => {
      requests++;
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) resolve();
        else options?.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return fauxAssistantMessage('interrupted');
    }
  ]);
  const handle = await host({ now: () => now }).start(
    {
      script: SDLC_SCRIPT,
      cwd,
      args: {
        goal: 'Update code documentation',
        acceptance: [{ description: 'Documentation matches source', verification: 'inspection' }],
        policy: { limits: { taskTimeoutMs: 1000 } }
      }
    },
    binding()
  );
  await expect.poll(() => requests, { interval: 10 }).toBe(1);
  await handle.close();
  now = 20_000;
  faux.setResponses([
    () => {
      requests++;
      return fauxAssistantMessage('must not request');
    }
  ]);
  const resumed = await host({ now: () => now }).resume(handle.runId, {}, binding());
  const outcome = await resumed.wait();
  assert.equal(requests, 1);
  assert.equal(outcome.status, 'completed');
  if (outcome.status === 'completed')
    assert.equal((outcome.value as { outcome: string }).outcome, 'incomplete');
  await resumed.close();
});

test('external tool configuration revisions prevent closure substitution across reopen', async () => {
  const agentDir = await customRole();
  const effects: string[] = [];
  const original = createWorkflowRoleServices({
    projectRoot: directory,
    agentDir,
    extensions: () => [provider('approved', effects)],
    toolRevision: () => 'approved'
  });
  const selected = original.resolve('custom');
  const replacement = provider('different', effects);
  const reopened = createWorkflowRoleServices({
    projectRoot: directory,
    agentDir,
    extensions: () => [replacement],
    toolRevision: () => 'different',
    pinned: [selected]
  });
  assert.throws(
    () => reopened.prepare({ resolvedRole: selected }),
    /revoked, unavailable, or changed/
  );
  const unversioned = createWorkflowRoleServices({
    projectRoot: directory,
    agentDir,
    extensions: () => [replacement]
  });
  assert.throws(
    () => unversioned.resolve('custom'),
    /explicit implementation\/configuration revision/
  );
  assert.deepEqual(effects, []);
});
