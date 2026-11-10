import { posix, win32 } from 'node:path';
import { defineTool, type ToolExecutionResult } from '@earendil-works/pi-durable';
import { getOrThrow } from '@earendil-works/pi-durable/env';
import { Type } from 'typebox';
import { inspectionProcess } from './inspection-process.js';

export const ReviewGitTool = defineTool({
  name: 'git_inspect',
  description:
    'Read-only Git inspection: resolve a revision to a commit, show prior file text, inspect focused log or blame. Paths are relative to cwd. Defaults to HEAD. No arbitrary flags, shell, working-tree diff, scripts, or mutations. Output is bounded to 50KB; show supports offset/limit, log defaults to 10 commits. Unavailable Git/history is an evidence limitation.',
  parameters: Type.Object({
    operation: Type.String({ enum: ['resolve', 'show', 'log', 'blame'] }),
    revision: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    path: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
    offset: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 }))
  }),
  replay: 'safe',
  async execute(args, api, context) {
    const env = api.env;
    if (!env)
      throw new Error('Git inspection unavailable: the host supplied no execution environment');
    const git = async (argv: string[], lines?: { offset: number; limit: number }) => {
      const result = await inspectionProcess(
        env,
        [
          'git',
          '--no-pager',
          '--no-optional-locks',
          '--literal-pathspecs',
          '-c',
          'core.fsmonitor=false',
          '-c',
          'log.showSignature=false',
          ...argv
        ],
        context,
        { lines }
      );
      if (result.exitCode !== 0) {
        throw new Error(
          `Git/history unavailable: ${result.stderr.trim() || `git exited ${result.exitCode}`}`
        );
      }
      return result;
    };
    const resolved = await git([
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${args.revision ?? 'HEAD'}^{commit}`
    ]);
    const commit = resolved.stdout.trim();
    if (!/^[0-9a-f]{40,64}$/.test(commit))
      throw new Error('Git returned an invalid commit identity');
    if (args.operation === 'resolve') return textResult(commit);
    if (!args.path) throw new Error(`git_inspect ${args.operation} requires a literal file path`);
    const root = (await git(['rev-parse', '--show-toplevel'])).stdout.replace(/\r?\n$/, '');
    const absolute = getOrThrow(await env.absolutePath(args.path, context));
    const pathApi = /^[a-z]:[\\/]/i.test(root) ? win32 : posix;
    const canonicalCwd = getOrThrow(await env.canonicalPath(env.cwd, context));
    const target = pathApi.isAbsolute(args.path)
      ? absolute
      : pathApi.resolve(canonicalCwd, args.path);
    const relative = pathApi.relative(root, target);
    const path = pathApi === win32 ? relative.replace(/\\/g, '/') : relative;
    if (!path || path === '..' || path.startsWith('../') || pathApi.isAbsolute(path)) {
      throw new Error('Historical file path must be inside the Git worktree');
    }
    const offset = args.offset ?? 1;
    const limit = args.limit ?? (args.operation === 'log' ? 10 : 200);
    let result: Awaited<ReturnType<typeof git>>;
    if (args.operation === 'show') {
      result = await git(['show', '--no-ext-diff', '--no-textconv', `${commit}:${path}`], {
        offset,
        limit
      });
    } else if (args.operation === 'log') {
      result = await git([
        '-C',
        root,
        'log',
        '--no-ext-diff',
        '--no-textconv',
        '--format=%H %s',
        `--max-count=${Math.min(limit, 50)}`,
        `--skip=${offset - 1}`,
        commit,
        '--',
        path
      ]);
      // The requested history page may have more commits. Never label a page as exhaustive history.
      return textResult(
        result.stdout,
        result.truncated,
        `History page only. Use offset=${offset + Math.min(limit, 50)} to continue.`
      );
    } else {
      result = await git([
        '-C',
        root,
        'blame',
        '--no-ext-diff',
        '--no-textconv',
        '-L',
        `${offset},${offset + limit - 1}`,
        commit,
        '--',
        path
      ]);
    }
    if (result.stdout.includes('\0'))
      throw new Error('Historical binary contents are not content-reviewed');
    return textResult(
      result.stdout,
      result.truncated,
      `Commit ${commit}. Lines start at ${offset}. Use offset=${offset + limit} to continue or narrow the range.`
    );
  }
});

function textResult(text: string, truncated = false, note = ''): ToolExecutionResult {
  return {
    output: [{ type: 'text', text: text || '(no content in this line/page range)' }],
    diagnostics: [
      ...(note ? [{ severity: 'info' as const, message: note }] : []),
      ...(truncated
        ? [
            {
              severity: 'warn' as const,
              code: 'truncated',
              message: 'Output truncated. Continue with a line/page offset or narrow the target.'
            }
          ]
        : [])
    ]
  };
}
