import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { afterEach, beforeEach, test } from 'vitest';
import { changedSdlcFiles, observeSdlcFiles } from '../../src/durable/sdlc-observation.js';
import {
  ensureSdlcWorkspace,
  forkSdlcWorkspace,
  inspectSdlcWorkspace,
  integrateSdlcWorkspace,
  planSdlcWorkspace
} from '../../src/durable/sdlc-workspace.js';

const exec = promisify(execFile);
async function prepare() {
  const directory = await mkdtemp(join(tmpdir(), 'sdlc-integration-'));
  const repo = join(directory, 'source');
  const git = async (...args: string[]) => (await exec('git', ['-C', repo, ...args])).stdout.trim();
  try {
    await mkdir(repo);
    await git('init', '-q');
    await git('config', 'user.name', 'Test');
    await git('config', 'user.email', 'test@example.com');
    await writeFile(join(repo, 'a.txt'), 'base\n');
    await writeFile(join(repo, 'b.txt'), 'before\n');
    await git('add', '.');
    await git('commit', '-qm', 'base');
    await writeFile(join(repo, 'a.txt'), 'staged\n');
    await git('add', 'a.txt');
    await writeFile(join(repo, 'a.txt'), 'working\n');
    const staged = await git('diff', '--cached', '--binary');
    const target = await planSdlcWorkspace({
      operationId: 'integration',
      sourceCwd: repo,
      storageDir: join(directory, 'storage'),
      mode: 'existing'
    });
    await ensureSdlcWorkspace(target);
    const first = await forkSdlcWorkspace(target, 'first');
    const second = await forkSdlcWorkspace(target, 'second');
    const initial = await inspectSdlcWorkspace(target);
    return { directory, repo, git, staged, target, first, second, initial };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
let fixture: Awaited<ReturnType<typeof prepare>>;
beforeEach(async () => {
  fixture = await prepare();
});
afterEach(async () => {
  const { directory } = fixture;
  await rm(directory, { recursive: true, force: true });
});

async function ignoredOutput(first: Awaited<ReturnType<typeof prepare>>['first']) {
  await writeFile(join(first.cwd, 'new.txt'), 'owned output');
  await exec('git', ['-C', first.cwd, 'add', 'new.txt']);
  await writeFile(join(first.cwd, '.gitignore'), 'new.txt\n');
}

test('integration retains newly ignored staged additions and replay preserves the source index', async () => {
  const { target, first, initial, repo, git, staged } = fixture;
  await ignoredOutput(first);
  const merged = await integrateSdlcWorkspace(target, first, initial.revision);
  assert.deepEqual(merged.changedFiles.sort(), ['.gitignore', 'new.txt']);
  assert.equal(await readFile(join(repo, 'new.txt'), 'utf8'), 'owned output');
  assert.equal(await git('diff', '--cached', '--binary'), staged);
  assert.equal(
    (await integrateSdlcWorkspace(target, first, initial.revision)).revision,
    merged.revision
  );
});

test('identical independent outputs integrate successfully without applying an empty patch', async () => {
  const { target, first, second, initial } = fixture;
  await writeFile(join(first.cwd, 'a.txt'), 'same output\n');
  await writeFile(join(second.cwd, 'a.txt'), 'same output\n');
  const integrated = await integrateSdlcWorkspace(target, first, initial.revision);
  assert.equal(
    (await integrateSdlcWorkspace(target, second, integrated.revision)).revision,
    integrated.revision
  );
});

test('independent outputs assemble automatically without changing staged source contents', async () => {
  const { target, first, second, initial, repo, git, staged } = fixture;
  await writeFile(join(first.cwd, 'a.txt'), 'implemented A\n');
  await writeFile(join(second.cwd, 'b.txt'), 'implemented B\n');
  const integrated = await integrateSdlcWorkspace(target, first, initial.revision);
  const combined = await integrateSdlcWorkspace(target, second, integrated.revision);
  assert.equal(await readFile(join(repo, 'a.txt'), 'utf8'), 'implemented A\n');
  assert.equal(await readFile(join(repo, 'b.txt'), 'utf8'), 'implemented B\n');
  assert.equal(await git('diff', '--cached', '--binary'), staged);
  assert.deepEqual(combined.changedFiles, ['a.txt', 'b.txt']);
});

test('dependent forks include integrated outputs absent from the source index', async () => {
  const { target, first, initial } = fixture;
  await ignoredOutput(first);
  await integrateSdlcWorkspace(target, first, initial.revision);
  const dependent = await forkSdlcWorkspace(target, 'dependent');
  assert.equal(await readFile(join(dependent.cwd, 'new.txt'), 'utf8'), 'owned output');
});

test('ownership observations include newly ignored integrated outputs', async () => {
  const { target, first, initial, repo } = fixture;
  await ignoredOutput(first);
  await integrateSdlcWorkspace(target, first, initial.revision);
  const observe = () =>
    observeSdlcFiles(target, (cwd) => new NodeExecutionEnv({ cwd }), BACKGROUND_CONTEXT);
  const before = await observe();
  await writeFile(join(repo, 'new.txt'), 'unexpected later mutation');
  assert.deepEqual(changedSdlcFiles(before, await observe()), ['new.txt']);
});
