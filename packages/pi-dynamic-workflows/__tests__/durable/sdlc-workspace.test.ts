import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { afterEach, beforeEach, test } from 'vitest';
import { changedSdlcFiles, observeSdlcFiles } from '../../src/durable/sdlc-observation.js';
import {
  acquireSdlcWorkspaceLease,
  ensureSdlcWorkspace,
  forkSdlcWorkspace,
  inspectSdlcWorkspace,
  integrateSdlcWorkspace,
  planSdlcWorkspace
} from '../../src/durable/sdlc-workspace.js';

const exec = promisify(execFile);
let directory: string;
let repo: string;
const git = async (...args: string[]) => (await exec('git', ['-C', repo, ...args])).stdout.trim();
const observe = (workspace: Parameters<typeof observeSdlcFiles>[0]) =>
  observeSdlcFiles(workspace, (cwd) => new NodeExecutionEnv({ cwd }), BACKGROUND_CONTEXT);

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pi-sdlc-workspace-'));
  repo = join(directory, 'repo with spaces');
  await mkdir(repo);
  await git('init', '-q');
  await git('config', 'user.name', 'Test');
  await git('config', 'user.email', 'test@example.com');
  await writeFile(join(repo, 'a.txt'), 'first\nsecond\nthird\n');
  await writeFile(join(repo, 'b.txt'), 'before\n');
  await git('add', '.');
  await git('commit', '-qm', 'base');
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function loseGitEffectResponse(command: 'worktree' | 'apply') {
  const executable = (await exec('which', ['git'])).stdout.trim();
  const tools = join(directory, 'git-interceptor');
  await mkdir(tools);
  const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
  const marker = quote(join(tools, 'lost-response'));
  const script = `#!/bin/sh
hit=0
adding=0
safe=0
for arg in "$@"; do
  [ "$arg" = ${quote(command)} ] && hit=1
  [ "$arg" = add ] && adding=1
  { [ "$arg" = --check ] || [ "$arg" = --cached ]; } && safe=1
done
if [ "$hit" = 1 ] && [ "$safe" = 0 ] && [ ! -e ${marker} ] && { [ ${quote(command)} != worktree ] || [ "$adding" = 1 ]; }; then
  ${quote(executable)} "$@"
  status=$?
  [ "$status" = 0 ] || exit "$status"
  printf 'effect completed' > ${marker}
  exit 97
fi
exec ${quote(executable)} "$@"
`;
  await writeFile(join(tools, 'git'), script, { mode: 0o755 });
  const original = process.env.PATH;
  process.env.PATH = `${tools}:${original}`;
  return () => {
    process.env.PATH = original;
  };
}

async function workspace(mode: 'existing' | 'isolated' = 'existing') {
  const result = await planSdlcWorkspace({
    operationId: 'goal-1',
    sourceCwd: repo,
    storageDir: join(directory, 'storage'),
    mode
  });
  await ensureSdlcWorkspace(result);
  return result;
}

test('isolated setup includes staged, unstaged, untracked and branch changes without touching the source index', async () => {
  await writeFile(join(repo, 'committed.txt'), 'branch content');
  await git('add', '.');
  await git('commit', '-qm', 'branch');
  await writeFile(join(repo, 'a.txt'), 'staged\n');
  await git('add', 'a.txt');
  await writeFile(join(repo, 'a.txt'), 'working\n');
  await writeFile(join(repo, 'new.txt'), 'untracked\n');
  await writeFile(join(repo, 'staged-new.txt'), 'staged addition\n');
  await git('add', 'staged-new.txt');
  await writeFile(join(repo, '.gitignore'), 'staged-new.txt\n');
  const before = await git('status', '--porcelain=v1');
  const staged = await git('diff', '--cached', '--binary');
  const target = await workspace('isolated');
  assert.notEqual(target.cwd, repo);
  assert.equal(await readFile(join(target.cwd, 'a.txt'), 'utf8'), 'working\n');
  assert.equal(await readFile(join(target.cwd, 'new.txt'), 'utf8'), 'untracked\n');
  assert.equal(await readFile(join(target.cwd, 'staged-new.txt'), 'utf8'), 'staged addition\n');
  assert.equal(await readFile(join(target.cwd, 'committed.txt'), 'utf8'), 'branch content');
  assert.equal(await git('status', '--porcelain=v1'), before);
  assert.equal(await git('diff', '--cached', '--binary'), staged);
  assert.deepEqual((await inspectSdlcWorkspace(target)).changedFiles, []);
  await writeFile(join(target.cwd, 'a.txt'), 'interrupted writer');
  await ensureSdlcWorkspace(target);
  assert.equal(await readFile(join(target.cwd, 'a.txt'), 'utf8'), 'interrupted writer');
});

test('setup recovers a checkout created before its success response was lost without resetting edits', async () => {
  const target = await planSdlcWorkspace({
    operationId: 'setup-interruption',
    sourceCwd: repo,
    storageDir: join(directory, 'storage'),
    mode: 'isolated'
  });
  const restore = await loseGitEffectResponse('worktree');
  try {
    await assert.rejects(
      ensureSdlcWorkspace(target),
      (error: unknown) => (error as { code?: number }).code === 97
    );
  } finally {
    restore();
  }
  await writeFile(join(target.cwd, 'a.txt'), 'owned partial edit');
  await ensureSdlcWorkspace(target);
  assert.equal(await readFile(join(target.cwd, 'a.txt'), 'utf8'), 'owned partial edit');
});

test('integration reconciles an applied patch after its success response was lost', async () => {
  const target = await workspace();
  const child = await forkSdlcWorkspace(target, 'lost-integration-response');
  await writeFile(join(child.cwd, 'b.txt'), 'integrated exactly once');
  const before = await inspectSdlcWorkspace(target);
  const restore = await loseGitEffectResponse('apply');
  try {
    await assert.rejects(
      integrateSdlcWorkspace(target, child, before.revision),
      (error: unknown) => (error as { code?: number }).code === 97
    );
  } finally {
    restore();
  }
  assert.equal(await readFile(join(repo, 'b.txt'), 'utf8'), 'integrated exactly once');
  const reconciled = await integrateSdlcWorkspace(target, child, before.revision);
  assert.deepEqual(reconciled.changedFiles, ['b.txt']);
  assert.equal(await git('diff', '--cached'), '');
});

test('source drift before setup and replaced worktree identity fail without discarding edits', async () => {
  const planned = await planSdlcWorkspace({
    operationId: 'goal-1',
    sourceCwd: repo,
    storageDir: join(directory, 'storage'),
    mode: 'isolated'
  });
  await writeFile(join(repo, 'a.txt'), 'external edit');
  await assert.rejects(ensureSdlcWorkspace(planned), /source drifted/);
  assert.equal(await readFile(join(repo, 'a.txt'), 'utf8'), 'external edit');
  const target = await workspace('isolated');
  await exec('git', ['-C', target.cwd, 'switch', '-qc', 'replacement']);
  await assert.rejects(inspectSdlcWorkspace(target), /different branch/);
});

test('dependent forks include integrated outputs and interrupted forks retain their active writer identity', async () => {
  const target = await workspace('isolated');
  await writeFile(join(target.cwd, 'a.txt'), 'dependency result\n');
  const child = await forkSdlcWorkspace(target, 'dependent');
  assert.equal(await readFile(join(child.cwd, 'a.txt'), 'utf8'), 'dependency result\n');
  await writeFile(join(child.cwd, 'b.txt'), 'partially edited\n');
  const recovered = await forkSdlcWorkspace(target, 'dependent');
  assert.deepEqual(recovered, child);
  assert.equal(await readFile(join(recovered.cwd, 'b.txt'), 'utf8'), 'partially edited\n');
});

test('integration drift and semantic conflicts preserve user changes and the index', async () => {
  const target = await workspace();
  const child = await forkSdlcWorkspace(target, 'worker');
  const initial = await inspectSdlcWorkspace(target);
  await writeFile(join(child.cwd, 'a.txt'), 'worker replacement\n');
  await writeFile(join(repo, 'a.txt'), 'external replacement\n');
  await assert.rejects(integrateSdlcWorkspace(target, child, initial.revision), /target drift/);
  const drifted = await inspectSdlcWorkspace(target);
  await assert.rejects(
    integrateSdlcWorkspace(target, child, drifted.revision),
    /integration conflict/
  );
  assert.equal(await readFile(join(repo, 'a.txt'), 'utf8'), 'external replacement\n');
  assert.equal(await git('diff', '--cached'), '');
});

test('nested targets report ownership paths relative to the selected cwd and expose out-of-scope changes', async () => {
  await mkdir(join(repo, 'nested'));
  await writeFile(join(repo, 'nested', 'code.ts'), 'initial');
  await git('add', '.');
  await git('commit', '-qm', 'nested');
  const target = await planSdlcWorkspace({
    operationId: 'nested',
    sourceCwd: join(repo, 'nested'),
    storageDir: join(directory, 'storage'),
    mode: 'existing'
  });
  await ensureSdlcWorkspace(target);
  await writeFile(join(target.cwd, 'code.ts'), 'implemented');
  await writeFile(join(repo, 'b.txt'), 'unexpected');
  assert.deepEqual((await inspectSdlcWorkspace(target)).changedFiles.sort(), [
    '../b.txt',
    'code.ts'
  ]);
  await writeFile(join(target.cwd, 'b.txt'), 'before\n');
  await rm(join(repo, 'b.txt'));
  assert.deepEqual((await inspectSdlcWorkspace(target)).changedFiles.sort(), [
    '../b.txt',
    'b.txt',
    'code.ts'
  ]);
});

test('candidate capture does not trust a copied index stat cache for same-size edits', async () => {
  await git('config', 'core.trustctime', 'false');
  await git('config', 'core.checkStat', 'minimal');
  const target = await workspace();
  const before = await inspectSdlcWorkspace(target);
  const file = join(repo, 'a.txt');
  const original = await stat(file);
  await writeFile(file, 'FIRST\nsecond\nthird\n');
  await utimes(file, original.atime, original.mtime);
  const after = await inspectSdlcWorkspace(target);
  assert.notEqual(after.revision, before.revision);
  assert.deepEqual(after.changedFiles, ['a.txt']);
});

test('ownership observations expose staging and history changes outside every writer allowance', async () => {
  const target = await workspace();
  await writeFile(join(repo, 'a.txt'), 'implementation');
  const before = await observe(target);
  await git('add', 'a.txt');
  const staged = await observe(target);
  assert.deepEqual(changedSdlcFiles(before, staged), ['../[git-index]']);
  await git('commit', '-qm', 'unexpected worker commit');
  assert.ok(changedSdlcFiles(staged, await observe(target)).includes('../[git-head]'));
});

test('ownership observations detect mode-only changes, not only content edits', async () => {
  const target = await workspace();
  const before = await observe(target);
  await chmod(join(repo, 'a.txt'), 0o755);
  assert.deepEqual(changedSdlcFiles(before, await observe(target)), ['a.txt']);
});

test('unsupported index flags fail before a checkout is created', async () => {
  await git('update-index', '--assume-unchanged', 'a.txt');
  await assert.rejects(workspace('isolated'), /assume-unchanged/);
  assert.equal(await readFile(join(repo, 'a.txt'), 'utf8'), 'first\nsecond\nthird\n');
});

test('one active operation owns an existing target until its process lease is released', async () => {
  const target = await workspace();
  const release = acquireSdlcWorkspaceLease(target);
  try {
    assert.throws(
      () => acquireSdlcWorkspaceLease({ ...target, operationId: 'another' }),
      /owned by another active operation/
    );
  } finally {
    release();
  }
  acquireSdlcWorkspaceLease(target)();
});

test('overlapping non-Git roots cannot hold simultaneous mutation leases', async () => {
  const sourceCwd = join(directory, 'plain');
  await mkdir(join(sourceCwd, 'src'), { recursive: true });
  const outer = await planSdlcWorkspace({
    operationId: 'outer',
    sourceCwd,
    storageDir: join(directory, 'storage'),
    mode: 'existing'
  });
  const inner = await planSdlcWorkspace({
    operationId: 'inner',
    sourceCwd: join(sourceCwd, 'src'),
    storageDir: join(directory, 'storage'),
    mode: 'existing'
  });
  const release = acquireSdlcWorkspaceLease(outer);
  try {
    assert.throws(() => acquireSdlcWorkspaceLease(inner), /owned by another active operation/);
  } finally {
    release();
  }
});

test('serial non-Git execution remains available while isolation fails explicitly', async () => {
  const sourceCwd = join(directory, 'plain');
  await mkdir(sourceCwd);
  await writeFile(join(sourceCwd, 'main.txt'), 'before');
  await mkdir(join(sourceCwd, 'dist'));
  await writeFile(join(sourceCwd, 'dist', 'main.js'), 'original source');
  const target = await planSdlcWorkspace({
    operationId: 'plain',
    sourceCwd,
    storageDir: join(directory, 'plain-storage'),
    mode: 'existing'
  });
  await ensureSdlcWorkspace(target);
  const before = await inspectSdlcWorkspace(target);
  const observed = await observe(target);
  await writeFile(join(sourceCwd, 'main.txt'), 'after');
  assert.notEqual((await inspectSdlcWorkspace(target)).revision, before.revision);
  assert.deepEqual((await inspectSdlcWorkspace(target)).changedFiles, ['main.txt']);
  await writeFile(join(sourceCwd, 'dist', 'main.js'), 'changed source');
  assert.deepEqual((await inspectSdlcWorkspace(target)).changedFiles, ['dist/main.js', 'main.txt']);
  assert.deepEqual(changedSdlcFiles(observed, await observe(target)), ['dist/main.js', 'main.txt']);
  await assert.rejects(
    planSdlcWorkspace({
      operationId: 'plain',
      sourceCwd,
      storageDir: join(directory, 'plain-storage'),
      mode: 'isolated'
    }),
    /require a Git/
  );
});
