import { inspect, types } from 'node:util';
import vm from 'node:vm';
import type { Usage } from '@earendil-works/pi-ai';
import {
  type ResolvedWorkflowProfile,
  type WorkflowProfileResolver,
  WorkflowProfileRoutingError
} from '../profiles/contracts.js';
import { addUsage, emptyUsage, hasUsage } from '../shared/usage.js';
import type { AgentOptions, WorkflowRunOptions, WorkflowRunResult } from './contracts.js';
import { parseWorkflowScript } from './parser.js';
import { createWorkflowContext } from './sandbox.js';
import { requireProfileName, throwProfileMigrationError } from './validation.js';

interface RuntimeState {
  currentPhase?: string;
  currentProfile?: ResolvedWorkflowProfile;
  currentProfileName?: string;
  profileRoutingError?: WorkflowProfileRoutingError;
  logs: string[];
  phases: string[];
  agentCount: number;
  /** `agent()` calls admitted so far; unlike `agentCount` it is assigned at call time. */
  agentCalls: number;
  spent: number;
  usage: Usage;
}

const DEFAULT_SYNC_TIMEOUT_MS = 10_000;
const MAX_CONCURRENCY = 16;
const MAX_LOG_LENGTH = 2000;

/**
 * Interpret a trusted workflow script. Replay requires the author to produce identical requests
 * given recorded results. Parser checks and runtime clock/random restrictions help catch mistakes;
 * they do not prove determinism, and Node vm is not a security boundary.
 */
export async function runWorkflow<T = unknown>(
  script: string,
  options: WorkflowRunOptions
): Promise<WorkflowRunResult<T>> {
  if (!options?.agent || typeof options.agent.run !== 'function') {
    throw new TypeError('runWorkflow requires an agent executor');
  }
  const started = Date.now();
  const { meta, body } = parseWorkflowScript(script);
  const workflowProfileName = meta.profile;
  const workflowProfile = workflowProfileName
    ? resolveProfile(workflowProfileName, options.profileResolver)
    : undefined;
  const state: RuntimeState = {
    currentProfile: workflowProfile,
    currentProfileName: workflowProfileName,
    logs: [],
    phases: [],
    agentCount: 0,
    agentCalls: 0,
    spent: 0,
    usage: emptyUsage()
  };
  const agentRunner = options.agent;
  const concurrency = resolveConcurrency(options.concurrency);
  const limiter = createLimiter(concurrency);
  const pendingAgentRuns = new Set<Promise<unknown>>();

  const record = (text: string) => {
    state.logs.push(text);
    options.onLog?.(text);
  };
  const log = (...messages: unknown[]) => record(formatLogArguments(messages));

  const phase = (title: unknown, phaseOptions: unknown = {}) => {
    const text = requireString(title, 'phase title');
    const normalizedOptions = normalizePhaseOptions(phaseOptions);
    const profileName = normalizedOptions.profile ?? workflowProfileName;
    // Resolve before changing anything: a rejected profile must not leave the new phase name
    // paired with the previous phase's route, even if the script catches the error.
    let profile: ResolvedWorkflowProfile | undefined;
    try {
      profile = profileName ? resolveProfile(profileName, options.profileResolver) : undefined;
    } catch (error) {
      if (error instanceof WorkflowProfileRoutingError) state.profileRoutingError ??= error;
      throw error;
    }
    state.currentPhase = text;
    state.currentProfileName = profileName;
    state.currentProfile = profile;
    if (!state.phases.includes(text)) state.phases.push(text);
    options.onPhase?.(text);
  };

  const budget = Object.freeze({
    total: options.tokenBudget ?? null,
    spent: () => state.spent,
    remaining: () =>
      options.tokenBudget == null ? Infinity : Math.max(0, options.tokenBudget - state.spent)
  });

  const throwIfAborted = () => {
    if (options.signal?.aborted) throw new Error('workflow aborted');
  };

  const trackAgentRun = <T>(run: Promise<T>): Promise<T> => {
    pendingAgentRuns.add(run);
    run.then(
      () => pendingAgentRuns.delete(run),
      (error) => {
        pendingAgentRuns.delete(run);
        if (error instanceof WorkflowProfileRoutingError) {
          state.profileRoutingError ??= error;
        }
      }
    );
    return run;
  };

  const agent = (prompt: unknown, agentOptions: unknown = {}): Promise<unknown> => {
    let taskPrompt: string;
    let normalizedOptions: AgentOptions;
    let assignedPhase: string | undefined;
    let requestedLabel: string | undefined;
    let profileName: string | undefined;
    let profile: ResolvedWorkflowProfile | undefined;
    try {
      throwIfAborted();
      if (budget.total !== null && budget.remaining() <= 0)
        throw new Error('workflow token budget exhausted');
      if (options.maxAgents !== undefined && state.agentCalls >= options.maxAgents) {
        throw new Error(
          `workflow agent limit reached: at most ${options.maxAgents} agent() calls are allowed per attempt`
        );
      }
      taskPrompt = requireString(prompt, 'agent prompt');
      normalizedOptions = normalizeAgentOptions(agentOptions);
      assignedPhase = normalizedOptions.phase ?? state.currentPhase;
      requestedLabel = normalizedOptions.label?.trim();
      profileName = normalizedOptions.profile ?? state.currentProfileName;
      profile = normalizedOptions.profile
        ? resolveProfile(normalizedOptions.profile, options.profileResolver)
        : state.currentProfile;
      state.agentCalls++;
    } catch (error) {
      if (error instanceof WorkflowProfileRoutingError) state.profileRoutingError ??= error;
      return trackAgentRun(Promise.reject(error));
    }

    const run = limiter(async () => {
      state.agentCount++;
      const label = requestedLabel || defaultAgentLabel(assignedPhase, state.agentCount);
      options.onAgentStart?.({
        label,
        phase: assignedPhase,
        profile: profileName,
        prompt: taskPrompt
      });
      let reportedUsage = false;
      try {
        throwIfAborted();
        const result = await agentRunner.run(taskPrompt, {
          label,
          requestedLabel: requestedLabel || undefined,
          phase: assignedPhase,
          profile: profileName,
          schema: normalizedOptions.schema,
          signal: options.signal,
          instructions: buildAgentInstructions(assignedPhase, normalizedOptions),
          route: profile,
          onUsage(usage) {
            // Providers without usage reporting yield zeros; keep the estimate fallback for them.
            if (hasUsage(usage)) reportedUsage = true;
            const previousTokens = state.usage.totalTokens;
            state.usage = addUsage(state.usage, usage);
            state.spent += state.usage.totalTokens - previousTokens;
          }
        });
        throwIfAborted();
        if (!reportedUsage) state.spent += estimateTokens(result);
        options.onAgentEnd?.({ label, phase: assignedPhase, result });
        return result;
      } catch (error) {
        if (options.signal?.aborted || error instanceof WorkflowProfileRoutingError) throw error;
        record(
          formatLogArguments([
            `agent ${label} failed: ${error instanceof Error ? error.message : String(error)}`
          ])
        );
        options.onAgentEnd?.({ label, phase: assignedPhase, result: null });
        return null;
      }
    });
    return trackAgentRun(run);
  };

  const parallel = async (thunks: Array<() => Promise<unknown>>) => {
    throwIfAborted();
    if (!Array.isArray(thunks)) throw new TypeError('parallel() expects an array of functions');
    if (thunks.some((thunk) => typeof thunk !== 'function')) {
      throw new TypeError(
        'parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)'
      );
    }
    return Promise.all(
      thunks.map(async (thunk, index) => {
        try {
          return await thunk();
        } catch (error) {
          if (options.signal?.aborted || error instanceof WorkflowProfileRoutingError) throw error;
          record(
            formatLogArguments([
              `parallel[${index}] failed: ${error instanceof Error ? error.message : String(error)}`
            ])
          );
          return null;
        }
      })
    );
  };

  const pipeline = async (
    items: unknown[],
    ...stages: Array<(prev: unknown, original: unknown, index: number) => unknown>
  ) => {
    throwIfAborted();
    if (!Array.isArray(items))
      throw new TypeError('pipeline() expects an array as the first argument');
    if (stages.some((stage) => typeof stage !== 'function')) {
      throw new TypeError(
        'pipeline() stages must be functions: pipeline(items, item => ..., result => ...)'
      );
    }
    return Promise.all(
      items.map(async (item, index) => {
        let value: unknown = item;
        for (const stage of stages) {
          try {
            throwIfAborted();
            value = await stage(value, item, index);
            throwIfAborted();
          } catch (error) {
            if (options.signal?.aborted || error instanceof WorkflowProfileRoutingError)
              throw error;
            record(
              formatLogArguments([
                `pipeline[${index}] failed: ${error instanceof Error ? error.message : String(error)}`
              ])
            );
            return null;
          }
        }
        return value;
      })
    );
  };

  const context = createWorkflowContext({
    agent,
    parallel,
    pipeline,
    log,
    phase,
    args: options.args,
    cwd: options.cwd ?? process.cwd(),
    process: Object.freeze({ cwd: () => options.cwd ?? process.cwd() }),
    budget,
    console: {
      log,
      info: log,
      debug: log,
      warn: (...messages: unknown[]) => record(formatLogArguments(['[warn]', ...messages])),
      error: (...messages: unknown[]) => record(formatLogArguments(['[error]', ...messages]))
    }
  });

  const wrapped = `(async () => {\n${body}\n})()`;
  const syncTimeoutMs = options.syncTimeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS;
  let running: Promise<unknown>;
  try {
    running = new vm.Script(wrapped, { filename: `${meta.name || 'workflow'}.js` }).runInContext(
      context,
      { timeout: syncTimeoutMs }
    );
  } catch (error) {
    if ((error as { code?: string }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      throw new Error(
        `workflow script ran for more than ${Math.round(syncTimeoutMs / 1000)}s before its first await; avoid long synchronous loops`
      );
    }
    throw error;
  }
  const result = await running;
  await Promise.allSettled([...pendingAgentRuns]);
  if (state.profileRoutingError) throw state.profileRoutingError;
  assertStructuredCloneable(result, 'workflow result');
  return {
    meta,
    result: result as T,
    logs: state.logs,
    phases: state.phases,
    agentCount: state.agentCount,
    durationMs: Date.now() - started,
    usage: state.usage
  };
}

function resolveConcurrency(requested: number | undefined): number {
  const fallback = Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 8) - 2);
  const value = typeof requested === 'number' && Number.isFinite(requested) ? requested : fallback;
  return Math.max(1, Math.min(Math.floor(value), MAX_CONCURRENCY));
}

/** `console.log`-style: every argument, objects inspected, on one bounded line. */
function formatLogArguments(values: readonly unknown[]): string {
  const text = values.map(formatLogValue).join(' ');
  return text.length > MAX_LOG_LENGTH ? `${text.slice(0, MAX_LOG_LENGTH - 1)}…` : text;
}

function formatLogValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (types.isNativeError(value)) return `${value.name}: ${value.message}`;
  try {
    return inspect(value, {
      depth: 4,
      breakLength: Number.POSITIVE_INFINITY,
      maxArrayLength: 50,
      maxStringLength: 500
    });
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function createLimiter(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    active--;
    queue.shift()?.();
  };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      next();
    }
  };
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, name);
}

function normalizeAgentOptions(value: unknown): AgentOptions {
  if (!value || typeof value !== 'object') throw new TypeError('agent options must be an object');
  const options = value as AgentOptions & { model?: unknown };
  if ('model' in options) throwProfileMigrationError('agent');
  return {
    ...options,
    schema: normalizeSchema(options.schema),
    label: optionalString(options.label, 'agent label'),
    phase: optionalString(options.phase, 'agent phase'),
    profile: optionalProfileName(options.profile, 'agent profile'),
    isolation: normalizeIsolation(options.isolation),
    agentType: optionalString(options.agentType, 'agent type')
  };
}

/**
 * A schema becomes the parameters of a `structured_output` tool, and model providers require
 * tool parameters to be a JSON Schema object. Fail here, with advice, instead of after retries.
 */
function normalizeSchema(value: unknown): AgentOptions['schema'] {
  if (value === undefined) return undefined;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (value as { type?: unknown }).type !== 'object'
  ) {
    throw new TypeError(
      'agent schema must be a JSON Schema object with `type: "object"` at its root. ' +
        'Wrap other results, for example { type: "object", properties: { items: { type: "array", items: { type: "string" } } }, required: ["items"] }'
    );
  }
  return value as AgentOptions['schema'];
}

function normalizeIsolation(value: unknown): 'worktree' | undefined {
  if (value !== undefined && value !== 'worktree') {
    throw new TypeError('agent isolation must be "worktree" (a non-enforced prompt hint)');
  }
  return value;
}

function normalizePhaseOptions(value: unknown): { profile?: string } {
  if (!value || typeof value !== 'object') throw new TypeError('phase options must be an object');
  const options = value as { profile?: unknown; model?: unknown };
  if ('model' in options) throwProfileMigrationError('phase');
  return { profile: optionalProfileName(options.profile, 'phase profile') };
}

function optionalProfileName(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  return requireProfileName(value, name);
}

function resolveProfile(
  name: string,
  resolver: WorkflowProfileResolver | undefined
): ResolvedWorkflowProfile {
  if (!resolver) throw new WorkflowProfileRoutingError(name, 'profile routing is unavailable');
  return resolver(name);
}

function assertStructuredCloneable(value: unknown, name: string): void {
  try {
    structuredClone(value);
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : '';
    throw new Error(
      `${name} must be structured-cloneable; did you forget to await agent(), parallel(), or pipeline()?${detail}`
    );
  }
}

function defaultAgentLabel(phase: string | undefined, index: number): string {
  return phase ? `${phase} agent ${index}` : `agent ${index}`;
}

function buildAgentInstructions(
  phase: string | undefined,
  options: AgentOptions
): string | undefined {
  const lines = [];
  if (phase) lines.push(`Workflow phase: ${phase}`);
  if (options.agentType) lines.push(`Act as workflow subagent type: ${options.agentType}`);
  if (options.isolation) lines.push(`Requested isolation: ${options.isolation}`);
  return lines.length ? lines.join('\n') : undefined;
}

function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value ?? '').length / 4);
}
