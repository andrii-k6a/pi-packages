import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import type { Context } from '@earendil-works/chord';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { getOrThrow } from '@earendil-works/pi-durable/env';
import { inspectionProcess } from './inspection-process.js';
import { type SdlcWorkspace, sdlcWorkspaceTrackingPaths } from './sdlc-workspace.js';

/** Content identities detect task/check mutation outside ownership; they are not an OS sandbox. */
export async function observeSdlcFiles(
  workspace: SdlcWorkspace,
  environment: (cwd: string) => ExecutionEnv,
  context: Context
): Promise<Record<string, string>> {
  const root =
    workspace.mode === 'isolated'
      ? (workspace.path ?? workspace.cwd)
      : (workspace.repoRoot ?? workspace.cwd);
  const env = environment(root);
  let paths: string[];
  if (workspace.repoRoot) {
    paths = [];
    let pending = '';
    const listing = await inspectionProcess(
      env,
      ['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      context,
      {
        onStdout(chunk) {
          const parts = (pending + chunk).split('\0');
          pending = parts.pop() ?? '';
          paths.push(...parts);
          if (paths.length > 50_000 || pending.length > 10_000)
            throw new Error('SDLC file identity capture exceeds its finite limit');
        }
      }
    );
    if (listing.exitCode !== 0 || pending)
      throw new Error(
        'Cannot capture SDLC task file identities in the selected execution environment'
      );
    paths.push(...(await sdlcWorkspaceTrackingPaths(workspace)));
  } else {
    const exclude = ['.git'];
    if (env.listFiles) {
      const listing = getOrThrow(
        await env.listFiles(root, { maxEntries: 50_000, timeoutMs: 30_000, exclude }, context)
      );
      if (listing.truncated) throw new Error('SDLC file identity capture was truncated');
      paths = listing.entries
        .filter((entry) => entry.kind !== 'directory')
        .map((entry) => entry.path);
    } else {
      paths = [];
      let entries = 0;
      const deadline = Date.now() + 30_000;
      const walk = async (directory: string): Promise<void> => {
        for (const entry of getOrThrow(await env.listDir(directory, context))) {
          if (exclude.includes(entry.name)) continue;
          if (++entries > 50_000 || Date.now() > deadline)
            throw new Error('SDLC file identity capture exceeds its finite limit');
          const path = getOrThrow(await env.joinPath([directory, entry.name], context));
          if (entry.kind === 'directory') await walk(path);
          else paths.push(path);
        }
      };
      await walk(root);
    }
  }
  const result: Record<string, string> = {};
  if (workspace.repoRoot) {
    const index = createHash('sha256');
    const staged = await inspectionProcess(env, ['git', 'ls-files', '--stage', '-z'], context, {
      onStdout: (chunk) => {
        index.update(chunk);
      }
    });
    const head = await inspectionProcess(
      env,
      ['git', 'rev-parse', 'HEAD', '--symbolic-full-name', 'HEAD'],
      context
    );
    if (staged.exitCode !== 0 || head.exitCode !== 0 || head.truncated)
      throw new Error('Cannot verify SDLC Git metadata ownership');
    // Reserved outside-scope identities detect index/history mutation without granting it to '*'.
    result['../[git-index]'] = index.digest('hex');
    result['../[git-head]'] = createHash('sha256').update(head.stdout).digest('hex');
  }
  for (const path of [...new Set(paths)].sort()) {
    const absolute = getOrThrow(await env.absolutePath(path, context));
    const info = await env.fileInfo(absolute, context);
    if (!info.ok && info.error.code === 'not_found') continue;
    if (!info.ok) throw info.error;
    if (info.value.kind !== 'file')
      throw new Error(`SDLC cannot establish safe write ownership for non-regular input ${path}`);
    if (info.value.size > 32 * 1024 * 1024)
      throw new Error(
        `SDLC file identity capture does not support files larger than 32MB: ${path}`
      );
    const bytes = getOrThrow(await env.readBinaryFile(absolute, context));
    const mode = (await lstat(absolute)).mode;
    result[relative(workspace.cwd, absolute).split(sep).join('/')] = createHash('sha256')
      .update(`${mode}:`)
      .update(bytes)
      .digest('hex');
  }
  return result;
}
export function changedSdlcFiles(
  before: Record<string, string>,
  after: Record<string, string>
): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((path) => before[path] !== after[path])
    .sort();
}
