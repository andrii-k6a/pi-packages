import { spawnSync } from 'node:child_process';
import { writeSync } from 'node:fs';
import { type Args, type ExtensionAPI, parseArgs } from '@earendil-works/pi-coding-agent';

/**
 * Adds `--dump-system-prompt` and `--dump-tools` to Pi.
 *
 * Both flags share the same two execution paths:
 *
 * 1. **No-prompt path** (`pi --dump-system-prompt` / `pi --dump-tools`): detected
 *    at extension-setup time, before Pi starts its interactive TUI. A synthetic
 *    child process is spawned with `-p dump` (and `--no-session`, unless the user
 *    selected a session) so turn-scoped hooks (e.g. `before_agent_start`) run
 *    normally. The parent exits immediately; the TUI never initialises.
 *
 * 2. **Direct path** (`pi --dump-system-prompt -p "…"` / `pi --dump-tools -p "…"`):
 *    Pi runs in print mode. The `context` hook fires after the full
 *    `before_agent_start` chain and exits before any provider/model request.
 */
export default function dumpSystemPrompt(pi: ExtensionAPI) {
  pi.registerFlag('dump-system-prompt', {
    description: 'Print the assembled system prompt and exit before calling the model',
    type: 'boolean',
    default: false
  });

  pi.registerFlag('dump-tools', {
    description:
      'Print all registered tools with descriptions and parameter schemas and exit before calling the model',
    type: 'boolean',
    default: false
  });

  let dumped = false;

  const dumpAndExit = (output: string) => {
    if (dumped) return;
    dumped = true;

    // Use fd 1 directly. In print/JSON integrations Pi may wrap process.stdout,
    // but fd 1 remains the caller's stdout and is redirect-friendly.
    writeAllSync(1, output.endsWith('\n') ? output : `${output}\n`);
    process.exit(0);
  };

  if (process.env.PI_INSPECT_SYNTHETIC_DUMP !== '1') {
    // pi.getFlag() is not populated yet at setup time, so parse argv with pi's own parser.
    const args = parseArgs(process.argv.slice(2));
    if (needsSyntheticTurn(args)) runSyntheticDumpTurn(args);
  }

  pi.on('context', (_event, ctx) => {
    // context runs after the full before_agent_start chain and is awaited while
    // building the request context, so we exit before any provider/model call.
    if (pi.getFlag('dump-system-prompt') === true) {
      dumpAndExit(ctx.getSystemPrompt());
    }
    if (pi.getFlag('dump-tools') === true) {
      dumpAndExit(formatTools(pi));
    }
  });
}

/**
 * Formats the full tool list as human-readable text suitable for stdout.
 *
 * Active tools (those enabled for the current turn) are listed first. Any
 * tools that are registered but not active are appended under a separator.
 * Each entry shows the tool name, its source (e.g. `builtin`, package name),
 * its description, and its JSON parameter schema (what the model receives).
 */
export function formatTools(pi: ExtensionAPI): string {
  const all = pi.getAllTools();
  const activeSet = new Set(pi.getActiveTools());

  const active = all.filter((t) => activeSet.has(t.name));
  const inactive = all.filter((t) => !activeSet.has(t.name));

  const lines: string[] = [];

  const header =
    inactive.length === 0
      ? `Tools: ${active.length} active`
      : `Tools: ${active.length} active, ${inactive.length} inactive (${all.length} total)`;
  lines.push(header);

  const appendTool = (tool: ReturnType<typeof pi.getAllTools>[number]) => {
    lines.push('');
    lines.push(`${tool.name} [${tool.sourceInfo.source}]`);
    if (tool.description) {
      lines.push(indent(tool.description, 2));
    }
    lines.push('  parameters:');
    lines.push(indent(JSON.stringify(tool.parameters, null, 2), 4));
  };

  for (const tool of active) appendTool(tool);

  if (inactive.length > 0) {
    lines.push('');
    lines.push('--- inactive ---');
    for (const tool of inactive) appendTool(tool);
  }

  return lines.join('\n');
}

/** Indents every non-empty line of `text` by `spaces` spaces. */
function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => (line ? pad + line : line))
    .join('\n');
}

/**
 * Spawns a synthetic `-p dump` child process so Pi assembles a full turn
 * context (including `before_agent_start` hooks) without the parent ever
 * entering interactive TUI mode.
 *
 * The child gets `--no-session` so the throwaway "dump" turn is not written to
 * session history, unless the user selected a session (`-c`, `-r`, `--session`,
 * `--fork`), in which case that session is left to Pi.
 *
 * The child is guarded by `PI_INSPECT_SYNTHETIC_DUMP=1` to prevent
 * recursive spawning. stdout/stderr are inherited so the child writes directly
 * to the caller's file descriptors — no parent-side buffering needed.
 */
function runSyntheticDumpTurn(args: Args): never {
  const childArgs = [process.argv[1], ...buildSyntheticArgs(process.argv.slice(2), args)];
  const result = spawnSync(process.execPath, childArgs, {
    cwd: process.cwd(),
    env: { ...process.env, PI_INSPECT_SYNTHETIC_DUMP: '1' },
    stdio: ['ignore', 'inherit', 'inherit']
  });

  if (result.error) {
    writeAllSync(2, `pi-inspect: failed to run synthetic dump turn: ${result.error.message}\n`);
    process.exit(1);
  }

  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }

  process.exit(0);
}

/**
 * Writes all bytes of `data` to the given file descriptor, looping on partial
 * writes and retrying on transient `EAGAIN`/`EWOULDBLOCK` errors.
 *
 * `fs.writeSync()` does not guarantee that all bytes are written in a single
 * call (particularly when writing to a pipe). Ignoring the return value — as
 * the original code did — caused output to be silently truncated at ~8 KB.
 */
export function writeAllSync(fd: number, data: string | Buffer): void {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  let offset = 0;

  while (offset < buffer.length) {
    let written: number;

    try {
      written = writeSync(fd, buffer, offset, buffer.length - offset);
    } catch (error) {
      if (isRetryableWriteError(error)) continue;
      throw error;
    }

    if (written <= 0) {
      throw new Error(`writeSync wrote ${written} bytes`);
    }

    offset += written;
  }
}

/** Returns true for errors that indicate a non-blocking fd temporarily cannot accept writes. */
function isRetryableWriteError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'EAGAIN' || error.code === 'EWOULDBLOCK')
  );
}

/**
 * Returns the argv for the synthetic child: the user's args plus `-p dump`, and
 * `--no-session` unless a session was selected. Anything from a bare `--`
 * onwards is dropped; it is empty here because positional prompts never reach
 * this point, and appended flags after `--` would be read as messages.
 */
export function buildSyntheticArgs(argv: string[], args: Args): string[] {
  const separator = argv.indexOf('--');
  const userArgs = separator === -1 ? argv : argv.slice(0, separator);
  const selectsSession = args.continue || args.resume || args.session || args.fork;
  const noSession = selectsSession || args.noSession ? [] : ['--no-session'];
  return [...userArgs, ...noSession, '-p', 'dump'];
}

/**
 * Returns true when a dump flag was passed but Pi would not run a turn on its
 * own, so the extension must spawn the synthetic `-p dump` child.
 *
 * Parsing is delegated to Pi's `parseArgs`, so flag values (`--thinking high`)
 * and the way Pi's parser swallows a word after a boolean flag
 * (`--dump-tools hello`) are classified exactly as Pi does. Boolean extension
 * flags are on whenever present, whatever value follows (`--dump-tools=false`).
 *
 * Exported for unit testing. `stdinIsTTY` defaults to `process.stdin.isTTY`.
 */
export function needsSyntheticTurn(args: Args, stdinIsTTY = process.stdin.isTTY): boolean {
  if (!args.unknownFlags.has('dump-system-prompt') && !args.unknownFlags.has('dump-tools')) {
    return false;
  }

  // Pi handles these itself and exits (or runs a real turn) without our help.
  // RPC mode ignores `-p`, so a synthetic child would never run a turn; the dump
  // happens on the first prompt sent over RPC instead.
  if (
    args.help ||
    args.version ||
    args.export !== undefined ||
    args.listModels !== undefined ||
    args.mode === 'rpc'
  ) {
    return false;
  }

  const hasPrompt = args.messages.length > 0 || args.fileArgs.length > 0;
  const hasPipedPrompt = args.print === true && !stdinIsTTY;
  return !hasPrompt && !hasPipedPrompt;
}
