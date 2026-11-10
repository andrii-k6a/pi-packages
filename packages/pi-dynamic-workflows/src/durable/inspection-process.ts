import type { Context } from '@earendil-works/chord';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';

/** Direct argv only. Keep bounded output in the host's environment, never a local fallback. */
export async function inspectionProcess(
  env: ExecutionEnv,
  command: readonly string[],
  context: Context,
  options: {
    lines?: { offset: number; limit: number };
    /** Receives raw stdout instead of capturing it. The consumer must bound retained data. */
    onStdout?: (chunk: string) => void;
  } = {}
): Promise<{ stdout: string; stderr: string; exitCode: number; truncated: boolean }> {
  const maxChars = 50_000;
  const { lines, onStdout } = options;
  let stdout = '';
  let stderr = '';
  let line = 1;
  let truncated = false;
  const result = await env.exec(
    command,
    {
      cwd: env.cwd,
      timeout: 10,
      env: { GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0' },
      onOutput(chunk, _context, info) {
        if (info.stream === 'stderr') {
          stderr = (stderr + chunk).slice(0, 4000);
          return;
        }
        if (onStdout) {
          onStdout(chunk);
          return;
        }
        if (!lines) {
          if (stdout.length + chunk.length > maxChars) truncated = true;
          stdout += chunk.slice(0, Math.max(0, maxChars - stdout.length));
          return;
        }
        for (let start = 0; start < chunk.length; ) {
          const newline = chunk.indexOf('\n', start);
          const end = newline === -1 ? chunk.length : newline + 1;
          if (line >= lines.offset && line < lines.offset + lines.limit) {
            const part = chunk.slice(start, end);
            if (stdout.length + part.length > maxChars) truncated = true;
            stdout += part.slice(0, Math.max(0, maxChars - stdout.length));
          } else if (line >= lines.offset + lines.limit) truncated = true;
          if (newline !== -1) line++;
          start = end;
        }
      }
    },
    context
  );
  if (!result.ok) {
    throw new Error(
      `Inspection unavailable in this execution environment: ${result.error.message}`
    );
  }
  return { stdout, stderr, exitCode: result.value.exitCode, truncated };
}
