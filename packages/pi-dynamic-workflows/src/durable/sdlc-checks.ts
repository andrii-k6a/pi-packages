import type { Context } from '@earendil-works/chord';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import type { SdlcCheck } from '../workflow/sdlc/contracts.js';
import type { SdlcCheckResult } from './sdlc-state.js';

export function observedTestCount(output: string): number | undefined {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI SGR color sequences from check output.
  const clean = output.replace(/\x1b\[[0-9;]*m/g, '');
  const patterns = [
    /(?:^|\n)\s*# tests (\d+)\b/,
    /\bTests\s+(\d+)\s+passed\b/,
    /\b(\d+) passing\b/,
    /\bRan (\d+) tests?\b/,
    /\btests?\s*:\s*(\d+) passed\b/i,
    /"numTotalTests"\s*:\s*(\d+)/
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(clean);
    if (match) return Number(match[1]);
  }
  if (/\b(?:no tests? (?:found|files found)|0 tests?)\b/i.test(clean)) return 0;
  return undefined;
}

/** Only configured/discovered commands. No shell strings, local fallback, or agent-proposed argv. */
export async function runSdlcCheck(options: {
  id: string;
  check: SdlcCheck;
  env: ExecutionEnv;
  candidateRevision: string;
  timeoutMs: number;
  now(): number;
  context: Context;
}): Promise<SdlcCheckResult> {
  const { id, check, env, candidateRevision, context } = options;
  const startedAt = options.now();
  let output = '';
  let truncated = false;
  const base = {
    id,
    command: check,
    cwd: env.cwd,
    environment: env.id,
    candidateRevision,
    startedAt,
    endedAt: startedAt,
    output,
    truncated
  };
  try {
    const executed = await env.exec(
      check.argv,
      {
        cwd: env.cwd,
        timeout: options.timeoutMs / 1000,
        onOutput(chunk) {
          if (output.length + chunk.length > 50_000) truncated = true;
          output = (output + chunk).slice(0, 50_000);
        }
      },
      context
    );
    if (!executed.ok)
      return {
        ...base,
        endedAt: options.now(),
        output,
        truncated,
        status: executed.error.code === 'aborted' ? 'interrupted' : 'unavailable',
        error: executed.error.message
      };
    const testCount = check.kind === 'test' ? observedTestCount(output) : undefined;
    return {
      ...base,
      endedAt: options.now(),
      output,
      truncated,
      exitCode: executed.value.exitCode,
      ...(testCount === undefined ? {} : { testCount }),
      status:
        executed.value.exitCode !== 0
          ? 'failed'
          : check.kind !== 'test'
            ? 'passed'
            : testCount === 0
              ? 'empty'
              : testCount === undefined
                ? 'unknown'
                : 'passed'
    };
  } catch (error) {
    return {
      ...base,
      endedAt: options.now(),
      output,
      truncated,
      status: 'unavailable',
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/** Repository-local configuration is evidence of an available check, not evidence that it passed. */
export async function discoverSdlcChecks(
  env: ExecutionEnv,
  context: Context
): Promise<SdlcCheck[]> {
  const path = await env.absolutePath('package.json', context);
  if (!path.ok) return [];
  const reader = await env.openBinaryReader(path.value, { noFollow: true }, context);
  if (!reader.ok) return [];
  try {
    const info = await reader.value.info(context);
    if (!info.ok || info.value.size > 100_000) return [];
    const bytes = await reader.value.read(0, 100_001, context);
    if (!bytes.ok) return [];
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.value));
    const script = value.scripts?.test;
    if (typeof script !== 'string' || !script.trim() || /no test specified/i.test(script))
      return [];
    const argv = [
      'npm',
      'test',
      ...(script.includes('vitest')
        ? ['--', '--run']
        : script.includes('jest')
          ? ['--', '--runInBand', '--watch=false']
          : [])
    ];
    return [{ id: 'repository-tests', argv, kind: 'test', outcomes: ['goal'] }];
  } catch {
    return [];
  } finally {
    await reader.value.close(context);
  }
}
