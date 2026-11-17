import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { afterEach, beforeEach, test } from 'vitest';
import { WorkflowHost, type WorkflowRunBinding } from '../../src/durable/host.js';
import type { WorkflowProviderContext } from '../../src/durable/providers.js';
import { SDLC_SCRIPT } from '../../src/workflow/builtins/sdlc.js';

const exec = promisify(execFile);
let directory: string;
let hosts: WorkflowHost[];
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'sdlc-lifecycle-')));
  hosts = [];
});
afterEach(async () => {
  await Promise.all(hosts.map((host) => host.closeAll()));
  await rm(directory, { recursive: true, force: true });
});
function binding(): WorkflowRunBinding {
  return {
    models: createModels(),
    resolveProfile() {
      throw new Error('No profiles');
    },
    promptContext: async () => ({ contextFiles: [], skills: '', append: '' })
  };
}
function host(options: ConstructorParameters<typeof WorkflowHost>[0] = {}) {
  const value = new WorkflowHost({ runsRoot: join(directory, 'runs'), ...options });
  hosts.push(value);
  return value;
}
const noWork = {
  goal: 'No requested work remains',
  noWork: { confirmed: true as const, reason: 'Explicitly empty scope' }
};

async function repository() {
  const cwd = join(directory, 'source');
  await mkdir(cwd);
  await writeFile(join(cwd, 'source.txt'), 'source');
  await exec('git', ['init', '-q', cwd]);
  await exec('git', ['-C', cwd, 'config', 'user.name', 'Test']);
  await exec('git', ['-C', cwd, 'config', 'user.email', 'test@example.com']);
  await exec('git', ['-C', cwd, 'add', '.']);
  await exec('git', [
    '-C',
    cwd,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'initial'
  ]);
  return cwd;
}

test('an isolated destination is durable and announced before checkout setup or worker execution', async () => {
  const cwd = await repository();
  const runtime = host();
  let destination: string | undefined;
  const configured = binding();
  configured.onWorkspaceSelected = async (workspace) => {
    destination = workspace.cwd;
    assert.notEqual(workspace.cwd, cwd);
    assert.equal((await runtime.inspectSdlc(workspace.operationId)).setup, 'intent');
    await assert.rejects(lstat(workspace.cwd), { code: 'ENOENT' });
  };
  const handle = await runtime.start(
    { script: SDLC_SCRIPT, args: { ...noWork, workspace: { mode: 'isolated' } }, cwd },
    configured
  );
  const outcome = await handle.wait();
  assert.ok(destination);
  assert.equal((await lstat(destination)).isDirectory(), true);
  assert.equal(outcome.status, 'completed');
  if (outcome.status === 'completed') assert.equal(outcome.agentCount, 0);
  await handle.close();
});

test('provider configuration and trust consistently use the selected source project across continuation', async () => {
  const caller = join(directory, 'caller');
  const selected = join(directory, 'selected');
  await mkdir(caller);
  await mkdir(selected);
  const opened: WorkflowProviderContext[] = [];
  const runtime = host({
    providers: [
      {
        name: 'observer',
        open: async (context) => {
          opened.push(context);
          return { extensions: [], notes: [], close: async () => {} };
        }
      }
    ]
  });
  const configured = { ...binding(), projectTrusted: (cwd: string) => cwd === selected };
  const original = await runtime.start(
    {
      script: SDLC_SCRIPT,
      args: { ...noWork, workspace: { mode: 'existing', cwd: selected } },
      cwd: caller
    },
    configured
  );
  await original.wait();
  await original.close();
  const continued = await runtime.continueSdlc(original.runId, {}, configured);
  await continued.wait();
  await continued.close();
  assert.equal(opened.length, 2);
  assert.ok(opened.every((context) => context.cwd === selected && context.projectTrusted));
});

test('missing owned workspaces block resumed child generation before another provider request', async () => {
  const cwd = await repository();
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  let requests = 0;
  const signal: { started?: () => void } = {};
  const started = new Promise<void>((resolve) => {
    signal.started = resolve;
  });
  faux.setResponses([
    async (_request, options) => {
      requests++;
      signal.started?.();
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) resolve();
        else options?.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return fauxAssistantMessage('interrupted');
    }
  ]);
  const configured = {
    ...binding(),
    models,
    route: { provider: 'faux', modelId: 'faux-1', thinkingLevel: 'off' as const }
  };
  const runtime = host();
  const handle = await runtime.start(
    {
      script: SDLC_SCRIPT,
      cwd,
      args: {
        goal: 'Document source',
        workspace: { mode: 'isolated' },
        acceptance: [{ description: 'Source is documented', verification: 'inspection' }]
      }
    },
    configured
  );
  await started;
  assert.equal(requests, 1);
  const state = await runtime.inspectSdlc(handle.runId);
  await handle.close();
  const backup = join(directory, 'retained-workspace');
  await rename(state.workspace.cwd, backup);
  try {
    faux.setResponses([
      () => {
        requests++;
        return fauxAssistantMessage('must not request');
      }
    ]);
    await assert.rejects(
      host().resume(handle.runId, {}, configured),
      /Cannot resume SDLC owned workspace/
    );
    assert.equal(requests, 1);
  } finally {
    await rename(backup, state.workspace.cwd);
  }
});

test('cancellation while announcing a selected workspace does not create its checkout', async () => {
  const cwd = await repository();
  const controller = new AbortController();
  let destination: string | undefined;
  const configured = {
    ...binding(),
    signal: controller.signal,
    onWorkspaceSelected: (workspace: { cwd: string }) => {
      destination = workspace.cwd;
      controller.abort();
    }
  };
  await assert.rejects(
    host().start(
      { script: SDLC_SCRIPT, args: { ...noWork, workspace: { mode: 'isolated' } }, cwd },
      configured
    ),
    /aborted before workspace execution/
  );
  assert.ok(destination);
  await assert.rejects(lstat(destination), { code: 'ENOENT' });
});
