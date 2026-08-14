import { type ChildProcess, spawn } from 'node:child_process';
import process from 'node:process';
import type { InhibitorCommand } from './inhibitors.js';

const FORCE_KILL_DELAY_MS = 2_000;

export type ProcessStarter = (
  command: InhibitorCommand,
  onError: (error: Error) => void,
  onExit: (description: string) => void
) => ChildProcess;

export const startInhibitorProcess: ProcessStarter = (command, onError, onExit) => {
  const child = spawn(command.executable, command.args, {
    detached: false,
    stdio: [command.releaseOnStdinClose ? 'pipe' : 'ignore', 'ignore', 'ignore']
  });
  child.once('error', onError);
  child.once('exit', (code, signal) => onExit(exitDescription(code, signal)));
  return child;
};

export function stopInhibitorProcess(
  child: ChildProcess,
  command: InhibitorCommand | undefined
): void {
  if (child.exitCode !== null || child.signalCode !== null) return;

  const consumeError = (): void => undefined;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const cleanup = (): void => {
    if (escalation) clearTimeout(escalation);
    child.removeListener('error', consumeError);
    child.removeListener('exit', cleanup);
  };
  child.once('error', consumeError);
  child.once('exit', cleanup);

  const stdin = child.stdin;
  const releaseOnStdinClose = command?.releaseOnStdinClose && stdin && !stdin.destroyed;
  if (releaseOnStdinClose) stdin.end();

  escalation = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, FORCE_KILL_DELAY_MS);
  escalation.unref();

  if (!releaseOnStdinClose) {
    if (process.platform === 'win32') child.kill();
    else child.kill('SIGTERM');
  }
}

export function exitDescription(code: number | null, signal: NodeJS.Signals | null): string {
  return signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
}
