import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  type CodeReviewArgs,
  type CodeReviewCapture,
  MAX_REVIEW_DIFF_CHARS,
  validateCodeReviewArgs
} from '../workflow/builtins/code-review-input.js';

const exec = promisify(execFile);
const NARROW_SCOPE =
  'The diff exceeds the capture limit. Select a smaller path with /code-review <path>.';

export function parseCodeReviewCommand(input: string): {
  mode: 'changes' | 'files';
  path?: string;
  profile?: string;
  base?: string;
  goal?: string;
  trackedOnly: boolean;
} {
  const tokens: string[] = [];
  let token = '';
  let started = false;
  let quote = '';
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (char === quote) {
      quote = '';
    } else if (!quote && (char === '"' || char === "'")) {
      quote = char;
      started = true;
    } else if (char === '\\' && quote !== "'" && /[\s\\"']/.test(input[index + 1] ?? '')) {
      token += input[++index];
      started = true;
    } else if (!quote && /\s/.test(char)) {
      if (started) tokens.push(token);
      token = '';
      started = false;
    } else {
      token += char;
      started = true;
    }
  }
  if (quote) throw new Error('Unclosed quote in /code-review arguments');
  if (started) tokens.push(token);
  let mode: 'changes' | 'files' = 'changes';
  let path: string | undefined;
  let profile: string | undefined;
  let base: string | undefined;
  let goal: string | undefined;
  let trackedOnly = false;
  const seen = new Set<string>();
  let options = true;
  for (let index = 0; index < tokens.length; index++) {
    const value = tokens[index];
    if (options && ['--files', '--tracked-only', '--profile', '--base', '--goal'].includes(value)) {
      if (seen.has(value)) throw new Error(`/code-review accepts only one ${value}`);
      seen.add(value);
    }
    if (options && value === '--') {
      options = false;
    } else if (options && value === '--files') {
      mode = 'files';
    } else if (options && value === '--tracked-only') {
      trackedOnly = true;
    } else if (options && ['--profile', '--base', '--goal'].includes(value)) {
      const argument = tokens[++index];
      if (!argument?.trim() || argument.startsWith('--')) {
        throw new Error(`/code-review ${value} requires a non-empty value`);
      }
      if (value === '--profile') profile = argument;
      else if (value === '--base') base = argument;
      else goal = argument;
    } else if (options && value.startsWith('-')) {
      throw new Error(
        `Unknown /code-review option ${JSON.stringify(value)}. Use -- before a dash-prefixed path.`
      );
    } else {
      if (path !== undefined) {
        throw new Error(
          '/code-review accepts one literal path. Put options before it and quote paths containing spaces.'
        );
      }
      if (!value.trim()) throw new Error('/code-review requires a non-empty path');
      path = value;
      options = false;
    }
  }
  if (mode === 'files' && trackedOnly) {
    throw new Error('/code-review --tracked-only cannot be combined with --files');
  }
  if (mode === 'files' && base !== undefined) {
    throw new Error('/code-review --base cannot be combined with --files');
  }
  return { mode, path, profile, base, goal, trackedOnly };
}

/** External requests may select capture. Stored workflow arguments must already be prepared. */
interface CodeReviewRequest extends CodeReviewArgs {
  base?: string;
  trackedOnly?: boolean;
}

export async function prepareCodeReviewInput(
  cwd: string,
  value: unknown,
  resolveProfile: (name: string) => unknown,
  signal?: AbortSignal
): Promise<{ cwd: string; args: CodeReviewArgs } | { empty: string }> {
  const request = value === undefined ? {} : value;
  validateCodeReviewRequest(request);
  if (request.profile !== undefined) resolveProfile(request.profile);
  signal?.throwIfAborted();
  if (request.mode === 'files' || 'diff' in request) {
    return { cwd, args: request };
  }
  const input = await captureCodeReviewChanges(cwd, request.path, request.trackedOnly ?? false, {
    base: request.base,
    signal
  });
  if (!input) {
    const comparison =
      request.base === undefined
        ? 'HEAD'
        : `the merge base of ${JSON.stringify(request.base)} and captured HEAD`;
    return {
      empty: request.trackedOnly
        ? `No tracked changes against ${comparison} to review (--tracked-only). No review run was started.`
        : `No changes against ${comparison} or eligible untracked additions to review. No review run was started.`
    };
  }
  const args = {
    ...input.args,
    ...(request.goal === undefined ? {} : { goal: request.goal }),
    ...(request.profile === undefined ? {} : { profile: request.profile })
  };
  validateCodeReviewArgs(args, MAX_REVIEW_DIFF_CHARS);
  return { cwd: input.cwd, args };
}

function validateCodeReviewRequest(value: unknown): asserts value is CodeReviewRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Code review requires args to be an object');
  }
  const args = value as Record<string, unknown>;
  if (args.mode === 'files' || 'diff' in args) {
    validateCodeReviewArgs(args, MAX_REVIEW_DIFF_CHARS);
    return;
  }
  if (args.mode !== undefined && args.mode !== 'changes') {
    throw new Error('Code review requires args.mode to be "changes" or "files"');
  }
  for (const key of ['base', 'path', 'profile', 'goal']) {
    if (
      args[key] !== undefined &&
      (typeof args[key] !== 'string' || (key !== 'goal' && !(args[key] as string).trim()))
    ) {
      throw new Error(
        `Code review requires args.${key} to be ${key === 'goal' ? 'a string' : 'a non-empty string'}`
      );
    }
  }
  if (args.trackedOnly !== undefined && typeof args.trackedOnly !== 'boolean') {
    throw new Error('Code review requires args.trackedOnly to be a boolean');
  }
  if (['diffSource', 'baseCommit', 'capture'].some((key) => key in args)) {
    throw new Error('Code review diffSource, baseCommit, and capture require a supplied diff');
  }
}

/** Capture once at the host boundary. Reviewers never reconstruct this input from a later diff. */
export async function captureCodeReviewChanges(
  cwd: string,
  path: string | undefined,
  trackedOnly: boolean,
  options: { base?: string; signal?: AbortSignal } = {}
): Promise<{ cwd: string; args: CodeReviewArgs } | undefined> {
  const comparison =
    options.base === undefined
      ? 'HEAD'
      : `the merge base of ${JSON.stringify(options.base)} and captured HEAD`;
  const git = async (args: string[], directory = cwd) => {
    options.signal?.throwIfAborted();
    try {
      return (
        await exec(
          'git',
          [
            '--no-pager',
            '--no-optional-locks',
            '--literal-pathspecs',
            '-c',
            'core.fsmonitor=false',
            ...args
          ],
          {
            cwd: directory,
            signal: options.signal,
            timeout: 30_000,
            maxBuffer: MAX_REVIEW_DIFF_CHARS * 4
          }
        )
      ).stdout;
    } catch (error) {
      options.signal?.throwIfAborted();
      if ((error as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        throw new Error(NARROW_SCOPE);
      }
      const message =
        error instanceof Error ? error.message.split(/\r?\n/).slice(0, 2).join(' ') : String(error);
      throw new Error(
        `Cannot capture changes against ${comparison}: ${args[0] === 'merge-base' ? 'No unique usable merge base. ' : ''}${message}. Use /code-review --files [path] to review existing code explicitly.`
      );
    }
  };
  const headCommit = (
    await git(['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'])
  ).trim();
  const baseTipCommit =
    options.base === undefined
      ? undefined
      : (
          await git(['rev-parse', '--verify', '--end-of-options', `${options.base}^{commit}`])
        ).trim();
  let baseCommit = headCommit;
  if (baseTipCommit !== undefined) {
    const bases = (await git(['merge-base', '--all', headCommit, baseTipCommit]))
      .trim()
      .split(/\s+/);
    if (bases.length !== 1 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(bases[0])) {
      throw new Error(`Cannot capture changes against ${comparison}: no unique usable merge base.`);
    }
    baseCommit = bases[0];
  }
  const root = (await git(['rev-parse', '--show-toplevel'])).replace(/\r?\n$/, '');
  const selected =
    path === undefined
      ? root
      : isAbsolute(path)
        ? resolve(await realpath(dirname(path)), basename(path))
        : resolve(await realpath(cwd), path);
  const target = relative(root, selected) || '.';
  let diff = await git(
    [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      '--no-relative',
      baseCommit,
      '--',
      target
    ],
    root
  );
  const capturedComparison = {
    headCommit,
    commit: baseCommit,
    ...(options.base === undefined ? {} : { baseRef: options.base, baseTipCommit }),
    localChanges: false
  };
  const capture: CodeReviewCapture = {
    target,
    untracked: trackedOnly ? 'excluded' : 'included',
    includedAdditions: [],
    exclusions: [],
    comparison: capturedComparison
  };
  const checkLimit = () => {
    if (diff.length > MAX_REVIEW_DIFF_CHARS) throw new Error(NARROW_SCOPE);
  };
  checkLimit();
  if (!trackedOnly) {
    const listing = await git(
      ['ls-files', '--others', '--exclude-standard', '-z', '--', target],
      root
    );
    for (const name of listing.split('\0').filter(Boolean)) {
      options.signal?.throwIfAborted();
      const absolute = resolve(root, name);
      const info = await lstat(absolute);
      if (!info.isFile()) {
        capture.exclusions.push({
          path: name,
          reason: info.isSymbolicLink() ? 'symlink not followed' : 'unsupported file type'
        });
        continue;
      }
      const file = await open(
        absolute,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      );
      let content: string;
      try {
        const before = await file.stat();
        if (!before.isFile())
          throw new Error(`Untracked file changed type during capture: ${name}`);
        // Probe before the text size limit; streaming decode tolerates a split UTF-8 character.
        const probe = Buffer.alloc(Math.min(before.size, 8192));
        const { bytesRead } = await file.read(probe, 0, probe.length, 0);
        try {
          const prefix = probe.subarray(0, bytesRead);
          if (prefix.includes(0)) throw new Error('binary');
          new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(prefix, {
            stream: true
          });
        } catch {
          capture.exclusions.push({ path: name, reason: 'binary or non-UTF-8 content' });
          continue;
        }
        const maxBytes = MAX_REVIEW_DIFF_CHARS * 4;
        if (before.size > maxBytes) throw new Error(NARROW_SCOPE);
        const bytes = Buffer.alloc(Math.min(before.size + 1, maxBytes + 1));
        let length = 0;
        while (length < bytes.length) {
          options.signal?.throwIfAborted();
          const read = await file.read(bytes, length, bytes.length - length, length);
          if (!read.bytesRead) break;
          length += read.bytesRead;
        }
        const after = await file.stat();
        if (
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs ||
          length !== before.size
        ) {
          throw new Error(`Untracked file changed during capture: ${name}. Retry the review.`);
        }
        try {
          if (bytes.subarray(0, length).includes(0)) throw new Error('binary');
          content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
            bytes.subarray(0, length)
          );
        } catch {
          capture.exclusions.push({ path: name, reason: 'binary or non-UTF-8 content' });
          continue;
        }
      } finally {
        await file.close();
      }
      diff += newFilePatch(name, content, (info.mode & 0o111) !== 0);
      checkLimit();
      capture.includedAdditions.push(name);
    }
  }
  options.signal?.throwIfAborted();
  if (!diff.trim() && !capture.exclusions.length) return undefined;
  if (!diff.trim()) {
    throw new Error(
      `No content-reviewable changes against ${comparison}. Not content-reviewed: ${JSON.stringify(capture.exclusions)}. Use /code-review --files <path> for explicit inspection.`
    );
  }
  capturedComparison.localChanges =
    baseCommit === headCommit ||
    capture.includedAdditions.length > 0 ||
    Boolean(
      await git(
        [
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--name-only',
          '--no-relative',
          headCommit,
          '--',
          target
        ],
        root
      )
    );
  return {
    cwd: root,
    args: {
      mode: 'changes',
      diff,
      baseCommit,
      diffSource: `git diff ${baseCommit} -- ${target}`,
      capture
    }
  };
}

function newFilePatch(path: string, content: string, executable: boolean): string {
  const before = quoteGitPath(`a/${path}`);
  const after = quoteGitPath(`b/${path}`);
  const header = `diff --git ${before} ${after}\nnew file mode ${executable ? '100755' : '100644'}\n`;
  if (!content) return `${header}index 0000000..e69de29\n`;
  const lines = content.split('\n');
  const terminated = lines.at(-1) === '';
  if (terminated) lines.pop();
  return `${header}--- /dev/null\n+++ ${after}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}\n`).join('')}${terminated ? '' : '\\ No newline at end of file\n'}`;
}

function quoteGitPath(path: string): string {
  if (
    ![...path].some(
      (char) => char <= ' ' || char.charCodeAt(0) >= 127 || char === '"' || char === '\\'
    )
  )
    return path;
  return `"${Array.from(Buffer.from(path), (byte) =>
    byte === 34 || byte === 92
      ? `\\${String.fromCharCode(byte)}`
      : byte < 32 || byte >= 127
        ? `\\${byte.toString(8).padStart(3, '0')}`
        : String.fromCharCode(byte)
  ).join('')}"`;
}
