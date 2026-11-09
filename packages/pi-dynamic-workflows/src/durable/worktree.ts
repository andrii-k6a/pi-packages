import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const GIT_OPTIONS = { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 };

/** Persisted before checkout creation, so recovery never allocates a different branch or base. */
export type WorkflowWorktree = {
  repoRoot: string;
  commonDir: string;
  path: string;
  cwd: string;
  branch: string;
  baseCommit: string;
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', cwd, ...args], GIT_OPTIONS);
  return stdout.replace(/\r?\n$/, '');
}

export async function planWorktree(cwd: string, label: string): Promise<WorkflowWorktree> {
  const repoRoot = await realpath(await git(cwd, 'rev-parse', '--show-toplevel'));
  const commonDir = await realpath(
    await git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  );
  const baseCommit = await git(cwd, 'rev-parse', '--verify', 'HEAD^{commit}');
  const subdirectory = relative(repoRoot, await realpath(cwd));
  if (isAbsolute(subdirectory) || subdirectory === '..' || subdirectory.startsWith(`..${sep}`)) {
    throw new Error('workflow cwd is outside the Git repository');
  }
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);
  const id = `${slug || 'agent'}-${randomUUID()}`;
  // Keep checkouts outside tracked files, including when the source is itself a linked worktree.
  const path = join(commonDir, 'pi-workflow-worktrees', id);
  return {
    repoRoot,
    commonDir,
    path,
    cwd: join(path, subdirectory),
    branch: `pi/workflow/${id}`,
    baseCommit
  };
}

/** Idempotent only during setup. Never reset, delete, or overwrite an existing checkout. */
export async function ensureWorktree(worktree: WorkflowWorktree): Promise<void> {
  const entries = await worktreeEntries(worktree);
  if (entries.some((entry) => entry.path === worktree.path)) {
    await validateWorktree(worktree);
    return;
  }
  try {
    await lstat(worktree.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    let branchCommit: string | undefined;
    try {
      branchCommit = await git(
        worktree.repoRoot,
        'rev-parse',
        '--verify',
        `refs/heads/${worktree.branch}`
      );
    } catch (error) {
      if ((error as { code?: number }).code !== 128) throw error;
    }
    if (branchCommit !== undefined && branchCommit !== worktree.baseCommit) {
      throw new Error(`worktree branch ${worktree.branch} has changed before checkout creation`);
    }
    await git(
      worktree.repoRoot,
      'worktree',
      'add',
      ...(branchCommit === undefined ? ['-b', worktree.branch] : []),
      worktree.path,
      branchCommit === undefined ? worktree.baseCommit : worktree.branch
    );
    await validateWorktree(worktree);
    return;
  }
  throw new Error(`worktree path already exists but is not registered: ${worktree.path}`);
}

/** Missing, replaced, or partially initialized checkouts fail closed rather than losing edits. */
export async function validateWorktree(worktree: WorkflowWorktree): Promise<void> {
  const entry = (await worktreeEntries(worktree)).find((item) => item.path === worktree.path);
  if (!entry || entry.branch !== `refs/heads/${worktree.branch}` || entry.locked) {
    throw new Error(`worktree is missing, locked, or on a different branch: ${worktree.path}`);
  }
  const root = await realpath(await git(worktree.path, 'rev-parse', '--show-toplevel'));
  const commonDir = await realpath(
    await git(worktree.path, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  );
  if (root !== worktree.path || commonDir !== worktree.commonDir) {
    throw new Error(`worktree repository does not match its saved identity: ${worktree.path}`);
  }
  if (!(await stat(worktree.cwd)).isDirectory()) {
    throw new Error(`worktree cwd is not a directory: ${worktree.cwd}`);
  }
}

async function worktreeEntries(worktree: WorkflowWorktree) {
  const output = await git(worktree.repoRoot, 'worktree', 'list', '--porcelain', '-z');
  return output
    .split('\0\0')
    .filter(Boolean)
    .map((record) => {
      const fields = record.split('\0');
      return {
        path: resolve(fields.find((field) => field.startsWith('worktree '))?.slice(9) ?? ''),
        branch: fields.find((field) => field.startsWith('branch '))?.slice(7),
        locked: fields.some((field) => field === 'locked' || field.startsWith('locked '))
      };
    });
}
