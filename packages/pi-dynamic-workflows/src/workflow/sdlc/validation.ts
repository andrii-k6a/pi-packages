import {
  DEFAULT_SDLC_LIMITS,
  type SdlcArgs,
  type SdlcBrief,
  type SdlcLimits,
  type SdlcPlanInput,
  type SdlcRequirement
} from './contracts.js';

export function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}
export function text(value: unknown, name: string, max = 30_000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0'))
    throw new Error(`${name} must be non-empty text of at most ${max} characters`);
  return value;
}
export function keys(value: Record<string, unknown>, allowed: string[], name: string): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) throw new Error(`${name}: unsupported argument ${key}`);
}
export function strings(value: unknown, name: string, max = 100): string[] {
  if (!Array.isArray(value) || value.length > max)
    throw new Error(`${name} must be an array (maximum ${max})`);
  return value.map((item) => text(item, name));
}
export function id(value: unknown, name: string): string {
  const result = text(value, name, 100);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(result))
    throw new Error(`${name} must be a stable identifier`);
  return result;
}
export function relativePath(value: unknown, name: string): string {
  const result = text(value, name, 1000).replace(/\\/g, '/').replace(/\/$/, '');
  if (
    result.startsWith('/') ||
    /^[a-z]:/i.test(result) ||
    result.split('/').includes('..') ||
    /[*?]/.test(result)
  )
    throw new Error(`${name} must be a literal path inside the workspace`);
  return result;
}
export function limits(
  value: unknown = {},
  base: SdlcLimits = { ...DEFAULT_SDLC_LIMITS }
): SdlcLimits {
  const input = object(value, 'SDLC limits');
  keys(input, Object.keys(DEFAULT_SDLC_LIMITS), 'SDLC limits');
  const next = { ...base };
  for (const [name, value] of Object.entries(input)) {
    const minimum = ['correctionRounds', 'replans'].includes(name) ? 0 : 1;
    if (!Number.isSafeInteger(value) || (value as number) < minimum)
      throw new Error(`SDLC limits.${name} must be a finite integer >= ${minimum}`);
    next[name as keyof SdlcLimits] = value as number;
  }
  if (next.concurrency > 16) throw new Error('SDLC concurrency cannot exceed 16');
  return next;
}
export function requirements(goal: string, acceptance: SdlcArgs['acceptance']): SdlcRequirement[] {
  const result: SdlcRequirement[] = [
    { id: 'goal', description: goal, verification: 'behavioral', checkIds: [] }
  ];
  if (acceptance !== undefined && (!Array.isArray(acceptance) || acceptance.length > 50))
    throw new Error('SDLC acceptance must be an array (maximum 50)');
  for (const [index, item] of (acceptance ?? []).entries()) {
    const input =
      typeof item === 'string' ? { description: item } : object(item, 'SDLC acceptance');
    keys(input, ['id', 'description', 'verification', 'checkIds'], 'SDLC acceptance');
    const requirement: SdlcRequirement = {
      id: input.id === undefined ? `outcome-${index + 1}` : id(input.id, 'acceptance id'),
      description: text(input.description, 'acceptance description'),
      verification:
        input.verification === undefined
          ? 'behavioral'
          : (input.verification as SdlcRequirement['verification']),
      checkIds: input.checkIds === undefined ? [] : strings(input.checkIds, 'acceptance checkIds')
    };
    if (!['behavioral', 'inspection'].includes(requirement.verification))
      throw new Error('SDLC acceptance verification must be behavioral or inspection');
    if (result.some((other) => other.id === requirement.id))
      throw new Error(`Duplicate SDLC outcome ${requirement.id}`);
    result.push(requirement);
  }
  // An explicitly inspection-only goal (for example documentation) does not require a test runner.
  if (result.length > 1 && result.slice(1).every((item) => item.verification === 'inspection'))
    result[0].verification = 'inspection';
  return result;
}
export function createBrief(args: SdlcArgs): SdlcBrief {
  return {
    originalGoal: args.goal,
    goal: args.goal,
    revision: 1,
    goalRevision: 1,
    context: typeof args.context === 'string' ? [args.context] : (args.context ?? []),
    constraints: args.constraints ?? [],
    acceptance: requirements(args.goal, args.acceptance),
    assumptions: [],
    unresolvedDecisions: args.unresolvedDecisions ?? [],
    clarifications: []
  };
}
export function validateSdlcArgs(value: unknown): asserts value is SdlcArgs {
  const args = object(value, 'SDLC args');
  keys(
    args,
    [
      'goal',
      'context',
      'constraints',
      'acceptance',
      'checks',
      'questions',
      'unresolvedDecisions',
      'planning',
      'plan',
      'evidence',
      'workspace',
      'policy',
      'noWork'
    ],
    'SDLC args'
  );
  text(args.goal, 'SDLC goal');
  if (args.context !== undefined)
    typeof args.context === 'string'
      ? text(args.context, 'SDLC context')
      : strings(args.context, 'SDLC context');
  for (const name of ['constraints', 'unresolvedDecisions'])
    if (args[name] !== undefined) strings(args[name], `SDLC ${name}`);
  const outcomes = requirements(args.goal as string, args.acceptance as SdlcArgs['acceptance']);
  if (args.planning !== undefined && !['auto', 'investigate'].includes(args.planning as string))
    throw new Error('SDLC planning must be auto or investigate');
  if (args.workspace !== undefined) {
    const workspace = object(args.workspace, 'SDLC workspace');
    keys(workspace, ['mode', 'cwd'], 'SDLC workspace');
    if (!['existing', 'isolated'].includes(workspace.mode as string))
      throw new Error('SDLC workspace.mode must be existing or isolated');
    if (workspace.cwd !== undefined) text(workspace.cwd, 'SDLC workspace.cwd');
  }
  if (args.policy !== undefined) {
    const policy = object(args.policy, 'SDLC policy');
    keys(
      policy,
      ['roles', 'profile', 'phaseProfiles', 'contextTarget', 'contextWindowTokens', 'limits'],
      'SDLC policy'
    );
    limits(policy.limits);
    if (policy.profile !== undefined) text(policy.profile, 'SDLC profile', 100);
    for (const field of ['roles', 'phaseProfiles'])
      if (policy[field] !== undefined) {
        const mapping = object(policy[field], `SDLC ${field}`);
        keys(mapping, ['analyst', 'implementer', 'reviewer'], `SDLC ${field}`);
        for (const value of Object.values(mapping)) text(value, `SDLC ${field}`, 100);
      }
    if (
      policy.contextWindowTokens !== undefined &&
      (!Number.isSafeInteger(policy.contextWindowTokens) ||
        (policy.contextWindowTokens as number) < 1024)
    )
      throw new Error('SDLC contextWindowTokens must be an integer >= 1024');
    if (
      policy.contextTarget !== undefined &&
      !(
        typeof policy.contextTarget === 'number' &&
        policy.contextTarget > 0 &&
        policy.contextTarget <= 1
      )
    )
      throw new Error('SDLC contextTarget must be a fraction greater than zero and at most one');
  }
  const checks = args.checks ?? [];
  if (!Array.isArray(checks) || checks.length > 30)
    throw new Error('SDLC checks must be an array (maximum 30)');
  const checkIds = new Set<string>();
  for (const item of checks) {
    const check = object(item, 'SDLC check');
    keys(check, ['id', 'argv', 'kind', 'cwd', 'outcomes'], 'SDLC check');
    const key = id(check.id, 'SDLC check id');
    if (checkIds.has(key)) throw new Error(`Duplicate SDLC check ${key}`);
    checkIds.add(key);
    if (!strings(check.argv, 'SDLC check argv').length)
      throw new Error('SDLC check argv must not be empty');
    if (!['test', 'check'].includes(check.kind as string))
      throw new Error('SDLC check kind must be test or check');
    if (check.cwd !== undefined) relativePath(check.cwd, 'SDLC check cwd');
    for (const outcome of strings(check.outcomes, 'SDLC check outcomes'))
      if (!outcomes.some((item) => item.id === outcome))
        throw new Error(`Unknown SDLC check outcome ${outcome}`);
  }
  for (const outcome of outcomes)
    for (const key of outcome.checkIds)
      if (!checkIds.has(key)) throw new Error(`Unknown required SDLC check ${key}`);
  if (args.questions !== undefined) validateQuestions(args.questions);
  if (args.plan !== undefined)
    validatePlan(
      args.plan,
      checkIds,
      new Set(((args.questions as SdlcArgs['questions']) ?? []).map((item) => item.id))
    );
  if (args.evidence !== undefined) {
    if (!Array.isArray(args.evidence) || args.evidence.length > 10)
      throw new Error('SDLC evidence must be an array (maximum 10)');
    for (const item of args.evidence) {
      const source = object(item, 'SDLC evidence');
      keys(source, ['kind', 'runId', 'attempt'], 'SDLC evidence');
      if (source.kind !== 'code-review') throw new Error('SDLC evidence kind must be code-review');
      text(source.runId, 'SDLC source runId', 200);
      if (!Number.isSafeInteger(source.attempt) || (source.attempt as number) < 1)
        throw new Error('SDLC source attempt must be an explicit positive attempt number');
    }
  }
  if (args.noWork !== undefined) {
    const noWork = object(args.noWork, 'SDLC noWork');
    keys(noWork, ['confirmed', 'reason'], 'SDLC noWork');
    if (noWork.confirmed !== true) throw new Error('SDLC noWork requires explicit confirmed: true');
    text(noWork.reason, 'SDLC noWork reason');
    if (
      (args.plan as SdlcPlanInput | undefined)?.tasks.length ||
      (args.evidence as unknown[])?.length
    )
      throw new Error(
        'SDLC noWork cannot also request planned work or unresolved historical claims'
      );
    if ((args.questions as unknown[])?.length || (args.unresolvedDecisions as unknown[])?.length)
      throw new Error('SDLC noWork cannot leave material decisions unanswered');
  }
}
export function validateQuestions(value: unknown): void {
  if (!Array.isArray(value) || value.length > 20)
    throw new Error('SDLC questions must be an array (maximum 20)');
  const ids = new Set<string>();
  for (const item of value) {
    const question = object(item, 'SDLC question');
    keys(question, ['id', 'text', 'choices', 'affectedTasks'], 'SDLC question');
    const key = id(question.id, 'SDLC question id');
    if (ids.has(key)) throw new Error(`Duplicate SDLC question ${key}`);
    ids.add(key);
    text(question.text, 'SDLC question text', 4000);
    strings(question.affectedTasks, 'SDLC affectedTasks');
    if (question.choices !== undefined) strings(question.choices, 'SDLC choices', 20);
  }
}
export function ownsPath(writes: string[], path: string): boolean {
  if (!path || path.startsWith('/') || /^[a-z]:/i.test(path) || path.split('/').includes('..'))
    return false;
  const actual = path
    .split('/')
    .filter((part) => part && part !== '.')
    .join('/');
  return writes.some((owner) => {
    if (owner === '*') return true;
    if (
      !owner.trim() ||
      owner.startsWith('/') ||
      /^[a-z]:/i.test(owner) ||
      owner.split('/').includes('..')
    )
      return false;
    const prefix = owner
      .split('/')
      .filter((part) => part && part !== '.')
      .join('/');
    return prefix === '' || actual === prefix || actual.startsWith(`${prefix}/`);
  });
}
export function validatePlan(
  value: unknown,
  checkIds: Set<string>,
  questionIds: Set<string>,
  externalDependencies: ReadonlyMap<string, readonly string[]> = new Map()
): asserts value is SdlcPlanInput {
  const plan = object(value, 'SDLC plan');
  keys(plan, ['reason', 'tasks'], 'SDLC plan');
  text(plan.reason, 'SDLC plan reason', 4000);
  if (!Array.isArray(plan.tasks) || !plan.tasks.length || plan.tasks.length > 50)
    throw new Error('SDLC plan requires 1 to 50 tasks');
  const tasks = plan.tasks.map((item) => {
    const task = object(item, 'SDLC task');
    keys(
      task,
      ['id', 'title', 'outcome', 'dependsOn', 'writes', 'inputs', 'checks', 'questionIds'],
      'SDLC task'
    );
    id(task.id, 'SDLC task id');
    text(task.title, 'SDLC task title', 200);
    text(task.outcome, 'SDLC task outcome');
    for (const field of ['dependsOn', 'writes', 'inputs', 'checks', 'questionIds'])
      strings(task[field], `SDLC task ${field}`);
    if (!(task.writes as string[]).length)
      throw new Error('SDLC implementation task requires write ownership');
    for (const path of task.writes as string[])
      if (path !== '*') relativePath(path, 'SDLC write ownership');
    for (const check of task.checks as string[])
      if (!checkIds.has(check)) throw new Error(`Unknown SDLC task check ${check}`);
    for (const question of task.questionIds as string[])
      if (!questionIds.has(question)) throw new Error(`Unknown SDLC task question ${question}`);
    return task as unknown as SdlcPlanInput['tasks'][number];
  });
  const byId = new Map(tasks.map((task) => [task.id, task]));
  if (byId.size !== tasks.length) throw new Error('Duplicate SDLC task IDs');
  for (const task of tasks)
    if (externalDependencies.has(task.id))
      throw new Error(`SDLC local task ${task.id} collides with an existing task ID`);
  const ancestors = (key: string, trail: string[] = []): Set<string> => {
    if (trail.includes(key)) throw new Error('SDLC task graph contains a cycle');
    const dependencies = byId.get(key)?.dependsOn ?? externalDependencies.get(key);
    if (!dependencies) throw new Error(`Missing SDLC dependency ${key}`);
    return new Set(
      dependencies.flatMap((dependency) => [dependency, ...ancestors(dependency, [...trail, key])])
    );
  };
  const dependencies = new Map(tasks.map((task) => [task.id, ancestors(task.id)]));
  for (let left = 0; left < tasks.length; left++)
    for (let right = left + 1; right < tasks.length; right++) {
      const a = tasks[left],
        b = tasks[right];
      if (dependencies.get(a.id)?.has(b.id) || dependencies.get(b.id)?.has(a.id)) continue;
      if (
        a.writes.some((path) => ownsPath(b.writes, path)) ||
        b.writes.some((path) => ownsPath(a.writes, path))
      )
        throw new Error(`Overlapping SDLC writers ${a.id} and ${b.id} must be dependency-ordered`);
    }
}
