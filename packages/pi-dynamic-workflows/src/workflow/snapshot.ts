import type { Usage } from '@earendil-works/pi-ai';
import type { WorkflowAgentStatus, WorkflowMeta, WorkflowRunStatus } from './contracts.js';

/** A renderer-independent projection; durable code need not depend on Pi UI modules. */
export interface WorkflowAgentSnapshot {
  id: number;
  label: string;
  phase?: string;
  profile?: string;
  prompt: string;
  status: WorkflowAgentStatus;
  resultPreview?: string;
  error?: string;
  /** `provider/model` the subagent ran with. */
  model?: string;
  durationMs?: number;
  tokens?: number;
  cost?: number;
  /** What a running subagent is doing right now, from its durable live state. */
  activity?: string;
  /** A durable warning that remains visible even after this agent finishes. */
  warning?: string;
  /** Attempt number whose completed result was reused instead of running again. */
  reusedFrom?: number;
  /** The subagent's durable conversation, for transcript inspection. */
  conversationId?: number;
}

export type WorkflowRunDisplayStatus = WorkflowRunStatus;

export interface WorkflowSnapshot {
  name: string;
  description?: string;
  phases: string[];
  currentPhase?: string;
  logs: string[];
  agents: WorkflowAgentSnapshot[];
  agentCount: number;
  runningCount: number;
  doneCount: number;
  errorCount: number;
  durationMs?: number;
  result?: unknown;
  /** Durable run identity, for resume and inspection. */
  runId?: string;
  attempt?: number;
  status?: WorkflowRunDisplayStatus;
  usage?: Usage;
}

export function createWorkflowSnapshot(meta: WorkflowMeta): WorkflowSnapshot {
  return {
    name: meta.name,
    description: meta.description,
    phases: [],
    logs: [],
    agents: [],
    agentCount: 0,
    runningCount: 0,
    doneCount: 0,
    errorCount: 0
  };
}

export function recomputeWorkflowSnapshot(snapshot: WorkflowSnapshot): WorkflowSnapshot {
  const runningCount = snapshot.agents.filter((agent) => agent.status === 'running').length;
  const doneCount = snapshot.agents.filter((agent) => agent.status === 'done').length;
  const errorCount = snapshot.agents.filter((agent) => agent.status === 'error').length;
  return { ...snapshot, agentCount: snapshot.agents.length, runningCount, doneCount, errorCount };
}

const DETAIL_PROMPT_CHARS = 200;

/**
 * A snapshot for transcripts and streamed tool updates. Renderers need neither the full prompts nor
 * the workflow result (the tool result already carries it), and a long run would otherwise repeat
 * both in every update and in the parent session file.
 */
export function compactSnapshot(snapshot: WorkflowSnapshot): WorkflowSnapshot {
  const { result: _result, ...rest } = snapshot;
  return {
    ...rest,
    agents: snapshot.agents.map((agent) => ({
      ...agent,
      prompt: preview(agent.prompt, DETAIL_PROMPT_CHARS)
    }))
  };
}

/** Stored data preview, not terminal formatting; renderers sanitize at the display boundary. */
export function preview(value: unknown, max = 80): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
