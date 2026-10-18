import { randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Usage } from '@earendil-works/pi-ai';
import type { Harness } from '@earendil-works/pi-durable';
import { hasUsage, subtractUsage, sumUsageState } from '../shared/usage.js';
import { usageWasDelivered, type WorkflowUsageReceipt } from './billing.js';
import { type StoredUsage, WorkflowBillingDoc } from './docs.js';

const context = BACKGROUND_CONTEXT;
export type UsageDestination = { sessionFile: string; toolCallId: string };
export type UsageOffer = { usage: Usage; receipt?: WorkflowUsageReceipt };

/** Commit an offer, not a claim. Reconcile the previous destination before offering again. */
export async function offerUsage(
  harness: Harness,
  runId: string,
  destination: UsageDestination | undefined
): Promise<UsageOffer> {
  await reconcileUsage(harness);
  const total = sumUsageState(await harness.usage(context));
  let usage = subtractUsage(total, {});
  let receipt: WorkflowUsageReceipt | undefined;
  await harness.commit(async (tx) => {
    const billing = await tx.doc(WorkflowBillingDoc);
    usage = subtractUsage(total, billing.reported);
    if (!hasUsage(usage)) return;
    receipt = { id: randomUUID(), runId };
    billing.pending = {
      ...receipt,
      usage: structuredClone(usage) as StoredUsage,
      total: structuredClone(total) as StoredUsage,
      ...destination
    };
  }, context);
  return { usage, ...(receipt ? { receipt } : {}) };
}

export async function reconcileUsage(harness: Harness): Promise<void> {
  const billing = await harness.snapshot(WorkflowBillingDoc, context);
  if (billing?.pending && (await usageWasDelivered(billing.pending))) {
    await acknowledgeUsage(harness, billing.pending.id);
  }
}

/** Call only after the receipt/usage has been durably recorded by the embedding host. */
export async function acknowledgeUsage(harness: Harness, receiptId: string): Promise<void> {
  await harness.commit(async (tx) => {
    const billing = await tx.doc(WorkflowBillingDoc);
    if (billing.pending?.id !== receiptId) return;
    // Documents are Chord draft proxies, not structured-cloneable host objects.
    billing.reported = { ...billing.pending.total, cost: { ...billing.pending.total.cost } };
    delete billing.pending;
  }, context);
}
