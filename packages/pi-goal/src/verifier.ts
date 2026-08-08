import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { Clock } from './ids.js';
import { estimateTokensFromText, PiJsonlCollector, parseFinalVerifierReport } from './jsonl.js';
import { sanitizeText, TEXT_LIMITS } from './sanitize.js';
import type { CompletionClaim, GoalState, VerificationReport } from './state.js';
import { remainingActiveTimeMs } from './state.js';
import { buildVerifierTask, VERIFIER_SYSTEM_PROMPT } from './verifier-prompt.js';

const VERIFIER_TOOLS = 'read,grep,find,ls';
const KILL_GRACE_MS = 5000;
const MAX_STDERR_CHARS = 8000;

export interface SourceModelInfo {
  cliModel: string;
  provider: string;
  model: string;
  thinking: ThinkingLevel;
}

export interface VerifierRunInput {
  state: GoalState;
  claim: CompletionClaim;
  launchLeafId: string | null;
  cwd: string;
  source: SourceModelInfo;
  remainingTimeMs: number;
  signal: AbortSignal;
  clock: Clock;
}

export type VerifierRunResult =
  | { ok: true; report: VerificationReport; usageTokens: number; diagnostics: string[] }
  | {
      ok: false;
      reason: string;
      usageTokens: number;
      diagnostics: string[];
      invalidated?: boolean;
    };

export interface VerifierTempFiles {
  dir: string;
  systemPromptPath: string;
  taskPath: string;
}

export interface VerifierInvocation {
  command: string;
  args: string[];
}

export interface SpawnedProcess {
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
  killed: boolean;
}

export type SpawnProcess = (
  command: string,
  args: string[],
  options: { cwd: string; shell: false; stdio: ['ignore', 'pipe', 'pipe'] }
) => SpawnedProcess;

export function resolveSourceModel(
  model: { provider?: unknown; id?: unknown } | undefined,
  thinking: ThinkingLevel | undefined
): SourceModelInfo | undefined {
  if (!model || typeof model.provider !== 'string' || typeof model.id !== 'string')
    return undefined;
  if (!thinking) return undefined;
  return {
    cliModel: `${model.provider}/${model.id}`,
    provider: model.provider,
    model: model.id,
    thinking
  };
}

export function buildVerifierArgs(input: {
  source: SourceModelInfo;
  systemPromptPath: string;
  taskPath: string;
}): string[] {
  return [
    '--mode',
    'json',
    '-p',
    '--model',
    input.source.cliModel,
    '--thinking',
    input.source.thinking,
    '--no-session',
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--no-context-files',
    '--no-approve',
    '--tools',
    VERIFIER_TOOLS,
    '--append-system-prompt',
    input.systemPromptPath,
    `@${input.taskPath}`
  ];
}

export async function createVerifierTempFiles(input: {
  state: GoalState;
  claim: CompletionClaim;
  launchLeafId: string | null;
  cwd: string;
}): Promise<VerifierTempFiles> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-goal-verifier-'));
  const systemPromptPath = join(dir, 'verifier-system.md');
  const taskPath = join(dir, 'verifier-task.md');

  await writeFile(systemPromptPath, VERIFIER_SYSTEM_PROMPT, { encoding: 'utf8', mode: 0o600 });
  await writeFile(taskPath, buildVerifierTask(input), { encoding: 'utf8', mode: 0o600 });

  return { dir, systemPromptPath, taskPath };
}

export async function verifierTempFileModes(files: VerifierTempFiles): Promise<number[]> {
  const system = await stat(files.systemPromptPath);
  const task = await stat(files.taskPath);
  return [system.mode & 0o777, task.mode & 0o777];
}

export async function cleanupVerifierTempFiles(
  files: VerifierTempFiles | undefined
): Promise<void> {
  if (!files) return;
  await rm(files.dir, { recursive: true, force: true });
}

export function getPiInvocation(args: string[]): VerifierInvocation {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith('/$bunfs/root/');
  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) return { command: process.execPath, args };

  return { command: 'pi', args };
}

export async function runVerifierSubprocess(
  input: VerifierRunInput,
  spawnProcess: SpawnProcess = spawn as unknown as SpawnProcess
): Promise<VerifierRunResult> {
  if (input.remainingTimeMs <= 0) {
    return {
      ok: false,
      reason: 'time budget exhausted before verifier launch',
      usageTokens: 0,
      diagnostics: []
    };
  }

  let tempFiles: VerifierTempFiles | undefined;
  try {
    tempFiles = await createVerifierTempFiles(input);
    const args = buildVerifierArgs({
      source: input.source,
      systemPromptPath: tempFiles.systemPromptPath,
      taskPath: tempFiles.taskPath
    });
    const invocation = getPiInvocation(args);
    const collector = new PiJsonlCollector();
    let stderr = '';
    let closed = false;
    let invalidated = input.signal.aborted;
    let killTimer: NodeJS.Timeout | undefined;
    let timeBudgetTimer: NodeJS.Timeout | undefined;

    const exitCode = await new Promise<number>((resolve) => {
      let proc: SpawnedProcess;
      try {
        proc = spawnProcess(invocation.command, invocation.args, {
          cwd: input.cwd,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe']
        });
      } catch (error) {
        stderr = error instanceof Error ? error.message : String(error);
        resolve(1);
        return;
      }

      const terminate = (expectedInvalidation: boolean) => {
        if (closed) return;
        invalidated = invalidated || expectedInvalidation;
        proc.kill('SIGTERM');
        killTimer = setTimeout(() => {
          if (!closed) proc.kill('SIGKILL');
        }, KILL_GRACE_MS);
      };

      const onAbort = () => terminate(true);
      if (input.signal.aborted) onAbort();
      else input.signal.addEventListener('abort', onAbort, { once: true });

      timeBudgetTimer = setTimeout(() => terminate(false), input.remainingTimeMs);

      proc.stdout.on('data', (chunk) => collector.write(chunk));
      proc.stderr.on('data', (chunk) => {
        stderr = boundedAppend(stderr, chunk.toString(), MAX_STDERR_CHARS);
      });
      proc.on('error', (error) => {
        stderr = boundedAppend(stderr, error.message, MAX_STDERR_CHARS);
      });
      proc.on('close', (code) => {
        closed = true;
        input.signal.removeEventListener('abort', onAbort);
        if (killTimer) clearTimeout(killTimer);
        if (timeBudgetTimer) clearTimeout(timeBudgetTimer);
        resolve(code ?? 0);
      });
    });

    const collected = collector.finish();
    const parsed = parseFinalVerifierReport(collected, {
      exitCode,
      stderr,
      requestedProvider: input.source.provider,
      requestedModel: input.source.model,
      createdAt: input.clock.nowIso(),
      invalidated
    });
    if (parsed.usageTokens > 0 && !collected.usageEstimated) return parsed;
    return {
      ...parsed,
      usageTokens:
        parsed.usageTokens +
        estimateTokensFromText(VERIFIER_SYSTEM_PROMPT) +
        estimateTokensFromText(buildVerifierTask(input))
    };
  } finally {
    await cleanupVerifierTempFiles(tempFiles);
  }
}

export function remainingVerifierTime(state: GoalState, clock: Clock): number {
  return remainingActiveTimeMs(state, clock);
}

export function verificationErrorMessage(reason: string, diagnostics: string[]): string {
  const details = diagnostics.length > 0 ? `: ${diagnostics.join('; ')}` : '';
  return sanitizeText(`verification_error: ${reason}${details}`, {
    maxLength: TEXT_LIMITS.reason,
    allowNewlines: false,
    collapseWhitespace: true
  });
}

function boundedAppend(current: string, chunk: string, maxChars: number): string {
  const combined = `${current}${chunk}`;
  if (combined.length <= maxChars) return combined;
  return `${combined.slice(0, maxChars)}… [truncated]`;
}

export function castChildProcess(proc: ChildProcessWithoutNullStreams): SpawnedProcess {
  return proc as unknown as SpawnedProcess;
}
