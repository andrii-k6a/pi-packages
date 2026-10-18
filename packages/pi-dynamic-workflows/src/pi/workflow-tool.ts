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
import { capturePromptContext } from '../durable/subagent.js';
import type { WorkflowProfile } from '../profiles/contracts.js';
import { createWorkflowProfileResolver } from '../profiles/routing.js';
import { terminalLine, terminalMultiline } from '../shared/terminal-text.js';
import { hasUsage } from '../shared/usage.js';
import { compactSnapshot, type WorkflowSnapshot } from '../workflow/snapshot.js';
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
  )
});

export type WorkflowToolInput = {
  script?: string;
  args?: Record<string, unknown>;
  resume?: string;
  tokenBudget?: number;
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
      'Use workflow only when the user explicitly asks for a workflow, fan-out, or multi-agent orchestration; for decomposable work, not quick edits.',
      "Script is raw JavaScript, no fences/TypeScript. First statement: `export const meta = { name: 'short_snake_case', description: '...' }` (non-empty); meta.phases is optional metadata (titles or { title, detail?, profile? }).",
      'phase(title) groups live progress. Phase names may be conditional or built in a loop; avoid speculative phases.',
      'No imports, require(), fs, Date.now(), Math.random(), new Date(). Globals: agent, parallel, pipeline, phase, log, args, cwd, process.cwd(), budget. Call agent() at least once. No loops that neither await nor end.',
      "parallel() takes functions, not promises: `await parallel(items.map(item => () => agent('...', { label: '...' })))`, never `await parallel(items.map(item => agent(...)))`; results in input order.",
      'pipeline(items, ...stages): sequential stages per item, concurrent items; stage args (previousValue, originalItem, index).',
      'Replay must produce identical calls given recorded results; avoid Promise.race() over agents and scheduling-dependent branches. Checks do not prove determinism.',
      'Subagents have separate conversations, shared filesystem access. isolation: "worktree" is a non-enforced prompt hint; no worktree is created.',
      'Label agents uniquely; include task context and paths, not parent context. Subagents cannot start workflows themselves.',
      'Ordinary agent()/parallel()/pipeline() failures return null: check for nulls before synthesis. Abort/profile routing failures reject. Synthesize with a final agent; return compact JSON.',
      'Pass plain JSON Schema via opts.schema for validated structured agent() output; root type must be "object".',
      'budget.remaining() is Infinity unless tokenBudget is set (soft limit).',
      "After failure/abort/interruption, resume: '<run id>' (plus a fixed script if needed); identical completed agent calls are reused.",
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
      const script =
        params.script === undefined ? undefined : normalizeWorkflowScript(params.script);
      const resume = params.resume?.trim() || undefined;
      if (!script && !resume) {
        throw new Error('workflow requires `script`, or `resume` with an earlier run id');
      }
      if (signal?.aborted) throw new Error('Workflow was aborted');
      if (!ctx.model) {
        throw new Error(
          'workflow requires an active session model for its subagents; select one with /model'
        );
      }

      const binding = createWorkflowRunBinding(ctx, { ...options, signal, toolCallId });
      let handle: WorkflowAttemptHandle;
      try {
        handle = resume
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
          ...(outcome.usageReceipt ? { usageReceipt: outcome.usageReceipt } : {})
        }
      };
    },
    renderCall(args, theme) {
      const resume = (args as WorkflowToolInput | undefined)?.resume;
      const title = theme.fg('toolTitle', theme.bold('workflow'));
      return new Text(
        resume ? `${title} ${theme.fg('muted', `resume ${terminalLine(resume)}`)}` : title,
        0,
        0
      );
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
  if (value.script === undefined && value.resume === undefined)
    throw new Error('workflow requires `script`, or `resume` with an earlier run id');
  return {
    ...value,
    ...(typeof value.script === 'string' ? { script: normalizeWorkflowScript(value.script) } : {})
  } as WorkflowToolInput;
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
