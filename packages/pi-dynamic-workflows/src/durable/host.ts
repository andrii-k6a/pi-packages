import { createHash } from 'node:crypto';
import type { JsonValue } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, type Models, type Usage } from '@earendil-works/pi-ai';
import {
  type ConversationView,
  type Cursor,
  createRegistry,
  defineExtension,
  type EntryRecord,
  type Extension,
  Harness,
  type HarnessSettings,
  InboxDoc,
  type InboxState,
  LiveDoc,
  SessionFailed,
  type TaskId,
  type TaskOutcome,
  UsageDoc
} from '@earendil-works/pi-durable';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { WorkflowProfileRoutingError } from '../profiles/contracts.js';
import { optionalJsonArgument } from '../shared/json-values.js';
import { sumUsageState } from '../shared/usage.js';
import { parseWorkflowScript } from '../workflow/parser.js';
import {
  preview,
  type WorkflowRunDisplayStatus,
  type WorkflowSnapshot
} from '../workflow/snapshot.js';
import type { WorkflowUsageReceipt } from './billing.js';
import {
  type StoredUsage,
  WorkflowAttemptDoc,
  type WorkflowAttemptState,
  WorkflowPauseDoc,
  type WorkflowPauseState,
  WorkflowPromptContextDoc,
  type WorkflowPromptContextState,
  type WorkflowRoute,
  WorkflowRunDoc,
  type WorkflowRunState
} from './docs.js';
import { extensionAdmissionError, validateHostExtensions } from './extension-admission.js';
import { type OpenRun, ownOpenRun, type RunExtras } from './open-run.js';
import type { WorkflowExtensionProvider, WorkflowProviderLease } from './providers.js';
import {
  attemptSnapshot,
  type FollowedTranscript,
  followedTranscript,
  queuedSteers,
  runIndex,
  transcriptItems,
  type WorkflowAttemptReport,
  type WorkflowRunReport,
  type WorkflowTranscriptItem
} from './report.js';
import {
  acquireRunLock,
  appendRunReport,
  assertValidRunId,
  createRunId,
  deleteRun,
  listRuns,
  removeRunDirectory,
  runDatabasePath,
  runDirectoryExists,
  runExists,
  runLockOwner,
  type WorkflowRunIndex,
  WorkflowRunLockedError,
  workflowRunsRoot,
  writeRunIndex
} from './store.js';
import { canonicalJson } from './subagent.js';
import { SubagentExtension } from './tasks/agent.js';
import {
  AGENT_TASK_NAME,
  type WorkflowAgentInput,
  type WorkflowAgentTaskResult,
  type WorkflowRunInput,
  type WorkflowRunTaskResult
} from './tasks/contracts.js';
import { createWorkflowTasks } from './tasks/factory.js';
import { outcomeMessage as outcomeError } from './tasks/outcome.js';
import { acknowledgeUsage, offerUsage, reconcileUsage } from './usage-delivery.js';

const context = BACKGROUND_CONTEXT;

/** Default cap on `agent()` calls per attempt: a guard against runaway loops, not a quota. */
export const DEFAULT_MAX_AGENTS = 500;
/** Longest transcript the inspector loads, in entries. */
const MAX_TRANSCRIPT_ENTRIES = 5000;
/** How long `pauseAgent` waits for the agent task to record the pause, in 25 ms steps. */
const PAUSE_SETTLE_STEPS = 120;
/** A finished agent's live state is not read again once it was read this long after it ended. */
const LIVE_SETTLE_MS = 5000;

/** What the caller that starts or resumes a run (the workflow tool call) provides. */
export interface WorkflowRunBinding {
  /** Model access for subagents: the parent's `ModelRuntime` implements pi-ai `Models`. */
  models: Models;
  /** Default subagent route: the parent session's model and thinking level. */
  route?: WorkflowRoute;
  /** Resolve an approved profile; throws `WorkflowProfileRoutingError`. */
  resolveProfile(name: string): WorkflowRoute;
  /** Project context for subagent prompts; captured once, when a run is created. */
  promptContext(cwd: string): Promise<WorkflowPromptContextState>;
  parentSessionFile?: string;
  /** Trust for the run's directory, not the calling session's. Booleans are for single-project hosts. */
  projectTrusted?: boolean | ((cwd: string) => boolean);
  /** Parent tool-result destination, used to reconcile usage delivery across process crashes. */
  usageDelivery?: { sessionFile: string; toolCallId: string };
  /** The workflow tool call's signal: cancelling it stops a run from opening. */
  signal?: AbortSignal;
}

export interface WorkflowHostOptions {
  /** Directory holding one subdirectory per run. Default: under the Pi agent directory. */
  runsRoot?: string;
  /** Harness clock; tests may control it. */
  now?: () => number;
  /** Overrides for Pi Durable run policy (retry, compaction, stream, progress, tool execution). */
  settings?: HarnessSettings;
  /** Execution environment of subagent tools for a working directory. Default: this machine. */
  env?: (cwd: string) => ExecutionEnv;
  /** Runtime reports, including fatal session/storage failures; also saved to `reports.log`. */
  onReport?: (error: unknown) => void;
  /** How often live snapshots are refreshed while watching (default 400 ms). */
  watchIntervalMs?: number;
  /**
   * Pi Durable extensions every subagent selects, in addition to the coding tools. Names must be
   * unique and must not start with `workflow.`. A run stores only the names; the host installs the
   * extensions again whenever it opens the run.
   */
  extensions?: readonly Extension[];
  /** Providers opened for each run that is started or resumed (for example MCP tools). */
  providers?: readonly WorkflowExtensionProvider[];
  /**
   * Most `agent()` calls one attempt may make; later calls reject. A guard against runaway loops.
   * Default 500; `Infinity` removes the limit. Stored with each attempt, so replays agree.
   */
  maxAgents?: number;
}

export interface StartWorkflowOptions {
  script: string;
  args?: unknown;
  cwd: string;
  concurrency?: number;
  /** Soft token limit behind the script's `budget`; see `WorkflowRunOptions.tokenBudget`. */
  tokenBudget?: number;
}

export interface ResumeWorkflowOptions {
  /** Replacement script: a new attempt that reuses identical completed agent calls. */
  script?: string;
  args?: unknown;
  concurrency?: number;
  /** Replaces the run's token budget; a live attempt with another budget is replaced. */
  tokenBudget?: number;
}

export type WorkflowAttemptOutcome =
  | {
      status: 'completed';
      value: JsonValue;
      agentCount: number;
      phases: string[];
      /** Unacknowledged spend. Reading the outcome does NOT mark usage as delivered. */
      unreportedUsage: Usage;
      /** Acknowledge only after durably recording the usage; Pi tool results carry this receipt. */
      usageReceipt?: WorkflowUsageReceipt;
      snapshot: WorkflowSnapshot;
    }
  | {
      status: 'failed' | 'aborted' | 'interrupted';
      error: string;
      snapshot: WorkflowSnapshot;
    };

export interface WorkflowAttemptHandle {
  readonly runId: string;
  readonly attemptId: number;
  readonly attemptNumber: number;
  /** How this attempt came to be: a fresh run, a continued live attempt, or a new attempt. */
  readonly mode: 'started' | 'continued' | 'retried' | 'completed';
  /** Settles when the attempt is terminal, or `interrupted` when its run is closed first. */
  wait(): Promise<WorkflowAttemptOutcome>;
  /** Embedding hosts call this only after durably recording the receipt and its usage. */
  acknowledgeUsage(receiptId: string): Promise<void>;
  /** Abort the attempt (Pi Durable abort protocol: agents first, bottom-up). */
  abort(): Promise<void>;
  /** Live snapshots until stopped. */
  watch(listener: (snapshot: WorkflowSnapshot) => void): () => void;
  /** Close the run's Session and release its lock. Live work stays resumable. */
  close(): Promise<void>;
}

/**
 * Process-side owner of durable workflow runs. Each run is a separate Pi Durable Session over
 * SQLite, held open (and locked) only while a workflow tool call drives it or the inspector reads
 * it. Closing never aborts: unfinished work stays committed and resumes on the next open.
 */
export class WorkflowHost {
  readonly runsRoot: string;
  readonly #options: WorkflowHostOptions;
  readonly #open = new Map<string, OpenRun>();

  constructor(options: WorkflowHostOptions = {}) {
    validateHostExtensions(options.extensions ?? []);
    const { maxAgents } = options;
    if (
      maxAgents !== undefined &&
      !(maxAgents === Infinity || (Number.isInteger(maxAgents) && maxAgents >= 1))
    ) {
      throw new Error('maxAgents must be a positive integer or Infinity');
    }
    this.#options = options;
    this.runsRoot = options.runsRoot ?? workflowRunsRoot();
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }

  #attemptLimits(
    tokenBudget: number | undefined
  ): Pick<WorkflowRunInput, 'tokenBudget' | 'maxAgents'> {
    const maxAgents = this.#options.maxAgents ?? DEFAULT_MAX_AGENTS;
    return {
      ...(tokenBudget === undefined ? {} : { tokenBudget }),
      ...(Number.isFinite(maxAgents) ? { maxAgents } : {})
    };
  }

  /** Runs with listing summaries, newest first. */
  list(): WorkflowRunIndex[] {
    // A run open here is owned by this process; asking the lease about it would only wait.
    return listRuns(this.runsRoot, (runId) => this.#open.has(runId));
  }

  isActive(runId: string): boolean {
    return this.#open.has(runId);
  }

  async start(
    options: StartWorkflowOptions,
    binding: WorkflowRunBinding
  ): Promise<WorkflowAttemptHandle> {
    const { meta } = parseWorkflowScript(options.script);
    const createdAt = this.#now();
    // The id has 16 random bits; never reuse a directory that already holds a run.
    let runId = createRunId(meta.name, createdAt);
    for (let tries = 0; tries < 16 && runDirectoryExists(this.runsRoot, runId); tries++) {
      runId = createRunId(meta.name, createdAt);
    }
    if (runDirectoryExists(this.runsRoot, runId)) {
      throw new Error(`could not allocate a unique workflow run id (last tried ${runId})`);
    }
    const promptContext = await binding.promptContext(options.cwd);
    const open = await this.#openRun(runId, binding);
    let created = false;
    try {
      await this.#attachExtensions(open, binding, options.cwd);
      const scriptHash = hashScript(options.script);
      const args = optionalJsonArgument(options.args);
      const root = await open.harness.root(context);
      const attemptId = await root.commit(async (tx) => {
        const run = await tx.doc(WorkflowRunDoc);
        run.runId = runId;
        run.name = meta.name;
        run.description = meta.description;
        run.cwd = options.cwd;
        run.createdAt = createdAt;
        if (binding.parentSessionFile) run.parentSessionFile = binding.parentSessionFile;
        const prompt = await tx.doc(WorkflowPromptContextDoc);
        prompt.contextFiles = promptContext.contextFiles.map((file) => ({ ...file }));
        prompt.skills = promptContext.skills;
        prompt.append = promptContext.append;
        const input: WorkflowRunInput = {
          number: 1,
          script: options.script,
          scriptHash,
          ...(args === undefined ? {} : { args }),
          cwd: options.cwd,
          ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
          ...this.#attemptLimits(options.tokenBudget),
          ...(binding.route ? { route: binding.route } : {}),
          reuse: false,
          ...(open.extras.extensions.size > 0
            ? { extensions: [...open.extras.extensions.keys()] }
            : {})
        };
        const id = await tx.createTask(open.tasks.RunTask, input, {
          ownership: { kind: 'conversation' }
        });
        run.attempts.push(id);
        await tx.doc(WorkflowAttemptDoc, String(id), {
          number: 1,
          taskId: id,
          scriptHash,
          at: createdAt
        });
        return id;
      }, context);
      created = true;
      await this.#writeIndex(open);
      open.harness.resume();
      return this.#handle(open, attemptId, 1, 'started');
    } catch (error) {
      // Discard before releasing the lease, so another opener cannot race the cleanup.
      // A storage error has an uncertain commit outcome. Never discard a possibly admitted run.
      await open.close(!created && !open.sessionClosing);
      if (open.sessionClosing && (await open.harness.closed).reason === 'failed') {
        throw new Error(
          `Workflow storage failed (run ${runId}); inspect with /workflows ${runId} before resuming.`,
          { cause: error }
        );
      }
      throw error;
    }
  }

  /**
   * Continue a run. A live attempt (interrupted by a crash, quit, or reload) continues in place
   * from its durable checkpoints. Otherwise a new attempt starts, with the given script or the
   * previous one, and reuses every completed agent call that is identical. A completed run with
   * no new script returns its stored result.
   */
  async resume(
    runId: string,
    options: ResumeWorkflowOptions,
    binding: WorkflowRunBinding
  ): Promise<WorkflowAttemptHandle> {
    assertValidRunId(runId);
    if (!runExists(this.runsRoot, runId)) throw new Error(`unknown workflow run ${runId}`);
    if (options.script !== undefined) parseWorkflowScript(options.script);
    const open = await this.#openRun(runId, binding);
    try {
      const harness = open.harness;
      const run = await readRun(harness);
      const latestId = run.attempts.at(-1);
      const latest =
        latestId === undefined
          ? undefined
          : await harness.getTask(latestId as TaskId<WorkflowRunTaskResult>, context);
      if (latestId === undefined || !latest)
        throw new Error(`workflow run ${runId} has no attempts`);
      const previous = latest.input as WorkflowRunInput;
      const script = options.script ?? previous.script;
      const scriptHash = hashScript(script);
      const args = options.args === undefined ? previous.args : optionalJsonArgument(options.args);
      const sameWork =
        scriptHash === previous.scriptHash &&
        canonicalJson(args ?? null) === canonicalJson(previous.args ?? null);
      const live = latest.state.status !== 'terminal';
      const tokenBudget = options.tokenBudget ?? previous.tokenBudget;
      const budgetChanged =
        options.tokenBudget !== undefined && options.tokenBudget !== previous.tokenBudget;

      if (
        !live &&
        sameWork &&
        latest.state.status === 'terminal' &&
        latest.state.outcome.status === 'completed'
      ) {
        return this.#handle(open, latestId, previous.number, 'completed');
      }
      await this.#attachExtensions(open, binding, previous.cwd);
      if (live && sameWork && !budgetChanged) {
        harness.resume();
        return this.#handle(open, latestId, previous.number, 'continued');
      }
      if (live) {
        // A different script replaces the live attempt; its completed agents stay reusable.
        await harness.abortTask(latestId as TaskId, context);
        harness.resume();
        await harness.waitForTask(latestId as TaskId, context);
      }

      const number = run.attempts.length + 1;
      const at = this.#now();
      const root = await harness.root(context);
      const attemptId = await root.commit(async (tx) => {
        const input: WorkflowRunInput = {
          number,
          script,
          scriptHash,
          ...(args === undefined ? {} : { args }),
          cwd: previous.cwd,
          ...((options.concurrency ?? previous.concurrency) === undefined
            ? {}
            : { concurrency: options.concurrency ?? previous.concurrency }),
          ...this.#attemptLimits(tokenBudget),
          // Keep the run's route: a different session model must not invalidate reuse.
          ...(previous.route ? { route: previous.route } : {}),
          reuse: true,
          ...(open.extras.extensions.size > 0
            ? { extensions: [...open.extras.extensions.keys()] }
            : {})
        };
        const id = await tx.createTask(open.tasks.RunTask, input, {
          ownership: { kind: 'conversation' }
        });
        const runDoc = await tx.doc(WorkflowRunDoc);
        runDoc.attempts.push(id);
        await tx.doc(WorkflowAttemptDoc, String(id), { number, taskId: id, scriptHash, at });
        return id;
      }, context);
      await this.#writeIndex(open);
      harness.resume();
      return this.#handle(open, attemptId, number, 'retried');
    } catch (error) {
      await open.close();
      throw error;
    }
  }

  /** Abort a run's live attempt, whether a tool call in this process drives it or it was interrupted. */
  async abort(runId: string): Promise<'aborted' | 'not_live'> {
    assertValidRunId(runId);
    const active = this.#open.get(runId);
    if (active) return this.#abortLatest(active);
    // Opening creates storage; never do that for a run that does not exist.
    if (!runExists(this.runsRoot, runId)) throw new Error(`unknown workflow run ${runId}`);
    const open = await this.#openRun(runId, undefined);
    try {
      const result = await this.#abortLatest(open);
      if (result === 'aborted') {
        // Let abort handlers run; nothing else can start once the marks are committed.
        open.harness.resume();
        const run = await readRun(open.harness);
        const latest = run.attempts.at(-1);
        if (latest !== undefined) await open.harness.waitForTask(latest as TaskId, context);
        await this.#writeIndex(open);
      }
      return result;
    } finally {
      await open.close();
    }
  }

  async #abortLatest(open: OpenRun): Promise<'aborted' | 'not_live'> {
    const run = await readRun(open.harness);
    const latest = run.attempts.at(-1);
    if (latest === undefined) return 'not_live';
    const record = await open.harness.getTask(latest as TaskId, context);
    if (!record || record.state.status === 'terminal') return 'not_live';
    await open.harness.abortTask(latest as TaskId, context);
    return 'aborted';
  }

  /** Read a run's durable state. Opens it briefly (without scheduling) unless already open here. */
  async report(runId: string): Promise<WorkflowRunReport> {
    return this.#read(runId, async (open) => {
      const harness = open.harness;
      const run = await readRun(harness);
      const attempts: WorkflowAttemptReport[] = [];
      for (const id of run.attempts) {
        const state = await readAttempt(harness, id);
        const record = await harness.getTask(id as TaskId, context);
        const input = record?.input as WorkflowRunInput | undefined;
        if (!state) continue;
        const compactionFailures: Record<string, string> = {};
        for (const row of Object.values(state.agents)) {
          if (row.conversationId === undefined) continue;
          const live = await harness.snapshot(LiveDoc, row.conversationId as never, context);
          if (live?.compactionFailure) {
            compactionFailures[row.conversationId] = live.compactionFailure.error;
          }
        }
        attempts.push({
          ...structuredClone(state as WorkflowAttemptState),
          script: input?.script ?? '',
          ...(Object.keys(compactionFailures).length ? { compactionFailures } : {}),
          ...(input?.args === undefined ? {} : { args: input.args })
        });
      }
      const latest = attempts.at(-1);
      const active = this.#open.has(runId) && !open.readOnly;
      return {
        runId,
        run: structuredClone(run),
        status:
          latest?.status === 'running' && !active
            ? 'interrupted'
            : ((latest?.status ?? 'interrupted') as WorkflowRunDisplayStatus),
        attempts,
        usage: sumUsageState(await harness.usage(context)),
        active
      };
    });
  }

  /** Readable transcript of one subagent conversation of a run. */
  async transcript(runId: string, conversationId: number): Promise<WorkflowTranscriptItem[]> {
    return this.#read(runId, async (open) => {
      const conversation = await open.harness.conversation(conversationId as never, context);
      if (!conversation)
        throw new Error(`conversation ${conversationId} not found in run ${runId}`);
      const entries: EntryRecord[] = [];
      let cursor: Cursor | undefined;
      do {
        const page = await conversation.entries({ order: 'ascending' }, 200, cursor, context);
        entries.push(...page.items);
        cursor = page.next;
      } while (cursor && entries.length < MAX_TRANSCRIPT_ENTRIES);
      const items = transcriptItems(entries);
      if (cursor) {
        items.push({
          role: 'note',
          text: `[transcript truncated: only the first ${MAX_TRANSCRIPT_ENTRIES} entries are shown]`
        });
      }
      return items;
    });
  }

  /**
   * Stream a running subagent's conversation to `listener`, starting with its current state.
   * Only for a run this process drives. Returns the function that stops the stream.
   */
  async follow(
    runId: string,
    conversationId: number,
    listener: (followed: FollowedTranscript) => void
  ): Promise<() => void> {
    const { conversation } = await this.#subagent(runId, conversationId);
    const view = await conversation.viewState(context);
    const unsubscribe = view.subscribe((value: ConversationView) =>
      listener(followedTranscript(value))
    );
    return () => {
      unsubscribe();
      view.dispose();
    };
  }

  /** Send a message that a running subagent reads after its current tool round. */
  async steer(runId: string, conversationId: number, text: string): Promise<void> {
    const message = text.trim();
    if (!message) throw new Error('nothing to send');
    const { open, conversation } = await this.#subagent(runId, conversationId);
    // A steer sent to an idle conversation would start a new run that nobody waits for.
    const live = await open.harness.snapshot(LiveDoc, conversationId as never, context);
    if (!live?.run) throw new Error('this agent is not working right now');
    await conversation.submit({ type: 'input', content: message, whenBusy: 'steer' }, context);
  }

  /** Take back the steers a running subagent has not read yet. Returns their text, oldest first. */
  async withdrawSteers(runId: string, conversationId: number): Promise<string[]> {
    const { open } = await this.#subagent(runId, conversationId);
    const inbox = await open.harness.snapshot(InboxDoc, conversationId as never, context);
    const withdrawn: string[] = [];
    for (const { id, text } of queuedSteers(inbox as InboxState | undefined)) {
      const result = await open.harness.abortSubmission(id, context, conversationId as never);
      if (result === 'aborted') withdrawn.push(text);
    }
    return withdrawn;
  }

  /**
   * Interrupt a running subagent, like Esc in Pi, and hold it. Its `agent()` call stays pending until
   * `resumeAgent` or `cancelAgent`. Returns the steers the interrupt withdrew, so they are not lost.
   */
  async pauseAgent(
    runId: string,
    conversationId: number
  ): Promise<{ paused: boolean; withdrawn: string[] }> {
    const { open, conversation } = await this.#subagent(runId, conversationId);
    const live = await open.harness.snapshot(LiveDoc, conversationId as never, context);
    if (!live?.run) throw new Error('this agent is not working right now');
    const inbox = await open.harness.snapshot(InboxDoc, conversationId as never, context);
    const withdrawn = queuedSteers(inbox as InboxState | undefined).map(({ text }) => text);
    await this.#setPause(open, conversationId, { paused: true, cancelled: false, message: '' });
    await conversation.abort(context);
    // The agent task records the pause once the interrupt has settled. If the agent answered first,
    // the request has no effect and the caller learns that nothing was paused.
    for (let step = 0; step < PAUSE_SETTLE_STEPS; step++) {
      if ((await this.#agentRow(open, conversationId))?.paused) return { paused: true, withdrawn };
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return { paused: false, withdrawn };
  }

  /** Resume a paused subagent with `message`, or with a plain "Continue." when there is none. */
  async resumeAgent(runId: string, conversationId: number, message?: string): Promise<void> {
    const { open, row } = await this.#subagent(runId, conversationId);
    if (!row.paused) throw new Error('this agent is not paused');
    await this.#setPause(open, conversationId, {
      paused: false,
      cancelled: false,
      message: message?.trim() ?? ''
    });
  }

  /** Stop one running or paused subagent. Its `agent()` call fails (null in the script); the run continues. */
  async cancelAgent(runId: string, conversationId: number): Promise<void> {
    const { open, conversation, row } = await this.#subagent(runId, conversationId);
    if (row.paused) {
      await this.#setPause(open, conversationId, { paused: false, cancelled: true, message: '' });
      return;
    }
    // A pause request that never took effect must not turn this interrupt into a pause.
    const pending = await open.harness.snapshot(WorkflowPauseDoc, conversationId as never, context);
    if (pending?.paused) {
      await this.#setPause(open, conversationId, { paused: false, cancelled: false, message: '' });
    }
    await conversation.abort(context);
  }

  async #setPause(open: OpenRun, conversationId: number, next: WorkflowPauseState): Promise<void> {
    await open.harness.commit(async (tx) => {
      const state = await tx.doc(WorkflowPauseDoc, conversationId as never);
      Object.assign(state, next);
    }, context);
  }

  async #agentRow(open: OpenRun, conversationId: number) {
    const run = await readRun(open.harness);
    const latest = run.attempts.at(-1);
    const attempt = latest === undefined ? undefined : await readAttempt(open.harness, latest);
    return Object.values(attempt?.agents ?? {}).find(
      (candidate) => candidate.conversationId === conversationId
    );
  }

  /** The conversation of a subagent that is running in a run this process drives. */
  async #subagent(runId: string, conversationId: number) {
    assertValidRunId(runId);
    const open = this.#open.get(runId);
    if (!open) throw new Error(`workflow run ${runId} is not running in this session`);
    const row = await this.#agentRow(open, conversationId);
    if (row?.status !== 'running') throw new Error('this agent is not running');
    const conversation = await open.harness.conversation(conversationId as never, context);
    if (!conversation) throw new Error(`conversation ${conversationId} not found in run ${runId}`);
    return { open, conversation, row };
  }

  delete(runId: string): void {
    assertValidRunId(runId);
    if (this.#open.has(runId)) throw new Error(`workflow run ${runId} is active in this session`);
    deleteRun(this.runsRoot, runId);
  }

  /** Explicit delivery acknowledgement for embedding hosts. Never call before persistence. */
  async acknowledgeUsage(runId: string, receiptId: string): Promise<void> {
    await this.#read(runId, async (open) => {
      await acknowledgeUsage(open.harness, receiptId);
      open.offer = undefined;
    });
  }

  /** Pi calls this at turn_end, AFTER tool results have been appended (not at message_end). */
  async settleDeliveries(sessionFile: string | undefined): Promise<void> {
    if (!sessionFile) return;
    await Promise.all(
      [...this.#open.values()]
        .filter((open) => open.offer && open.usageDelivery?.sessionFile === sessionFile)
        .map(async (open) => {
          try {
            await open.offer;
            await reconcileUsage(open.harness);
          } catch (error) {
            appendRunReport(this.runsRoot, open.runId, error, this.#now());
          } finally {
            await open.close();
          }
        })
    );
  }

  /** Close every open run without aborting it (quit, reload, session switch). */
  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.#open.values()].map((open) => open.close()));
  }

  async #read<T>(
    runId: string,
    read: (open: OpenRun & { readOnly?: boolean }) => Promise<T>
  ): Promise<T> {
    assertValidRunId(runId);
    const active = this.#open.get(runId);
    if (active) return read(active);
    if (!runExists(this.runsRoot, runId)) throw new Error(`unknown workflow run ${runId}`);
    const owner = runLockOwner(this.runsRoot, runId);
    if (owner) throw new WorkflowRunLockedError(runId, owner);
    const open = await this.#openRun(runId, undefined);
    try {
      return await read({ ...open, readOnly: true });
    } finally {
      await open.close();
    }
  }

  async #openRun(runId: string, binding: WorkflowRunBinding | undefined): Promise<OpenRun> {
    if (this.#open.has(runId)) {
      throw new Error(`workflow run ${runId} is already active in this Pi session`);
    }
    const release = acquireRunLock(this.runsRoot, runId);
    let harness: Harness | undefined;
    try {
      const registry = createRegistry();
      const installed = new Set<string>();
      const extras: RunExtras = { extensions: new Map(), notes: [], leases: [] };
      const tasks = createWorkflowTasks({
        install(extension) {
          if (installed.has(extension.name)) return;
          installed.add(extension.name);
          registry.install(extension);
        },
        resolveProfile(name) {
          if (!binding)
            throw new WorkflowProfileRoutingError(name, 'profile routing is unavailable');
          return binding.resolveProfile(name);
        },
        extensions(names) {
          const found: Extension[] = [];
          const missing: string[] = [];
          for (const name of names) {
            const extension = extras.extensions.get(name);
            if (extension) found.push(extension);
            else missing.push(name);
          }
          return { found, missing };
        },
        notes: () => extras.notes
      });
      registry.install(CodingTools);
      registry.install(SubagentExtension);
      registry.install(
        defineExtension({ name: 'workflow.tasks', tasks: [tasks.RunTask, tasks.AgentTask] })
      );
      const storage = await openNodeSqliteStorage(runDatabasePath(this.runsRoot, runId));
      const env = this.#options.env ?? ((cwd: string) => new NodeExecutionEnv({ cwd }));
      try {
        harness = await Harness.open(
          storage,
          {
            models: binding?.models ?? createModels(),
            registry,
            settings: {
              extensions: [CodingTools, SubagentExtension],
              progress: { partialIntervalMs: 250, outputIntervalMs: 250 },
              ...this.#options.settings
            },
            env: ({ cwd }) => env(cwd ?? process.cwd()),
            ...(this.#options.now ? { now: this.#options.now } : {}),
            onReport: (error) => {
              appendRunReport(this.runsRoot, runId, error, this.#now());
              this.#options.onReport?.(error);
            }
          },
          context
        );
      } catch (error) {
        await storage.close(context).catch(() => {});
        throw error;
      }
      // Live agents of a reopened run need their structured-output tools before scheduling resumes.
      for (const live of (await harness.inspect(context)).tasks) {
        if (live.record.kind !== AGENT_TASK_NAME) continue;
        const schema = (live.record.input as WorkflowAgentInput).schema;
        if (schema !== undefined) tasks.outputExtension(schema);
      }

      const open = ownOpenRun(
        { runId, harness, registry, extras, tasks, usageDelivery: binding?.usageDelivery },
        {
          writeIndex: (open) => this.#writeIndex(open),
          report: (error) => appendRunReport(this.runsRoot, runId, error, this.#now()),
          forget: (open) => {
            if (this.#open.get(runId) === open) this.#open.delete(runId);
          },
          discard: () => removeRunDirectory(this.runsRoot, runId),
          release
        }
      );
      this.#open.set(runId, open);
      return open;
    } catch (error) {
      await harness?.close(context).catch(() => {});
      release();
      throw error;
    }
  }

  /**
   * Install the host's curated extensions and open the providers for a run about to do work. Runs
   * before any scheduling, so extensions exist when agents are created and their names can be
   * pinned in the attempt. Provider failures degrade to notes; they never stop the run.
   */
  async #attachExtensions(open: OpenRun, binding: WorkflowRunBinding, cwd: string): Promise<void> {
    const { extras, registry } = open;
    const add = (extension: Extension) => {
      const error = extensionAdmissionError(extension);
      if (error) {
        extras.notes.push(`${error}; extension was not installed`);
        return;
      }
      if (extras.extensions.has(extension.name)) {
        extras.notes.push(`extension ${extension.name} was provided twice; the first one is used`);
        return;
      }
      registry.install(extension);
      extras.extensions.set(extension.name, extension);
    };
    for (const extension of this.#options.extensions ?? []) add(extension);

    const providerContext = {
      cwd,
      projectTrusted:
        typeof binding.projectTrusted === 'function'
          ? binding.projectTrusted(cwd)
          : (binding.projectTrusted ?? false),
      ...(binding.signal ? { signal: binding.signal } : {})
    };
    const leases = await Promise.all(
      (this.#options.providers ?? []).map(async (provider) => {
        let lease: WorkflowProviderLease;
        try {
          lease = await provider.open(providerContext);
        } catch {
          // An arbitrary provider exception may contain credentials. Providers that can explain
          // failures safely should return curated notes; never persist a raw opening exception.
          extras.notes.push(`${provider.name}: unavailable (provider failed to open)`);
          return;
        }
        // Register each lease as it arrives, not after every provider finishes. Closing may have
        // already drained extras.leases while this provider was opening. A late lease must never
        // enter that closed run, and must still outlive all of the Session's in-flight calls.
        if (open.isClosed() || open.sessionClosing) {
          await open.harness.closed;
          await lease
            .close()
            .catch((error) => appendRunReport(this.runsRoot, open.runId, error, this.#now()));
          return;
        }
        extras.leases.push(lease);
        return lease;
      })
    );
    if (binding.signal?.aborted) throw new Error('Workflow was aborted');
    if (open.isClosed() || open.sessionClosing) throw new Error('Workflow run was closed');
    // Install in provider declaration order, independent of acquisition timing.
    for (const lease of leases) {
      if (!lease) continue;
      for (const extension of lease.extensions) add(extension);
      extras.notes.push(...lease.notes);
    }
  }

  #handle(
    open: OpenRun,
    attemptId: number,
    attemptNumber: number,
    mode: WorkflowAttemptHandle['mode']
  ): WorkflowAttemptHandle {
    return {
      runId: open.runId,
      attemptId,
      attemptNumber,
      mode,
      wait: () => this.#wait(open, attemptId),
      acknowledgeUsage: (receiptId) => this.acknowledgeUsage(open.runId, receiptId),
      abort: async () => {
        if (open.isClosed()) return;
        await open.harness.abortTask(attemptId as TaskId, context);
      },
      watch: (listener) => this.#watch(open, attemptId, listener),
      close: () => open.close()
    };
  }

  async #wait(open: OpenRun, attemptId: number): Promise<WorkflowAttemptOutcome> {
    try {
      return await this.#waitForOutcome(open, attemptId);
    } catch (error) {
      if (!(error instanceof SessionFailed) && !open.sessionClosing) throw error;
      return this.#interrupted(open, attemptId);
    }
  }

  async #interrupted(open: OpenRun, attemptId: number): Promise<WorkflowAttemptOutcome> {
    const end = open.sessionClosing ? await open.harness.closed : undefined;
    const snapshot = await this.#snapshot(open, attemptId).catch(
      () => open.lastSnapshot ?? emptySnapshot(open.runId)
    );
    const error =
      end?.reason === 'failed'
        ? `Pi Durable session failed: ${end.error instanceof Error ? end.error.message : String(end.error)}; reopen the run to recover from committed state`
        : 'the workflow run was interrupted before it finished';
    return {
      status: 'interrupted',
      error,
      snapshot: { ...snapshot, status: 'interrupted', logs: [...snapshot.logs, error] }
    };
  }

  async #waitForOutcome(open: OpenRun, attemptId: number): Promise<WorkflowAttemptOutcome> {
    const interrupted = open.closed.then(() => undefined);
    let settled: Awaited<ReturnType<Harness['waitForTask']>> | undefined;
    try {
      settled = await Promise.race([
        open.harness.waitForTask(attemptId as TaskId<WorkflowRunTaskResult>, context),
        interrupted
      ]);
    } catch (error) {
      if (!open.isClosed()) throw error;
    }
    if (!settled || open.isClosed()) {
      return this.#interrupted(open, attemptId);
    }
    const outcome = settled.state.outcome as TaskOutcome<WorkflowRunTaskResult>;
    await this.#writeIndex(open);
    const snapshot = await this.#snapshot(open, attemptId);
    if (outcome.status === 'completed') {
      // One offer per open run, so concurrent waiters share a single pending receipt.
      if (!open.offer) open.offer = offerUsage(open.harness, open.runId, open.usageDelivery);
      const offer = await open.offer;
      return {
        status: 'completed',
        value: outcome.result.value,
        agentCount: outcome.result.agentCount,
        phases: outcome.result.phases,
        unreportedUsage: offer.usage,
        ...(offer.receipt ? { usageReceipt: offer.receipt } : {}),
        snapshot
      };
    }
    return {
      status: outcome.status === 'aborted' ? 'aborted' : 'failed',
      error: outcomeError(outcome),
      snapshot
    };
  }

  #watch(open: OpenRun, attemptId: number, listener: (snapshot: WorkflowSnapshot) => void) {
    let stopped = false;
    let running = false;
    let lastIndexAt = 0;
    let lastCounts = '';
    const tick = async () => {
      if (stopped || running || open.isClosed()) return;
      running = true;
      try {
        const snapshot = await this.#snapshot(open, attemptId);
        if (stopped) return;
        // The listing index is refreshed on every structural change and at least every 2 s,
        // independently of the listener, so `/workflows` stays accurate even after a crash.
        const counts = `${snapshot.agentCount}/${snapshot.doneCount}/${snapshot.errorCount}/${snapshot.runningCount}`;
        if (counts !== lastCounts || this.#now() - lastIndexAt > 2000) {
          lastCounts = counts;
          lastIndexAt = this.#now();
          await this.#writeIndex(open).catch((error) =>
            appendRunReport(this.runsRoot, open.runId, error, this.#now())
          );
        }
        try {
          listener(snapshot);
        } catch (error) {
          appendRunReport(this.runsRoot, open.runId, error, this.#now());
        }
      } catch {
        // The run may be closing; the next tick or the final result reports state.
      } finally {
        running = false;
      }
    };
    const timer = setInterval(() => void tick(), this.#options.watchIntervalMs ?? 400);
    timer.unref?.();
    void tick();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  async #snapshot(open: OpenRun, attemptId: number): Promise<WorkflowSnapshot> {
    const harness = open.harness;
    const run = await readRun(harness);
    const attempt = await readAttempt(harness, attemptId);
    if (!attempt) return emptySnapshot(open.runId, run);
    const live = new Map<
      number,
      { state?: import('@earendil-works/pi-durable').LiveState; usage?: Usage }
    >();
    const now = this.#now();
    for (const row of Object.values(attempt.agents)) {
      if (row.conversationId === undefined) continue;
      // A finished agent's live state only matters for a lingering compaction warning. Once it was
      // read a few seconds after the agent ended, polling it again every tick is wasted work.
      const cached = open.liveCache.get(row.conversationId);
      if (cached && row.endedAt !== undefined && cached.readAt >= row.endedAt + LIVE_SETTLE_MS) {
        live.set(row.conversationId, cached.entry);
        continue;
      }
      const id = row.conversationId as never;
      const [state, usage] = await Promise.all([
        harness.snapshot(LiveDoc, id, context),
        row.status === 'running' ? harness.snapshot(UsageDoc, id, context) : undefined
      ]);
      const entry = {
        ...(state ? { state: state as import('@earendil-works/pi-durable').LiveState } : {}),
        ...(usage ? { usage: sumUsageState(usage) } : {})
      };
      live.set(row.conversationId, entry);
      if (row.status !== 'running' && row.status !== 'queued') {
        open.liveCache.set(row.conversationId, { entry, readAt: now });
      }
    }
    const snapshot = attemptSnapshot(run, attempt as WorkflowAttemptState, this.#now(), live);
    open.lastSnapshot = snapshot;
    return snapshot;
  }

  async #writeIndex(open: OpenRun): Promise<void> {
    try {
      const run = await readRun(open.harness);
      if (!run.runId) return;
      const latest = run.attempts.at(-1);
      const attempt = latest === undefined ? undefined : await readAttempt(open.harness, latest);
      writeRunIndex(this.runsRoot, runIndex(run, attempt, this.#now()));
    } catch (error) {
      // A cache failure must not turn a committed success into a tool failure.
      appendRunReport(this.runsRoot, open.runId, error, this.#now());
    }
  }
}

/** Task outcomes are authoritative even when an uncaught fault bypassed the task's document writes. */
async function readAttempt(
  harness: Harness,
  id: number
): Promise<WorkflowAttemptState | undefined> {
  const stored = await harness.snapshot(WorkflowAttemptDoc, String(id), context);
  if (!stored) return undefined;
  const attempt = structuredClone(stored) as WorkflowAttemptState;
  const record = await harness.getTask(id as TaskId<WorkflowRunTaskResult>, context);
  if (record?.state.status === 'terminal') {
    const outcome = record.state.outcome;
    attempt.status =
      outcome.status === 'completed'
        ? 'completed'
        : outcome.status === 'aborted'
          ? 'aborted'
          : 'failed';
    attempt.endedAt = record.endedAt ?? attempt.endedAt ?? attempt.startedAt;
    if (outcome.status === 'completed') attempt.result = outcome.result.value;
    else attempt.error = outcomeError(outcome);
  } else if (record) {
    attempt.status = 'running';
    delete attempt.endedAt;
  }
  for (const row of Object.values(attempt.agents)) {
    if (row.taskId === undefined || (row.status !== 'running' && row.status !== 'queued')) continue;
    const agent = await harness.getTask(row.taskId as TaskId<WorkflowAgentTaskResult>, context);
    if (agent?.state.status !== 'terminal') continue;
    const outcome = agent.state.outcome;
    row.endedAt = agent.endedAt ?? row.endedAt ?? attempt.endedAt ?? attempt.startedAt;
    row.status =
      outcome.status === 'completed' ? 'done' : outcome.status === 'aborted' ? 'skipped' : 'error';
    if (outcome.status === 'completed') row.preview = preview(outcome.result.value, 160);
    else row.error = outcomeError(outcome);
    if (outcome.result) row.usage = outcome.result.usage;
    else if (row.conversationId !== undefined) {
      row.usage = sumUsageState(
        await harness.snapshot(UsageDoc, row.conversationId as never, context)
      ) as StoredUsage;
    }
  }
  return attempt;
}

async function readRun(harness: Harness): Promise<WorkflowRunState> {
  const run = await harness.snapshot(WorkflowRunDoc, context);
  if (!run) throw new Error('workflow run storage has no run record');
  return run as WorkflowRunState;
}

function emptySnapshot(runId: string, run?: WorkflowRunState): WorkflowSnapshot {
  return {
    name: run?.name ?? runId,
    description: run?.description,
    phases: [],
    logs: [],
    agents: [],
    agentCount: 0,
    runningCount: 0,
    doneCount: 0,
    errorCount: 0,
    runId
  };
}

export function hashScript(script: string): string {
  return createHash('sha256').update(script).digest('hex').slice(0, 16);
}
