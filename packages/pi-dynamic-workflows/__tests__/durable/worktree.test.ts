import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, test } from 'vitest';
import { ensureWorktree, planWorktree, validateWorktree } from '../../src/durable/worktree.js';

const exec = promisify(execFile);
let directory: string;
let repo: string;
async function git(...args: string[]) {
  return (await exec('git', ['-C', repo, ...args])).stdout.trim();
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pi-worktree-'));
  repo = join(directory, 'repo with spaces');
  await mkdir(repo);
  await git('init', '-q');
  await git('config', 'user.name', 'Test');
  await git('config', 'user.email', 'test@example.com');
  await writeFile(join(repo, 'tracked.txt'), 'base');
  await git('add', '.');
  await git('commit', '-qm', 'base');
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

test('setup replay preserves dirty files and uses the captured commit even after parent HEAD moves', async () => {
  const worktree = await planWorktree(repo, '../Unusual editor label!');
  await writeFile(join(repo, 'tracked.txt'), 'later commit');
  await git('commit', '-qam', 'later');
  await ensureWorktree(worktree);
  assert.equal(await readFile(join(worktree.cwd, 'tracked.txt'), 'utf8'), 'base');
  await writeFile(join(worktree.cwd, 'tracked.txt'), 'agent edit');
  await ensureWorktree(worktree);
  assert.equal(await readFile(join(worktree.cwd, 'tracked.txt'), 'utf8'), 'agent edit');
  assert.equal(await git('status', '--porcelain'), '');
});

test('setup recovers a branch created before checkout allocation', async () => {
  const worktree = await planWorktree(repo, 'editor');
  await git('branch', worktree.branch, worktree.baseCommit);
  await ensureWorktree(worktree);
  await validateWorktree(worktree);
  assert.equal(await readFile(join(worktree.cwd, 'tracked.txt'), 'utf8'), 'base');
});

test('existing unregistered directories are never overwritten or removed', async () => {
  const worktree = await planWorktree(repo, 'editor');
  await mkdir(worktree.path, { recursive: true });
  await writeFile(join(worktree.path, 'keep.txt'), 'important');
  await assert.rejects(ensureWorktree(worktree), /already exists but is not registered/);
  assert.equal(await readFile(join(worktree.path, 'keep.txt'), 'utf8'), 'important');
});

test('missing, branch-switched, and locked worktrees fail validation without destroying changes', async () => {
  const worktree = await planWorktree(repo, 'editor');
  await assert.rejects(validateWorktree(worktree), /missing/);
  await ensureWorktree(worktree);
  await writeFile(join(worktree.cwd, 'keep.txt'), 'important');
  await exec('git', ['-C', worktree.cwd, 'switch', '-qc', 'replacement']);
  await assert.rejects(validateWorktree(worktree), /different branch/);
  await exec('git', ['-C', worktree.cwd, 'switch', '-q', worktree.branch]);
  await git('worktree', 'lock', '--reason', 'initializing', worktree.path);
  await assert.rejects(ensureWorktree(worktree), /locked/);
  assert.equal(await readFile(join(worktree.cwd, 'keep.txt'), 'utf8'), 'important');
});

test('a source that is itself a linked worktree supplies its own HEAD and relative cwd', async () => {
  const linked = join(directory, 'linked');
  await git('worktree', 'add', '-qb', 'source', linked);
  await mkdir(join(linked, 'nested'));
  await writeFile(join(linked, 'nested', 'source.txt'), 'source branch');
  await exec('git', ['-C', linked, 'add', '.']);
  await exec('git', ['-C', linked, 'commit', '-qm', 'source']);
  const worktree = await planWorktree(join(linked, 'nested'), 'editor');
  await ensureWorktree(worktree);
  assert.equal(worktree.cwd, join(worktree.path, 'nested'));
  assert.equal(await readFile(join(worktree.cwd, 'source.txt'), 'utf8'), 'source branch');
  assert.equal(await git('status', '--porcelain'), '');
});
