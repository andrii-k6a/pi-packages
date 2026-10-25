import type { Context, Draft, JsonValue } from '@earendil-works/chord';
import {
  AssistantEntry,
  type ConversationId,
  configure,
  defineTask,
  type Extension,
  type TaskOutcome,
  type TaskRuntime,
  type Tx,
  UsageDoc
} from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { emptyUsage, sumUsageState } from '../../shared/usage.js';
import { preview } from '../../workflow/snapshot.js';
import {
  CANCELLED_ENTRY,
  PAUSED_ENTRY,
  RESUMED_ENTRY,
  type StoredUsage,
  type WorkflowAgentRow,
  WorkflowAttemptDoc,
  type WorkflowAttemptState,
  WorkflowOutputDoc,
  WorkflowPauseDoc
} from '../docs.js';
import { createSubagentExtension, STRUCTURED_OUTPUT_NUDGE } from '../subagent.js';
import {
  AGENT_TASK_NAME,
  type AgentCheckpoint,
  MAX_STRUCTURED_OUTPUT_NUDGES,
  type WorkflowAgentInput,
  type WorkflowAgentTaskResult,
  type WorkflowTaskServices
} from './contracts.js';
import { outcomeMessage } from './outcome.js';

/** How often a paused agent checks whether the user has resumed it. */
const PAUSE_POLL_MS = 250;
/** Sent when the user resumes an agent without a message. */
export const CONTINUE_MESSAGE = 'Continue.';

/** Shared by every subagent conversation; selected by name in each conversation's agent. */
export const SubagentExtension = createSubagentExtension();

/** Conversation intent, generation effect, and terminal accounting of one agent task. */
export function createAgentTask(
  services: WorkflowTaskServices,
  outputExtension: (schema: JsonValue) => Extension
) {
  return defineTask<WorkflowAgentInput, AgentCheckpoint, WorkflowAgentTaskResult>({
    name: AGENT_TASK_NAME,
    version: 1,
    initial: () => ({ phase: 'start' }),
    phases: {
      // Intent: create the subagent's own conversation, owned by this task, so aborting the task
      // aborts the subagent and the ownership index finds it again after a restart.
      start: async (task, runtime, context) => {
        const input = task.input;
        const output = input.schema === undefined ? undefined : outputExtension(input.schema);
        const provided = services.extensions(input.extensions ?? []);
        await runtime.commit(async (tx) => {
          const existing = (await tx.scanConversations({ ownerTaskId: task.id }, 1)).items[0];
          let conversationId = existing?.id;
          if (conversationId === undefined) {
            const created = await tx.createConversation({
              ownership: { kind: 'task', taskId: task.id }
            });
            conversationId = created.id;
            await configure(tx, created.id, {
              ...(input.route
                ? {
                    model: { provider: input.route.provider, modelId: input.route.modelId },
                    thinkingLevel: input.route.thinkingLevel
                  }
                : {}),
              // Persist every requested name, even when unavailable in this process. Durable
              // resolves these name-only references against the registry at each use, so tools
              // return when their extension is installed on a later resume.
              // The output extension comes last so nothing can shadow `structured_output`.
              extensions: [
                CodingTools,
                SubagentExtension,
                ...(input.extensions ?? []).map((name) => ({ name })),
                ...(output ? [output] : [])
              ],
              cwd: input.cwd,
              ...(input.instructions ? { instructions: input.instructions } : {})
            });
          }
          if (provided.missing.length > 0 && existing === undefined) {
            const attempt = await attemptDraft(tx, input, runtime.now());
            attempt.logs.push(
              `${input.label}: extension ${provided.missing.join(', ')} is not installed in this process; its tools are unavailable to this subagent`
            );
          }
          const row = await agentRow(tx, input, runtime.now());
          if (row) {
            row.status = 'running';
            row.conversationId = conversationId;
            row.startedAt ??= runtime.now();
          }
          return { status: 'running', checkpoint: { phase: 'run', conversationId, nudges: 0 } };
        }, context);
      },
      // Effect: submit the prompt (idempotent by request ID) and wait for the answer. A restart
      // re-enters here and reattaches to the same submission; generation resumes on its own.
      run: async (task, runtime, context) => {
        const input = task.input;
        const { conversationId, nudges, turn = 0, message } = task.state.checkpoint;
        const id = conversationId as ConversationId;
        const handle = await runtime.conversation(id, context);
        if (!handle) {
          await finishAgent(runtime, task, context, {
            status: 'failed',
            error: { message: 'subagent conversation is missing' },
            result: { value: null, usage: emptyUsage() as StoredUsage }
          });
          return;
        }
        const requestId =
          message !== undefined
            ? `workflow.agent:${task.id}:resume:${turn}`
            : nudges === 0
              ? `workflow.agent:${task.id}`
              : `workflow.agent:${task.id}:nudge:${nudges}`;
        const content = message ?? (nudges === 0 ? input.prompt : STRUCTURED_OUTPUT_NUDGE);
        const submission = await handle.submit({ type: 'input', content, requestId }, context);
        const settled = await submission.wait(context);
        const usage = sumUsageState(await runtime.snapshot(UsageDoc, id, context)) as StoredUsage;

        // The user interrupted the agent to pause it: keep the call pending instead of failing it.
        if (
          settled.status === 'unanswered' &&
          settled.reason === 'aborted' &&
          (await runtime.snapshot(WorkflowPauseDoc, id, context))?.paused
        ) {
          await runtime.commit(async (tx) => {
            const row = await agentRow(tx, input, runtime.now());
            if (row) row.paused = true;
            await tx.appendEntry(id, { kind: PAUSED_ENTRY, data: {} });
            return {
              status: 'running',
              checkpoint: { phase: 'paused', conversationId, nudges, turn }
            };
          }, context);
          return;
        }

        if (settled.status !== 'done' || settled.type !== 'input') {
          const reason = settled.status === 'unanswered' ? settled.reason : settled.status;
          await finishAgent(runtime, task, context, {
            status: 'failed',
            error: { message: `subagent did not answer: ${reason}${detailText(settled)}` },
            result: { value: null, usage, conversationId }
          });
          return;
        }

        let value: JsonValue;
        if (input.schema !== undefined) {
          const output = await runtime.snapshot(WorkflowOutputDoc, id, context);
          if (!output?.set) {
            if (nudges < MAX_STRUCTURED_OUTPUT_NUDGES) {
              // Durable progress: the next invocation of this phase sends the follow-up.
              await runtime.commit(
                () => ({
                  status: 'running',
                  checkpoint: {
                    phase: 'run',
                    conversationId,
                    nudges: nudges + 1,
                    ...(turn ? { turn } : {})
                  }
                }),
                context
              );
              return;
            }
            await finishAgent(runtime, task, context, {
              status: 'failed',
              error: { message: 'Subagent finished without calling structured_output' },
              result: { value: null, usage, conversationId }
            });
            return;
          }
          value = output.value;
        } else {
          // The answer lives in the subagent's conversation, not the task's; read it globally.
          let answer: { model?: readonly unknown[] } | undefined;
          await runtime.commit(async (tx) => {
            answer = await tx.entry(AssistantEntry, settled.answer);
            return undefined;
          }, context);
          value = assistantText(answer);
          // A final message without text (for example only thinking, or a cut-off answer) is a
          // failure the script can see as null, not an empty string it would mistake for a result.
          if (!value.trim()) {
            await finishAgent(runtime, task, context, {
              status: 'failed',
              error: { message: 'Subagent finished without a text answer' },
              result: { value: null, usage, conversationId }
            });
            return;
          }
        }
        await finishAgent(runtime, task, context, {
          status: 'completed',
          result: { value, usage, conversationId }
        });
      },
      paused: async (task, runtime, context) => {
        const input = task.input;
        const { conversationId, nudges, turn } = task.state.checkpoint;
        const id = conversationId as ConversationId;
        let state = await runtime.snapshot(WorkflowPauseDoc, id, context);
        while (state?.paused) {
          await sleep(PAUSE_POLL_MS, runtime.signal);
          if (runtime.signal.aborted) return;
          state = await runtime.snapshot(WorkflowPauseDoc, id, context);
        }
        if (state?.cancelled) {
          await runtime.commit(async (tx) => {
            await tx.appendEntry(id, { kind: CANCELLED_ENTRY, data: {} });
            return undefined;
          }, context);
          const usage = sumUsageState(await runtime.snapshot(UsageDoc, id, context)) as StoredUsage;
          await finishAgent(runtime, task, context, {
            status: 'failed',
            error: { message: 'subagent was cancelled' },
            result: { value: null, usage, conversationId }
          });
          return;
        }
        const message = state?.message || CONTINUE_MESSAGE;
        await runtime.commit(async (tx) => {
          const row = await agentRow(tx, input, runtime.now());
          if (row) delete row.paused;
          await tx.appendEntry(id, { kind: RESUMED_ENTRY, data: {} });
          return {
            status: 'running',
            checkpoint: { phase: 'run', conversationId, nudges, turn: turn + 1, message }
          };
        }, context);
      }
    },
    // Runs after the subagent's conversation work has been aborted (bottom-up).
    abort: async (task, runtime, context) => {
      const checkpoint = task.state.checkpoint;
      const usage =
        checkpoint.phase !== 'start'
          ? (sumUsageState(
              await runtime.snapshot(UsageDoc, checkpoint.conversationId as ConversationId, context)
            ) as StoredUsage)
          : (emptyUsage() as StoredUsage);
      await finishAgent(runtime, task, context, {
        status: 'aborted',
        reason: 'workflow aborted',
        result: {
          value: null,
          usage,
          ...(checkpoint.phase !== 'start' ? { conversationId: checkpoint.conversationId } : {})
        }
      });
    }
  });
}

type AgentRuntime = TaskRuntime<
  WorkflowAgentInput,
  AgentCheckpoint,
  WorkflowAgentTaskResult,
  object
>;

async function finishAgent(
  runtime: AgentRuntime,
  task: { input: WorkflowAgentInput },
  context: Context,
  outcome: TaskOutcome<WorkflowAgentTaskResult>
): Promise<void> {
  const endedAt = runtime.now();
  await runtime.commit(async (tx) => {
    const row = await agentRow(tx, task.input, endedAt);
    if (row) {
      row.endedAt = endedAt;
      delete row.paused;
      if (outcome.result) row.usage = outcome.result.usage;
      if (outcome.result?.conversationId !== undefined)
        row.conversationId = outcome.result.conversationId;
      if (outcome.status === 'completed') {
        row.status = 'done';
        row.preview = preview(outcome.result.value, 160);
        delete row.error;
      } else if (outcome.status === 'aborted') {
        row.status = 'skipped';
        row.error = 'aborted';
      } else {
        row.status = 'error';
        row.error = outcomeMessage(outcome);
      }
    }
    return { status: 'terminal', outcome };
  }, context);
}

async function attemptDraft(
  tx: Tx,
  input: WorkflowAgentInput,
  now: number
): Promise<Draft<WorkflowAttemptState>> {
  return tx.doc(WorkflowAttemptDoc, String(input.attemptId), {
    number: 0,
    taskId: input.attemptId,
    scriptHash: '',
    at: now
  });
}

async function agentRow(
  tx: Tx,
  input: WorkflowAgentInput,
  now: number
): Promise<Draft<WorkflowAgentRow> | undefined> {
  return (await attemptDraft(tx, input, now)).agents[input.key];
}

function assistantText(entry: { model?: readonly unknown[] } | undefined): string {
  const message = entry?.model?.[0] as { content?: unknown } | undefined;
  if (!Array.isArray(message?.content)) return '';
  return message.content
    .filter(
      (part): part is { type: 'text'; text: string } =>
        !!part && typeof part === 'object' && (part as { type?: unknown }).type === 'text'
    )
    .map((part) => part.text)
    .join('');
}

function detailText(settled: { detail?: JsonValue }): string {
  if (settled.detail === undefined || settled.detail === null) return '';
  const text = typeof settled.detail === 'string' ? settled.detail : JSON.stringify(settled.detail);
  return text ? ` (${text.length > 400 ? `${text.slice(0, 399)}…` : text})` : '';
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}
