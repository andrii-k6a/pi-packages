import type { JsonRepresentation, JsonValue } from '@earendil-works/chord';
import type { ModelThinkingLevel, Usage } from '@earendil-works/pi-ai';
import { defineDoc, defineDocFamily } from '@earendil-works/pi-durable';
import type { WorkflowAgentStatus, WorkflowAttemptStatus } from '../workflow/contracts.js';

export type { WorkflowAttemptStatus } from '../workflow/contracts.js';

/** Usage as stored in documents: the strict-JSON shape of pi-ai `Usage`. */
export type StoredUsage = JsonRepresentation<Usage>;

/**
 * Durable document model of one workflow run. Every document lives in the run's own Pi Durable
 * Session and changes only in commits, together with the task transitions they describe.
 */

/** Provider-qualified model and thinking level a subagent runs with. */
export type WorkflowRoute = {
  provider: string;
  modelId: string;
  thinkingLevel: ModelThinkingLevel;
};

/** Identity of a run, written once when its storage is created. */
export type WorkflowRunState = {
  version: 1;
  runId: string;
  name: string;
  description: string;
  cwd: string;
  createdAt: number;
  /** Parent Pi session file that started the run, when known. */
  parentSessionFile?: string;
  /** `workflow.run` task IDs of every attempt, oldest first. */
  attempts: number[];
};

export const WorkflowRunDoc = defineDoc<WorkflowRunState>({
  kind: 'workflow.run',
  version: 1,
  scope: 'session',
  initial: () => ({
    version: 1,
    runId: '',
    name: '',
    description: '',
    cwd: '',
    createdAt: 0,
    attempts: []
  })
});

/**
 * Project context captured once when the run is created. Subagent prompt sections render from it,
 * so a resumed run keeps the same system prompt (and warm provider prompt caches).
 */
export type WorkflowPromptContextState = {
  contextFiles: Array<{ path: string; content: string }>;
  skills: string;
  append: string;
};

export const WorkflowPromptContextDoc = defineDoc<WorkflowPromptContextState>({
  kind: 'workflow.prompt-context',
  version: 1,
  scope: 'session',
  initial: () => ({ contextFiles: [], skills: '', append: '' })
});

export type WorkflowAgentRowStatus = WorkflowAgentStatus;

/** One `agent()` call of an attempt, as the live view and the inspector show it. */
export type WorkflowAgentRow = {
  key: string;
  /** Display order within the attempt, starting at 1. */
  index: number;
  label: string;
  phase?: string;
  profile?: string;
  model?: string;
  thinkingLevel?: string;
  prompt: string;
  status: WorkflowAgentRowStatus;
  /** `workflow.agent` task; absent for a result reused from an earlier attempt. */
  taskId?: number;
  /** The subagent's own durable conversation (transcript, live state, usage). */
  conversationId?: number;
  /** Attempt number whose completed result this row reuses. */
  reusedFrom?: number;
  startedAt?: number;
  endedAt?: number;
  usage?: StoredUsage;
  preview?: string;
  error?: string;
};

/** Live and historical state of one attempt (one `workflow.run` task). */
export type WorkflowAttemptState = {
  number: number;
  taskId: number;
  status: WorkflowAttemptStatus;
  scriptHash: string;
  startedAt: number;
  endedAt?: number;
  phases: string[];
  currentPhase?: string;
  logs: string[];
  agents: Record<string, WorkflowAgentRow>;
  error?: string;
  /** Completed attempts only: the JSON-serializable workflow return value. */
  result?: JsonValue;
};

export type WorkflowAttemptSeed = {
  number: number;
  taskId: number;
  scriptHash: string;
  at: number;
};

/** Keyed by the attempt's task ID. Session-scoped, so it outlives the task that writes it. */
export const WorkflowAttemptDoc = defineDocFamily<WorkflowAttemptState, WorkflowAttemptSeed>({
  kind: 'workflow.attempt',
  version: 1,
  scope: 'session',
  family: true,
  initial: (seed) => ({
    number: seed.number,
    taskId: seed.taskId,
    status: 'running',
    scriptHash: seed.scriptHash,
    startedAt: seed.at,
    phases: [],
    logs: [],
    agents: {}
  })
});

/** An offer of usage, committed before returning it but acknowledged only after delivery. */
export type WorkflowUsageDelivery = {
  id: string;
  runId: string;
  usage: StoredUsage;
  total: StoredUsage;
  sessionFile?: string;
  toolCallId?: string;
};

/** Acknowledged spend plus an outstanding offer that can be reconciled after a crash. */
export type WorkflowBillingState = { reported: StoredUsage; pending?: WorkflowUsageDelivery };

export const WorkflowBillingDoc = defineDoc<WorkflowBillingState>({
  kind: 'workflow.billing',
  version: 1,
  scope: 'session',
  initial: () => ({
    reported: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    }
  })
});

/** A subagent's `structured_output` value, written by the tool before the result entry. */
export type WorkflowOutputState = { set: boolean; value: JsonValue };

export const WorkflowOutputDoc = defineDoc<WorkflowOutputState>({
  kind: 'workflow.output',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ set: false, value: null })
});

/** Maximum logs kept per attempt; older lines are dropped from the durable view. */
export const MAX_ATTEMPT_LOGS = 200;
