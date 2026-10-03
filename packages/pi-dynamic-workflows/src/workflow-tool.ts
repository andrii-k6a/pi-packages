import {
  type CreateAgentSessionOptions,
  defineTool,
  type ExtensionContext,
  type ToolDefinition
} from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import {
  createToolUpdateWorkflowDisplay,
  createWorkflowSnapshot,
  preview,
  recomputeWorkflowSnapshot,
  renderWorkflowText,
  type WorkflowSnapshot
} from './display.js';
import { createWorkflowProfileResolver, type WorkflowProfile } from './profiles.js';
import { hasUsage } from './usage.js';
import { parseWorkflowScript, runWorkflow, type WorkflowRunResult } from './workflow.js';

const workflowToolSchema = Type.Object({
  script: Type.String({
    description:
      "Raw JavaScript, no Markdown fences; start with export const meta = { name: '...', description: '...' }."
  }),
  args: Type.Optional(
    Type.Any({
      description: 'Optional JSON value exposed to the workflow script as global `args`.'
    })
  )
});

export type WorkflowToolInput = {
  script: string;
  args?: unknown;
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
  getActiveTools?: () => readonly string[];
}

export function inheritsCodemode(getActiveTools?: () => readonly string[]): boolean {
  return getActiveTools?.().includes('codemode') ?? false;
}

export function createWorkflowTool(
  options: WorkflowToolOptions = {}
): ToolDefinition<typeof workflowToolSchema, unknown> {
  const profileGuidelines = buildProfileGuidelines(options.profiles ?? []);

  return defineTool({
    name: 'workflow',
    label: 'Workflow',
    description:
      'Run deterministic JavaScript workflows that orchestrate isolated subagents with agent(), parallel(), and pipeline().',
    promptSnippet:
      "Run a workflow. Required header: export const meta = { name: 'short_snake_case', description: 'non-empty description' }; call phase(title) for live progress.",
    promptGuidelines: [
      'Use workflow only when the user explicitly asks for a workflow, fan-out, or multi-agent orchestration; suits decomposable work (repo inspection, independent research/checks, multi-perspective review, fan-out/fan-in synthesis), not a quick read/edit or when ordinary tools suffice.',
      "For workflow, script takes one raw JavaScript string (no Markdown fences/prose). First statement: `export const meta = { name: 'short_snake_case', description: '...' }` (both non-empty); meta.phases is optional metadata (title strings or { title, detail?, profile? } outline).",
      'For workflow, phase(title) starts live progress groups. Phase names may be conditional or built in a loop; do not predeclare speculative phases.',
      'For workflow, use plain JavaScript: no TypeScript syntax, imports, require(), fs, Date.now(), Math.random(), new Date(). Globals: agent(prompt, opts), parallel(thunks), pipeline(items, ...stages), phase(title), log(message), args, cwd, process.cwd(), budget. Call agent() at least once.',
      "For workflow, parallel() takes functions, not promises: `await parallel(items.map(item => () => agent('...', { label: '...' })))`, never `await parallel(items.map(item => agent(...)))`; results in input order.",
      "For workflow, pipeline(items, ...stages) runs each item's stages sequentially, items concurrently; stage args: (previousValue, originalItem, index).",
      'For workflow, label every agent() uniquely (2-5 words); subagents lack parent context—include task context and relevant paths in prompts. Subagents cannot start workflows themselves.',
      'For workflow, failed agent()/parallel()/pipeline() branches return null and log failure unless aborted; check for nulls before synthesis. Use a final synthesis/assertion agent to combine results; return compact JSON-serializable value with ok/verdict and important outputs.',
      'For workflow, pass plain JSON Schema via opts.schema for machine-readable agent() output; agent() returns the validated object. Use JSON Schema syntax, not TypeScript or TypeBox constructors.',
      ...profileGuidelines
    ],
    parameters: workflowToolSchema,
    // Orchestrates subagents and streams progress, so only the model may call it, never
    // codemode scripts via ctx.executeTool().
    exposure: 'model-only',
    prepareArguments(args) {
      return normalizeWorkflowToolArgs(args);
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const script = normalizeWorkflowScript(params.script);
      const parsed = parseWorkflowScript(script);
      let snapshot: WorkflowSnapshot = createWorkflowSnapshot(parsed.meta);
      const display = createToolUpdateWorkflowDisplay(onUpdate, undefined, workflowDisplayOptions);

      const update = () => {
        snapshot = recomputeWorkflowSnapshot(snapshot);
        display.update(snapshot);
      };

      const recordPhase = (title: string | undefined) => {
        if (!title) return;
        if (!snapshot.phases.includes(title)) snapshot.phases.push(title);
      };

      let result: WorkflowRunResult;
      try {
        result = await runWorkflow(script, {
          cwd: options.cwd ?? ctx.cwd,
          args: params.args,
          signal,
          concurrency: options.concurrency,
          codemode: inheritsCodemode(options.getActiveTools),
          session: createWorkflowSessionOptions(ctx),
          profileResolver: createWorkflowProfileResolver(options.profiles ?? [], ctx),
          onLog(message) {
            snapshot.logs.push(message);
            update();
          },
          onPhase(title) {
            snapshot.currentPhase = title;
            recordPhase(title);
            update();
          },
          onAgentStart(event) {
            if (signal?.aborted) throw new Error('Workflow was aborted');
            recordPhase(event.phase);
            snapshot.agents.push({
              id: snapshot.agents.length + 1,
              label: event.label,
              phase: event.phase,
              profile: event.profile,
              prompt: event.prompt,
              status: 'running'
            });
            update();
          },
          onAgentEnd(event) {
            const agent = [...snapshot.agents]
              .reverse()
              .find((item) => item.label === event.label && item.status === 'running');
            if (agent) {
              agent.status = event.result === null ? 'error' : 'done';
              agent.resultPreview = preview(event.result);
            }
            update();
          }
        });
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) {
          for (const agent of snapshot.agents) {
            if (agent.status === 'running') {
              agent.status = 'skipped';
              agent.error = 'aborted';
            }
          }
          snapshot = recomputeWorkflowSnapshot(snapshot);
          display.complete(snapshot);
          throw new Error('Workflow was aborted');
        }
        throw error;
      }

      if (result.agentCount === 0) {
        throw new Error(
          'workflow scripts must call agent() at least once; this workflow declared phases but did not run any subagents'
        );
      }

      snapshot.result = result.result;
      snapshot.durationMs = result.durationMs;
      snapshot = recomputeWorkflowSnapshot(snapshot);
      display.complete(snapshot);

      // Aborted or failed workflows still throw, so their usage cannot be reported here.
      return {
        ...(hasUsage(result.usage) ? { usage: result.usage } : {}),
        content: [
          {
            type: 'text',
            text: `Workflow ${result.meta.name} completed with ${result.agentCount} agent(s).\n\nResult:\n${JSON.stringify(result.result, null, 2)}`
          }
        ],
        details: {
          ...snapshot,
          meta: result.meta,
          phases: result.phases,
          logs: result.logs,
          result: result.result,
          durationMs: result.durationMs,
          usage: result.usage
        }
      };
    },
    renderCall(_args, theme) {
      return new Text(theme.fg('toolTitle', theme.bold('workflow')), 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      const snapshot = result.details as WorkflowSnapshot | undefined;
      if (snapshot?.name) {
        return new Text(renderWorkflowText(snapshot, !isPartial, workflowDisplayOptions), 0, 0);
      }
      const text = result.content?.[0];
      return new Text(text?.type === 'text' ? text.text : theme.fg('muted', 'workflow'), 0, 0);
    }
  });
}

export function createWorkflowSessionOptions(
  ctx: Pick<ExtensionContext, 'modelRegistry' | 'model' | 'thinkingLevel' | 'scopedModels'>
): Partial<CreateAgentSessionOptions> {
  return {
    modelRuntime: getModelRuntime(ctx.modelRegistry),
    model: ctx.model,
    thinkingLevel: ctx.thinkingLevel,
    scopedModels: [...ctx.scopedModels]
  };
}

function getModelRuntime(
  modelRegistry: unknown
): NonNullable<CreateAgentSessionOptions['modelRuntime']> {
  // Pi exposes the parent ModelRegistry to extensions but no public accessor for its
  // ModelRuntime (verified through 1.0.0), and createAgentSession() creates a separate runtime
  // when modelRuntime is omitted, which would lose the parent's provider/auth configuration.
  // Keep this compatibility shim narrow, validated, and loud until Pi exposes a public accessor.
  const runtime = (modelRegistry as { runtime?: unknown }).runtime;
  if (!isModelRuntime(runtime)) {
    throw new Error(
      'workflow requires Pi ModelRuntime from ExtensionContext; current pi-coding-agent does not expose it publicly'
    );
  }
  return runtime;
}

function isModelRuntime(
  value: unknown
): value is NonNullable<CreateAgentSessionOptions['modelRuntime']> {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return ['getAuth', 'getModel', 'getAvailable', 'hasConfiguredAuth', 'streamSimple'].every(
    (method) => typeof candidate[method] === 'function'
  );
}

function normalizeWorkflowToolArgs(args: unknown): WorkflowToolInput {
  if (!args || typeof args !== 'object')
    throw new Error('workflow requires an object argument with a script string');
  const value = args as Record<string, unknown>;
  if (typeof value.script !== 'string')
    throw new Error('workflow requires `script` to be a string');
  return { ...value, script: normalizeWorkflowScript(value.script) } as WorkflowToolInput;
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

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /\babort(?:ed)?\b/i.test(error.message);
}
