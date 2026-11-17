import { createHash } from 'node:crypto';

export const PACKAGED_ROLE_IDS = ['analyst', 'implementer', 'reviewer'] as const;
export type WorkflowRoleStage = (typeof PACKAGED_ROLE_IDS)[number];
export type WorkflowRoleCeiling = WorkflowRoleStage;
export const ROLE_OUTPUT_TOOL = 'structured_output';

export class WorkflowRoleError extends Error {
  constructor(message: string) {
    super(`Workflow role: ${message}`);
    this.name = 'WorkflowRoleError';
  }
}

export type WorkflowRoleSource = {
  scope: 'packaged' | 'user' | 'project';
  path: string;
};

/** A selected definition, not a live reference to a Markdown file. */
export type WorkflowRoleSnapshot = {
  version: 1;
  id: string;
  description: string;
  source: WorkflowRoleSource;
  contentHash: string;
  instructions: string;
  tools: string[];
  denyTools: string[];
  profile?: string;
};

/** Ownership and implementation revision are both part of a tool's identity. */
export type WorkflowRoleToolIdentity = {
  name: string;
  owner: string;
  implementation: string;
};

export type WorkflowRolePolicy = {
  version: 1;
  ceiling: WorkflowRoleCeiling;
  reviewOnly: boolean;
  roleHash: string;
  tools: WorkflowRoleToolIdentity[];
  hash: string;
};

export type WorkflowResolvedRole = {
  definition: WorkflowRoleSnapshot;
  policy: WorkflowRolePolicy;
};

export interface WorkflowRoleSelection {
  /** The controller owns this ceiling. Scripts cannot supply it through agent(). */
  ceiling?: WorkflowRoleCeiling;
  toolset?: 'review';
}

export type WorkflowRoleResolver = (
  id: string,
  selection?: WorkflowRoleSelection
) => WorkflowResolvedRole;

export interface WorkflowRoleDescription {
  id: string;
  description: string;
  enabled: boolean;
  source: WorkflowRoleSource;
}

export function requireRoleId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value)) {
    throw new WorkflowRoleError(
      'role must be a lowercase ID, for example "reviewer" or "api-reviewer"'
    );
  }
  return value;
}

/** Sorted JSON keeps hashes stable across persistence and object construction order. */
export function roleHash(value: unknown): string {
  return createHash('sha256')
    .update(
      JSON.stringify(value, (_key, item: unknown) =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? Object.fromEntries(
              Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            )
          : item
      )
    )
    .digest('hex');
}

export function roleContentHash(markdown: string): string {
  return createHash('sha256').update(markdown).digest('hex');
}

export function validateRoleFields(
  fields: unknown,
  instructions: string,
  source: WorkflowRoleSource,
  contentHash: string
): WorkflowRoleSnapshot & { enabled: boolean } {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new WorkflowRoleError(`${source.path}: frontmatter must be an object`);
  }
  const data = fields as Record<string, unknown>;
  const allowed = new Set(['name', 'description', 'tools', 'denyTools', 'enabled', 'profile']);
  for (const key of Object.keys(data)) {
    if (!allowed.has(key))
      throw new WorkflowRoleError(`${source.path}: unknown field ${JSON.stringify(key)}`);
  }
  const id = requireRoleId(data.name);
  if (source.scope !== 'packaged' && PACKAGED_ROLE_IDS.includes(id as WorkflowRoleStage)) {
    throw new WorkflowRoleError(`${source.path}: ${id} is a reserved packaged role ID`);
  }
  if (typeof data.description !== 'string' || !data.description.trim()) {
    throw new WorkflowRoleError(`${source.path}: description must be a nonempty string`);
  }
  if (typeof instructions !== 'string' || !instructions.trim())
    throw new WorkflowRoleError(`${source.path}: Markdown instructions are empty`);
  const tools = exactTools(data.tools, 'tools', source.path);
  const denyTools =
    data.denyTools === undefined ? [] : exactTools(data.denyTools, 'denyTools', source.path);
  if (tools.includes(ROLE_OUTPUT_TOOL) || denyTools.includes(ROLE_OUTPUT_TOOL)) {
    throw new WorkflowRoleError(
      `${source.path}: structured_output belongs to the controller; do not allow, deny, or shadow it`
    );
  }
  if (data.enabled !== undefined && typeof data.enabled !== 'boolean') {
    throw new WorkflowRoleError(`${source.path}: enabled must be a boolean`);
  }
  if (
    data.profile !== undefined &&
    (typeof data.profile !== 'string' ||
      !data.profile.trim() ||
      data.profile !== data.profile.trim())
  ) {
    throw new WorkflowRoleError(`${source.path}: profile must be a nonempty approved profile name`);
  }
  return {
    version: 1,
    id,
    description: data.description.trim(),
    source,
    contentHash,
    instructions: instructions.trim(),
    tools,
    denyTools,
    ...(data.profile === undefined ? {} : { profile: data.profile as string }),
    enabled: data.enabled !== false
  };
}

function exactTools(value: unknown, field: string, path: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((name) => typeof name !== 'string' || !/^[A-Za-z0-9_.:-]+$/.test(name))
  ) {
    throw new WorkflowRoleError(
      `${path}: ${field} must be an explicit array of exact tool names (use [] for no tools; wildcards are forbidden)`
    );
  }
  if (new Set(value).size !== value.length)
    throw new WorkflowRoleError(`${path}: ${field} contains duplicate tool names`);
  return [...value] as string[];
}

export function createRolePolicy(
  definition: WorkflowRoleSnapshot,
  selection: WorkflowRoleSelection,
  admitted: readonly WorkflowRoleToolIdentity[]
): WorkflowResolvedRole {
  const ceiling = selection.ceiling ?? defaultRoleCeiling(definition.id);
  if (selection.toolset !== undefined && selection.toolset !== 'review')
    throw new WorkflowRoleError('toolset must be review when specified');
  if (!PACKAGED_ROLE_IDS.includes(ceiling))
    throw new WorkflowRoleError(`unknown capability ceiling ${JSON.stringify(ceiling)}`);
  if (
    PACKAGED_ROLE_IDS.includes(definition.id as WorkflowRoleStage) &&
    selection.ceiling &&
    definition.id !== ceiling
  ) {
    throw new WorkflowRoleError(
      `packaged role ${definition.id} is incompatible with the ${ceiling} stage; select a custom variant explicitly`
    );
  }
  const denied = new Set(definition.denyTools);
  const tools = admitted.filter(
    (tool) => definition.tools.includes(tool.name) && !denied.has(tool.name)
  );
  if (new Set(tools.map((tool) => tool.name)).size !== tools.length)
    throw new WorkflowRoleError('admitted tool names collide');
  const policy = {
    version: 1 as const,
    ceiling,
    reviewOnly: selection.toolset === 'review' || ceiling === 'reviewer',
    roleHash: roleHash(definition),
    tools: tools.map((tool) => ({ ...tool }))
  };
  return { definition: structuredClone(definition), policy: { ...policy, hash: roleHash(policy) } };
}

export function defaultRoleCeiling(id: string): WorkflowRoleCeiling {
  return id === 'reviewer' || id === 'analyst' ? id : 'implementer';
}

export function assertResolvedRole(role: WorkflowResolvedRole): void {
  if (!role?.definition || !role.policy)
    throw new WorkflowRoleError('a resolved role snapshot is required');
  const { hash, ...policy } = role.policy;
  if (!Array.isArray(policy.tools))
    throw new WorkflowRoleError('role policy tools must be an array');
  if (
    role.definition.version !== 1 ||
    policy.version !== 1 ||
    policy.roleHash !== roleHash(role.definition) ||
    hash !== roleHash(policy)
  ) {
    throw new WorkflowRoleError(
      'role or policy snapshot is corrupt or unsupported; create a recorded task revision instead of replacing it'
    );
  }
  const definition = role.definition;
  if (
    !definition.source ||
    !['packaged', 'project', 'user'].includes(definition.source.scope) ||
    typeof definition.source.path !== 'string' ||
    !definition.source.path ||
    typeof definition.contentHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(definition.contentHash)
  ) {
    throw new WorkflowRoleError('role snapshot has invalid source identity');
  }
  validateRoleFields(
    {
      name: definition.id,
      description: definition.description,
      tools: definition.tools,
      denyTools: definition.denyTools,
      ...(definition.profile === undefined ? {} : { profile: definition.profile })
    },
    definition.instructions,
    definition.source,
    definition.contentHash
  );
  if (
    !PACKAGED_ROLE_IDS.includes(policy.ceiling) ||
    typeof policy.reviewOnly !== 'boolean' ||
    (policy.ceiling === 'reviewer' && !policy.reviewOnly) ||
    (PACKAGED_ROLE_IDS.includes(definition.id as WorkflowRoleStage) &&
      definition.id !== policy.ceiling)
  ) {
    throw new WorkflowRoleError('role snapshot has an invalid capability ceiling');
  }
  if (
    policy.tools.some(
      (tool) =>
        !tool ||
        typeof tool.name !== 'string' ||
        typeof tool.owner !== 'string' ||
        !tool.owner ||
        typeof tool.implementation !== 'string' ||
        !tool.implementation ||
        !definition.tools.includes(tool.name) ||
        definition.denyTools.includes(tool.name)
    ) ||
    new Set(policy.tools.map((tool) => tool.name)).size !== policy.tools.length
  ) {
    throw new WorkflowRoleError(
      'role policy exceeds its explicit allowlist or has invalid tool ownership'
    );
  }
}

/** Validate every mapping before scheduling any stage. */
export function resolveStageRoles(
  mapping: Partial<Record<WorkflowRoleStage, string>>,
  resolve: WorkflowRoleResolver
): Record<WorkflowRoleStage, WorkflowResolvedRole> {
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping))
    throw new WorkflowRoleError('stage roles must be an object');
  for (const stage of Object.keys(mapping)) {
    if (!PACKAGED_ROLE_IDS.includes(stage as WorkflowRoleStage))
      throw new WorkflowRoleError(`unknown stage ${JSON.stringify(stage)}`);
  }
  return Object.fromEntries(
    PACKAGED_ROLE_IDS.map((stage) => {
      const id = requireRoleId(mapping[stage] === undefined ? stage : mapping[stage]);
      const selected = resolve(id, { ceiling: stage });
      assertResolvedRole(selected);
      if (selected.definition.id !== id || selected.policy.ceiling !== stage)
        throw new WorkflowRoleError(`resolver did not enforce the ${stage} stage selection`);
      return [stage, selected];
    })
  ) as Record<WorkflowRoleStage, WorkflowResolvedRole>;
}
