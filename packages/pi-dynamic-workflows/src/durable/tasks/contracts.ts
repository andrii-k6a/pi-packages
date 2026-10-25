import type { JsonValue } from '@earendil-works/chord';
import type { Extension } from '@earendil-works/pi-durable';
import type { StoredUsage, WorkflowRoute } from '../docs.js';

export const RUN_TASK_NAME = 'workflow.run';
export const AGENT_TASK_NAME = 'workflow.agent';
/** Follow-ups asking a schema agent that answered in prose to call structured_output. */
export const MAX_STRUCTURED_OUTPUT_NUDGES = 2;

/** Input of one attempt: everything needed to replay it, captured when it starts. */
export type WorkflowRunInput = {
  /** 1-based attempt number within the run. */
  number: number;
  script: string;
  scriptHash: string;
  args?: JsonValue;
  cwd: string;
  concurrency?: number;
  /** Soft token limit behind the script's `budget`; absent means unlimited. */
  tokenBudget?: number;
  /** Most `agent()` calls the script may make in this attempt; absent means unlimited. */
  maxAgents?: number;
  /** Session model and thinking level at start; subagents without a profile use it. */
  route?: WorkflowRoute;
  /** Reuse completed agent results of earlier attempts whose calls are identical. */
  reuse: boolean;
  /**
   * Names of the host-provided extensions (curated and provider-supplied, such as MCP tools) this
   * attempt's subagents select. Pinned at attempt creation so agents created after a restart get the
   * same set; names are resolved against the registry the restarted process installs.
   */
  extensions?: string[];
};

export type RunCheckpoint = {
  phase: 'run';
  /** Agent key -> `workflow.agent` task created by this attempt. */
  agents: Record<string, number>;
  /** Agent key -> earlier `workflow.agent` task whose completed result this attempt reuses. */
  reused: Record<string, number>;
  /** Profile name -> route, resolved once on first use and stable for the attempt's replays. */
  routes: Record<string, WorkflowRoute>;
};

export type WorkflowRunTaskResult = {
  value: JsonValue;
  agentCount: number;
  phases: string[];
};

export type WorkflowAgentInput = {
  attemptId: number;
  key: string;
  prompt: string;
  label: string;
  instructions?: string;
  /** Plain JSON Schema for structured output. */
  schema?: JsonValue;
  route?: WorkflowRoute;
  cwd: string;
  /** Host-provided extensions the subagent selects, by name (see `WorkflowRunInput.extensions`). */
  extensions?: string[];
};

export type AgentCheckpoint =
  | { phase: 'start' }
  | {
      phase: 'run';
      conversationId: number;
      nudges: number;
      /** Times the user has resumed this agent; keeps each resume message's request ID unique. */
      turn?: number;
      /** Set when the agent has just resumed: the message this invocation sends. */
      message?: string;
    }
  | { phase: 'paused'; conversationId: number; nudges: number; turn: number };

export type WorkflowAgentTaskResult = {
  value: JsonValue;
  usage: StoredUsage;
  conversationId?: number;
};

/** Host capabilities a run's tasks use; bound by the process that holds the run open. */
export interface WorkflowTaskServices {
  /** Install an extension in this run's registry (per-schema structured output tools). */
  install(extension: Extension): void;
  /** Resolve an approved profile in the current host context; throws WorkflowProfileRoutingError. */
  resolveProfile(name: string): WorkflowRoute;
  /** Look up host-provided extensions by name; `missing` are names this process has not installed. */
  extensions(names: readonly string[]): { found: Extension[]; missing: string[] };
  /** What the providers opened for this run could and could not offer, one line each. */
  notes(): readonly string[];
}
