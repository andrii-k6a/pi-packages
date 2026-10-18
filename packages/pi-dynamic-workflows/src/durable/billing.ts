import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { WorkflowUsageDelivery } from './docs.js';

/** Included in the parent tool result alongside its usage; the JSONL entry is the delivery receipt. */
export type WorkflowUsageReceipt = { runId: string; id: string };

/**
 * Read raw history, not the active branch: spend on abandoned branches was still delivered.
 * Never infer delivery from message_end (Pi persists the message only AFTER that event).
 * A missing/unreadable parent file fails closed; it may have been deleted after delivery.
 */
export async function usageWasDelivered(delivery: WorkflowUsageDelivery): Promise<boolean> {
  if (!delivery.sessionFile) return false;
  const stream = createReadStream(delivery.sessionFile, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let malformed = false;
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      if (malformed) throw new Error('invalid JSONL before the end of the file');
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        // A process may have died during its final append. Ignore only a torn final line.
        malformed = true;
        continue;
      }
      if (isDeliveryEntry(entry, delivery)) return true;
    }
    return false;
  } catch (error) {
    throw new Error(
      `Cannot reconcile workflow usage receipt ${delivery.id}: parent session ${delivery.sessionFile} is unavailable or invalid. Restore it before resuming, or explicitly acknowledge the receipt if its usage was recorded.`,
      { cause: error }
    );
  } finally {
    lines.close();
    stream.destroy();
  }
}

function isDeliveryEntry(entry: unknown, delivery: WorkflowUsageDelivery): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const value = entry as {
    type?: string;
    message?: {
      role?: string;
      toolName?: string;
      toolCallId?: string;
      details?: { usageReceipt?: WorkflowUsageReceipt };
      usage?: { totalTokens?: number; cost?: { total?: number } };
    };
  };
  const message = value.message;
  const receipt = message?.details?.usageReceipt;
  return (
    value.type === 'message' &&
    message?.role === 'toolResult' &&
    message.toolName === 'workflow' &&
    receipt?.id === delivery.id &&
    receipt.runId === delivery.runId &&
    (delivery.toolCallId === undefined || message.toolCallId === delivery.toolCallId) &&
    // Redacting usage while retaining details must not silently acknowledge unpaid accounting.
    (message.usage?.totalTokens ?? 0) >= delivery.usage.totalTokens &&
    (message.usage?.cost?.total ?? 0) >= delivery.usage.cost.total
  );
}
