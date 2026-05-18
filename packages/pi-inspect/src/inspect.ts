import { spawnSync } from 'node:child_process';
import { writeSync } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/**
 * Adds `--dump-system-prompt` and `--dump-tools` to Pi.
 *
 * Both flags share the same two execution paths:
 *
 * 1. **No-prompt path** (`pi --dump-system-prompt` / `pi --dump-tools`): detected
 *    at extension-setup time, before Pi starts its interactive TUI. A synthetic
 *    child process is spawned with `-p dump` so turn-scoped hooks (e.g.
 *    `before_agent_start`) run normally. The parent exits immediately; the TUI
 *    never initialises.
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
    description: 'Print all registered tools with descriptions and exit before calling the model',
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

  if (
    (hasDumpSystemPromptFlag() || hasDumpToolsFlag()) &&
    !hasInitialPrompt() &&
    process.env.PI_INSPECT_SYNTHETIC_DUMP !== '1'
  ) {
    runSyntheticDumpTurn();
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
 * and its description.
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
      lines.push(`  ${tool.description}`);
    }
  };

  for (const tool of active) appendTool(tool);

  if (inactive.length > 0) {
    lines.push('');
    lines.push('--- inactive ---');
    for (const tool of inactive) appendTool(tool);
  }

  return lines.join('\n');
}

/**
 * Spawns a synthetic `-p dump` child process so Pi assembles a full turn
 * context (including `before_agent_start` hooks) without the parent ever
 * entering interactive TUI mode.
 *
 * The child is guarded by `PI_INSPECT_SYNTHETIC_DUMP=1` to prevent
 * recursive spawning. stdout/stderr are inherited so the child writes directly
 * to the caller's file descriptors — no parent-side buffering needed.
 */
function runSyntheticDumpTurn(): never {
  const childArgs = [process.argv[1], ...process.argv.slice(2), '-p', 'dump'];
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
 * Returns true if `--dump-system-prompt` (or `--dump-system-prompt=true`) is
 * present in `process.argv`. Used at extension-setup time when `pi.getFlag()`
 * is not yet populated.
 */
function hasDumpSystemPromptFlag(): boolean {
  return process.argv.slice(2).some((arg) => {
    if (arg === '--dump-system-prompt') return true;
    if (arg.startsWith('--dump-system-prompt=')) return arg !== '--dump-system-prompt=false';
    return false;
  });
}

/**
 * Returns true if `--dump-tools` (or `--dump-tools=true`) is present in
 * `process.argv`. Used at extension-setup time when `pi.getFlag()` is not yet
 * populated.
 */
function hasDumpToolsFlag(): boolean {
  return process.argv.slice(2).some((arg) => {
    if (arg === '--dump-tools') return true;
    if (arg.startsWith('--dump-tools=')) return arg !== '--dump-tools=false';
    return false;
  });
}

/**
 * Returns true if `args` contains a user-supplied prompt (positional text,
 * `@file`, `-p`/`--print` with piped stdin) that would cause Pi to start a
 * real agent turn without the synthetic child.
 *
 * Exported for unit testing. Defaults to `process.argv.slice(2)` and
 * `process.stdin.isTTY` so runtime callers need no arguments.
 */
export function hasInitialPrompt(
  args = process.argv.slice(2),
  stdinIsTTY = process.stdin.isTTY
): boolean {
  const flagsWithRequiredValue = new Set([
    '--provider',
    '--model',
    '--api-key',
    '--system-prompt',
    '--append-system-prompt',
    '--mode',
    '--session',
    '--fork',
    '--session-dir',
    '--models',
    '--tools',
    '-t',
    '--extension',
    '-e',
    '--skill',
    '--prompt-template',
    '--theme',
    '--export'
  ]);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--dump-system-prompt') continue;
    if (arg === '--dump-tools') continue;
    if ((arg === '--print' || arg === '-p') && !stdinIsTTY) return true;
    if (arg.startsWith('@')) return true;

    if (arg === '--list-models') {
      // Optional search arg; either way Pi exits before a prompt would run.
      return true;
    }

    if (flagsWithRequiredValue.has(arg)) {
      i++;
      continue;
    }

    if (arg.startsWith('--') && arg.includes('=')) continue;
    if (arg.startsWith('-')) continue;

    return true;
  }

  return false;
}
