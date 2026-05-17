import { existsSync, rmSync } from 'node:fs';
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  SessionManager
} from '@earendil-works/pi-coding-agent';
import { type Direction, directionConfig, directions, loadConfig } from './config.js';

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function getTemporaryExtensionCliArgs(argv = process.argv): string[] {
  const extensionArgs: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '-e' || arg === '--extension') {
      const spec = argv[i + 1];
      if (spec) {
        extensionArgs.push(arg, spec);
        i++;
      }
      continue;
    }

    if (arg.startsWith('--extension=')) {
      extensionArgs.push(arg);
    }
  }

  return extensionArgs;
}

function piCommand(extraArgs: string[] = []): string {
  const piArgs = [...getTemporaryExtensionCliArgs(), ...extraArgs];

  return ['pi', ...piArgs.map(shellQuote)].join(' ');
}

function tmuxSplitArgs(direction: Direction, cwd: string, piArgs: string[] = []): string[] {
  const config = directionConfig[direction];
  const args: string[] = ['split-window', config.splitFlag];

  if (config.before) {
    args.push('-b');
  }

  args.push('-c', cwd, piCommand(piArgs));
  return args;
}

function branchDescription(direction: Direction): string {
  return `Branch the current Pi session into a new tmux pane ${directionConfig[direction].description}`;
}

async function openFreshPane(
  pi: ExtensionAPI,
  direction: Direction,
  ctx: ExtensionContext,
  piArgs: string[] = []
): Promise<void> {
  const result = await pi.exec('tmux', tmuxSplitArgs(direction, ctx.cwd, piArgs));

  if (result.code !== 0) {
    const reason = result.stderr.trim() || `tmux split failed with exit code ${result.code}`;
    ctx.ui.notify(`Failed to open tmux pane: ${reason}`, 'error');
    return;
  }
}

async function branchIntoPaneNow(
  pi: ExtensionAPI,
  direction: Direction,
  ctx: ExtensionContext
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify('Branch panes require the interactive Pi UI', 'error');
    return;
  }

  if (!process.env.TMUX) {
    ctx.ui.notify('Branch panes require tmux', 'error');
    return;
  }

  const currentSessionFile = ctx.sessionManager.getSessionFile();
  const sessionDir = ctx.sessionManager.getSessionDir();
  const leafId = ctx.sessionManager.getLeafId();

  if (!currentSessionFile) {
    if (!process.argv.includes('--no-session')) {
      ctx.ui.notify('No saved Pi session to branch', 'error');
      return;
    }

    await openFreshPane(pi, direction, ctx, ['--no-session']);
    return;
  }

  if (!leafId || !existsSync(currentSessionFile)) {
    await openFreshPane(pi, direction, ctx);
    return;
  }

  // Create a branched session file directly instead of ctx.fork(), because ctx.fork() would replace the current runtime/pane.
  // This bypasses Pi's normal fork lifecycle in the original pane, so session_before_fork,
  // session_shutdown, and session_start hooks are not emitted there.
  let branchedSessionFile: string | undefined;
  try {
    const sessionManager = SessionManager.open(currentSessionFile, sessionDir);
    branchedSessionFile = sessionManager.createBranchedSession(leafId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Failed to branch Pi session: ${message}`, 'error');
    return;
  }

  if (!branchedSessionFile) {
    ctx.ui.notify('No branch session was created', 'error');
    return;
  }

  const result = await pi.exec(
    'tmux',
    tmuxSplitArgs(direction, ctx.cwd, ['--session', branchedSessionFile])
  );
  if (result.code !== 0) {
    const reason = result.stderr.trim() || `tmux split failed with exit code ${result.code}`;

    try {
      if (existsSync(branchedSessionFile)) {
        rmSync(branchedSessionFile);
      }
    } catch (error) {
      const cleanupReason = error instanceof Error ? error.message : String(error);
      console.warn(
        `[pi-tmux-branch] Failed to remove unused branch session ${branchedSessionFile}: ${cleanupReason}`
      );
    }

    ctx.ui.notify(`Failed to open tmux pane: ${reason}`, 'error');
    return;
  }

  ctx.ui.notify(
    `Branched Pi session into a tmux pane ${directionConfig[direction].description}`,
    'info'
  );
}

async function branchIntoPaneFromCommand(
  pi: ExtensionAPI,
  direction: Direction,
  ctx: ExtensionCommandContext
): Promise<void> {
  await ctx.waitForIdle();
  await branchIntoPaneNow(pi, direction, ctx);
}

async function branchIntoPaneFromShortcut(
  pi: ExtensionAPI,
  direction: Direction,
  ctx: ExtensionContext
): Promise<void> {
  if (!ctx.isIdle()) {
    ctx.ui.notify('Pi is busy; wait for idle before branching', 'error');
    return;
  }

  await branchIntoPaneNow(pi, direction, ctx);
}

export default function (pi: ExtensionAPI): void {
  for (const direction of directions) {
    pi.registerCommand(`tmux-branch-${direction}`, {
      description: branchDescription(direction),
      handler: async (_args, ctx) => branchIntoPaneFromCommand(pi, direction, ctx)
    });
  }

  const config = loadConfig();
  for (const direction of directions) {
    const shortcut = config.shortcuts[direction];
    if (!shortcut) {
      continue;
    }

    pi.registerShortcut(shortcut, {
      description: branchDescription(direction),
      handler: async (ctx) => branchIntoPaneFromShortcut(pi, direction, ctx)
    });
  }
}
