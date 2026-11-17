import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Models } from '@earendil-works/pi-ai';
import { getAgentDir, parseFrontmatter } from '@earendil-works/pi-coding-agent';
import {
  defineExtension,
  type Extension,
  section,
  type ToolRegistration
} from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import {
  assertResolvedRole,
  createRolePolicy,
  defaultRoleCeiling,
  PACKAGED_ROLE_IDS,
  ROLE_OUTPUT_TOOL,
  requireRoleId,
  roleContentHash,
  roleHash,
  validateRoleFields,
  type WorkflowResolvedRole,
  type WorkflowRoleDescription,
  WorkflowRoleError,
  type WorkflowRoleResolver,
  type WorkflowRoleSelection,
  type WorkflowRoleSnapshot,
  type WorkflowRoleSource,
  type WorkflowRoleStage,
  type WorkflowRoleToolIdentity
} from '../workflow/roles.js';
import type { WorkflowRoute } from './docs.js';
import { ReviewTools } from './review-tools.js';
import { PACKAGED_ROLE_MARKDOWN } from './role-definitions.js';
import { createSubagentExtension } from './subagent.js';
import { workflowToolRevision } from './tool-identity.js';

export interface WorkflowRolePaths {
  /** Recorded root, not the cwd of a worker worktree. */
  projectRoot: string;
  agentDir?: string;
  projectTrusted?: boolean;
}

export interface WorkflowRoleExecution {
  executionId?: string;
  role?: string;
  resolvedRole?: WorkflowResolvedRole;
  toolset?: 'review';
  profile?: string;
  route?: WorkflowRoute;
}

export interface WorkflowRoleServices {
  resolve: WorkflowRoleResolver;
  /** Rehydrate pinned policies before scheduling restored conversations. */
  pin(role: WorkflowResolvedRole): void;
  /** Installs nothing: the caller must install the returned extension before scheduling. */
  prepare(input: WorkflowRoleExecution, output?: Extension): Extension;
  /** Required at Harness.open: recheck prepared policies before provider requests and polling. */
  guardModels(models: Models): Models;
  release(executionId: string): void;
}

export interface WorkflowRoleServiceOptions extends WorkflowRolePaths {
  /** Only currently admitted extensions. Re-evaluated before generation and execution. */
  extensions(): readonly Extension[];
  /** Exact host-owned registrations, never names. No tool is research-capable by default. */
  researchTools?(): readonly ToolRegistration[];
  /** A host-owned revision can account for implementation changes hidden in closures. */
  toolRevision?(owner: string, tool: ToolRegistration): string;
  /** Current host admission, including explicit revocation of built-in tools. */
  admitTool?(owner: string, tool: ToolRegistration): boolean;
  revokedRoles?(): readonly string[];
  recheckProfile?(name: string, pinned?: WorkflowRoute): void;
  pinned?: readonly WorkflowResolvedRole[];
}

/** Bind before Harness.open when role services are bootstrapped only after opening storage. */
export function guardWorkflowRoleModels(
  models: Models,
  roles: () => WorkflowRoleServices | undefined
): Models {
  return new Proxy(models, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const current = roles()?.guardModels(target) ?? target;
        return Reflect.apply(Reflect.get(current, property, current), current, args);
      };
    }
  });
}

export function workflowRoleExecutionId(input: { attemptId: number; key: string }): string {
  return `${input.attemptId}:${input.key}`;
}

interface RoleFile extends WorkflowRoleDescription {
  markdown?: string;
}

/** Validate Markdown separately from discovery so embedding hosts can supply definitions too. */
export function parseWorkflowRole(
  markdown: string,
  source: WorkflowRoleSource
): WorkflowRoleSnapshot & { enabled: boolean } {
  const normalized = markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!/^---\n[\s\S]*?\n---(?:\n|$)/.test(normalized)) {
    throw new WorkflowRoleError(`${source.path}: expected YAML frontmatter between --- lines`);
  }
  try {
    const { frontmatter, body } = parseFrontmatter(normalized);
    return validateRoleFields(frontmatter, body, source, roleContentHash(markdown));
  } catch (error) {
    if (error instanceof WorkflowRoleError) throw error;
    throw new WorkflowRoleError(
      `${source.path}: invalid Markdown frontmatter: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** Compact selection metadata. Project files are read only when the recorded root is trusted. */
export function listWorkflowRoles(options: WorkflowRolePaths): WorkflowRoleDescription[] {
  return [...discoverRoles(options).values()].map(
    ({ markdown: _markdown, ...description }) => description
  );
}

function discoverRoles(options: WorkflowRolePaths): Map<string, RoleFile> {
  const result = new Map<string, RoleFile>();
  for (const id of PACKAGED_ROLE_IDS) {
    const markdown = PACKAGED_ROLE_MARKDOWN[id];
    const source: WorkflowRoleSource = { scope: 'packaged', path: `packaged:${id}` };
    const parsed = parseWorkflowRole(markdown, source);
    result.set(id, {
      id,
      description: parsed.description,
      enabled: parsed.enabled,
      source,
      markdown
    });
  }
  for (const [directory, scope] of [
    [join(options.agentDir ?? getAgentDir(), 'agents'), 'user'],
    ...(options.projectTrusted
      ? [[join(resolve(options.projectRoot), '.pi', 'agents'), 'project']]
      : [])
  ] as Array<[string, 'user' | 'project']>) {
    let names: string[];
    try {
      names = readdirSync(directory)
        .filter((name) => name.endsWith('.md'))
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new WorkflowRoleError(`cannot read ${directory}: ${String(error)}`);
    }
    const seen = new Set<string>();
    for (const name of names) {
      const source = { scope, path: join(directory, name) };
      const parsed = readRole(source);
      if (seen.has(parsed.id))
        throw new WorkflowRoleError(
          `${directory}: duplicate role ${JSON.stringify(parsed.id)} in one scope`
        );
      seen.add(parsed.id);
      result.set(parsed.id, {
        id: parsed.id,
        description: parsed.description,
        enabled: parsed.enabled,
        source
      });
    }
  }
  return result;
}

function readRole(source: WorkflowRoleSource): WorkflowRoleSnapshot & { enabled: boolean } {
  try {
    const markdown =
      source.scope === 'packaged'
        ? PACKAGED_ROLE_MARKDOWN[source.path.slice('packaged:'.length) as WorkflowRoleStage]
        : readFileSync(source.path, 'utf8');
    if (markdown === undefined) throw new Error('packaged definition is unavailable');
    return parseWorkflowRole(markdown, source);
  } catch (error) {
    if (error instanceof WorkflowRoleError) throw error;
    throw new WorkflowRoleError(
      `cannot load ${source.path}: ${error instanceof Error ? error.message : String(error)}; restore the definition or create an explicit task revision`
    );
  }
}

interface AdmittedTool {
  identity: WorkflowRoleToolIdentity;
  tool: ToolRegistration;
}

/**
 * Roles select implementations, not extension bundles: unrelated extension hooks, wraps and tasks
 * are never imported into a role conversation. The only selected extension is the guarded bundle.
 */
export function createWorkflowRoleServices(
  options: WorkflowRoleServiceOptions
): WorkflowRoleServices {
  const definitions = new Map<string, WorkflowRoleSnapshot>();
  const policies = new Map<string, WorkflowResolvedRole>();
  const implementations = new Map<string, ToolRegistration>();
  const prepared = new Map<string, Extension>();
  const modelChecks = new Map<string, () => unknown>();
  const guardedModels = new WeakMap<Models, Models>();
  const policyKey = (id: string, selection: WorkflowRoleSelection) => {
    const ceiling = selection.ceiling ?? defaultRoleCeiling(id);
    return `${id}:${ceiling}:${selection.toolset === 'review' || ceiling === 'reviewer'}`;
  };

  const admission = (
    selection: WorkflowRoleSelection,
    id: string,
    selectedTools: readonly string[]
  ): AdmittedTool[] => {
    const extensions = [...options.extensions()];
    const seenOwners = new Set<string>([CodingTools.name, ReviewTools.name]);
    const ordinaryNames = new Set(
      [...(CodingTools.tools ?? []), ...(ReviewTools.tools ?? [])].map((tool) => tool.name)
    );
    const extensionNames = new Set<string>();
    const research = new Set(options.researchTools?.() ?? []);
    for (const extension of extensions) {
      if (seenOwners.has(extension.name))
        throw new WorkflowRoleError(
          `tool owner ${extension.name} collides with another admitted extension`
        );
      seenOwners.add(extension.name);
      for (const tool of extension.tools ?? []) {
        if (
          tool.name === ROLE_OUTPUT_TOOL ||
          ordinaryNames.has(tool.name) ||
          extensionNames.has(tool.name)
        ) {
          throw new WorkflowRoleError(
            `admitted tool ${tool.name} from ${extension.name} collides with a built-in, another owner, or controller-owned structured_output`
          );
        }
        extensionNames.add(tool.name);
      }
    }
    const ceiling = selection.ceiling ?? defaultRoleCeiling(id);
    const inspection = selection.toolset === 'review' || ceiling !== 'implementer';
    const candidates = [
      ...(inspection ? (ReviewTools.tools ?? []) : (CodingTools.tools ?? [])).map((tool) => ({
        owner: inspection ? ReviewTools.name : CodingTools.name,
        tool
      })),
      ...extensions.flatMap((extension) =>
        (extension.tools ?? [])
          .filter(
            (tool) =>
              !inspection ||
              (ceiling === 'analyst' && selection.toolset !== 'review' && research.has(tool))
          )
          .map((tool) => ({ owner: extension.name, tool }))
      )
    ];
    return candidates
      .filter(({ owner, tool }) => options.admitTool?.(owner, tool) !== false)
      .map(({ owner, tool }) => {
        const revision = options.toolRevision?.(owner, tool) ?? workflowToolRevision(tool);
        if (
          owner !== CodingTools.name &&
          owner !== ReviewTools.name &&
          selectedTools.includes(tool.name) &&
          (typeof revision !== 'string' || !revision.trim())
        )
          throw new WorkflowRoleError(
            `tool ${tool.name} from ${owner} needs an explicit implementation/configuration revision; configure roles.toolRevision before execution`
          );
        const identity = {
          name: tool.name,
          owner,
          implementation: roleHash({
            parameters: tool.parameters,
            description: tool.description,
            execute: String(tool.execute),
            prepareArguments: String(tool.prepareArguments),
            replay: tool.replay ?? 'unsafe',
            callers: tool.callers ?? ['model', 'tools'],
            structuredOutputSchema: tool.structuredOutputSchema ?? null,
            revision: revision ?? null
          })
        };
        const key = `${owner}:${tool.name}`;
        const previous = implementations.get(key);
        if (previous && previous !== tool)
          throw new WorkflowRoleError(
            `admitted tool ${tool.name} from ${owner} was substituted in this process; reopen with an approved implementation revision`
          );
        implementations.set(key, tool);
        return { identity, tool };
      });
  };

  const checkDefinition = (
    definition: WorkflowRoleSnapshot,
    effectiveTools: readonly WorkflowRoleToolIdentity[]
  ) => {
    if (options.revokedRoles?.().includes(definition.id))
      throw new WorkflowRoleError(
        `${definition.id} is explicitly revoked; approve it or create a recorded replacement task revision`
      );
    if (definition.source.scope === 'project' && !options.projectTrusted)
      throw new WorkflowRoleError(
        `${definition.id} requires trust for recorded project ${options.projectRoot}`
      );
    // Ordinary edits do not replace pinned instructions. Missing/disabled definitions revoke use.
    const current = readRole(definition.source);
    if (current.id !== definition.id || !current.enabled)
      throw new WorkflowRoleError(
        `${definition.id} is disabled or replaced at ${definition.source.path}; enable it or create a recorded task revision`
      );
    const denied = effectiveTools.find((tool) => current.denyTools.includes(tool.name));
    if (denied)
      throw new WorkflowRoleError(
        `tool ${denied.name} is explicitly denied by the current ${definition.id} definition; remove the denial or create a recorded task revision`
      );
    const removed = effectiveTools.find((tool) => !current.tools.includes(tool.name));
    if (removed)
      throw new WorkflowRoleError(
        `tool ${removed.name} was removed from the current ${definition.id} allowlist; restore its permission or create a recorded task revision`
      );
  };

  const pin = (role: WorkflowResolvedRole) => {
    assertResolvedRole(role);
    const known = definitions.get(role.definition.id);
    if (known && roleHash(known) !== roleHash(role.definition))
      throw new WorkflowRoleError(
        `${role.definition.id} has conflicting pinned definitions; replacement requires a task revision`
      );
    definitions.set(role.definition.id, structuredClone(role.definition));
    const key = policyKey(role.definition.id, {
      ceiling: role.policy.ceiling,
      toolset: role.policy.reviewOnly ? 'review' : undefined
    });
    const previous = policies.get(key);
    if (previous && previous.policy.hash !== role.policy.hash)
      throw new WorkflowRoleError(`${role.definition.id} has conflicting pinned policies`);
    policies.set(key, structuredClone(role));
  };

  const resolveRole: WorkflowRoleResolver = (id, selection = {}) => {
    requireRoleId(id);
    if (selection.toolset !== undefined && selection.toolset !== 'review')
      throw new WorkflowRoleError('toolset must be review when specified');
    if (selection.ceiling !== undefined && !PACKAGED_ROLE_IDS.includes(selection.ceiling))
      throw new WorkflowRoleError(
        `unknown capability ceiling ${JSON.stringify(selection.ceiling)}`
      );
    const key = policyKey(id, {
      ...selection,
      toolset: selection.toolset ?? (id === 'reviewer' ? 'review' : undefined)
    });
    const previous = policies.get(key);
    if (previous) {
      checkDefinition(previous.definition, previous.policy.tools);
      return structuredClone(previous);
    }
    let definition = definitions.get(id);
    if (!definition) {
      const file = discoverRoles(options).get(id);
      if (!file)
        throw new WorkflowRoleError(
          `unknown role ${JSON.stringify(id)}; add a definition to the user agents directory or the trusted project's .pi/agents directory`
        );
      const { enabled, ...snapshot } = readRole(file.source);
      if (!enabled) throw new WorkflowRoleError(`${id} is disabled at ${file.source.path}`);
      definition = snapshot;
    }
    const selected = createRolePolicy(
      definition,
      selection,
      admission(
        selection,
        id,
        definition.tools.filter((name) => !definition.denyTools.includes(name))
      ).map(({ identity }) => identity)
    );
    checkDefinition(definition, selected.policy.tools);
    pin(selected);
    return structuredClone(selected);
  };

  const prepare = (input: WorkflowRoleExecution, output?: Extension): Extension => {
    const role = input.resolvedRole;
    if (!role)
      throw new WorkflowRoleError(
        `role ${input.role ?? '(unspecified)'} has no pinned policy; resolve and persist it before creating the agent task`
      );
    assertResolvedRole(role);
    if (role.definition.profile && !input.profile)
      throw new WorkflowRoleError(
        `role fallback profile ${role.definition.profile} has not been resolved; select its approved route before creating the agent task`
      );
    if (input.role !== undefined && requireRoleId(input.role) !== role.definition.id)
      throw new WorkflowRoleError('selector and resolved role snapshot do not match');
    if (input.toolset === 'review' && !role.policy.reviewOnly)
      throw new WorkflowRoleError('toolset review requires a pinned inspection-only policy');
    pin(role);
    const selection: WorkflowRoleSelection = {
      ceiling: role.policy.ceiling,
      toolset: role.policy.reviewOnly ? 'review' : undefined
    };
    const recheck = () => {
      assertResolvedRole(role);
      checkDefinition(role.definition, role.policy.tools);
      if (input.profile) {
        if (!options.recheckProfile)
          throw new WorkflowRoleError(
            `cannot recheck profile ${input.profile}; the host must supply current profile admission`
          );
        try {
          options.recheckProfile(input.profile, input.route);
        } catch (error) {
          throw new WorkflowRoleError(
            `profile ${input.profile} is revoked or unavailable: ${error instanceof Error ? error.message : String(error)}; restore approval or choose an explicit recovery profile`
          );
        }
      }
      const current = admission(
        selection,
        role.definition.id,
        role.policy.tools.map((tool) => tool.name)
      );
      return role.policy.tools.map((expected) => {
        const found = current.find(
          ({ identity }) => identity.name === expected.name && identity.owner === expected.owner
        );
        if (!found || found.identity.implementation !== expected.implementation)
          throw new WorkflowRoleError(
            `tool ${expected.name} from ${expected.owner} is revoked, unavailable, or changed; restore its approved implementation or create a recorded task revision`
          );
        return found.tool;
      });
    };
    const tools = recheck();
    const outputs = output?.tools ?? [];
    if (output && (outputs.length !== 1 || outputs[0].name !== ROLE_OUTPUT_TOOL))
      throw new WorkflowRoleError(
        'the controller output extension must provide exactly structured_output'
      );
    const name = `workflow.role.${roleHash({ policy: role.policy.hash, output: output?.name ?? null, profile: input.profile ?? null, route: input.route ?? null })}`;
    const cached = prepared.get(name);
    modelChecks.set(input.executionId ?? name, recheck);
    if (cached) return cached;
    let extension: Extension;
    const guarded = [...tools, ...outputs].map(
      (tool): ToolRegistration => ({
        ...tool,
        prepareArguments(args) {
          recheck();
          return tool.prepareArguments ? tool.prepareArguments(args) : args;
        },
        async execute(args, api, context) {
          // beforeTool hooks are NOT rerun by Durable's execute-phase recovery. This wrapper is.
          recheck();
          if (api.registry.extension(name) !== extension)
            throw new WorkflowRoleError(`guarded tool bundle ${name} was substituted`);
          const result = await tool.execute(args, api, context);
          if (!result.control?.addTools) return result;
          const allowed = new Set(role.policy.tools.map((identity) => identity.name));
          return {
            ...result,
            control: {
              ...result.control,
              addTools: result.control.addTools.filter((toolName) => allowed.has(toolName))
            }
          };
        }
      })
    );
    extension = defineExtension({
      name,
      tools: guarded,
      sections: [
        ...(
          createSubagentExtension(
            role.policy.ceiling === 'implementer' && !role.policy.reviewOnly ? undefined : 'review'
          ).sections ?? []
        ).map((promptSection) =>
          role.policy.ceiling === 'analyst' &&
          !role.policy.reviewOnly &&
          promptSection.key === 'rules'
            ? section('rules', () =>
                [
                  'Use the supplied inspection tools for local evidence. Editing and arbitrary commands are unavailable.',
                  'Use research tools only for the assigned question. Their admission does not establish evidence quality.',
                  'Resolve truncated results before relying on missing portions. Report unresolved evidence gaps.',
                  'Stay within the assignment, be concise, and show source paths clearly.'
                ]
                  .map((rule) => `- ${rule}`)
                  .join('\n')
              )
            : promptSection
        ),
        section(
          'workflow_role',
          () =>
            `Role: ${role.definition.id}\nPolicy: ${role.policy.hash}\n\n${role.definition.instructions}`
        )
      ]
    });
    prepared.set(name, extension);
    return extension;
  };

  const guardModels = (models: Models): Models => {
    const previous = guardedModels.get(models);
    if (previous) return previous;
    // Durable reports and swallows generation-hook exceptions. Admission must therefore run at
    // the Models boundary, not in beforeRequest. This also covers compaction and restored polling.
    // A run cannot spend while any prepared execution policy is revoked; stored results need no model.
    const requests = new Set<keyof Models>([
      'stream',
      'complete',
      'streamSimple',
      'completeSimple',
      'streamDeferred',
      'fetchDeferred',
      'generateImages',
      'classify'
    ]);
    const wrapped = new Proxy(models, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if (requests.has(property as keyof Models)) {
            for (const check of modelChecks.values()) check();
          }
          return Reflect.apply(value, target, args);
        };
      }
    });
    guardedModels.set(models, wrapped);
    guardedModels.set(wrapped, wrapped);
    return wrapped;
  };

  for (const role of options.pinned ?? []) pin(role);
  return {
    resolve: resolveRole,
    pin,
    prepare,
    guardModels,
    release: (id) => {
      modelChecks.delete(id);
    }
  };
}
