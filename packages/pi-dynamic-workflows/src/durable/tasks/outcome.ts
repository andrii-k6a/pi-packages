import type { TaskOutcome } from '@earendil-works/pi-durable';

/** Task outcomes remain authoritative when a fault bypasses document writes. */
export function outcomeMessage(outcome: TaskOutcome<unknown>): string {
  switch (outcome.status) {
    case 'failed':
    case 'faulted':
      return outcome.error.message;
    case 'aborted':
      return outcome.reason ?? 'aborted';
    case 'orphaned':
      return outcome.reason;
    default:
      return outcome.status;
  }
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? 'unknown error');
}
