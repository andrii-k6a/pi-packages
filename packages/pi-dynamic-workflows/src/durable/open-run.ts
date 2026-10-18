import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Usage } from '@earendil-works/pi-ai';
import type { createRegistry, Extension, Harness, LiveState } from '@earendil-works/pi-durable';
import type { WorkflowSnapshot } from '../workflow/snapshot.js';
import type { WorkflowProviderLease } from './providers.js';
import type { WorkflowTasks } from './tasks/factory.js';
import type { UsageDestination, UsageOffer } from './usage-delivery.js';

const context = BACKGROUND_CONTEXT;
/** Minimum pause between listing-cache writes triggered by commits. */
const INDEX_THROTTLE_MS = 150;

/** Host-provided extensions of one open run, shared with its task services. */
export type RunExtras = {
  extensions: Map<string, Extension>;
  notes: string[];
  leases: WorkflowProviderLease[];
};

/** What a snapshot learned about one subagent conversation. */
export type LiveEntry = { state?: LiveState; usage?: Usage };

export type OpenRun = {
  runId: string;
  harness: Harness;
  registry: ReturnType<typeof createRegistry>;
  extras: RunExtras;
  tasks: WorkflowTasks;
  closed: Promise<void>;
  isClosed(): boolean;
  sessionClosing: boolean;
  lastSnapshot?: WorkflowSnapshot;
  /** Live reads of finished agents, by conversation, so polling does not repeat them. */
  liveCache: Map<number, { entry: LiveEntry; readAt: number }>;
  usageDelivery?: UsageDestination;
  offer?: Promise<UsageOffer>;
  close(discard?: boolean): Promise<void>;
};

type OpenRunResources = Pick<
  OpenRun,
  'runId' | 'harness' | 'registry' | 'extras' | 'tasks' | 'usageDelivery'
>;
type OwnershipCallbacks = {
  writeIndex(open: OpenRun): Promise<void>;
  report(error: unknown): void;
  /** Remove from the host's open-run map (only if it still owns this exact object). */
  forget(open: OpenRun): void;
  discard(): void;
  release(): void;
};

/**
 * Own the Session, provider leases, index subscription, and OS lease as one lifetime. Closing
 * never aborts work. Providers outlive every invocation; discard happens before releasing the
 * OS lease, so another opener cannot race cleanup. Storage failure joins Durable before release.
 */
export function ownOpenRun(resources: OpenRunResources, callbacks: OwnershipCallbacks): OpenRun {
  let isClosed = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let closing: Promise<void> | undefined;
  const open: OpenRun = {
    ...resources,
    closed,
    liveCache: new Map(),
    isClosed: () => isClosed,
    sessionClosing: false,
    close: (discard = false) => {
      unsubscribe();
      if (indexTimer) clearTimeout(indexTimer);
      closing ??= (async () => {
        isClosed = true;
        resolveClosed();
        try {
          if (!open.sessionClosing) await callbacks.writeIndex(open).catch(() => {});
          await open.harness.close(context);
        } finally {
          // Providers' resources outlive in-flight tool calls, so they are released last.
          await Promise.allSettled(open.extras.leases.map((lease) => lease.close()));
          callbacks.forget(open);
          try {
            if (discard) callbacks.discard();
          } finally {
            callbacks.release();
          }
        }
      })().finally(unsubscribeClose);
      return closing;
    }
  };
  // Refresh the listing cache after commits, not just polling, so abrupt death retains progress.
  let indexTimer: ReturnType<typeof setTimeout> | undefined;
  const unsubscribe = open.harness.subscribeCommits(() => {
    if (indexTimer || isClosed) return;
    indexTimer = setTimeout(() => {
      indexTimer = undefined;
      if (!isClosed) callbacks.writeIndex(open).catch(callbacks.report);
    }, INDEX_THROTTLE_MS);
    indexTimer.unref?.();
  });
  const unsubscribeClose = open.harness.subscribeClose(() => {
    // This callback runs on the Session line: capture only, never call Session APIs here.
    open.sessionClosing = true;
  });
  // Durable 1.2 joins every invocation before resolving closed, even without an awaiting caller.
  void open.harness.closed
    .then(async (end) => {
      if (end.reason === 'failed') await open.close();
    })
    .catch(callbacks.report);
  return open;
}
