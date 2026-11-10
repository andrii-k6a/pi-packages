import { posix, win32 } from 'node:path';
import type { Context } from '@earendil-works/chord';
import {
  defineExtension,
  defineTool,
  type Extension,
  type ToolDiagnostic,
  type ToolExecutionResult
} from '@earendil-works/pi-durable';
import { type ExecutionEnv, getOrThrow } from '@earendil-works/pi-durable/env';
import { Type } from 'typebox';
import { inspectionProcess } from './inspection-process.js';
import { ReviewGitTool } from './review-git.js';

const EXCLUDED = [
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.cache',
  '.next',
  '.nuxt',
  'dist',
  'build',
  'coverage',
  'target',
  'vendor'
];
const DISCOVERY_NOTE = `Directory discovery excludes ${EXCLUDED.join(', ')} and does not follow symlinks. Explicit regular files bypass directory ignores.`;
const pathField = Type.Optional(Type.String({ minLength: 1 }));
const limitField = Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 }));
const offsetField = Type.Optional(Type.Integer({ minimum: 0, maximum: 50_000 }));

function result(text: string, truncated = false, note = ''): ToolExecutionResult {
  return {
    output: [{ type: 'text', text }],
    diagnostics: [
      ...(note ? [{ severity: 'info' as const, message: note }] : []),
      ...(truncated
        ? [
            {
              severity: 'warn' as const,
              code: 'truncated',
              message:
                'Output truncated. Continue with offset, or narrow the path/pattern. Do not assume full coverage.'
            }
          ]
        : [])
    ]
  };
}

function relativePath(cwd: string, path: string): string {
  const paths = /^[a-z]:[\\/]/i.test(cwd) ? win32 : posix;
  const relative = paths.relative(cwd, path);
  return paths === win32 ? relative.replace(/\\/g, '/') : relative;
}

const ReviewReadTool = defineTool({
  name: 'read',
  description:
    'Read bounded regular UTF-8 text files at literal paths in the host environment. Output is limited to 2000 lines or 50KB. Use offset/limit to continue. Binary contents and final-component symlinks are unsupported.',
  parameters: Type.Object({
    path: Type.String({ minLength: 1 }),
    offset: Type.Optional(Type.Integer({ minimum: 1, description: 'First line, 1-indexed.' })),
    limit: Type.Optional(Type.Integer({ minimum: 1, description: 'Maximum lines to read.' }))
  }),
  replay: 'safe',
  async execute(args, api, context) {
    if (!api.env) throw new Error('Read unavailable: the host supplied no execution environment');
    const absolute = getOrThrow(await api.env.absolutePath(args.path.replace(/^@/, ''), context));
    const reader = getOrThrow(
      await api.env.openBinaryReader(absolute, { noFollow: true }, context)
    );
    try {
      const before = getOrThrow(await reader.info(context));
      const probe = getOrThrow(await reader.read(0, 8192, context));
      if (probe.includes(0))
        throw new Error('Binary contents are not reviewed by the review toolset');
      const offset = args.offset ?? 1;
      const lines = Math.min(args.limit ?? 2000, 2000);
      const scan = getOrThrow(
        await reader.scanLines({ startLine: offset - 1, endLine: offset - 1 + lines }, context)
      );
      const totalLines = scan.newlines + 1;
      if (offset > totalLines)
        throw new Error(`Offset ${offset} is beyond end of file (${totalLines} lines total)`);
      const bom = probe[0] === 0xef && probe[1] === 0xbb && probe[2] === 0xbf;
      const start = scan.start === 0 && bom ? 3 : scan.start;
      const maxBytes = 50 * 1024;
      const bytes = getOrThrow(
        await reader.read(start, Math.min(Math.max(0, scan.end - start), maxBytes), context)
      );
      if (bytes.includes(0))
        throw new Error('Binary contents are not reviewed by the review toolset');
      const byteLimited = scan.selectedBytes > maxBytes;
      let content: string;
      try {
        content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes, {
          stream: byteLimited
        });
      } catch {
        throw new Error('Binary or non-UTF-8 contents are not reviewed by the review toolset');
      }
      const after = getOrThrow(await reader.info(context));
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
        throw new Error(`${args.path} changed while it was read. Retry the read.`);
      }
      const diagnostics: ToolDiagnostic[] = [];
      if (byteLimited && scan.firstLineBytes > maxBytes) {
        diagnostics.push({
          severity: 'warn',
          code: 'truncated',
          message: `Line ${offset} exceeds the 50KB read limit. Only its prefix is available; the full line was not reviewed.`
        });
      } else {
        if (byteLimited && content.includes('\n'))
          content = content.slice(0, content.lastIndexOf('\n'));
        const shownLines = byteLimited
          ? content.split('\n').length
          : Math.min(lines, totalLines - offset + 1);
        const nextOffset = offset + shownLines;
        if (byteLimited || offset - 1 + lines < totalLines) {
          diagnostics.push({
            severity: 'info',
            code: 'truncated',
            message: `Showing lines ${offset}-${nextOffset - 1} of ${totalLines}. Use offset=${nextOffset} to continue.`
          });
        }
      }
      return { output: content ? [{ type: 'text', text: content }] : [], diagnostics };
    } finally {
      await reader.close(context);
    }
  }
});

const ReviewLsTool = defineTool({
  name: 'ls',
  description: `List bounded directory entries with type suffixes, relative to cwd. Names are JSON-quoted to preserve unusual filenames. Default 200, maximum 1000 entries. Use offset to continue. ${DISCOVERY_NOTE}`,
  parameters: Type.Object({ path: pathField, offset: offsetField, limit: limitField }),
  replay: 'safe',
  async execute(args, api, context) {
    const env = api.env;
    if (!env)
      throw new Error('Directory listing unavailable: the host supplied no execution environment');
    const path = getOrThrow(await env.absolutePath(args.path ?? '.', context));
    const reader = getOrThrow(await env.openDirReader(path, context));
    const entries: string[] = [];
    const limit = args.limit ?? 200;
    const offset = args.offset ?? 0;
    let seen = 0;
    let scanned = 0;
    let done = false;
    try {
      while (!done && entries.length <= limit && scanned < 50_000) {
        const page = getOrThrow(await reader.next(100, context));
        done = page.done;
        for (const entry of page.entries) {
          scanned++;
          if (EXCLUDED.includes(entry.name)) continue;
          if (seen++ < offset) continue;
          entries.push(
            JSON.stringify(entry.name) +
              (entry.kind === 'directory'
                ? '/'
                : entry.kind === 'symlink'
                  ? ' [symlink, not followed]'
                  : '')
          );
          if (entries.length > limit) break;
        }
      }
    } finally {
      await reader.close(context);
    }
    const truncated = entries.length > limit || !done;
    return result(
      entries.slice(0, limit).join('\n') || '(no entries in this page)',
      truncated,
      `${DISCOVERY_NOTE} ${truncated ? `Use offset=${offset + limit} or select a subdirectory.` : ''}`
    );
  }
});

const discoveryGlobs = EXCLUDED.flatMap((name) => ['--glob', `!**/${name}/**`]);

const ReviewFindTool = defineTool({
  name: 'find',
  description: `Find filenames with a glob (e.g. **/*.test.ts) in the host execution environment. No Git executable is needed. Requires rg there. Default 200 results, maximum 1000, bounded 50KB. Paths are relative to cwd and JSON-quoted. Use offset to continue or narrow the target. ${DISCOVERY_NOTE}`,
  parameters: Type.Object({
    pattern: Type.String({ minLength: 1, maxLength: 2000 }),
    path: pathField,
    offset: offsetField,
    limit: limitField
  }),
  replay: 'safe',
  async execute(args, api, context) {
    const env = api.env;
    if (!env)
      throw new Error('File discovery unavailable: the host supplied no execution environment');
    const path = getOrThrow(await env.absolutePath(args.path ?? '.', context));
    const info = getOrThrow(await env.fileInfo(path, context));
    if (info.kind === 'file')
      return result(JSON.stringify(relativePath(env.cwd, path)), false, 'Explicit file target.');
    if (info.kind !== 'directory') throw new Error('File discovery does not follow symlinks');
    const offset = args.offset ?? 0;
    const limit = args.limit ?? 200;
    const maxOutputBytes = 50_000;
    const paths: string[] = [];
    let pending = '';
    let matched = 0;
    let outputBytes = 0;
    let truncated = false;
    const found = await inspectionProcess(
      env,
      [
        'rg',
        '--no-config',
        '--files',
        '--null',
        '--hidden',
        '--sort',
        'path',
        ...discoveryGlobs,
        '--',
        path
      ],
      context,
      {
        onStdout(chunk) {
          const files = (pending + chunk).split('\0');
          pending = files.pop() ?? '';
          if (pending.length > maxOutputBytes)
            throw new Error('File discovery returned an oversized filename');
          for (const file of files) {
            if (truncated) continue;
            // Positive rg globs override ignore rules. Match names after ignored-file discovery instead.
            const relative = relativePath(path, file);
            if (
              !posix.matchesGlob(
                args.pattern.includes('/') ? relative : posix.basename(relative),
                args.pattern
              )
            )
              continue;
            if (matched++ < offset) continue;
            const rendered = JSON.stringify(relativePath(env.cwd, file));
            const bytes = Buffer.byteLength(rendered) + (paths.length ? 1 : 0);
            if (!paths.length && bytes > maxOutputBytes)
              throw new Error(
                'A matching filename exceeds the output limit. Inspect its path explicitly.'
              );
            if (paths.length >= limit || outputBytes + bytes > maxOutputBytes) {
              truncated = true;
              continue;
            }
            paths.push(rendered);
            outputBytes += bytes;
          }
        }
      }
    );
    if (found.exitCode !== 0 && found.exitCode !== 1) {
      throw new Error(
        `File discovery unavailable: ${found.stderr || `rg exited ${found.exitCode}`}`
      );
    }
    if (pending) throw new Error('File discovery ended with an incomplete filename');
    return result(
      paths.join('\n') || '(no matching files in this page)',
      truncated,
      `${DISCOVERY_NOTE} ${truncated ? `Use offset=${offset + paths.length} to continue, or narrow the path/pattern.` : ''}`
    );
  }
});

const ReviewGrepTool = defineTool({
  name: 'grep',
  description: `Search text with paths, line numbers, and optional context in the host environment. No Git executable is needed. Requires rg there. Pattern is data, not a command. Ignores binary contents. Default 100 matches per file, maximum 1000, output bounded to 50KB. Narrow path/pattern or use read offsets after truncation. ${DISCOVERY_NOTE}`,
  parameters: Type.Object({
    pattern: Type.String({ maxLength: 2000 }),
    path: pathField,
    literal: Type.Optional(Type.Boolean()),
    ignoreCase: Type.Optional(Type.Boolean()),
    context: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
    limit: limitField
  }),
  replay: 'safe',
  async execute(args, api, context) {
    const env = api.env;
    if (!env)
      throw new Error('Content search unavailable: the host supplied no execution environment');
    const path = getOrThrow(await env.absolutePath(args.path ?? '.', context));
    const info = getOrThrow(await env.fileInfo(path, context));
    if (info.kind === 'symlink') throw new Error('Content search does not follow symlinks');
    const found = await inspectionProcess(
      env,
      [
        'rg',
        '--no-config',
        '--json',
        '--hidden',
        '--color=never',
        ...(info.kind === 'directory' ? discoveryGlobs : []),
        '--max-count',
        String(args.limit ?? 100),
        '--context',
        String(args.context ?? 0),
        ...(args.literal ? ['--fixed-strings'] : []),
        ...(args.ignoreCase ? ['--ignore-case'] : []),
        '--regexp',
        args.pattern,
        '--',
        path
      ],
      context
    );
    if (found.exitCode !== 0 && found.exitCode !== 1) {
      throw new Error(
        `Content search unavailable: ${found.stderr || `rg exited ${found.exitCode}`}`
      );
    }
    const output: string[] = [];
    const matchesPerFile = new Map<string, number>();
    let truncated = found.truncated;
    for (const line of found.stdout.split('\n').filter(Boolean)) {
      let event: {
        type: string;
        data: { path?: { text?: string }; lines?: { text?: string }; line_number?: number };
      };
      try {
        event = JSON.parse(line);
      } catch {
        truncated = true;
        continue;
      }
      if (event.type !== 'match' && event.type !== 'context') continue;
      const file = event.data.path?.text;
      const text = event.data.lines?.text;
      if (file === undefined || text === undefined) {
        truncated = true;
        continue;
      }
      if (event.type === 'match') {
        const count = (matchesPerFile.get(file) ?? 0) + 1;
        matchesPerFile.set(file, count);
        if (count >= (args.limit ?? 100)) truncated = true;
      }
      output.push(
        `${JSON.stringify(relativePath(env.cwd, file))}:${event.data.line_number}${event.type === 'context' ? '-' : ':'} ${text.replace(/\r?\n$/, '')}`
      );
    }
    return result(
      output.join('\n') || '(no text matches in captured output)',
      truncated,
      `${DISCOVERY_NOTE} Search is limited to ${args.limit ?? 100} matches per file. Refine the pattern or use read with line offsets to investigate further.`
    );
  }
});

/** Validate new file-review targets in the host environment, without interpreter filesystem access. */
export async function validateReviewTarget(
  env: ExecutionEnv,
  path: string,
  context: Context
): Promise<void> {
  try {
    const absolute = getOrThrow(await env.absolutePath(path, context));
    const info = getOrThrow(await env.fileInfo(absolute, context));
    if (info.kind === 'directory') {
      const reader = getOrThrow(await env.openDirReader(absolute, context));
      try {
        getOrThrow(await reader.next(1, context));
      } finally {
        await reader.close(context);
      }
    } else if (info.kind === 'file') {
      const reader = getOrThrow(await env.openBinaryReader(absolute, { noFollow: true }, context));
      await reader.close(context);
    } else {
      throw new Error(
        'Explicit symlink targets are unsupported. Select the actual file or directory.'
      );
    }
  } catch (error) {
    throw new Error(
      `Cannot inspect file-review target ${JSON.stringify(path)}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** Exact extension and tool arrays override host defaults at declaration and execution time. */
export const ReviewTools: Extension = defineExtension({
  name: 'workflow.review_tools',
  tools: [ReviewReadTool, ReviewLsTool, ReviewFindTool, ReviewGrepTool, ReviewGitTool]
});
