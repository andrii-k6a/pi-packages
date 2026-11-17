import { realpathSync } from 'node:fs';
import type { Models } from '@earendil-works/pi-ai';
import {
  defineTool,
  type ExtensionContext,
  type ToolDefinition
} from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import type { WorkflowPromptContextState } from '../durable/docs.js';
import {
  type WorkflowAttemptHandle,
  type WorkflowAttemptOutcome,
  WorkflowHost,
  type WorkflowRunBinding
} from '../durable/host.js';
import { attemptSnapshot } from '../durable/report.js';
import { capturePromptContext } from '../durable/subagent.js';
import type { WorkflowProfile } from '../profiles/contracts.js';
import { createWorkflowProfileResolver } from '../profiles/routing.js';
import { terminalLine, terminalMultiline } from '../shared/terminal-text.js';
import { hasUsage } from '../shared/usage.js';
import { SDLC_SCRIPT } from '../workflow/builtins/sdlc.js';
import { BUILTIN_WORKFLOWS, resolveBuiltinWorkflow } from '../workflow/builtins.js';
import { workflowFailureSummary } from '../workflow/diagnostics.js';
import { workflowResultText } from '../workflow/result-text.js';
import type { ContinueSdlcOptions, SdlcArgs } from '../workflow/sdlc/contracts.js';
import { compactSnapshot, type WorkflowSnapshot } from '../workflow/snapshot.js';
import type { WorkflowBackgroundRuns } from './background.js';
import { prepareCodeReviewInput } from './code-review-input.js';
import { createToolUpdateWorkflowDisplay, renderWorkflowText } from './display.js';
import {
  compactSdlc,
  renderSdlcStatusLines,
  type SdlcSummary,
  sdlcStartWorkspaceNotice,
  sdlcWorkspaceNotice
} from './sdlc-display.js';
import { prepareSdlcArgs } from './sdlc-input.js';

const workflowToolSchema = Type.Object(
  {
    name: Type.Optional(
      Type.String({
        description: `Start a built-in workflow by name instead of script. Do not combine with script or resume. Available: ${BUILTIN_WORKFLOWS.map((workflow) => `${workflow.name}: ${workflow.description}`).join('\n')}`
      })
    ),
    script: Type.Optional(
      Type.String({
        description:
          "Raw JavaScript, no Markdown fences; start with export const meta = { name: '...', description: '...' }."
      })
    ),
    // An object schema on purpose: a schema without `type` (Any/Unknown) is rejected by some backends.
    args: Type.Optional(
      Type.Object(
        {},
        {
          additionalProperties: true,
          description: 'Optional JSON object exposed to the workflow script as global `args`.'
        }
      )
    ),
    tokenBudget: Type.Optional(
      Type.Integer({
        minimum: 1,
        description:
          'Optional soft token limit for the whole workflow, readable as budget.remaining(); agent() rejects once finished agents have used it. Agents started together can overshoot.'
      })
    ),
    resume: Type.Optional(
      Type.String({
        description:
          'Recover interrupted work or retry a failed runtime attempt. Completed runs return their stored result. Use continue for additional SDLC work.'
      })
    ),
    resumeProfile: Type.Optional(
      Type.String({
        description:
          'With resume only: keep recorded inputs and completed calls, use this approved profile only for unfinished work. Cannot combine with replacement script or args.'
      })
    ),
    background: Type.Optional(
      Type.Boolean({
        description:
          'Default false. Return a run id without waiting. TUI/RPC only. Continue other work, do not poll. A follow-up requests result retrieval when ready. Session changes interrupt the run safely.'
      })
    ),
    answer: Type.Optional(
      Type.Object(
        {
          runId: Type.String({ minLength: 1 }),
          questionId: Type.String({ minLength: 1 }),
          briefRevision: Type.Integer({ minimum: 1 }),
          answer: Type.String({ minLength: 1 })
        },
        {
          additionalProperties: false,
          description:
            'Record an explicit SDLC answer for this question and brief revision. Use alone. Does not continue work or approve anything else.'
        }
      )
    ),
    continue: Type.Optional(
      Type.String({
        description:
          'Explicitly continue a completed SDLC operation. Unlike resume, schedules more work under the same operation id.'
      })
    ),
    continueOptions: Type.Optional(
      Type.Object(
        {
          answers: Type.Optional(
            Type.Array(
              Type.Object(
                {
                  questionId: Type.String({ minLength: 1 }),
                  briefRevision: Type.Integer({ minimum: 1 }),
                  answer: Type.String({ minLength: 1 })
                },
                { additionalProperties: false }
              )
            )
          ),
          goalRevision: Type.Optional(Type.Integer({ minimum: 1 })),
          goal: Type.Optional(Type.String({ minLength: 1 })),
          context: Type.Optional(Type.Array(Type.String())),
          constraints: Type.Optional(Type.Array(Type.String())),
          acceptance: Type.Optional(
            Type.Array(
              Type.Union([
                Type.String({ minLength: 1 }),
                Type.Object(
                  {
                    id: Type.Optional(Type.String({ minLength: 1 })),
                    description: Type.String({ minLength: 1 }),
                    verification: Type.Optional(
                      Type.Union([Type.Literal('behavioral'), Type.Literal('inspection')])
                    ),
                    checkIds: Type.Optional(Type.Array(Type.String()))
                  },
                  { additionalProperties: false }
                )
              ])
            )
          ),
          checks: Type.Optional(
            Type.Array(
              Type.Object(
                {
                  id: Type.String({ minLength: 1 }),
                  argv: Type.Array(Type.String(), { minItems: 1 }),
                  kind: Type.Union([Type.Literal('test'), Type.Literal('check')]),
                  cwd: Type.Optional(Type.String()),
                  outcomes: Type.Array(Type.String())
                },
                { additionalProperties: false }
              ),
              {
                description:
                  'Add authorized observable verification. Existing check IDs may be repeated unchanged, never replaced or weakened. Does not revise the goal or acceptance.'
              }
            )
          ),
          limits: Type.Optional(
            Type.Object(
              {
                maxTasks: Type.Optional(Type.Integer({ minimum: 1 })),
                correctionRounds: Type.Optional(Type.Integer({ minimum: 0 })),
                replans: Type.Optional(Type.Integer({ minimum: 0 })),
                concurrency: Type.Optional(Type.Integer({ minimum: 1 })),
                taskTimeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
                checkTimeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
                tokenBudget: Type.Optional(Type.Integer({ minimum: 1 }))
              },
              { additionalProperties: false }
            )
          ),
          resumeProfile: Type.Optional(Type.String({ minLength: 1 }))
        },
        {
          additionalProperties: false,
          description:
            'Requires continue and a settled attempt. Answers record explicit clarifications. Goal/context/constraints/acceptance changes require the current goalRevision as authorization. Checks add evidence without reducing acceptance. Limits adjust total allowance, not consumption. resumeProfile reroutes unfinished work.'
        }
      )
    ),
    status: Type.Optional(
      Type.String({
        description:
          'Inspect this run id without starting work, including SDLC activity, questions, workspace, limits, and usage.'
      })
    ),

    result: Type.Optional(
      Type.String({
        description: 'Retrieve this completed run id and its usage. Does not resume work.'
      })
    ),
    cancel: Type.Optional(
      Type.String({ description: 'Cancel this run id. Completed work is kept.' })
    )
  },
  { additionalProperties: false }
);

export type WorkflowToolInput = {
  name?: string;
  script?: string;
  args?: Record<string, unknown>;
  resume?: string;
  resumeProfile?: string;
  tokenBudget?: number;
  background?: boolean;
  status?: string;
  result?: string;
  cancel?: string;
  answer?: { runId: string; questionId: string; briefRevision: number; answer: string };
  continue?: string;
  continueOptions?: Record<string, unknown>;
};

const workflowDisplayOptions = {
  key: 'workflow',
  streamToolUpdates: true,
  maxAgents: 4,
  maxLogs: 1,
  showResultPreviews: false
} as const;

export interface WorkflowToolOptions {
  cwd?: string;
  concurrency?: number;
  profiles?: readonly WorkflowProfile[];
  /** Durable runtime that owns workflow runs; one per extension instance. */
  host?: WorkflowHost;
  /** Session-scoped background execution and result-ready delivery. */
  backgroundRuns?: WorkflowBackgroundRuns;
  /** Override project-context capture for subagent prompts (tests, embedding hosts). */
  promptContext?: (cwd: string) => Promise<WorkflowPromptContextState>;
}

export function createWorkflowTool(
  options: WorkflowToolOptions = {}
): ToolDefinition<typeof workflowToolSchema, unknown> {
  const profileGuidelines = buildProfileGuidelines(options.profiles ?? []);
  const host = options.host ?? new WorkflowHost();

  return defineTool({
    name: 'workflow',
    label: 'Workflow',
    description:
      'Run named SDLC implementation or read-only code review, or replayable JavaScript subagent workflows. SDLC takes args.goal plus optional context, constraints, acceptance, checks, workspace, and policy. Runtime completion does not imply goal acceptance. Runs are durable; subagents share filesystem access unless isolated.',
    promptSnippet:
      "Run a built-in workflow with { name, args }, or supply a script. Script header: export const meta = { name: 'short_snake_case', description: 'non-empty description' }; call phase(title) for live progress.",
    promptGuidelines: [
      'Use workflow only when the user explicitly asks for a workflow, fan-out, or multi-agent orchestration. Not for quick edits.',
      'Use raw JavaScript, no fences/TypeScript. First statement: `export const meta = ...` with non-empty name and description. meta.phases is optional metadata.',
      'phase(title) shows progress. Phase names may be conditional or built in a loop.',
      'SDLC: answer records input; continue adds work. Report product outcome and evidence gaps.',
      'Scripts: no imports, require(), fs, Date.now(), Math.random(), new Date(). Scripts require agent(); SDLC no-work needs no agent. Loops must await or end.',
      "parallel() takes functions, not promises: `await parallel(items.map(item => () => agent('...', { label: '...' })))`, never `await parallel(items.map(item => agent(...)))`; results in input order.",
      'pipeline(items, ...stages): sequential stages per item, concurrent items; stage args (previousValue, originalItem, index).',
      'Replay requires identical calls given recorded results. Avoid Promise.race() and scheduling-dependent branches.',
      'Scripts: Use isolation: "worktree" for independent editing agents. It retains a HEAD checkout without parent edits. Git errors fail. Not a sandbox. Merge/remove manually.',
      'Ask isolated agents for branch, checkout path, and verification results. Later agents do not automatically see their edits. Inspect via /workflows.',
      'Label agents uniquely. Give self-contained tasks and relative paths. Subagents cannot start workflows themselves.',
      'agent()/parallel()/pipeline() ordinary failures return null. Abort/routing/role-policy failures reject. Check for nulls before synthesis. Return compact JSON.',
      'Pass plain JSON Schema via opts.schema. The root must be "object".',
      'budget.remaining() is Infinity unless tokenBudget is set (soft limit).',
      'Call workflow directly. It is unavailable inside codemode.',
      'Resume reuses completed calls. Fix authentication/quota first. resumeProfile reroutes only unfinished work.',
      'Use background: true if other work can proceed; else wait for it.',
      ...profileGuidelines
    ],
    parameters: workflowToolSchema,
    // Orchestrates subagents and streams progress, so only the model may call it, never
    // codemode scripts via ctx.executeTool().
    exposure: 'model-only',
    prepareArguments(args) {
      return normalizeWorkflowToolArgs(args);
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      params = normalizeWorkflowToolArgs(params);
      if (signal?.aborted) throw new Error('Workflow was aborted');
      if (params.answer) {
        const { runId, ...answer } = params.answer;
        await host.answerSdlc(runId, answer);
        return {
          content: [
            {
              type: 'text',
              text: `Answer recorded for ${answer.questionId} in operation ${runId}. No work was started. Use { "continue": "${runId}" } when ready.`
            }
          ],
          details: { runId, questionId: answer.questionId, answerRecorded: true }
        };
      }
      const query = params.status ?? params.result ?? params.cancel;
      if (query) {
        const cancelled = params.cancel ? await host.abort(query) : undefined;
        const ready = params.result ? await options.backgroundRuns?.prepareResult(query) : true;
        const live = options.backgroundRuns?.snapshot(query);
        const report = await host.report(query);
        const attempt = report.attempts.at(-1);
        if (!attempt) throw new Error(`workflow run ${query} has no attempts`);
        const sdlc =
          attempt.script === SDLC_SCRIPT ? compactSdlc(await host.inspectSdlc(query)) : undefined;
        if (live && (!params.result || ready === false)) {
          return workflowStatusResult(live, cancelled, undefined, sdlc);
        }
        if (!params.result || report.status !== 'completed') {
          return workflowStatusResult(
            { ...attemptSnapshot(report.run, attempt, Date.now()), status: report.status },
            cancelled,
            attempt.error,
            sdlc
          );
        }
      }
      let workflowArgs =
        params.name === 'sdlc' ? prepareSdlcArgs(params.args, params.background) : params.args;
      let script =
        params.name && params.name !== 'code-review'
          ? resolveBuiltinWorkflow(params.name, workflowArgs)
          : params.script;
      const resume = params.result ?? params.resume?.trim();
      if (!script && !params.name && !resume && !params.continue) {
        throw new Error('workflow requires `name`, `script`, or `resume` with an earlier run id');
      }
      if (params.background) {
        if (ctx.mode === 'print' || ctx.mode === 'json') {
          throw new Error('Background workflows require TUI or RPC mode. Use background: false.');
        }
        if (!options.backgroundRuns) {
          throw new Error('Background workflows require the Pi extension background runner');
        }
      }
      if (!ctx.model && !params.result) {
        throw new Error(
          'workflow requires an active session model for its subagents; select one with /model'
        );
      }

      const binding = createWorkflowRunBinding(ctx, {
        ...options,
        signal,
        onWorkspaceSelected: (workspace) => {
          onUpdate?.({
            content: [
              {
                type: 'text',
                text: sdlcWorkspaceNotice({
                  cwd: workspace.cwd,
                  mode: workspace.mode,
                  branch: workspace.branch
                })
              }
            ],
            details: {}
          });
        },
        ...(params.background ? {} : { toolCallId })
      });
      let runCwd = options.cwd ?? ctx.cwd;
      if (params.name === 'code-review') {
        const input = await prepareCodeReviewInput(
          runCwd,
          params.args,
          binding.resolveProfile,
          signal
        );
        if ('empty' in input) {
          return {
            content: [{ type: 'text', text: input.empty }],
            details: { noRunStarted: true }
          };
        }
        workflowArgs = { ...input.args };
        runCwd = input.cwd;
        script = resolveBuiltinWorkflow(params.name, workflowArgs);
      }
      const workspaceNotice =
        params.name === 'sdlc'
          ? await sdlcStartWorkspaceNotice(workflowArgs as SdlcArgs, runCwd)
          : params.continue
            ? sdlcWorkspaceNotice(compactSdlc(await host.inspectSdlc(params.continue)).workspace)
            : undefined;
      if (workspaceNotice && params.name === 'sdlc')
        onUpdate?.({ content: [{ type: 'text', text: workspaceNotice }], details: {} });
      if (signal?.aborted) throw new Error('Workflow was aborted');
      let handle: WorkflowAttemptHandle;
      try {
        handle = params.result
          ? await host.result(params.result, binding)
          : params.continue
            ? await host.continueSdlc(
                params.continue,
                (params.continueOptions ?? {}) as ContinueSdlcOptions,
                binding
              )
            : resume
              ? await host.resume(
                  resume,
                  {
                    script,
                    args: params.args,
                    resumeProfile: params.resumeProfile,
                    tokenBudget: params.tokenBudget
                  },
                  binding
                )
              : await host.start(
                  {
                    script: script as string,
                    args: workflowArgs,
                    cwd: runCwd,
                    concurrency: options.concurrency,
                    tokenBudget: params.tokenBudget
                  },
                  binding
                );
      } catch (error) {
        // Opening a run can wait on providers (for example MCP servers); Esc ends that wait.
        if (signal?.aborted) throw new Error('Workflow was aborted');
        throw error;
      }

      if (params.background) {
        try {
          if (signal?.aborted) {
            await handle.abort();
            throw new Error(`Workflow was aborted (run ${handle.runId})`);
          }
          options.backgroundRuns?.start(handle, ctx);
        } catch (error) {
          await handle.close();
          throw error;
        }
        return {
          content: [
            {
              type: 'text',
              text: `${workspaceNotice ? `${workspaceNotice}\n` : ''}Workflow started in the background. Run id: ${handle.runId}. Continue other work or end this turn. A follow-up will request result retrieval when ready. Do not poll. Use { "status": "${handle.runId}" } to inspect or { "cancel": "${handle.runId}" } to stop.`
            }
          ],
          details: { runId: handle.runId, attempt: handle.attemptNumber, background: true }
        };
      }

      const display = createToolUpdateWorkflowDisplay(onUpdate, undefined, workflowDisplayOptions);
      const stopWatching = handle.watch((snapshot) => display.update(compactSnapshot(snapshot)));
      // Esc follows the Pi Durable abort protocol: subagents are aborted bottom-up, and completed
      // results stay in the run for a later `resume`.
      const onAbort = () => void handle.abort().catch(() => {});
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();

      let outcome: WorkflowAttemptOutcome | undefined;
      try {
        outcome = await handle.wait();
        display.complete(compactSnapshot(outcome.snapshot));
      } catch (error) {
        await handle.close();
        throw error;
      } finally {
        stopWatching();
        signal?.removeEventListener('abort', onAbort);
        // Keep the lease through parent persistence, not merely through execute(). Otherwise a
        // competing resume could re-offer usage while this tool result is still being delivered.
        if (outcome?.status !== 'completed' || !outcome.usageReceipt || !binding.usageDelivery) {
          try {
            // An in-memory Pi session has no transcript file to reconcile against, so a receipt
            // could never be verified. Acknowledge now (at-most-once) rather than re-offer the same
            // spend to the session that is about to receive it.
            if (outcome?.status === 'completed' && outcome.usageReceipt) {
              await handle.acknowledgeUsage(outcome.usageReceipt.id);
            }
          } catch {
            // A finished workflow's result must not be replaced by a bookkeeping failure. The
            // receipt stays pending, so at worst the next resume offers this spend a second time.
          } finally {
            await handle.close();
          }
        }
      }

      if (outcome.status !== 'completed') {
        throw new Error(workflowFailureMessage(outcome, handle.runId));
      }
      const reused = outcome.snapshot.agents.filter(
        (agent) => agent.reusedFrom !== undefined
      ).length;
      const name = terminalLine(outcome.snapshot.name);
      const summary = [
        `Workflow ${name} completed with ${outcome.agentCount} agent(s)`,
        reused ? ` (${reused} reused from earlier attempts)` : '',
        handle.mode === 'completed' ? ' (stored result of an already completed run)' : '',
        `. Run id: ${handle.runId}. Report available: /workflows ${handle.runId} --report.`
      ].join('');

      // Spend of failed or aborted attempts is returned here too, once, when the run completes.
      return {
        ...(hasUsage(outcome.unreportedUsage) ? { usage: outcome.unreportedUsage } : {}),
        content: [
          {
            type: 'text',
            text: `${summary}${workspaceNotice ? `\n${workspaceNotice}` : ''}\n\nResult:\n${JSON.stringify(outcome.value, null, 2)}`
          }
        ],
        details: {
          ...compactSnapshot(outcome.snapshot),
          resultDelivered: true,
          ...(outcome.usageReceipt ? { usageReceipt: outcome.usageReceipt } : {})
        }
      };
    },
    renderCall(args, theme) {
      const input = args as WorkflowToolInput | undefined;
      const action = (['status', 'result', 'cancel', 'resume', 'continue'] as const).find(
        (key) => input?.[key]
      );
      const title = theme.fg('toolTitle', theme.bold('workflow'));
      const suffix = action
        ? `${action} ${terminalLine(input?.[action] ?? '')}`
        : input?.answer
          ? `answer ${terminalLine(input.answer.runId)} ${terminalLine(input.answer.questionId)}`
          : [input?.name ? terminalLine(input.name) : '', input?.background ? 'background' : '']
              .filter(Boolean)
              .join(' ');
      return new Text(suffix ? `${title} ${theme.fg('muted', suffix)}` : title, 0, 0);
    },
    renderResult(result, { isPartial, expanded }, theme) {
      const snapshot = result.details as WorkflowSnapshot | undefined;
      if (snapshot?.name) {
        const sdlc = (result.details as { sdlc?: SdlcSummary }).sdlc;
        const progress = [
          renderWorkflowText(snapshot, !isPartial, workflowDisplayOptions),
          ...(sdlc ? renderSdlcStatusLines(sdlc) : [])
        ].join('\n');
        const content = result.content?.[0];
        if (expanded && !isPartial && snapshot.status === 'completed' && content?.type === 'text') {
          const saved = content.text.split('\n\nResult:\n')[1];
          let report = saved ?? content.text;
          if (saved) {
            try {
              report = workflowResultText(JSON.parse(saved));
            } catch {
              /* Keep readable legacy text. */
            }
          }
          return new Text(`${progress}\n\n${terminalMultiline(report)}`, 0, 0);
        }
        return new Text(progress, 0, 0);
      }
      const text = result.content?.[0];
      return new Text(
        text?.type === 'text' ? terminalMultiline(text.text) : theme.fg('muted', 'workflow'),
        0,
        0
      );
    }
  });
}

/** What a run needs from the calling session: model access, routing, and project context. */
export function createWorkflowRunBinding(
  ctx: Pick<
    ExtensionContext,
    'modelRegistry' | 'model' | 'thinkingLevel' | 'scopedModels' | 'cwd'
  > &
    Partial<Pick<ExtensionContext, 'isProjectTrusted' | 'sessionManager' | 'hasUI' | 'ui'>>,
  options: Pick<WorkflowToolOptions, 'profiles' | 'promptContext'> & {
    signal?: AbortSignal;
    toolCallId?: string;
    onWorkspaceSelected?: WorkflowRunBinding['onWorkspaceSelected'];
  } = {}
): WorkflowRunBinding {
  const models = getModelRuntime(ctx.modelRegistry);
  const resolver = createWorkflowProfileResolver(options.profiles ?? [], ctx);
  const parentSessionFile = ctx.sessionManager?.getSessionFile();
  return {
    models,
    ...(ctx.model
      ? {
          route: {
            provider: ctx.model.provider,
            modelId: ctx.model.id,
            thinkingLevel: ctx.thinkingLevel ?? 'off'
          }
        }
      : {}),
    resolveProfile(name, pinned) {
      const route = resolver(
        name,
        pinned === undefined
          ? undefined
          : {
              model: { provider: pinned.provider, id: pinned.modelId },
              thinkingLevel: pinned.thinkingLevel
            }
      );
      return {
        provider: route.model.provider,
        modelId: route.model.id,
        thinkingLevel: route.thinkingLevel
      };
    },
    promptContext: (cwd) =>
      options.promptContext?.(cwd) ??
      capturePromptContext({ cwd, projectTrusted: trustedProject(ctx, cwd) }),
    projectTrusted: (cwd) => trustedProject(ctx, cwd),
    ...(options.onWorkspaceSelected || (ctx.hasUI && ctx.ui)
      ? {
          onWorkspaceSelected:
            options.onWorkspaceSelected ??
            ((workspace) =>
              ctx.ui?.notify(
                sdlcWorkspaceNotice({
                  cwd: workspace.cwd,
                  mode: workspace.mode,
                  branch: workspace.branch
                }),
                'info'
              ))
        }
      : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(parentSessionFile ? { parentSessionFile } : {}),
    ...(parentSessionFile && options.toolCallId
      ? { usageDelivery: { sessionFile: parentSessionFile, toolCallId: options.toolCallId } }
      : {})
  };
}

/** A session's trust decision applies only to its canonical working directory, not a resumed run's. */
function trustedProject(
  ctx: { cwd: string; isProjectTrusted?: () => boolean },
  cwd: string
): boolean {
  if (!ctx.isProjectTrusted?.()) return false;
  try {
    return realpathSync(ctx.cwd) === realpathSync(cwd);
  } catch {
    return false;
  }
}

export function workflowFailureMessage(
  outcome: Exclude<WorkflowAttemptOutcome, { status: 'completed' }>,
  runId: string
): string {
  const name = terminalLine(outcome.snapshot.name);
  const diagnostics = workflowFailureSummary({ ...outcome.snapshot, runId }, outcome.error).join(
    '\n'
  );
  switch (outcome.status) {
    case 'aborted':
      return `Workflow ${name} was aborted (run ${runId}).\n${diagnostics}`;
    case 'interrupted':
      return `Workflow ${name} was interrupted (run ${runId}). Committed progress is saved.\n${diagnostics}`;
    default:
      return `Workflow ${name} failed (run ${runId}).\n${diagnostics}`;
  }
}

function getModelRuntime(modelRegistry: unknown): Models {
  // Pi exposes the parent ModelRegistry to extensions but no public accessor for its
  // ModelRuntime (verified through 1.3.0). ModelRuntime implements pi-ai `Models`, which Pi
  // Durable uses for generation, so subagents share the parent's providers, auth, and request
  // transforms. Keep this compatibility shim narrow, validated, and loud.
  const runtime = (modelRegistry as { runtime?: unknown }).runtime;
  if (!isModelRuntime(runtime)) {
    throw new Error(
      'workflow requires Pi ModelRuntime from ExtensionContext; current pi-coding-agent does not expose it publicly'
    );
  }
  return runtime;
}

function isModelRuntime(value: unknown): value is Models {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return ['getAuth', 'getModel', 'getProvider', 'getProviders', 'streamSimple'].every(
    (method) => typeof candidate[method] === 'function'
  );
}

function normalizeWorkflowToolArgs(args: unknown): WorkflowToolInput {
  if (!args || typeof args !== 'object' || Array.isArray(args))
    throw new Error('workflow requires an object argument with a name, script, or resume run id');
  const value = args as Record<string, unknown>;
  const allowed = [
    'name',
    'script',
    'args',
    'tokenBudget',
    'resume',
    'resumeProfile',
    'background',
    'status',
    'result',
    'cancel',
    'answer',
    'continue',
    'continueOptions'
  ];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`workflow: unsupported argument ${key}`);
  }
  if (value.answer !== undefined) {
    if (Object.keys(value).some((key) => key !== 'answer')) {
      throw new Error('workflow answer must be used alone. Continue the operation separately.');
    }
    const answer = value.answer as Record<string, unknown> | null;
    if (
      !answer ||
      typeof answer !== 'object' ||
      Array.isArray(answer) ||
      Object.keys(answer).some(
        (key) => !['runId', 'questionId', 'briefRevision', 'answer'].includes(key)
      ) ||
      typeof answer.runId !== 'string' ||
      !answer.runId.trim() ||
      typeof answer.questionId !== 'string' ||
      !answer.questionId.trim() ||
      !Number.isSafeInteger(answer.briefRevision) ||
      (answer.briefRevision as number) < 1 ||
      typeof answer.answer !== 'string' ||
      !answer.answer.trim()
    ) {
      throw new Error(
        'workflow answer requires runId, questionId, a positive briefRevision, and a non-empty answer string'
      );
    }
    return {
      answer: {
        runId: answer.runId.trim(),
        questionId: answer.questionId,
        briefRevision: answer.briefRevision as number,
        answer: answer.answer
      }
    };
  }
  if (value.continue !== undefined) {
    if (typeof value.continue !== 'string' || !value.continue.trim()) {
      throw new Error('workflow continue requires a non-empty run id string');
    }
    if (
      Object.keys(value).some((key) => !['continue', 'continueOptions', 'background'].includes(key))
    ) {
      throw new Error('workflow continue can only be combined with continueOptions and background');
    }
    if (
      value.continueOptions !== undefined &&
      (!value.continueOptions ||
        typeof value.continueOptions !== 'object' ||
        Array.isArray(value.continueOptions))
    ) {
      throw new Error('workflow continueOptions must be a JSON object');
    }
    if (value.background !== undefined && typeof value.background !== 'boolean') {
      throw new Error('workflow requires `background` to be a boolean');
    }
    return { ...value, continue: value.continue.trim() } as WorkflowToolInput;
  }
  if (value.continueOptions !== undefined) {
    throw new Error('workflow continueOptions requires continue');
  }
  if (value.name !== undefined && (typeof value.name !== 'string' || !value.name.trim())) {
    throw new Error('workflow requires `name` to be a non-empty built-in workflow name');
  }
  if (value.name !== undefined && (value.script !== undefined || value.resume !== undefined)) {
    throw new Error('workflow `name` cannot be combined with `script` or `resume`');
  }
  if (
    value.resumeProfile !== undefined &&
    (typeof value.resumeProfile !== 'string' ||
      !value.resumeProfile.trim() ||
      typeof value.resume !== 'string' ||
      !value.resume.trim() ||
      ['name', 'script', 'args', 'status', 'result', 'cancel'].some(
        (key) => value[key] !== undefined
      ))
  ) {
    throw new Error(
      'resumeProfile requires resume and cannot be combined with name, script, args, status, result, or cancel'
    );
  }
  if (value.script !== undefined && typeof value.script !== 'string')
    throw new Error('workflow requires `script` to be a string');
  if (value.resume !== undefined && typeof value.resume !== 'string')
    throw new Error('workflow requires `resume` to be a run id string');
  if (
    value.args !== undefined &&
    (!value.args || typeof value.args !== 'object' || Array.isArray(value.args))
  ) {
    throw new Error('workflow requires `args` to be a JSON object');
  }
  if (
    value.tokenBudget !== undefined &&
    !(
      typeof value.tokenBudget === 'number' &&
      Number.isInteger(value.tokenBudget) &&
      value.tokenBudget >= 1
    )
  ) {
    throw new Error('workflow requires `tokenBudget` to be a positive integer');
  }
  if (value.background !== undefined && typeof value.background !== 'boolean') {
    throw new Error('workflow requires `background` to be a boolean');
  }
  const queries = ['status', 'result', 'cancel'].filter((key) => value[key] !== undefined);
  for (const key of queries) {
    if (typeof value[key] !== 'string' || !(value[key] as string).trim()) {
      throw new Error(`workflow requires \`${key}\` to be a non-empty run id string`);
    }
  }
  if (
    queries.length > 1 ||
    (queries.length === 1 &&
      ['name', 'script', 'resume', 'resumeProfile', 'args', 'tokenBudget', 'background'].some(
        (key) => value[key] !== undefined
      ))
  ) {
    throw new Error('workflow status, result, and cancel must be used alone with a run id');
  }
  if (
    value.name === undefined &&
    value.script === undefined &&
    value.resume === undefined &&
    queries.length === 0
  )
    throw new Error('workflow requires `name`, `script`, or `resume` with an earlier run id');
  return {
    ...value,
    ...(typeof value.name === 'string' ? { name: value.name.trim() } : {}),
    ...(typeof value.script === 'string' ? { script: normalizeWorkflowScript(value.script) } : {})
  } as WorkflowToolInput;
}

function workflowStatusResult(
  snapshot: WorkflowSnapshot,
  cancelled?: 'aborted' | 'not_live',
  error?: string,
  sdlc?: SdlcSummary
) {
  return {
    content: [
      {
        type: 'text' as const,
        text: [
          cancelled === 'aborted' ? 'Cancellation requested. Completed work is kept.' : '',
          `Workflow ${terminalLine(snapshot.name)}: ${snapshot.status}. Run id: ${snapshot.runId}.`,
          `${snapshot.doneCount}/${snapshot.agentCount} agents done.`,
          ...(sdlc ? renderSdlcStatusLines(sdlc) : []),
          ...(snapshot.errorCount ||
          ['failed', 'aborted', 'interrupted'].includes(snapshot.status ?? '')
            ? workflowFailureSummary(snapshot, error)
            : error
              ? [terminalLine(error)]
              : []),
          snapshot.status === 'completed'
            ? `Report available: /workflows ${snapshot.runId} --report. Retrieve the result with { "result": "${snapshot.runId}" }.`
            : snapshot.status === 'running'
              ? 'The run is still finishing. Continue other work rather than polling.'
              : ''
        ]
          .filter(Boolean)
          .join('\n')
      }
    ],
    details: { ...compactSnapshot(snapshot), ...(sdlc ? { sdlc } : {}) }
  };
}

function normalizeWorkflowScript(script: string): string {
  let text = script.trim();
  const fence = text.match(/^```(?:js|javascript)?\s*\n([\s\S]*?)\n```$/i);
  if (fence) text = fence[1].trim();
  return text;
}

function buildProfileGuidelines(profiles: readonly WorkflowProfile[]): string[] {
  if (profiles.length === 0) return [];
  const availableProfiles = profiles
    .map((profile) => `- ${JSON.stringify(profile.name)} — ${profile.description}`)
    .join('\n');
  return [
    [
      'For workflow, profiles are optional approved routes for a model and thinking level.',
      '',
      'Available profiles:',
      availableProfiles,
      '',
      'Set `profile` only to an exact name from the available profiles. Choose based on the description; profile order has no meaning. Replace "<profile-name>" below with the selected name:',
      '- Workflow default: `export const meta = { name: "workflow_name", description: "Workflow description", profile: "<profile-name>" }`',
      '- For agents launched after a phase: `phase("Review", { profile: "<profile-name>" })`',
      '- For one subagent: `agent("...", { profile: "<profile-name>" })`',
      '',
      'Profile precedence is: agent > phase > workflow > role fallback > active session. A later `phase("Next phase")` without `profile` resets routing to the workflow profile, then the selected role fallback or active session. `meta.phases` is documentation only; use runtime `phase(...)` to select a phase profile.'
    ].join('\n')
  ];
}
