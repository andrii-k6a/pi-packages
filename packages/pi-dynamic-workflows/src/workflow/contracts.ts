import type { Usage } from '@earendil-works/pi-ai';
import type { TSchema } from 'typebox';
import type { ResolvedWorkflowProfile, WorkflowProfileResolver } from '../profiles/contracts.js';

export interface WorkflowMetaPhase {
  title: string;
  detail?: string;
  profile?: string;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  whenToUse?: string;
  profile?: string;
  phases?: WorkflowMetaPhase[];
}

/** Domain statuses shared by durable records, listing summaries, and display projections. */
export type WorkflowAgentStatus = 'queued' | 'running' | 'done' | 'error' | 'skipped';
export type WorkflowAttemptStatus = 'running' | 'completed' | 'failed' | 'aborted';
/** Interrupted is an observed run state, not a committed attempt outcome. */
export type WorkflowRunStatus = WorkflowAttemptStatus | 'interrupted';

/** What one `agent()` call asks of the executor that runs subagents. */
export interface WorkflowAgentRunOptions {
  /** Display label: the label the script requested, or a generated one. */
  label: string;
  /**
   * Label the script passed explicitly. Unlike generated labels, which depend on scheduling order,
   * it is identical on every replay of the script, so durable executors may key on it.
   */
  requestedLabel?: string;
  phase?: string;
  /** Effective approved profile name, if any. */
  profile?: string;
  schema?: TSchema;
  instructions?: string;
  signal?: AbortSignal;
  /** Resolved route of the effective profile; absent when the subagent inherits the session. */
  route?: ResolvedWorkflowProfile;
  /** Report spend, including spend of a failed run. */
  onUsage?: (usage: Usage) => void;
}

/** Runs subagents for the script interpreter. */
export interface WorkflowAgentExecutor {
  run(prompt: string, options: WorkflowAgentRunOptions): Promise<unknown>;
}

export interface WorkflowRunOptions {
  /** Executes `agent()` calls; the durable runtime supplies one backed by Pi Durable tasks. */
  agent: WorkflowAgentExecutor;
  args?: unknown;
  cwd?: string;
  concurrency?: number;
  /**
   * Soft token limit exposed as `budget`. It is checked when `agent()` is called and counts the
   * usage of agents that have already finished, so agents started together may overshoot it.
   */
  tokenBudget?: number | null;
  /** Reject `agent()` calls beyond this count, as a guard against runaway loops. Default: none. */
  maxAgents?: number;
  /**
   * Longest the script may run synchronously before its first `await`. Applies to that first
   * stretch only: Node cannot interrupt later synchronous stretches of a script. Default 10 s.
   */
  syncTimeoutMs?: number;
  signal?: AbortSignal;
  profileResolver?: WorkflowProfileResolver;
  onLog?: (message: string) => void;
  onPhase?: (title: string) => void;
  onAgentStart?: (event: {
    label: string;
    phase?: string;
    profile?: string;
    prompt: string;
  }) => void;
  onAgentEnd?: (event: { label: string; phase?: string; result: unknown }) => void;
}

export interface WorkflowRunResult<T = unknown> {
  meta: WorkflowMeta;
  result: T;
  logs: string[];
  phases: string[];
  agentCount: number;
  durationMs: number;
  usage: Usage;
}

export interface AgentOptions<TSchemaDef extends TSchema | undefined = TSchema | undefined> {
  label?: string;
  phase?: string;
  schema?: TSchemaDef;
  profile?: string;
  /** Non-enforced prompt hint. Does not create a worktree or change filesystem access. */
  isolation?: 'worktree';
  agentType?: string;
}
