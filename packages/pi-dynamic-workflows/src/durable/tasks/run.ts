import { createHash } from 'node:crypto';
import type { Context, Draft, JsonValue } from '@earendil-works/chord';
import type { Usage } from '@earendil-works/pi-ai';
import {
  type Cursor,
  defineTask,
  type Extension,
  type TaskId,
  type TaskOutcome,
  type TaskRecord,
  type TaskRuntime,
  type Tx
} from '@earendil-works/pi-durable';
import { jsonValue, jsonWorkflowResult } from '../../shared/json-values.js';
import {
  reviewOutputContract,
  validateReviewOutput
} from '../../workflow/builtins/code-review-output.js';
import { SDLC_SCRIPT } from '../../workflow/builtins/sdlc.js';
import type { WorkflowAgentExecutor, WorkflowAgentRunOptions } from '../../workflow/contracts.js';
import { WorkflowRoleError } from '../../workflow/roles.js';
import { runWorkflow } from '../../workflow/runtime.js';
import { preview } from '../../workflow/snapshot.js';
import {
  MAX_ATTEMPT_LOGS,
  type StoredUsage,
  type WorkflowAgentRow,
  WorkflowAttemptDoc,
  type WorkflowAttemptSeed,
  type WorkflowAttemptState,
  type WorkflowRoute,
  WorkflowRunDoc
} from '../docs.js';
import { workflowRoleExecutionId } from '../roles.js';
import { executeDurableSdlc } from '../sdlc-runtime.js';
import { WorkflowSdlcDoc } from '../sdlc-state.js';
import { canonicalJson, STRUCTURED_OUTPUT_CONTRACT } from '../subagent.js';
import type { createAgentTask } from './agent.js';
import {
  AGENT_TASK_NAME,
  RUN_TASK_NAME,
  type RunCheckpoint,
  type WorkflowAgentInput,
  type WorkflowAgentTaskResult,
  type WorkflowRunInput,
  type WorkflowRunTaskResult,
  type WorkflowTaskServices
} from './contracts.js';
import { errorText, outcomeMessage } from './outcome.js';

/** Replay one attempt, admitting child agents atomically with their identity/checkpoint rows. */
export function createRunTask(
  services: WorkflowTaskServices,
  AgentTask: ReturnType<typeof createAgentTask>,
  outputExtension: (schema: JsonValue) => Extension
) {
  return defineTask<WorkflowRunInput, RunCheckpoint, WorkflowRunTaskResult>({
    name: RUN_TASK_NAME,
    version: 1,
    initial: () => ({ phase: 'run', agents: {}, reused: {}, routes: {} }),
    phases: {
      run: async (task, runtime, context) => {
        const input = task.input;
        const attemptKey = String(task.id);
        const seed: WorkflowAttemptSeed = {
          number: input.number,
          taskId: task.id,
          scriptHash: input.scriptHash,
          at: runtime.now()
        };
        // A replay re-derives logs and phases from the script; keyed agent rows survive it.
        let nextIndex = 1;
        await runtime.commit(async (tx) => {
          const attempt = await tx.doc(WorkflowAttemptDoc, attemptKey, seed);
          attempt.status = 'running';
          if (input.recovery) attempt.recovery = input.recovery;
          attempt.logs = [];
          attempt.phases = [];
          delete attempt.currentPhase;
          nextIndex = Object.keys(attempt.agents).length + 1;
        }, context);

        const reusable = input.reuse
          ? await findReusableResults(runtime, task.id, input, context)
          : new Map<string, ReusableResult>();
        const writer = createAttemptWriter(runtime, attemptKey, seed, context);
        for (const line of services.notes()) writer.log(line);
        const occurrences = new Map<string, number>();
        const pendingRoutes: Record<string, WorkflowRoute> = {};
        const routeFor = (name: string): WorkflowRoute => {
          const known =
            task.state.checkpoint.routes[name] ??
            pendingRoutes[name] ??
            input.profileRoutes?.[name];
          if (known) return known;
          // An unreached profile has no original route to preserve and must not block recovery.
          const resolved = input.recovery?.route ?? services.resolveProfile(name);
          pendingRoutes[name] = resolved;
          return resolved;
        };

        const executor: WorkflowAgentExecutor = {
          async run(prompt, options) {
            const resolvedRole =
              options.resolvedRole ??
              (options.role
                ? services.roles?.resolve(options.role, { toolset: options.toolset })
                : undefined);
            if (options.role && !resolvedRole)
              throw new Error(`Workflow role ${options.role} cannot be resolved by this host`);
            if (resolvedRole) services.roles?.pin(resolvedRole);
            const profile = options.profile ?? resolvedRole?.definition.profile;
            const route = profile ? routeFor(profile) : input.route;
            options = {
              ...options,
              ...(profile ? { profile } : {}),
              ...(resolvedRole ? { resolvedRole } : {})
            };
            const baseKey = agentBaseKey(prompt, options, route);
            const occurrence = (occurrences.get(baseKey) ?? 0) + 1;
            occurrences.set(baseKey, occurrence);
            const key = `${baseKey}.${occurrence}`;
            // Values built inside the script's vm realm are not plain host-realm JSON.
            const schema = options.schema === undefined ? undefined : jsonValue(options.schema);
            const outputContract = reviewOutputContract(schema);

            let agentId: number | undefined;
            let reusedResult: ReusableResult | undefined;
            await runtime.commit(async (tx, current) => {
              const checkpoint = current.state.checkpoint;
              agentId = checkpoint.agents[key];
              if (agentId !== undefined) return undefined;
              const reusedId = checkpoint.reused[key];
              reusedResult =
                reusedId === undefined
                  ? reusable.get(key)
                  : (reusable.get(key) ?? (await reusableFromTask(tx, reusedId)));
              const attempt = await tx.doc(WorkflowAttemptDoc, attemptKey, seed);
              if (
                input.maxAgents !== undefined &&
                attempt.agents[key] === undefined &&
                Object.keys(attempt.agents).length >= input.maxAgents
              )
                throw new Error(
                  `workflow agent limit reached: at most ${input.maxAgents} agent() calls are allowed per attempt`
                );
              if (reusedResult && outputContract) {
                try {
                  validateReviewOutput(reusedResult.value, outputContract);
                } catch {
                  reusedResult = undefined;
                  attempt.logs.push(`${options.label}: retrying incompatible saved review output`);
                }
              }
              const routes = { ...input.profileRoutes, ...checkpoint.routes, ...pendingRoutes };
              attempt.profileRoutes = routes;
              const roles = {
                ...input.roles,
                ...checkpoint.roles,
                ...(resolvedRole ? { [resolvedRole.policy.hash]: resolvedRole } : {})
              };
              if (reusedResult) {
                if (reusedId !== undefined) return undefined;
                attempt.agents[key] = agentRowDraft(
                  key,
                  nextIndex++,
                  prompt,
                  { ...options, profile: reusedResult.profile },
                  reusedResult.route,
                  {
                    status: 'done',
                    reusedFrom: reusedResult.attemptNumber,
                    conversationId: reusedResult.conversationId,
                    ...(reusedResult.worktree ? { worktree: reusedResult.worktree } : {}),
                    usage: reusedResult.usage,
                    preview: preview(reusedResult.value, 160),
                    startedAt: runtime.now(),
                    endedAt: runtime.now()
                  }
                );
                return {
                  status: 'running',
                  checkpoint: {
                    ...checkpoint,
                    routes,
                    ...(Object.keys(roles).length ? { roles } : {}),
                    reused: { ...checkpoint.reused, [key]: reusedResult.taskId }
                  }
                };
              }
              const executionRoute = input.recovery?.route ?? route;
              const executionProfile = input.recovery?.profile ?? options.profile;
              if (input.recovery) {
                services.resolveProfile(input.recovery.profile, input.recovery.route);
              }
              if (schema !== undefined) outputExtension(schema);
              const instructions = [
                options.instructions,
                `Task label: ${options.label}`,
                schema === undefined ? undefined : STRUCTURED_OUTPUT_CONTRACT
              ]
                .filter(Boolean)
                .join('\n\n');
              agentId = await tx.createTask(
                AgentTask,
                {
                  attemptId: task.id,
                  key,
                  prompt,
                  label: options.label,
                  instructions,
                  ...(schema === undefined ? {} : { schema }),
                  ...(executionRoute ? { route: executionRoute } : {}),
                  ...(executionProfile ? { profile: executionProfile } : {}),
                  ...(input.recovery
                    ? { recovery: true as const, ...(route ? { logicalRoute: route } : {}) }
                    : {}),
                  cwd: options.cwd ?? input.cwd,
                  ...(options.role ? { role: options.role } : {}),
                  ...(resolvedRole ? { resolvedRole } : {}),
                  ...(options.inputRevision ? { inputRevision: options.inputRevision } : {}),
                  ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
                  ...(options.isolation ? { isolation: options.isolation } : {}),
                  ...(options.toolset ? { toolset: options.toolset } : {}),
                  ...(input.extensions?.length ? { extensions: input.extensions } : {})
                },
                { ownership: { kind: 'task', taskId: task.id } }
              );
              attempt.agents[key] = agentRowDraft(
                key,
                nextIndex++,
                prompt,
                { ...options, profile: executionProfile },
                executionRoute,
                {
                  status: 'queued',
                  taskId: agentId
                }
              );
              return {
                status: 'running',
                checkpoint: {
                  ...checkpoint,
                  routes,
                  ...(Object.keys(roles).length ? { roles } : {}),
                  agents: { ...checkpoint.agents, [key]: agentId }
                }
              };
            }, context);

            if (agentId === undefined) {
              const result = reusedResult as ReusableResult;
              options.onUsage?.(result.usage as Usage);
              return result.value;
            }

            const settled = await runtime.waitForTask(
              agentId as TaskId<WorkflowAgentTaskResult>,
              context
            );
            const outcome = settled.state.outcome;
            services.roles?.release(workflowRoleExecutionId({ attemptId: task.id, key }));
            if (outcome.result) options.onUsage?.(outcome.result.usage as Usage);
            switch (outcome.status) {
              case 'completed':
                return outcome.result.value;
              case 'failed':
                if (
                  outcome.error.detail &&
                  typeof outcome.error.detail === 'object' &&
                  !Array.isArray(outcome.error.detail) &&
                  outcome.error.detail.kind === 'workflow-role'
                )
                  throw new WorkflowRoleError(outcome.error.message);
                throw new Error(outcome.error.message);
              case 'aborted':
                throw new Error(outcome.reason ?? 'subagent was aborted');
              default:
                throw new Error(`subagent ${outcome.status}: ${outcomeMessage(outcome)}`);
            }
          }
        };

        let failure: unknown;
        let value: JsonValue = null;
        let result:
          | Pick<Awaited<ReturnType<typeof runWorkflow>>, 'result' | 'agentCount' | 'phases'>
          | undefined;
        try {
          if (input.script === SDLC_SCRIPT) {
            const phases: string[] = [];
            const value = await executeDurableSdlc(
              services,
              runtime,
              executor,
              (title) => {
                writer.phase(title);
                if (!phases.includes(title)) phases.push(title);
              },
              context
            );
            const stored = await runtime.snapshot(WorkflowAttemptDoc, attemptKey, context);
            result = {
              result: value,
              agentCount: Object.keys(stored?.agents ?? {}).length,
              phases
            };
          } else
            result = await runWorkflow(input.script, {
              agent: executor,
              args: input.args,
              cwd: input.cwd,
              concurrency: input.concurrency,
              ...(input.tokenBudget === undefined ? {} : { tokenBudget: input.tokenBudget }),
              ...(input.maxAgents === undefined ? {} : { maxAgents: input.maxAgents }),
              signal: runtime.signal,
              ...(services.roles
                ? { roleResolver: (name, selection) => services.roles!.resolve(name, selection) }
                : {}),
              profileResolver: (name) => {
                const route = routeFor(name);
                return {
                  model: { provider: route.provider, id: route.modelId },
                  thinkingLevel: route.thinkingLevel
                };
              },
              onLog: writer.log,
              onPhase: writer.phase
            });
          if (result.agentCount === 0 && input.script !== SDLC_SCRIPT) {
            throw new Error(
              'workflow scripts must call agent() at least once; this workflow declared phases but did not run any subagents'
            );
          }
          try {
            value = jsonWorkflowResult(result.result);
          } catch (error) {
            throw new Error(`workflow result must be JSON-serializable: ${errorText(error)}`);
          }
        } catch (error) {
          // Closing or an abort mark: leave the decision to the scheduler (resume or abort handler).
          if (runtime.signal.aborted) throw error;
          failure = error;
        }
        await writer.flush();
        const endedAt = runtime.now();
        await runtime.commit(async (tx) => {
          const attempt = await tx.doc(WorkflowAttemptDoc, attemptKey, seed);
          attempt.endedAt = endedAt;
          if (failure !== undefined || !result) {
            attempt.status = 'failed';
            attempt.error = errorText(failure);
            // A failed outcome aborts the agents still running; their rows settle as skipped.
            return {
              status: 'terminal',
              outcome: { status: 'failed', error: { message: errorText(failure) } }
            };
          }
          attempt.status = 'completed';
          attempt.result = value;
          return {
            status: 'terminal',
            outcome: {
              status: 'completed',
              result: { value, agentCount: result.agentCount, phases: result.phases }
            }
          };
        }, context);
      }
    },
    // Runs once every agent this attempt owns has been aborted.
    abort: async (task, runtime, context) => {
      const endedAt = runtime.now();
      await runtime.commit(async (tx) => {
        if (task.input.script === SDLC_SCRIPT) {
          const sdlc = await tx.doc(WorkflowSdlcDoc);
          if (sdlc.state) {
            sdlc.state.outcome = 'cancelled';
            sdlc.state.activity = 'Cancelled; completed work and cumulative usage are retained';
            delete sdlc.state.result;
          }
        }
        const attempt = await tx.doc(WorkflowAttemptDoc, String(task.id), {
          number: task.input.number,
          taskId: task.id,
          scriptHash: task.input.scriptHash,
          at: endedAt
        });
        attempt.status = 'aborted';
        attempt.endedAt = endedAt;
        for (const row of Object.values(attempt.agents)) {
          if (row.status === 'queued' || row.status === 'running') {
            row.status = 'skipped';
            row.error = 'aborted';
            row.endedAt ??= endedAt;
          }
        }
        return { status: 'terminal', outcome: { status: 'aborted', reason: 'workflow aborted' } };
      }, context);
    }
  });
}

type ReusableResult = {
  taskId: number;
  value: JsonValue;
  usage: StoredUsage;
  conversationId?: number;
  attemptNumber?: number;
  worktree?: WorkflowAgentTaskResult['worktree'];
  route?: WorkflowRoute;
  profile?: string;
};

type RunRuntime = TaskRuntime<WorkflowRunInput, RunCheckpoint, WorkflowRunTaskResult, object>;

function agentRowDraft(
  key: string,
  index: number,
  prompt: string,
  options: WorkflowAgentRunOptions,
  route: WorkflowRoute | undefined,
  fields: Partial<WorkflowAgentRow> & Pick<WorkflowAgentRow, 'status'>
): WorkflowAgentRow {
  return {
    key,
    index,
    label: options.label,
    ...(options.phase ? { phase: options.phase } : {}),
    ...(options.profile ? { profile: options.profile } : {}),
    ...(options.resolvedRole
      ? { role: options.resolvedRole.definition.id, rolePolicy: options.resolvedRole.policy.hash }
      : {}),
    ...(route
      ? { model: `${route.provider}/${route.modelId}`, thinkingLevel: route.thinkingLevel }
      : {}),
    prompt: prompt.length > 2000 ? `${prompt.slice(0, 1999)}…` : prompt,
    ...fields
  };
}

/**
 * Deterministic identity of one `agent()` call. Generated labels are excluded: they depend on
 * scheduling order. Everything that shapes the subagent's work is included, so a changed prompt,
 * schema, instructions, or route never reuses a stale result.
 */
export function agentBaseKey(
  prompt: string,
  options: Pick<
    WorkflowAgentRunOptions,
    | 'requestedLabel'
    | 'instructions'
    | 'schema'
    | 'isolation'
    | 'toolset'
    | 'role'
    | 'resolvedRole'
    | 'cwd'
    | 'inputRevision'
    | 'timeoutMs'
  >,
  route: WorkflowRoute | undefined
): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        prompt,
        label: options.requestedLabel ?? null,
        instructions: options.instructions ?? null,
        schema: options.schema ?? null,
        ...(options.isolation ? { isolation: options.isolation } : {}),
        ...(options.toolset ? { toolset: options.toolset } : {}),
        ...(options.role ? { role: options.role } : {}),
        ...(options.resolvedRole ? { resolvedRole: options.resolvedRole } : {}),
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.inputRevision ? { inputRevision: options.inputRevision } : {}),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        route: route ?? null
      })
    )
    .digest('hex')
    .slice(0, 24);
}

function createAttemptWriter(
  runtime: RunRuntime,
  key: string,
  seed: WorkflowAttemptSeed,
  context: Context
) {
  let pending: Array<(attempt: Draft<WorkflowAttemptState>) => void> = [];
  let tail: Promise<void> = Promise.resolve();
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    tail = tail
      .then(async () => {
        // Let a burst of synchronous log()/phase() calls land in one commit.
        await new Promise<void>((resolve) => setImmediate(resolve));
        scheduled = false;
        const batch = pending;
        pending = [];
        if (batch.length === 0) return;
        await runtime.commit(async (tx) => {
          const attempt = await tx.doc(WorkflowAttemptDoc, key, seed);
          for (const apply of batch) apply(attempt);
          if (attempt.logs.length > MAX_ATTEMPT_LOGS) {
            attempt.logs.splice(0, attempt.logs.length - MAX_ATTEMPT_LOGS);
          }
        }, context);
      })
      .catch((error) => {
        if (!runtime.signal.aborted) runtime.report(error);
      });
  };
  return {
    log(message: string) {
      pending.push((attempt) => {
        attempt.logs.push(message);
      });
      schedule();
    },
    phase(title: string) {
      pending.push((attempt) => {
        attempt.currentPhase = title;
        if (!attempt.phases.includes(title)) attempt.phases.push(title);
      });
      schedule();
    },
    flush: () => tail
  };
}

async function findReusableResults(
  runtime: RunRuntime,
  attemptId: number,
  runInput: WorkflowRunInput,
  context: Context
): Promise<Map<string, ReusableResult>> {
  const run = await runtime.snapshot(WorkflowRunDoc, context);
  const attemptNumbers = new Map((run?.attempts ?? []).map((id, index) => [id, index + 1]));
  const results = new Map<string, ReusableResult>();
  const attempts = new Map<number, WorkflowAttemptState>();
  for (const id of run?.attempts ?? []) {
    const attempt = await runtime.snapshot(WorkflowAttemptDoc, String(id), context);
    if (attempt) attempts.set(id, attempt);
  }
  await runtime.commit(async (tx) => {
    let cursor: Cursor | undefined;
    do {
      const page = await tx.scanTasks(
        { kind: AGENT_TASK_NAME, status: 'terminal', order: 'ascending' },
        200,
        cursor
      );
      for (const record of page.items) {
        const reusable = reusableFromRecord(record, attemptNumbers);
        const input = record.input as WorkflowAgentInput;
        // Newest completed result wins; never reuse within the same attempt.
        if (
          reusable &&
          input.attemptId !== attemptId &&
          (!input.recovery ||
            runInput.recovery ||
            canonicalJson(input.logicalRoute ?? null) === canonicalJson(input.route ?? null)) &&
          (input.cwd === runInput.cwd ||
            (runInput.script === SDLC_SCRIPT && input.inputRevision !== undefined)) &&
          canonicalJson(input.extensions ?? []) === canonicalJson(runInput.extensions ?? [])
        ) {
          reusable.profile ??= attempts.get(input.attemptId)?.agents[input.key]?.profile;
          results.set(input.key, reusable);
        }
      }
      cursor = page.next;
    } while (cursor);
  }, context);
  return results;
}

async function reusableFromTask(tx: Tx, taskId: number): Promise<ReusableResult | undefined> {
  return reusableFromRecord(await tx.task(taskId as TaskId), new Map());
}

function reusableFromRecord(
  record: TaskRecord<JsonValue, JsonValue, JsonValue> | undefined,
  attemptNumbers: Map<number, number>
): ReusableResult | undefined {
  if (record?.state.status !== 'terminal') return undefined;
  const outcome = record.state.outcome as TaskOutcome<WorkflowAgentTaskResult>;
  if (outcome.status !== 'completed') return undefined;
  const input = record.input as WorkflowAgentInput;
  return {
    taskId: record.id,
    value: outcome.result.value,
    usage: outcome.result.usage,
    ...(input.route ? { route: input.route } : {}),
    ...(input.profile ? { profile: input.profile } : {}),
    ...(outcome.result.worktree ? { worktree: outcome.result.worktree } : {}),
    ...(outcome.result.conversationId === undefined
      ? {}
      : { conversationId: outcome.result.conversationId }),
    ...(attemptNumbers.has(input.attemptId)
      ? { attemptNumber: attemptNumbers.get(input.attemptId) }
      : {})
  };
}
