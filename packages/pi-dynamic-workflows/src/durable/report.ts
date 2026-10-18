import type { JsonValue } from '@earendil-works/chord';
import type { Usage } from '@earendil-works/pi-ai';
import type { EntryRecord, LiveState } from '@earendil-works/pi-durable';
import { addUsage, emptyUsage } from '../shared/usage.js';
import type {
  WorkflowAgentSnapshot,
  WorkflowRunDisplayStatus,
  WorkflowSnapshot
} from '../workflow/snapshot.js';
import type { WorkflowAgentRow, WorkflowAttemptState, WorkflowRunState } from './docs.js';
import type { WorkflowRunIndex } from './store.js';

/** Everything the inspector shows about one run, read from its durable Session. */
export interface WorkflowRunReport {
  runId: string;
  run: WorkflowRunState;
  status: WorkflowRunDisplayStatus;
  attempts: WorkflowAttemptReport[];
  usage: Usage;
  /** Held open by an active workflow tool call in this process. */
  active: boolean;
}

export interface WorkflowAttemptReport extends WorkflowAttemptState {
  script: string;
  args?: JsonValue;
  /** Latest unresolved compaction failure by subagent conversation, including finished agents. */
  compactionFailures?: Record<string, string>;
}

/** One readable transcript item of a subagent conversation. */
export type WorkflowTranscriptItem = {
  role: 'user' | 'assistant' | 'thinking' | 'tool-call' | 'tool-result' | 'system' | 'note';
  text: string;
  toolName?: string;
  isError?: boolean;
};

/** Agent rows in display order. */
export function attemptRows(attempt: Pick<WorkflowAttemptState, 'agents'>): WorkflowAgentRow[] {
  return Object.values(attempt.agents).sort((a, b) => a.index - b.index);
}

/** Display snapshot of one attempt; `live` adds activity and spend of running subagents. */
export function attemptSnapshot(
  run: Pick<WorkflowRunState, 'runId' | 'name' | 'description'>,
  attempt: WorkflowAttemptState,
  now: number,
  live: ReadonlyMap<number, { state?: LiveState; usage?: Usage }> = new Map()
): WorkflowSnapshot {
  let usage = emptyUsage();
  const agents: WorkflowAgentSnapshot[] = attemptRows(attempt).map((row) => {
    const current = row.conversationId === undefined ? undefined : live.get(row.conversationId);
    const rowUsage = (row.status === 'running' ? current?.usage : undefined) ?? row.usage;
    // Reused results were paid for by an earlier attempt; they are not this attempt's spend.
    if (rowUsage && row.reusedFrom === undefined) usage = addUsage(usage, rowUsage);
    return {
      id: row.index,
      label: row.label,
      ...(row.phase ? { phase: row.phase } : {}),
      ...(row.profile ? { profile: row.profile } : {}),
      prompt: row.prompt,
      status: row.status,
      ...(row.preview ? { resultPreview: row.preview } : {}),
      ...(row.error ? { error: row.error } : {}),
      ...(row.model ? { model: row.model } : {}),
      ...(row.startedAt !== undefined ? { durationMs: (row.endedAt ?? now) - row.startedAt } : {}),
      ...(rowUsage?.totalTokens ? { tokens: rowUsage.totalTokens } : {}),
      ...(rowUsage?.cost?.total ? { cost: rowUsage.cost.total } : {}),
      ...(row.status === 'running' && current?.state
        ? { activity: liveActivity(current.state) ?? 'working' }
        : row.status === 'running'
          ? { activity: 'starting' }
          : {}),
      ...(current?.state?.compactionFailure
        ? { warning: `compaction failed: ${current.state.compactionFailure.error}` }
        : {}),
      ...(row.reusedFrom !== undefined ? { reusedFrom: row.reusedFrom } : {}),
      ...(row.conversationId !== undefined ? { conversationId: row.conversationId } : {})
    };
  });
  const runningCount = agents.filter((agent) => agent.status === 'running').length;
  return {
    name: run.name,
    description: run.description,
    phases: [...attempt.phases],
    ...(attempt.currentPhase ? { currentPhase: attempt.currentPhase } : {}),
    logs: [...attempt.logs],
    agents,
    agentCount: agents.length,
    runningCount,
    doneCount: agents.filter((agent) => agent.status === 'done').length,
    errorCount: agents.filter((agent) => agent.status === 'error').length,
    durationMs: (attempt.endedAt ?? now) - attempt.startedAt,
    ...(attempt.result !== undefined ? { result: attempt.result } : {}),
    runId: run.runId,
    attempt: attempt.number,
    status: attempt.status,
    usage
  };
}

/** One-phrase description of what a subagent is doing, from its `pi.live` document. */
export function liveActivity(live: LiveState): string | undefined {
  const tools = [...(live.tools ?? []), ...(live.nestedTools ?? [])];
  const parents = new Set(
    (live.nestedTools ?? [])
      .filter((tool) => tool.status === 'running')
      .map((tool) => tool.parentTaskId)
  );
  // Show the actual work, not just the orchestrating tool (for example codemode).
  const running = tools.filter(
    (tool) => tool.status === 'running' && (!tool.taskId || !parents.has(tool.taskId))
  );
  if (running.length > 0) {
    const byId = new Map(
      tools.filter((tool) => tool.taskId !== undefined).map((tool) => [tool.taskId, tool])
    );
    const names = [
      ...new Set(
        running.map((tool) => {
          const parent = 'parentTaskId' in tool ? byId.get(tool.parentTaskId) : undefined;
          return parent ? `${parent.name} → ${tool.name}` : tool.name;
        })
      )
    ];
    const output = running.length === 1 ? lastLine(running[0].output) : undefined;
    return `${names.join(', ')}${output ? `: ${output}` : ''}`;
  }
  if (live.compactions?.length) return 'compacting context';
  const generation = live.generation;
  if (generation?.retry)
    return `retrying (attempt ${generation.attempt}): ${generation.retry.error}`;
  if (generation?.deferred) return 'waiting for deferred response';
  if (generation?.message) {
    const content = (generation.message as { content?: unknown[] }).content ?? [];
    const last = content.at(-1) as { type?: string; name?: string } | undefined;
    if (last?.type === 'thinking') return 'thinking';
    if (last?.type === 'toolCall') return `calling ${last.name ?? 'a tool'}`;
    return 'responding';
  }
  if (generation) return 'waiting for model';
  if (live.tools?.length) return 'finishing tool round';
  return undefined;
}

/** Readable transcript of a subagent conversation's entries, oldest first. */
export function transcriptItems(entries: readonly EntryRecord[]): WorkflowTranscriptItem[] {
  const items: WorkflowTranscriptItem[] = [];
  for (const entry of entries) {
    switch (entry.kind) {
      case 'pi.system':
        break;
      case 'pi.user':
      case 'pi.reset':
      case 'pi.compaction':
        for (const message of entry.model ?? []) {
          const text = contentText((message as { content?: unknown }).content);
          if (text) {
            items.push({
              role: entry.kind === 'pi.user' ? 'user' : 'note',
              text: entry.kind === 'pi.compaction' ? `[context compacted]\n${text}` : text
            });
          }
        }
        break;
      case 'pi.assistant':
        for (const message of entry.model ?? []) {
          const assistant = message as {
            content?: unknown[];
            stopReason?: string;
            errorMessage?: string;
          };
          for (const part of assistant.content ?? []) {
            const block = part as {
              type?: string;
              text?: string;
              thinking?: string;
              name?: string;
              arguments?: unknown;
            };
            if (block.type === 'text' && block.text?.trim())
              items.push({ role: 'assistant', text: block.text });
            else if (block.type === 'thinking' && block.thinking?.trim())
              items.push({ role: 'thinking', text: block.thinking });
            else if (block.type === 'toolCall')
              items.push({
                role: 'tool-call',
                toolName: block.name,
                text: JSON.stringify(block.arguments ?? {})
              });
          }
          if (assistant.stopReason === 'error' || assistant.stopReason === 'aborted') {
            items.push({
              role: 'note',
              text: `[${assistant.stopReason}]${assistant.errorMessage ? ` ${assistant.errorMessage}` : ''}`
            });
          }
        }
        break;
      case 'pi.tool-result':
        for (const message of entry.model ?? []) {
          const result = message as { toolName?: string; isError?: boolean; content?: unknown };
          items.push({
            role: 'tool-result',
            toolName: result.toolName,
            isError: result.isError === true,
            text: contentText(result.content)
          });
        }
        break;
      default:
        items.push({ role: 'note', text: `[${entry.kind}]` });
    }
  }
  return items;
}

/** Listing summary of a run, derived from its latest attempt. */
export function runIndex(
  run: WorkflowRunState,
  latest: WorkflowAttemptState | undefined,
  updatedAt: number
): WorkflowRunIndex {
  const rows = latest ? attemptRows(latest) : [];
  return {
    version: 1,
    runId: run.runId,
    name: run.name,
    description: run.description,
    cwd: run.cwd,
    createdAt: run.createdAt,
    updatedAt,
    status: latest?.status ?? 'running',
    attempts: run.attempts.length,
    agents: {
      total: rows.length,
      done: rows.filter((row) => row.status === 'done').length,
      error: rows.filter((row) => row.status === 'error').length,
      running: rows.filter((row) => row.status === 'running' || row.status === 'queued').length
    },
    ...(latest?.error ? { error: latest.error.slice(0, 500) } : {}),
    ...(run.parentSessionFile ? { parentSessionFile: run.parentSessionFile } : {})
  };
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      const block = part as { type?: string; text?: string };
      if (block?.type === 'text') return block.text ?? '';
      if (block?.type === 'image') return '[image]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function lastLine(output: string | undefined): string | undefined {
  const line = output
    ?.split('\n')
    .map((item) => item.trim())
    .filter(Boolean)
    .at(-1);
  return line ? (line.length > 60 ? `${line.slice(0, 59)}…` : line) : undefined;
}
