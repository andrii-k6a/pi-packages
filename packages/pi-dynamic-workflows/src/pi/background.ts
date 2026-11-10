import { randomUUID } from 'node:crypto';
import type {
  CustomMessageEntryDraft,
  ExtensionAPI,
  ExtensionContext
} from '@earendil-works/pi-coding-agent';
import type {
  WorkflowAttemptHandle,
  WorkflowAttemptOutcome,
  WorkflowHost
} from '../durable/host.js';
import { attemptSnapshot } from '../durable/report.js';
import { terminalLine } from '../shared/terminal-text.js';
import { workflowFailureSummary } from '../workflow/diagnostics.js';
import {
  compactSnapshot,
  createWorkflowSnapshot,
  type WorkflowSnapshot
} from '../workflow/snapshot.js';

const BACKGROUND_ENTRY = 'workflow-background';
const READY_MESSAGE = 'workflow-background-ready';

type BackgroundMarker = { runId: string; attempt: number; sessionId: string };
type PendingNotification = CustomMessageEntryDraft & {
  details: {
    deliveryId: string;
    runId?: string;
    attempt?: number;
    status?: WorkflowSnapshot['status'];
  };
};
type BackgroundRun = {
  handle: WorkflowAttemptHandle;
  snapshot: WorkflowSnapshot;
  outcome?: WorkflowAttemptOutcome;
  stopWatching: () => void;
  finished: Promise<void>;
};

/** Session-scoped execution. Durable results and usage remain in the host until collected. */
export class WorkflowBackgroundRuns {
  readonly #runs = new Map<string, BackgroundRun>();
  readonly #pendingNotifications = new Map<
    string,
    { entry: PendingNotification; triggered: boolean }
  >();
  #notificationFlush: ReturnType<typeof setTimeout> | undefined;
  #closed = false;

  constructor(
    private readonly pi: Pick<ExtensionAPI, 'appendEntry' | 'sendMessage'>,
    private readonly host: WorkflowHost
  ) {}

  start(handle: WorkflowAttemptHandle, ctx: ExtensionContext): void {
    if (this.#closed) throw new Error('The workflow session is shutting down');
    const marker: BackgroundMarker = {
      runId: handle.runId,
      attempt: handle.attemptNumber,
      sessionId: ctx.sessionManager.getSessionId()
    };
    // Persist ownership before detaching, including when the initiating tool result is lost.
    this.pi.appendEntry(BACKGROUND_ENTRY, marker);
    const index = this.host.list().find((run) => run.runId === handle.runId);
    const run: BackgroundRun = {
      handle,
      snapshot: {
        ...createWorkflowSnapshot({
          name: index?.name ?? handle.runId,
          description: index?.description ?? ''
        }),
        runId: handle.runId,
        attempt: handle.attemptNumber,
        status: 'running'
      },
      stopWatching: () => {},
      finished: Promise.resolve()
    };
    this.#runs.set(handle.runId, run);
    let lastProgress: string | undefined;
    run.stopWatching = handle.watch((snapshot) => {
      run.snapshot = compactSnapshot(snapshot);
      if (this.#closed || !ctx.hasUI) return;
      const progress = `◆ ${terminalLine(snapshot.name)}: ${snapshot.doneCount}/${snapshot.agentCount} done${snapshot.currentPhase ? ` · ${terminalLine(snapshot.currentPhase)}` : ''} · ${handle.runId}`;
      const lines = [progress, ...(snapshot.errorCount ? workflowFailureSummary(snapshot) : [])];
      const picture = lines.join('\n');
      if (picture === lastProgress) return;
      lastProgress = picture;
      ctx.ui.setWidget(widgetKey(handle.runId), lines);
    });
    run.finished = this.#finish(run, ctx);
  }

  snapshot(runId: string): WorkflowSnapshot | undefined {
    return this.#runs.get(runId)?.snapshot;
  }

  /** A result query never waits for live agents, only for a terminal run's lease to close. */
  async prepareResult(runId: string): Promise<boolean> {
    const run = this.#runs.get(runId);
    if (!run) return true;
    if (!run.outcome) return false;
    await run.finished;
    return true;
  }

  async #finish(run: BackgroundRun, ctx: ExtensionContext): Promise<void> {
    let error: unknown;
    try {
      run.outcome = await run.handle.wait();
      run.snapshot = compactSnapshot(run.outcome.snapshot);
    } catch (cause) {
      error = cause;
    } finally {
      run.stopWatching();
      try {
        // Background wait() offers no parent receipt destination. Do not acknowledge that offer:
        // result retrieval will re-offer the spend to its own persisted workflow tool result.
        await run.handle.close();
      } catch (cause) {
        error ??= cause;
      }
      this.#runs.delete(run.handle.runId);
    }
    if (this.#closed) return;
    if (ctx.hasUI) ctx.ui.setWidget(widgetKey(run.handle.runId), undefined);
    this.#notify(
      ctx,
      run.snapshot,
      error ? String(error) : run.outcome?.status === 'completed' ? undefined : run.outcome?.error
    );
  }

  #notify(ctx: ExtensionContext, snapshot: WorkflowSnapshot, error?: string): void {
    if (this.#closed) return;
    const runId = snapshot.runId;
    const status = error && snapshot.status === 'running' ? 'interrupted' : snapshot.status;
    this.settleNotifications(ctx);
    if (
      [...this.#pendingNotifications.values()].some(
        ({ entry }) =>
          entry.details.runId === runId &&
          entry.details.attempt === snapshot.attempt &&
          entry.details.status === status
      )
    ) {
      this.sendNotifications(ctx);
      return;
    }
    const content = [
      `Background workflow ${terminalLine(snapshot.name)} ${status} (run ${runId}, attempt ${snapshot.attempt}).`,
      status === 'completed'
        ? `Report available: /workflows ${runId} --report. Call workflow with ${JSON.stringify({ result: runId })} to retrieve the result and record its usage. Do not resume or rerun it.`
        : workflowFailureSummary(snapshot, error).join('\n')
    ].join('\n');
    const deliveryId = randomUUID();
    const notification: PendingNotification = {
      type: 'custom_message',
      customType: READY_MESSAGE,
      content,
      display: true,
      details: { deliveryId, runId, attempt: snapshot.attempt, status }
    };
    this.#pendingNotifications.set(deliveryId, { entry: notification, triggered: false });
    this.sendNotifications(ctx);
  }

  sendNotifications(ctx: ExtensionContext): void {
    if (this.#closed) return;
    this.settleNotifications(ctx);
    if ([...this.#pendingNotifications.values()].some((pending) => pending.triggered)) return;
    for (const pending of this.#pendingNotifications.values()) {
      // Esc clears Pi's in-memory follow-up queue. Busy sessions receive a persisted boundary
      // entry instead, and an aborted turn leaves it pending for the next successful turn.
      if (!ctx.isIdle()) return;
      pending.triggered = true;
      try {
        this.pi.sendMessage(pending.entry, { triggerTurn: true, deliverAs: 'followUp' });
        return;
      } catch (cause) {
        pending.triggered = false;
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Workflow ${pending.entry.details.runId} delivery is pending: ${terminalLine(String(cause))}. Use /workflows to inspect it.`,
            'warning'
          );
        }
      }
    }
  }

  /** Proposed entries remain pending until a later event observes them in session history. */
  notificationEntries(ctx: ExtensionContext): CustomMessageEntryDraft[] {
    if (this.#closed) return [];
    this.settleNotifications(ctx);
    // Idle sends can be deferred by Pi while it emits agent_settled. The boundary must not
    // insert an entry that the deferred sender still owns.
    return [...this.#pendingNotifications.values()]
      .filter((pending) => !pending.triggered)
      .map((pending) => pending.entry);
  }

  scheduleNotificationFlush(ctx: ExtensionContext): void {
    if (this.#closed || this.#notificationFlush) return;
    // session_compact runs before Pi clears its busy state, and other handlers can await work.
    // Do not block that event while waiting for Pi to finish compaction.
    this.#notificationFlush = setTimeout(() => {
      this.#notificationFlush = undefined;
      if (this.#closed) return;
      if (ctx.isIdle()) this.sendNotifications(ctx);
      else this.scheduleNotificationFlush(ctx);
    }, 25);
    this.#notificationFlush.unref?.();
  }

  cancelNotificationFlush(): void {
    if (this.#notificationFlush) clearTimeout(this.#notificationFlush);
    this.#notificationFlush = undefined;
  }

  settleNotifications(ctx: ExtensionContext): void {
    if (this.#pendingNotifications.size === 0) return;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === 'custom_message' && entry.customType === READY_MESSAGE) {
        const details = entry.details as { deliveryId?: string } | undefined;
        if (details?.deliveryId) this.#pendingNotifications.delete(details.deliveryId);
      }
    }
  }

  /** Raw history retains ownership and collection records even after compaction or tree changes. */
  async recover(ctx: ExtensionContext): Promise<void> {
    if (ctx.mode === 'print' || ctx.mode === 'json') return;
    const pending = new Map<string, BackgroundMarker>();
    const notices = new Set<string>();
    const sessionId = ctx.sessionManager.getSessionId();
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === 'custom' && entry.customType === BACKGROUND_ENTRY) {
        const marker = entry.data as Partial<BackgroundMarker> | undefined;
        if (
          marker?.sessionId === sessionId &&
          typeof marker.runId === 'string' &&
          Number.isInteger(marker.attempt)
        ) {
          pending.set(marker.runId, marker as BackgroundMarker);
        }
      } else if (entry.type === 'custom_message' && entry.customType === READY_MESSAGE) {
        const details = entry.details as Partial<WorkflowSnapshot> | undefined;
        notices.add(`${details?.runId}/${details?.attempt}/${details?.status}`);
      } else if (
        entry.type === 'message' &&
        entry.message.role === 'toolResult' &&
        entry.message.toolName === 'workflow' &&
        !entry.message.isError
      ) {
        const details = entry.message.details as
          | (WorkflowSnapshot & { resultDelivered?: boolean })
          | undefined;
        const marker = details?.runId ? pending.get(details.runId) : undefined;
        if (marker && details?.resultDelivered && details.attempt === marker.attempt) {
          pending.delete(marker.runId);
        }
      }
    }
    const runs = new Set(this.host.list().map((run) => run.runId));
    for (const marker of pending.values()) {
      if (this.#closed) return;
      if (!runs.has(marker.runId)) continue;
      try {
        const report = await this.host.report(marker.runId);
        const attempt = report.attempts.at(-1);
        if (!attempt || attempt.number !== marker.attempt || this.#closed) continue;
        if (
          report.status !== 'completed' &&
          notices.has(`${marker.runId}/${marker.attempt}/${report.status}`)
        ) {
          continue;
        }
        this.#notify(
          ctx,
          {
            ...attemptSnapshot(report.run, attempt, Date.now()),
            status: report.status
          },
          attempt.error
        );
      } catch (cause) {
        if (!this.#closed && ctx.hasUI) {
          ctx.ui.notify(
            `Cannot recover background workflow ${terminalLine(marker.runId)}: ${terminalLine(String(cause))}`,
            'warning'
          );
        }
      }
    }
  }

  async close(ctx: ExtensionContext): Promise<void> {
    this.#closed = true;
    this.cancelNotificationFlush();
    this.#pendingNotifications.clear();
    const runs = [...this.#runs.values()];
    for (const run of runs) {
      run.stopWatching();
      if (ctx.hasUI) ctx.ui.setWidget(widgetKey(run.handle.runId), undefined);
    }
    await this.host.closeAll();
    await Promise.all(runs.map((run) => run.finished));
  }
}

function widgetKey(runId: string): string {
  return `workflow-background-${runId}`;
}
