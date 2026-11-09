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
import { compactSnapshot, type WorkflowSnapshot } from '../workflow/snapshot.js';
import type { WorkflowBackgroundRuns } from './background.js';
import { createToolUpdateWorkflowDisplay, renderWorkflowText } from './display.js';

const workflowToolSchema = Type.Object({
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
        'Run id of an earlier workflow to continue or retry; completed agent() results are reused.'
    })
  ),
  background: Type.Optional(
    Type.Boolean({
      description:
        'Default false. Return a run id without waiting. TUI/RPC only. Continue other work, do not poll. A follow-up requests result retrieval when ready. Session changes interrupt the run safely.'
    })
  ),
  status: Type.Optional(Type.String({ description: 'Inspect this run id without starting work.' })),
  result: Type.Optional(
    Type.String({
      description: 'Retrieve this completed run id and its usage. Does not resume work.'
    })
  ),
  cancel: Type.Optional(Type.String({ description: 'Cancel this run id. Completed work is kept.' }))
});

export type WorkflowToolInput = {
  script?: string;
  args?: Record<string, unknown>;
  resume?: string;
  tokenBudget?: number;
  background?: boolean;
  status?: string;
  result?: string;
  cancel?: string;
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
      'Run replayable JavaScript workflows that orchestrate subagents with separate conversation context using agent(), parallel(), and pipeline(). Runs are durable and resumable by run id; subagents share filesystem access.',
    promptSnippet:
      "Run a workflow. Required header: export const meta = { name: 'short_snake_case', description: 'non-empty description' }; call phase(title) for live progress.",
    promptGuidelines: [
      'Use workflow only when the user explicitly asks for a workflow, fan-out, or multi-agent orchestration. Not for quick edits.',
      'Use raw JavaScript, no fences/TypeScript. First statement: `export const meta = ...` with non-empty name and description. meta.phases is optional metadata.',
      'phase(title) shows progress. Phase names may be conditional or built in a loop; avoid speculative phases.',
      'No imports, require(), fs, Date.now(), Math.random(), new Date(). Globals: agent, parallel, pipeline, phase, log, args, cwd, process.cwd(), budget. Call agent() at least once. Loops must await or end.',
      "parallel() takes functions, not promises: `await parallel(items.map(item => () => agent('...', { label: '...' })))`, never `await parallel(items.map(item => agent(...)))`; results in input order.",
      'pipeline(items, ...stages): sequential stages per item, concurrent items; stage args (previousValue, originalItem, index).',
      'Replay needs identical calls given recorded results. Avoid Promise.race() and scheduling-dependent branches. Checks do not prove determinism.',
      'Use isolation: "worktree" for independent editing agents. It retains a HEAD checkout without parent edits. Git errors fail. Not a sandbox. Merge/remove manually.',
      'Ask isolated agents for branch, checkout path, and verification results. Later agents do not automatically see their edits. Inspect via /workflows.',
      'Label agents uniquely. Give self-contained tasks and relative paths. Subagents cannot start workflows themselves.',
      'Ordinary agent()/parallel()/pipeline() failures return null. Abort/profile routing failures reject. Check for nulls before final-agent synthesis. Return compact JSON.',
      'Pass plain JSON Schema via opts.schema for structured output. Its root type must be "object".',
      'budget.remaining() is Infinity unless tokenBudget is set (soft limit).',
      "After failure/abort/interruption, resume: '<run id>' (plus a fixed script if needed); identical completed agent calls are reused.",
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
      const query = params.status ?? params.result ?? params.cancel;
      if (query) {
        const cancelled = params.cancel ? await host.abort(query) : undefined;
        const ready = params.result ? await options.backgroundRuns?.prepareResult(query) : true;
        const live = options.backgroundRuns?.snapshot(query);
        if (live && (!params.result || ready === false)) {
          return workflowStatusResult(live, cancelled);
        }
        const report = await host.report(query);
        const attempt = report.attempts.at(-1);
        if (!attempt) throw new Error(`workflow run ${query} has no attempts`);
        if (!params.result || report.status !== 'completed') {
          return workflowStatusResult(
            { ...attemptSnapshot(report.run, attempt, Date.now()), status: report.status },
            cancelled,
            attempt.error
          );
        }
      }
      const script = params.script;
      const resume = params.result ?? params.resume?.trim();
      if (!script && !resume) {
        throw new Error('workflow requires `script`, or `resume` with an earlier run id');
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
        ...(params.background ? {} : { toolCallId })
      });
      let handle: WorkflowAttemptHandle;
      try {
        handle = params.result
          ? await host.result(params.result, binding)
          : resume
            ? await host.resume(
                resume,
                {
                  script,
                  args: params.args,
                  concurrency: options.concurrency,
                  tokenBudget: params.tokenBudget
                },
                binding
              )
            : await host.start(
                {
                  script: script as string,
                  args: params.args,
                  cwd: options.cwd ?? ctx.cwd,
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
              text: `Workflow started in the background. Run id: ${handle.runId}. Continue other work or end this turn. A follow-up will request result retrieval when ready. Do not poll. Use { "status": "${handle.runId}" } to inspect or { "cancel": "${handle.runId}" } to stop.`
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
      const name = outcome.snapshot.name;
      const summary = [
        `Workflow ${name} completed with ${outcome.agentCount} agent(s)`,
        reused ? ` (${reused} reused from earlier attempts)` : '',
        handle.mode === 'completed' ? ' (stored result of an already completed run)' : '',
        `. Run id: ${handle.runId}.`
      ].join('');

      // Spend of failed or aborted attempts is returned here too, once, when the run completes.
      return {
        ...(hasUsage(outcome.unreportedUsage) ? { usage: outcome.unreportedUsage } : {}),
        content: [
          {
            type: 'text',
            text: `${summary}\n\nResult:\n${JSON.stringify(outcome.value, null, 2)}`
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
      const action = (['status', 'result', 'cancel', 'resume'] as const).find(
        (key) => input?.[key]
      );
      const title = theme.fg('toolTitle', theme.bold('workflow'));
      const suffix = action
        ? `${action} ${terminalLine(input?.[action] ?? '')}`
        : input?.background
          ? 'background'
          : '';
      return new Text(suffix ? `${title} ${theme.fg('muted', suffix)}` : title, 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      const snapshot = result.details as WorkflowSnapshot | undefined;
      if (snapshot?.name) {
        return new Text(renderWorkflowText(snapshot, !isPartial, workflowDisplayOptions), 0, 0);
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
    Partial<Pick<ExtensionContext, 'isProjectTrusted' | 'sessionManager'>>,
  options: Pick<WorkflowToolOptions, 'profiles' | 'promptContext'> & {
    signal?: AbortSignal;
    toolCallId?: string;
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
    resolveProfile(name) {
      const route = resolver(name);
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
  const name = outcome.snapshot.name;
  const done = outcome.snapshot.doneCount;
  const kept = done ? ` ${done} completed agent result(s) are saved in the run.` : '';
  const resume = `{ "resume": "${runId}" }`;
  switch (outcome.status) {
    case 'aborted':
      return `Workflow ${name} was aborted (run ${runId}).${kept} Call workflow with ${resume} to finish it without re-running completed agents.`;
    case 'interrupted':
      return `Workflow ${name} was interrupted (run ${runId}): ${outcome.error}. Committed progress is saved. Call workflow with ${resume} to continue where it stopped.`;
    default:
      return `Workflow ${name} failed: ${outcome.error} (run ${runId}).${kept} Call workflow with ${resume} to retry, adding a fixed "script" if the script was at fault; identical agent() calls reuse their completed results.`;
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
  if (!args || typeof args !== 'object')
    throw new Error('workflow requires an object argument with a script string or a resume run id');
  const value = args as Record<string, unknown>;
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
      ['script', 'resume', 'args', 'tokenBudget', 'background'].some(
        (key) => value[key] !== undefined
      ))
  ) {
    throw new Error('workflow status, result, and cancel must be used alone with a run id');
  }
  if (value.script === undefined && value.resume === undefined && queries.length === 0)
    throw new Error('workflow requires `script`, or `resume` with an earlier run id');
  return {
    ...value,
    ...(typeof value.script === 'string' ? { script: normalizeWorkflowScript(value.script) } : {})
  } as WorkflowToolInput;
}

function workflowStatusResult(
  snapshot: WorkflowSnapshot,
  cancelled?: 'aborted' | 'not_live',
  error?: string
) {
  return {
    content: [
      {
        type: 'text' as const,
        text: [
          cancelled === 'aborted' ? 'Cancellation requested. Completed work is kept.' : '',
          `Workflow ${snapshot.name}: ${snapshot.status}. Run id: ${snapshot.runId}.`,
          `${snapshot.doneCount}/${snapshot.agentCount} agents done.`,
          error ?? '',
          snapshot.status === 'completed'
            ? `Retrieve the result with { "result": "${snapshot.runId}" }.`
            : snapshot.status === 'running'
              ? 'The run is still finishing. Continue other work rather than polling.'
              : `To continue, call workflow with { "resume": "${snapshot.runId}" }.`
        ]
          .filter(Boolean)
          .join('\n')
      }
    ],
    details: compactSnapshot(snapshot)
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
      'Profile precedence is: agent > phase > workflow > active session. A later `phase("Next phase")` without `profile` resets routing to the workflow profile, or to active session settings when the workflow has no profile. `meta.phases` is documentation only; use runtime `phase(...)` to select a phase profile. If no profile is selected at any level, the subagent uses the active session settings.'
    ].join('\n')
  ];
}
