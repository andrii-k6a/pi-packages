/**
 * Ambient globals available inside pi-dynamic-workflows workflow scripts.
 *
 * Add this to a JavaScript or TypeScript workflow file for editor IntelliSense:
 *
 *   /// <reference types="@andrii-k6a/pi-dynamic-workflows/workflow" />
 */

export {};

declare global {
  /** Literal workflow metadata. Must be the first statement: `export const meta = { ... }`. */
  interface WorkflowMeta {
    name: string;
    description: string;
    whenToUse?: string;
    /** Optional approved profile name for all subagents unless a runtime phase or agent overrides it. */
    profile?: string;
    /** Optional documentation for an expected outline. Live progress is driven by `phase(...)`. A plain string is shorthand for `{ title: string }`. */
    phases?: Array<string | WorkflowMetaPhase>;
  }

  interface WorkflowMetaPhase {
    title: string;
    detail?: string;
    /** Optional approved profile name. This metadata documents the expected outline only. */
    profile?: string;
  }

  interface WorkflowAgentOptions<TSchema = JsonSchema> {
    /** Short label shown in the live progress UI. */
    label?: string;
    /** Override the current runtime phase for this agent. */
    phase?: string;
    /**
     * JSON Schema for structured output; its root must be `type: 'object'` (wrap lists in a property).
     * When present, the returned value is typed as unknown unless you provide a generic.
     */
    schema?: TSchema;
    /** Optional approved profile name for this subagent. */
    profile?: string;
    /** Non-enforced prompt hint. Does not create a worktree or change filesystem access. */
    isolation?: 'worktree';
    /** Requested subagent role/type. */
    agentType?: string;
  }

  type JsonPrimitive = string | number | boolean | null;
  type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
  interface JsonObject {
    [key: string]: JsonValue;
  }

  interface JsonSchema {
    type?: string | string[];
    properties?: Record<string, JsonSchema>;
    items?: JsonSchema | JsonSchema[];
    required?: string[];
    additionalProperties?: boolean | JsonSchema;
    enum?: JsonValue[];
    const?: JsonValue;
    description?: string;
    [key: string]: unknown;
  }

  interface WorkflowBudget {
    /** Soft token limit set by the workflow call's `tokenBudget`; null means no limit. */
    total: number | null;
    /** Tokens reported by subagents; successful runs with no usage report use an estimate. */
    spent(): number;
    /** Total minus spent(), floored at zero; Infinity when there is no limit. */
    remaining(): number;
  }

  /**
   * Spawn a subagent with separate conversation context, but shared filesystem access.
   * Ordinary executor failures return null. Abort and profile routing failures reject.
   * Prose output is string; schema output is unknown unless an explicit generic is supplied.
   *
   * Runs are durable: when a run is resumed the script is replayed from the top, and an identical call
   * (same prompt, label, instructions, schema, and route) returns its recorded result instead of running again.
   */
  function agent<T = unknown>(
    prompt: string,
    options: WorkflowAgentOptions & { schema: JsonSchema }
  ): Promise<T | null>;
  function agent(
    prompt: string,
    options?: WorkflowAgentOptions & { schema?: undefined }
  ): Promise<string | null>;
  /** Optional-schema options return unknown; a result generic requires a schema that is present. */
  function agent(prompt: string, options: WorkflowAgentOptions): Promise<unknown>;

  /** Run independent async tasks concurrently. Ordinary branch failures return null. Pass functions, not promises. */
  function parallel<T>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>>;

  /** Run each item through sequential async stages while items fan out. Ordinary stage failures return null. */
  function pipeline<TItem, TResult = unknown>(
    items: TItem[],
    ...stages: Array<(previous: unknown, original: TItem, index: number) => TResult | Promise<TResult>>
  ): Promise<Array<TResult | null>>;

  /** Mark the current workflow phase for progress grouping and optionally select an approved profile. */
  function phase(title: string, options?: { profile?: string }): void;

  /**
   * Append a workflow-level log line. Every value is recorded, space-separated; strings stay as
   * they are and other values are inspected. `console.log` behaves the same.
   */
  function log(...values: unknown[]): void;

  /** Optional JSON object passed to the workflow tool. Narrow with a local type assertion when needed. */
  const args: unknown;

  /** Current working directory for the workflow/subagents. */
  const cwd: string;

  /** Deterministic process shim exposing only cwd(). */
  const process: { cwd(): string };

  /** Token budget tracker using reported subagent usage when available. */
  const budget: WorkflowBudget;
}
