import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from '@earendil-works/pi-ai';
import { afterEach, beforeEach, test, vi } from 'vitest';
import type { WorkflowRunBinding } from '../../src/durable/host.js';
import { WorkflowHost } from '../../src/durable/host.js';
import { createRunId, runDirectoryExists } from '../../src/durable/store.js';

// Control only the 2-byte suffix of run ids; every other random value stays real.
const suffixes: string[] = [];
vi.mock('node:crypto', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:crypto')>();
  return {
    ...original,
    randomBytes: (size: number) =>
      size === 2 && suffixes.length > 0
        ? Buffer.from(suffixes.shift() as string, 'hex')
        : original.randomBytes(size)
  };
});

let directory: string;
let host: WorkflowHost;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pi-workflow-collision-'));
  suffixes.length = 0;
  host = new WorkflowHost({ runsRoot: join(directory, 'runs'), now: () => 1_800_000_000_000 });
});

afterEach(async () => {
  await host.closeAll();
  await rm(directory, { recursive: true, force: true });
});

function binding(): WorkflowRunBinding {
  const faux = fauxProvider({ models: [{ id: 'faux-1' }] });
  faux.setResponses([() => fauxAssistantMessage([fauxText('ok')])]);
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

test('a new run never reuses the id of a run that already exists', async () => {
  const script =
    "export const meta = { name: 'collide', description: 'd' }\nreturn await agent('x')";
  suffixes.push('abcd');
  const taken = createRunId('collide', 1_800_000_000_000);
  assert.ok(taken.endsWith('-abcd'));
  mkdirSync(join(host.runsRoot, taken), { recursive: true });
  assert.ok(runDirectoryExists(host.runsRoot, taken));

  // The first draw collides with the existing run; the second is free.
  suffixes.push('abcd', '1234');
  const handle = await host.start({ script, cwd: directory }, binding());
  assert.notEqual(handle.runId, taken);
  assert.ok(handle.runId.endsWith('-1234'), handle.runId);
  assert.equal((await handle.wait()).status, 'completed');
  await handle.close();
});

test('start gives up with a clear error when no free id can be drawn', async () => {
  const script =
    "export const meta = { name: 'collide', description: 'd' }\nreturn await agent('x')";
  suffixes.push('abcd');
  const taken = createRunId('collide', 1_800_000_000_000);
  mkdirSync(join(host.runsRoot, taken), { recursive: true });

  suffixes.push(...Array.from({ length: 20 }, () => 'abcd'));
  await assert.rejects(
    () => host.start({ script, cwd: directory }, binding()),
    /could not allocate a unique workflow run id/
  );
});
