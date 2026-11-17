import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { JsonValue } from '@earendil-works/chord';
import type { Usage } from '@earendil-works/pi-ai';
import type { TSchema } from 'typebox';
import { jsonValue } from '../shared/json-values.js';
import { emptyUsage } from '../shared/usage.js';
import type { WorkflowAgentExecutor } from '../workflow/contracts.js';
import {
  resolveStageRoles,
  type WorkflowResolvedRole,
  type WorkflowRoleResolver
} from '../workflow/roles.js';
import type {
  ContinueSdlcOptions,
  SdlcAnswer,
  SdlcArgs,
  SdlcFinding,
  SdlcPlanInput,
  SdlcReview,
  SdlcStage,
  SdlcTaskContract
} from '../workflow/sdlc/contracts.js';
import {
  createSdlcReviewSchema,
  qualifySdlcReview,
  SDLC_ANALYSIS_SCHEMA,
  SDLC_IMPLEMENTATION_SCHEMA,
  SDLC_REVIEW_INSTRUCTIONS,
  validateSdlcReview
} from '../workflow/sdlc/review.js';
import {
  createBrief,
  keys,
  limits,
  object,
  ownsPath,
  requirements,
  strings,
  text,
  validatePlan,
  validateQuestions,
  validateSdlcArgs
} from '../workflow/sdlc/validation.js';
import type { StoredUsage } from './docs.js';
import { changedSdlcFiles } from './sdlc-observation.js';
import type {
  SdlcAssessment,
  SdlcCheckResult,
  SdlcEvidence,
  SdlcResult,
  SdlcState,
  SdlcTask
} from './sdlc-state.js';
import type { SdlcWorkspace } from './sdlc-workspace.js';
import { canonicalJson } from './subagent.js';

export type SdlcControllerServices = {
  state: SdlcState;
  save(state: SdlcState): Promise<void>;
  agent: WorkflowAgentExecutor;
  resolveRole?: WorkflowRoleResolver;
  usage(): Promise<StoredUsage>;
  now(): number;
  signal: AbortSignal;
  phase(title: string): void;
  /** Materialize a read-only evidence cache. SQLite remains authoritative. */
  artifact?(evidence: SdlcEvidence): Promise<string>;
  acquire?(workspace: SdlcWorkspace): () => void;
  ensure(workspace: SdlcWorkspace): Promise<void>;
  inspect(workspace: SdlcWorkspace): Promise<{ revision: string; changedFiles: string[] }>;
  observe(workspace: SdlcWorkspace): Promise<Record<string, string>>;
  fork(workspace: SdlcWorkspace, taskId: string): Promise<SdlcWorkspace>;
  integrate(
    target: SdlcWorkspace,
    child: SdlcWorkspace,
    expectedRevision: string
  ): Promise<{ revision: string; changedFiles: string[] }>;
  check(
    checkId: string,
    workspace: SdlcWorkspace,
    evidenceId: string,
    revision: string
  ): Promise<SdlcCheckResult>;
};

export function sdlcIdentity(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
export function initialSdlcState(
  operationId: string,
  args: SdlcArgs,
  workspace: SdlcWorkspace,
  tokenBudget?: number,
  concurrency?: number
): SdlcState {
  validateSdlcArgs(args);
  const configured = limits({
    ...args.policy?.limits,
    ...(tokenBudget === undefined ? {} : { tokenBudget }),
    ...(concurrency === undefined ? {} : { concurrency })
  });
  return {
    version: 1,
    operationId,
    args,
    brief: createBrief(args),
    briefHistory: [],
    plans: [],
    tasks: [],
    questions: (args.questions ?? []).map((item) => ({ ...item, briefRevision: 1 })),
    workspace,
    setup: 'intent',
    candidateRevision: workspace.sourceRevision,
    changedFiles: [],
    evidence: [],
    assessments: [],
    checks: [],
    importedFindings: [],
    importedUsage: emptyUsage() as StoredUsage,
    limits: configured,
    consumed: { tasks: 0, corrections: 0, replans: 0, failedTasks: 0 },
    usage: emptyUsage() as StoredUsage,
    roleSnapshots: {},
    decisions: [],
    extensions: [],
    continuation: 0,
    activity: 'Workspace selected; setup intent recorded'
  };
}

/** Validate all answers against one snapshot before applying any. An absent answer stays absent. */
export function applySdlcAnswers(state: SdlcState, answers: SdlcAnswer[], now: number): void {
  const ids = new Set<string>();
  for (const answer of answers) {
    keys(object(answer, 'SDLC answer'), ['questionId', 'briefRevision', 'answer'], 'SDLC answer');
    const question = state.questions.find((item) => item.id === answer.questionId);
    if (!question) throw new Error(`Unknown SDLC question ${answer.questionId}`);
    if (question.answer !== undefined || ids.has(answer.questionId))
      throw new Error(`SDLC question ${answer.questionId} already has an answer`);
    if (
      answer.briefRevision !== question.briefRevision ||
      answer.briefRevision !== state.brief.revision
    )
      throw new Error(`Stale SDLC answer ${answer.questionId}; inspect the current brief revision`);
    text(answer.answer, 'SDLC answer', 10_000);
    ids.add(answer.questionId);
  }
  if (!answers.length) return;
  state.briefHistory.push(structuredClone(state.brief));
  for (const answer of answers) {
    const question = state.questions.find((item) => item.id === answer.questionId)!;
    question.answer = answer.answer;
    question.answeredAt = now;
    state.brief.clarifications.push({
      questionId: answer.questionId,
      answer: answer.answer,
      atRevision: state.brief.revision
    });
    invalidateSdlc(
      state,
      state.tasks
        .filter(
          (task) =>
            task.questionIds.includes(question.id) ||
            question.affectedTasks.some((id) => task.id === id)
        )
        .map((task) => task.id),
      `answer:${question.id}`
    );
  }
  state.brief.revision++;
  for (const question of state.questions)
    if (question.answer === undefined) question.briefRevision = state.brief.revision;
  state.brief.unresolvedDecisions = state.questions
    .filter((question) => question.answer === undefined)
    .map((question) => question.text);
  // Unaffected completed outputs remain valid; pending assignments receive the new clarification.
  for (const task of state.tasks)
    if (task.status === 'pending') task.briefRevision = state.brief.revision;
  delete state.result;
}

export function invalidateSdlc(state: SdlcState, taskIds: string[], reason: string): void {
  const affected = new Set(taskIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of state.tasks)
      if (!affected.has(task.id) && task.dependsOn.some((id) => affected.has(id))) {
        affected.add(task.id);
        changed = true;
      }
  }
  for (const task of state.tasks)
    if (affected.has(task.id) && task.status === 'completed') task.status = 'invalidated';
  for (const evidence of state.evidence)
    if (
      affected.has(evidence.producingTask) ||
      evidence.dependencies.some((dependency) => affected.has(dependency))
    )
      evidence.invalidatedBy = reason;
}

export function applySdlcContinuation(
  state: SdlcState,
  options: ContinueSdlcOptions,
  now: number
): void {
  // Validate and apply against a copy so rejected authorization never partially revises the brief.
  const next = structuredClone(state);
  continueSdlc(next, options, now);
  delete state.result;
  delete state.outcome;
  delete state.stopReason;
  Object.assign(state, next);
}

function continueSdlc(state: SdlcState, options: ContinueSdlcOptions, now: number): void {
  keys(
    object(options, 'SDLC continuation'),
    [
      'answers',
      'goalRevision',
      'goal',
      'context',
      'constraints',
      'acceptance',
      'checks',
      'limits',
      'resumeProfile'
    ],
    'SDLC continuation'
  );
  if (options.answers !== undefined) {
    if (!Array.isArray(options.answers))
      throw new Error('SDLC continuation answers must be an array');
    applySdlcAnswers(state, options.answers, now);
  }
  const goalChanged = ['goal', 'context', 'constraints', 'acceptance'].some(
    (field) => field in options
  );
  if (goalChanged) {
    if (options.goalRevision !== state.brief.goalRevision)
      throw new Error('SDLC goalRevision is stale or missing for a goal change');
    state.briefHistory.push(structuredClone(state.brief));
    if (options.goal !== undefined) state.brief.goal = text(options.goal, 'SDLC revised goal');
    if (options.context !== undefined)
      state.brief.context = strings(options.context, 'SDLC revised context');
    if (options.constraints !== undefined)
      state.brief.constraints = strings(options.constraints, 'SDLC revised constraints');
    if (options.acceptance !== undefined || options.goal !== undefined)
      state.brief.acceptance = requirements(
        state.brief.goal,
        options.acceptance ?? state.args.acceptance
      );
    state.brief.revision++;
    state.brief.goalRevision++;
    for (const question of state.questions)
      if (question.answer === undefined) question.briefRevision = state.brief.revision;
    invalidateSdlc(
      state,
      state.tasks.map((task) => task.id),
      `goal:${state.brief.goalRevision}`
    );
    for (const task of state.tasks) task.status = 'invalidated';
    // An explicit scope change is the only way to replace the original goal obligation.
    state.args = {
      ...state.args,
      goal: state.brief.goal,
      ...(options.acceptance === undefined ? {} : { acceptance: options.acceptance })
    };
    delete state.args.noWork;
    state.plans = [...state.plans];
  } else if (
    options.goalRevision !== undefined &&
    options.goalRevision !== state.brief.goalRevision
  )
    throw new Error('SDLC goalRevision is stale');
  if (options.checks !== undefined) {
    if (!Array.isArray(options.checks))
      throw new Error('SDLC continuation checks must be an array');
    const checks = [...(state.args.checks ?? [])];
    for (const check of options.checks) {
      const prior = checks.find((item) => item.id === check.id);
      if (prior && canonicalJson(prior) !== canonicalJson(check))
        throw new Error(
          `SDLC continuation cannot replace or weaken check ${check.id}; add a new check ID`
        );
      if (!prior) checks.push(check);
    }
    validateSdlcArgs({
      ...state.args,
      noWork: undefined,
      plan: undefined,
      goal: state.brief.goal,
      acceptance: state.brief.acceptance.filter((item) => item.id !== 'goal'),
      checks
    });
    state.args.checks = checks;
    for (const evidence of state.evidence)
      if (evidence.kind === 'review')
        evidence.invalidatedBy = 'Authorized verification command update';
    for (const task of state.tasks)
      if (task.kind === 'review' && task.status === 'completed') task.status = 'invalidated';
  }
  validateSdlcArgs({
    ...state.args,
    noWork: undefined,
    plan: undefined,
    goal: state.brief.goal,
    acceptance: state.brief.acceptance.filter((item) => item.id !== 'goal')
  });
  if (options.limits !== undefined) {
    const previous = { ...state.limits };
    state.limits = limits(options.limits, state.limits);
    state.extensions.push({
      at: now,
      previous,
      next: { ...state.limits },
      reason: 'Explicit continuation allowance adjustment; consumption is retained'
    });
  }
  if (options.resumeProfile !== undefined)
    text(options.resumeProfile, 'SDLC recovery profile', 100);
  // Each retired assignment is replaced once. A failed analyst is retried; a completed analysis
  // whose plan was already applied is never repeated.
  const affected = state.tasks.filter(
    (task) =>
      !task.supersededBy &&
      (task.kind === 'implementation'
        ? task.status === 'invalidated' || task.status === 'failed'
        : task.kind === 'analysis' && task.status === 'failed')
  );
  if (goalChanged || affected.length) {
    const revision = state.plans.length + 1;
    const replacements = goalChanged
      ? [
          {
            id: `p${revision}-revised-goal`,
            title: 'Implement authorized revised goal',
            outcome: state.brief.goal,
            dependsOn: [],
            writes: ['*'],
            inputs: [],
            checks: (state.args.checks ?? []).map((check) => check.id),
            questionIds: state.questions
              .filter((question) => question.answer === undefined)
              .map((question) => question.id)
          }
        ]
      : affected.map((task) => ({
          id: `${task.id}-r${task.revision + 1}`,
          title: task.title,
          outcome: task.outcome,
          dependsOn: [...task.dependsOn],
          writes: [...task.writes],
          inputs: [...task.inputs],
          checks: [...task.checks],
          questionIds: [...task.questionIds]
        }));
    const ids = new Map(
      affected.map((task, index) => [task.id, replacements[goalChanged ? 0 : index]?.id])
    );
    for (const [index, contract] of replacements.entries()) {
      contract.dependsOn = contract.dependsOn.map((id) => ids.get(id) ?? id);
      const prior = goalChanged ? undefined : affected[index];
      // Unintegrated fork output stays with its owner. Integrated work is revised in the target.
      const retained =
        prior?.workspace &&
        prior.workspace.owner !== state.workspace.owner &&
        !['completed', 'resolved'].includes(prior.integration?.status ?? '')
          ? prior.workspace
          : undefined;
      state.tasks.push({
        ...contract,
        kind: prior?.kind ?? 'implementation',
        status: 'pending',
        revision: (prior?.revision ?? 0) + 1,
        planRevision: revision,
        briefRevision: state.brief.revision,
        ...(retained ? { workspace: retained } : {})
      });
    }
    for (const task of state.tasks) {
      if (task.status === 'pending') task.dependsOn = task.dependsOn.map((id) => ids.get(id) ?? id);
      if (task.integration?.resolutionTaskId)
        task.integration.resolutionTaskId =
          ids.get(task.integration.resolutionTaskId) ?? task.integration.resolutionTaskId;
    }
    for (const question of state.questions)
      question.affectedTasks = question.affectedTasks.map((id) => ids.get(id) ?? id);
    for (const prior of affected) {
      prior.status = 'invalidated';
      prior.supersededBy = ids.get(prior.id);
    }
    state.plans.push({
      revision,
      reason: goalChanged
        ? 'Authorized scope change invalidates uncertain downstream inputs'
        : 'Recorded answers or explicit retry revise only affected assignments',
      shape:
        !goalChanged && affected.every((task) => task.kind === 'analysis')
          ? 'investigation'
          : replacements.length === 1
            ? 'single'
            : 'sequential',
      taskIds: replacements.map((task) => task.id),
      briefRevision: state.brief.revision
    });
  }
  // Continuation reruns checks under new evidence IDs, so a failed, non-decisive or previously
  // accepted review needs a fresh conversation. A decisive negative judgment still drives correction
  // without paying for the same unchanged review again.
  const latest = state.assessments.at(-1);
  if (latest && !decisiveAssessment(latest)) {
    for (const task of state.tasks)
      if (task.id === latest.reviewTask && task.status === 'completed') task.status = 'invalidated';
    for (const item of state.evidence)
      if (item.id === latest.id)
        item.invalidatedBy ??= 'Explicit continuation requests a fresh review';
  }
  // Failed independent reviews get a new conversation, not a reused invalid completion claim.
  for (const task of state.tasks)
    if (task.kind === 'review' && task.status === 'failed') task.status = 'invalidated';
  state.continuation++;
  state.decisions.push({
    id: `continue-${state.continuation}`,
    at: now,
    kind: 'continuation',
    reason: goalChanged
      ? 'Authorized goal revision'
      : 'Explicit continuation with retained usage and evidence',
    inputRevision: sdlcIdentity(options),
    taskIds: []
  });
  // Unanswered questions do not prevent independent tasks, but never authorize dependent work.
  delete state.outcome;
  delete state.result;
  delete state.stopReason;
  state.activity = 'Continuation admitted';
}

/** Runs inside workflow.run. All model work still belongs to the existing durable agent tasks. */
export async function runSdlcController(services: SdlcControllerServices): Promise<SdlcResult> {
  const state = structuredClone(services.state);
  if (state.version !== 1) throw new Error('Unsupported SDLC state version');
  let tail = Promise.resolve();
  const change = (apply: () => void): Promise<void> => {
    const next = tail.then(async () => {
      const before = structuredClone(state);
      try {
        apply();
      } catch (error) {
        Object.assign(state, before);
        throw error;
      }
      await services.save(structuredClone(state));
    });
    tail = next.catch(() => {});
    return next;
  };
  const decision = (kind: string, reason: string, taskIds: string[] = []) => {
    state.decisions.push({
      id: `decision-${state.decisions.length + 1}`,
      at: services.now(),
      kind,
      reason,
      inputRevision: sdlcIdentity({
        brief: state.brief.revision,
        candidate: state.candidateRevision,
        continuation: state.continuation
      }),
      taskIds
    });
    state.activity = reason;
  };
  const usage = async () => {
    const total = await services.usage();
    await change(() => {
      state.usage = total;
    });
  };
  const finish = async (
    outcome: SdlcResult['outcome'],
    unresolvedWork: string[]
  ): Promise<SdlcResult> => {
    await usage();
    await change(() => {
      state.outcome = outcome;
      state.activity = `${outcome}: ${unresolvedWork.join('; ') || 'independent acceptance recorded'}`;
      const assessment = state.assessments.at(-1);
      const review = [...state.tasks]
        .reverse()
        .find((task) => task.kind === 'review' && task.status === 'completed')?.result as unknown as
        | SdlcReview
        | undefined;
      state.result = {
        operationId: state.operationId,
        outcome,
        goalRevision: state.brief.goalRevision,
        workspace: state.workspace,
        candidateRevision: state.candidateRevision,
        changedFiles: state.changedFiles,
        ...(assessment ? { assessmentId: assessment.id } : {}),
        acceptanceEvidence: state.evidence
          .filter(
            (item) => !item.invalidatedBy && item.candidateRevision === state.candidateRevision
          )
          .map((item) => item.id),
        findingDispositions: assessment?.findingDispositions ?? review?.findingDispositions ?? [],
        unresolvedWork,
        pendingQuestions: state.questions.filter((question) => question.answer === undefined),
        limits: state.limits,
        consumed: state.consumed,
        usage: state.usage,
        report: `# SDLC: ${outcome}\n\n${state.brief.goal}\n\nWorkspace: ${state.workspace.cwd}\nCandidate: ${state.candidateRevision}\n\n${unresolvedWork.length ? unresolvedWork.map((item) => `- ${item}`).join('\n') : 'Independent code review and complete goal assessment support this outcome.'}`
      };
    });
    return state.result!;
  };
  if (state.result) return state.result;
  let release: (() => void) | undefined;
  try {
    release = services.acquire?.(state.workspace);
    if (!Object.keys(state.roleSnapshots).length && !state.args.noWork) {
      if (!services.resolveRole)
        throw new Error(
          'SDLC role resolution is unavailable; configure the host role services before execution'
        );
      const selected = resolveStageRoles(state.args.policy?.roles ?? {}, services.resolveRole);
      await change(() => {
        state.roleSnapshots = Object.fromEntries(
          Object.entries(selected).map(([stage, role]) => [stage, jsonValue(role)])
        );
        decision('roles', 'Selected role definitions and effective policies pinned before effects');
      });
    }
    // The selected workspace intent was committed by host.start before this first effect.
    await services.ensure(state.workspace);
    if (state.setup === 'intent') {
      const candidate = await services.inspect(state.workspace);
      await change(() => {
        state.setup = 'ready';
        state.candidateRevision = candidate.revision;
        state.changedFiles = candidate.changedFiles;
        decision('setup', 'Selected workspace setup reconciled');
      });
    }
    for (const task of state.tasks)
      if (task.ownershipViolations?.length) {
        const current = await services.observe(task.workspace ?? state.workspace);
        const remaining = task.ownershipViolations.filter(
          (path) => current[path] !== task.filesBefore?.[path]
        );
        if (remaining.length)
          throw new SdlcStop(
            'blocked',
            `Failed task ${task.id} changed files outside its ownership: ${remaining.join(', ')}. Restore those inputs before continuing; changes were not discarded.`
          );
        await change(() => {
          delete task.ownershipViolations;
          decision(
            'ownership-restored',
            'Unexpected partial changes were restored before scheduling',
            [task.id]
          );
        });
      }
    if (state.args.noWork) return finish('no-work', [state.args.noWork.reason]);
    if (state.consumed.replans > state.limits.replans)
      return finish('incomplete', [
        'Replanning allowance exhausted; extend it explicitly to continue'
      ]);
    if (state.outcome)
      return finish(state.outcome, [
        state.stopReason ?? 'Continue explicitly to schedule more work'
      ]);

    // An explicit continuation adopts edits made to the selected target while the operation was
    // paused. Recovery of in-flight work never does: owned writers and integrations reconcile first.
    if ((state.adoptedContinuation ?? 0) < state.continuation) {
      const current = await services.inspect(state.workspace);
      const inflight = state.tasks.some(
        (task) =>
          task.status === 'preparing' ||
          task.status === 'running' ||
          task.integration?.status === 'intent'
      );
      await change(() => {
        state.adoptedContinuation = state.continuation;
        if (inflight || current.revision === state.candidateRevision) return;
        decision(
          'adopt-target',
          'Continuation adopts the target as changed while paused. Earlier checks and reviews of the prior revision stay stale; user changes are preserved'
        );
        state.candidateRevision = current.revision;
        state.changedFiles = current.changedFiles;
      });
    }
    const roleFor = (stage: SdlcStage) =>
      state.roleSnapshots[stage] as unknown as WorkflowResolvedRole;
    const stageFor = (task: SdlcTask): SdlcStage =>
      task.kind === 'analysis' ? 'analyst' : task.kind === 'review' ? 'reviewer' : 'implementer';
    const createTask = (
      contract: SdlcTaskContract,
      kind: SdlcTask['kind'],
      planRevision: number
    ): SdlcTask => ({
      ...contract,
      kind,
      revision: 1,
      planRevision,
      briefRevision: state.brief.revision,
      status: 'pending'
    });
    const existingDependencies = () =>
      new Map(state.tasks.map((task) => [task.id, task.dependsOn]));
    const addPlan = (
      plan: SdlcPlanInput,
      kind: 'implementation' | 'analysis' = 'implementation',
      /** Corrections and conflict resolution spend correctionRounds, not the replanning allowance. */
      replan = kind === 'implementation'
    ) => {
      validatePlan(
        plan,
        new Set((state.args.checks ?? []).map((check) => check.id)),
        new Set(state.questions.map((question) => question.id)),
        existingDependencies()
      );
      const replanning = replan && state.plans.some((plan) => plan.shape !== 'investigation');
      if (replanning && state.consumed.replans >= state.limits.replans)
        throw new SdlcStop(
          'incomplete',
          'Autonomous replanning allowance exhausted; extend it explicitly to continue'
        );
      const revision = state.plans.length + 1;
      const prefix = `p${revision}-`;
      const localIds = new Set(plan.tasks.map((task) => task.id));
      for (const question of state.questions) {
        for (const id of question.affectedTasks)
          if (!localIds.has(id) && !state.tasks.some((task) => task.id === id))
            throw new Error(`SDLC question ${question.id} references unknown affected task ${id}`);
        question.affectedTasks = question.affectedTasks.map((id) =>
          localIds.has(id) ? prefix + id : id
        );
      }
      if (replanning) state.consumed.replans++;
      const taskIds = plan.tasks.map((task) => prefix + task.id);
      const shape =
        kind === 'analysis'
          ? 'investigation'
          : plan.tasks.length === 1
            ? 'single'
            : plan.tasks.some((task, index) =>
                  plan.tasks
                    .slice(index + 1)
                    .some(
                      (other) =>
                        !task.dependsOn.includes(other.id) && !other.dependsOn.includes(task.id)
                    )
                )
              ? 'parallel'
              : 'sequential';
      state.plans.push({
        revision,
        reason: plan.reason,
        shape,
        taskIds,
        briefRevision: state.brief.revision
      });
      for (const contract of plan.tasks)
        state.tasks.push(
          createTask(
            {
              ...contract,
              id: prefix + contract.id,
              dependsOn: contract.dependsOn.map((id) => (localIds.has(id) ? prefix + id : id)),
              questionIds: [
                ...new Set([
                  ...contract.questionIds,
                  ...state.questions
                    .filter(
                      (question) =>
                        question.answer === undefined &&
                        (!question.affectedTasks.length ||
                          question.affectedTasks.includes(contract.id) ||
                          question.affectedTasks.includes(prefix + contract.id))
                    )
                    .map((question) => question.id)
                ])
              ]
            },
            kind,
            revision
          )
        );
      decision('plan', plan.reason, taskIds);
    };
    const simpleTask = (
      id: string,
      outcome: string,
      questions: string[] = []
    ): SdlcTaskContract => ({
      id,
      title: outcome.slice(0, 180),
      outcome,
      dependsOn: [],
      writes: ['*'],
      inputs: [],
      checks: (state.args.checks ?? []).map((check) => check.id),
      questionIds: questions
    });
    const workerDecision = (task: SdlcTask, value: unknown) => {
      const output = object(value, `SDLC ${task.kind}`);
      const analyst = task.kind === 'analysis';
      keys(
        output,
        analyst
          ? ['reason', 'assumptions', 'requirements', 'questions', 'tasks', 'artifacts']
          : ['summary', 'limitations', 'questions', 'plan', 'artifacts'],
        'SDLC worker result'
      );
      if (analyst) {
        text(output.reason, 'SDLC planning reason', 4000);
        strings(output.assumptions, 'SDLC planning assumptions', 20);
        if (!Array.isArray(output.requirements) || output.requirements.length > 20)
          throw new Error('SDLC analysis requires bounded additional requirements');
        for (const value of output.requirements) {
          const item = object(value, 'SDLC additional requirement');
          keys(item, ['description', 'verification', 'checkIds'], 'SDLC additional requirement');
          text(item.description, 'SDLC additional requirement');
          if (!['behavioral', 'inspection'].includes(item.verification as string))
            throw new Error('Invalid SDLC additional requirement verification');
          if (
            strings(item.checkIds, 'SDLC additional requirement checks').some(
              (id) => !state.args.checks?.some((check) => check.id === id)
            )
          )
            throw new Error('Analyst proposed an unconfigured check');
        }
      } else {
        text(output.summary, 'SDLC implementation summary', 4000);
        strings(output.limitations, 'SDLC implementation limitations', 20);
      }
      validateArtifacts(output);
      const questions = output.questions ?? [];
      validateQuestions(questions);
      const nextQuestions = questions as NonNullable<SdlcArgs['questions']>;
      for (const question of nextQuestions)
        if (state.questions.some((other) => other.id === question.id))
          throw new Error(`Duplicate SDLC question ${question.id}`);
      let plan: unknown = analyst ? { reason: output.reason, tasks: output.tasks } : output.plan;
      if (analyst && Array.isArray(output.tasks) && !output.tasks.length && nextQuestions.length)
        plan = { reason: output.reason, tasks: [simpleTask('clarified', state.brief.goal)] };
      else if (!analyst && plan === undefined && nextQuestions.length)
        plan = {
          reason: 'Material ambiguity pauses dependent implementation until recorded answers',
          tasks: [
            {
              id: 'clarified',
              title: task.title,
              outcome: task.outcome,
              writes: [...task.writes],
              inputs: [...task.inputs],
              checks: [...task.checks],
              dependsOn: [...task.dependsOn],
              questionIds: [
                ...new Set([...task.questionIds, ...nextQuestions.map((item) => item.id)])
              ]
            }
          ]
        };
      if (plan !== undefined) {
        validatePlan(
          plan,
          new Set((state.args.checks ?? []).map((check) => check.id)),
          new Set([...state.questions, ...nextQuestions].map((question) => question.id)),
          existingDependencies()
        );
        const local = new Set(plan.tasks.map((item) => item.id));
        const dependsOnTask = (id: string, seen = new Set<string>()): boolean => {
          if (id === task.id) return true;
          if (seen.has(id)) return false;
          seen.add(id);
          return (
            state.tasks
              .find((item) => item.id === id)
              ?.dependsOn.some((dependency) => dependsOnTask(dependency, seen)) ?? false
          );
        };
        for (const item of plan.tasks)
          for (const dependency of item.dependsOn)
            if (!local.has(dependency) && dependsOnTask(dependency))
              throw new Error(`SDLC handoff dependency ${dependency} would create a cycle`);
        for (const question of nextQuestions)
          for (const id of question.affectedTasks)
            if (!local.has(id) && !state.tasks.some((item) => item.id === id))
              throw new Error(
                `SDLC question ${question.id} references unknown affected task ${id}`
              );
      }
      return { output, nextQuestions, plan: plan as SdlcPlanInput | undefined };
    };
    /** Admit at most the remaining task and soft token allowance. Consumption is cumulative. */
    const admissible = async (wanted: number): Promise<number> => {
      await usage();
      if (state.usage.totalTokens >= state.limits.tokenBudget)
        throw new SdlcStop(
          'incomplete',
          'Cumulative operation token allowance exhausted; in-flight work can exceed this soft allowance'
        );
      const remainingTasks = state.limits.maxTasks - state.consumed.tasks;
      if (remainingTasks < 1)
        throw new SdlcStop('incomplete', 'Cumulative SDLC task allowance exhausted');
      // Heuristic only: observed spend per admitted task, including failed work.
      const average = state.usage.totalTokens / Math.max(1, state.consumed.tasks);
      const affordable = Math.max(
        1,
        Math.floor((state.limits.tokenBudget - state.usage.totalTokens) / Math.max(1, average))
      );
      return Math.min(wanted, remainingTasks, affordable);
    };
    const evidence = (item: Omit<SdlcEvidence, 'briefRevision' | 'goalRevision'>) => {
      state.evidence.push({
        ...item,
        briefRevision: state.brief.revision,
        goalRevision: state.brief.goalRevision
      });
    };
    const saveArtifacts = (task: SdlcTask, result: Record<string, unknown>) => {
      validateArtifacts(result);
      for (const [index, item] of (result.artifacts as unknown[]).entries()) {
        const artifact = object(item, 'SDLC artifact');
        const contentRevision = sdlcIdentity(artifact);
        evidence({
          id: `${task.id}-artifact-${index + 1}-${contentRevision.slice(0, 12)}`,
          kind: 'artifact',
          producingTask: task.id,
          inputRevision: task.inputRevision!,
          candidateRevision: task.outputRevision ?? task.candidateRevision!,
          scope: [...task.writes],
          dependencies: [...task.dependsOn],
          result: jsonValue({ ...artifact, contentRevision }),
          limitations: []
        });
      }
    };
    const runCheck = async (
      checkId: string,
      workspace: SdlcWorkspace,
      revision: string,
      phase: 'baseline' | 'task' | 'integration',
      taskId: string
    ) => {
      const key = `${phase}:${taskId}:${checkId}:${revision}:c${state.continuation}`;
      const known = state.checks.find((item) => item.id === key);
      if (known?.status === 'completed') return known.result!;
      if (known) {
        const interrupted: SdlcCheckResult = {
          id: key,
          command: state.args.checks!.find((check) => check.id === checkId)!,
          cwd: workspace.cwd,
          environment: 'recorded-environment',
          candidateRevision: revision,
          startedAt: services.now(),
          endedAt: services.now(),
          status: 'interrupted',
          output: '',
          truncated: false,
          error:
            'Interrupted check has an uncertain external effect; explicit continuation admits a new check'
        };
        await change(() => {
          known.result = interrupted;
          known.status = 'completed';
        });
        return interrupted;
      }
      await change(() => {
        state.checks.push({
          id: key,
          phase,
          taskId,
          candidateRevision: revision,
          status: 'intent'
        });
        decision('check', `Run configured check ${checkId} on ${phase} candidate`, [taskId]);
      });
      const before = await services.observe(workspace);
      const result = await services.check(checkId, workspace, key, revision);
      if (result.status === 'passed' && result.command.kind === 'test') {
        if (result.testCount === 0) result.status = 'empty';
        else if (!Number.isSafeInteger(result.testCount) || result.testCount! < 1)
          result.status = 'unknown';
      }
      const after = await services.observe(workspace);
      if (changedSdlcFiles(before, after).length)
        throw new SdlcStop(
          'blocked',
          `Check ${checkId} changed source inputs; acceptance evidence is invalid. Inspect the workspace without discarding changes.`
        );
      const baseline = state.checks.find(
        (item) => item.phase === 'baseline' && item.result?.command.id === checkId
      )?.result;
      if (result.status !== 'passed')
        result.classification =
          result.status !== 'failed'
            ? 'missing-coverage'
            : phase === 'baseline' || baseline?.status === 'failed'
              ? 'baseline-failure'
              : baseline?.status === 'passed'
                ? 'introduced-failure'
                : 'missing-baseline';
      await change(() => {
        const entry = state.checks.find((item) => item.id === key)!;
        entry.result = result;
        entry.status = 'completed';
        evidence({
          id: key,
          kind: 'check',
          producingTask: taskId,
          inputRevision: sdlcIdentity({ checkId, revision, phase }),
          candidateRevision: revision,
          scope: result.command.outcomes,
          dependencies: [taskId],
          result: jsonValue(result),
          limitations:
            result.status === 'passed'
              ? []
              : [result.error ?? `${result.status}; tests=${result.testCount ?? 'unknown'}`]
        });
      });
      return result;
    };
    const runTask = async (task: SdlcTask) => {
      if (task.status === 'completed') return;
      const stage = stageFor(task);
      if (task.forkBaseRevision && !task.workspace) {
        const workspace = await services.fork(state.workspace, task.id);
        if (workspace.sourceRevision !== task.forkBaseRevision)
          throw new SdlcStop('blocked', 'Worker fork has an incompatible candidate base');
        await change(() => {
          task.workspace = workspace;
        });
      }
      if (!task.inputRevision) {
        const candidate = await services.inspect(task.workspace ?? state.workspace);
        const expected = state.candidateRevision;
        if (
          (!task.workspace || task.workspace.owner === state.workspace.owner) &&
          candidate.revision !== expected
        )
          throw new SdlcStop(
            'blocked',
            'Target drift detected before task admission; user changes were preserved'
          );
        await change(() => {
          task.status = 'preparing';
          task.candidateRevision = candidate.revision;
          task.role = roleFor(stage).definition.id;
          task.resolvedRole = jsonValue(roleFor(stage));
          task.inputRevision = sdlcIdentity({
            task: { ...task, status: 'pending' },
            brief: state.brief,
            candidate: expected,
            dependencies: task.dependsOn.map(
              (id) => state.tasks.find((other) => other.id === id)?.outputRevision
            ),
            role: roleFor(stage).policy.hash
          });
          decision(
            'admit',
            `Admit ${stage} ${task.id} with stable inputs and workspace ownership`,
            [task.id]
          );
          state.consumed.tasks++;
        });
      }
      if (!task.workspace)
        await change(() => {
          task.workspace = state.workspace;
        });
      if (!task.filesBefore) {
        const filesBefore = await services.observe(task.workspace!);
        await change(() => {
          task.filesBefore = filesBefore;
        });
      }
      if (!task.prompt) {
        const contextArtifacts = state.brief.context.map(
          (content, index): SdlcEvidence => ({
            id: `context-${index + 1}-${sdlcIdentity(content).slice(0, 12)}`,
            kind: 'artifact',
            producingTask: 'brief',
            briefRevision: state.brief.revision,
            goalRevision: state.brief.goalRevision,
            inputRevision: sdlcIdentity(content),
            candidateRevision: state.candidateRevision,
            scope: ['brief:context'],
            dependencies: [],
            result: jsonValue({
              name: `Supplied context ${index + 1}`,
              content,
              references: [],
              contentRevision: sdlcIdentity(content)
            }),
            limitations: []
          })
        );
        if (contextArtifacts.some((item) => !state.evidence.some((other) => item.id === other.id)))
          await change(() => {
            for (const item of contextArtifacts)
              if (!state.evidence.some((other) => item.id === other.id)) state.evidence.push(item);
          });
        const artifactPaths = new Map<string, string>();
        if (services.artifact)
          for (const item of state.evidence)
            if (item.kind === 'artifact' || item.kind === 'check' || item.kind === 'review')
              artifactPaths.set(item.id, await services.artifact(item));
        const artifacts = state.evidence.filter(
          (item) =>
            task.inputs.includes(item.id) ||
            (!item.invalidatedBy &&
              (task.dependsOn.includes(item.producingTask) ||
                task.inputs.includes(item.producingTask) ||
                item.kind === 'import'))
        );
        const manifest = state.evidence.map(
          ({ id, kind, producingTask, inputRevision, scope, limitations }) => ({
            id,
            kind,
            producingTask,
            inputRevision,
            scope,
            limitations,
            ...(artifactPaths.has(id)
              ? {
                  path: artifactPaths.get(id),
                  retrieval:
                    'Read this cached evidence file selectively with the admitted read tool. The operation database owns its contents.'
                }
              : {})
          })
        );
        let contextCharacters = Math.max(
          1000,
          ((state.args.policy?.contextWindowTokens ?? 128_000) *
            (state.args.policy?.contextTarget ?? 0.5) -
            12_000) *
            4
        );
        const compactBrief = {
          ...state.brief,
          context: state.brief.context.map((content, index) => {
            const budget = Math.max(0, contextCharacters);
            contextCharacters -= content.length;
            const path = artifactPaths.get(contextArtifacts[index].id);
            return path && content.length > budget
              ? `${content.slice(0, budget)}\n[Remaining supplied context: read ${path}]`
              : content;
          })
        };
        const compactEvidence = (item: SdlcEvidence) => {
          const path = artifactPaths.get(item.id);
          const reference = { id: item.id, path, scope: item.scope, limitations: item.limitations };
          if (item.kind === 'check') {
            const { output, ...summary } = item.result as unknown as SdlcCheckResult;
            return {
              ...reference,
              result: {
                ...summary,
                outputCharacters: output.length,
                ...(path
                  ? {}
                  : {
                      output: output.slice(0, 1000),
                      retrieval: 'Retrieve full evidence by ID from the host'
                    })
              }
            };
          }
          return path ? reference : item;
        };
        const taskSchema =
          stage === 'reviewer'
            ? createSdlcReviewSchema({
                goalRevision: state.brief.goalRevision,
                candidateRevision: state.candidateRevision,
                outcomeIds: state.brief.acceptance.map((item) => item.id),
                checkIds: (state.args.checks ?? []).map((check) => check.id),
                cwd: state.workspace.cwd,
                supporting: !!task.reviewContext,
                producer: task.id,
                knownFindingIds: [
                  ...state.importedFindings.map((finding) => finding.id),
                  ...recordedSdlcReviews(state).flatMap(({ review }) =>
                    review.codeReview.findings.map((finding) => finding.id)
                  )
                ]
              })
            : stage === 'analyst'
              ? SDLC_ANALYSIS_SCHEMA
              : SDLC_IMPLEMENTATION_SCHEMA;
        const instructions =
          stage === 'reviewer'
            ? SDLC_REVIEW_INSTRUCTIONS
            : stage === 'analyst'
              ? 'Investigate only the named uncertainties. Propose a validated dependency graph with literal write ownership and checks from the configured list. Preserve all original outcomes; add missing criteria, never remove them. Persist material questions through this structured result. Do not mutate files.'
              : 'Implement the authorized assignment in the assigned workspace. Read relevant guidance. Respect write ownership. Read failure evidence referenced in assignment.inputs or relevantEvidence before correcting checks or review findings. Do not publish, deploy, change unrelated files, or weaken tests/acceptance. Report evidence limitations, not invented results. If a material ambiguity prevents implementation, return optional questions before editing. If the assignment exceeds the context target or has useful independent interfaces, return an optional dependency plan before editing. Questions may reference local plan task IDs; absent affectedTasks pauses all replacement tasks. Do not use handoff merely to restate a clear small task. Return compact artifacts through structured_output.';
        const promptInput = {
          assignment: {
            id: task.id,
            outcome: task.outcome,
            writes: task.writes,
            inputs: task.inputs,
            checks: task.checks
          },
          brief: compactBrief,
          candidateRevision: task.candidateRevision,
          inputRevision: task.inputRevision,
          dependencies: task.dependsOn.map((id) => {
            const dependency = state.tasks.find((other) => other.id === id);
            let result = dependency?.result;
            if (result && typeof result === 'object' && !Array.isArray(result)) {
              const cached = state.evidence.filter(
                (item) =>
                  item.kind === 'artifact' &&
                  item.producingTask === id &&
                  artifactPaths.has(item.id)
              );
              if (
                cached.length &&
                Array.isArray(result.artifacts) &&
                cached.length === result.artifacts.length
              )
                result = {
                  ...result,
                  artifacts: cached.map((item) => ({
                    id: item.id,
                    path: artifactPaths.get(item.id)!
                  }))
                };
            }
            return { id, outputRevision: dependency?.outputRevision, result };
          }),
          questions: state.questions.filter((question) => task.questionIds.includes(question.id)),
          evidenceManifest: manifest,
          relevantEvidence: artifacts.map(compactEvidence),
          ...(stage === 'reviewer'
            ? {
                checks: state.evidence
                  .filter(
                    (item) =>
                      item.kind === 'check' &&
                      item.candidateRevision === state.candidateRevision &&
                      item.id.endsWith(`:c${state.continuation}`) &&
                      !item.invalidatedBy
                  )
                  .map(compactEvidence),
                pendingFindings: pendingSdlcFindings(state),
                importedFindings: state.importedFindings,
                changedFiles: state.changedFiles,
                ...(task.reviewContext
                  ? {
                      reviewContext: task.reviewContext,
                      sourceReviews: task.reviewContext.sourceReviewIds.map((id) => ({
                        id,
                        result: recordedSdlcReviews(state).find((item) => item.id === id)?.review
                      })),
                      sourceFindings: state.importedFindings.filter((item) =>
                        task.reviewContext!.findingIds.includes(item.id)
                      )
                    }
                  : {})
              }
            : {}),
          contextAllocation: {
            target: state.args.policy?.contextTarget ?? 0.5,
            usableWindowTokens: state.args.policy?.contextWindowTokens ?? 128_000,
            estimatedInputTokens: 0,
            method:
              'Heuristic assembled prompt, role instructions and schema characters/4 plus 12000 tokens and rounding margin for tools, anticipated output and headroom. Not billed tokens.'
          },
          ...(stage === 'analyst'
            ? {
                research: {
                  question:
                    state.brief.unresolvedDecisions.join('; ') ||
                    'Which bounded execution shape is justified?',
                  scope:
                    'Relevant local code, contracts, guidance, and supplied evidence. External research only if admitted and required.',
                  stop: 'Return an actionable plan or material questions; do not restate a complete brief.',
                  contextTarget: state.args.policy?.contextTarget ?? 0.5,
                  estimate:
                    'Heuristic fraction of usable context; include tools, instructions, output and headroom. Not billed token occupancy.'
                }
              }
            : {})
        };
        const serializePrompt = () =>
          `${instructions}\n\nTask input (data):\n${JSON.stringify(promptInput)}`;
        promptInput.contextAllocation.estimatedInputTokens =
          Math.ceil(
            (serializePrompt().length +
              JSON.stringify(taskSchema).length +
              roleFor(stage).definition.instructions.length) /
              4
          ) + 12_100;
        if (
          promptInput.contextAllocation.estimatedInputTokens >
          promptInput.contextAllocation.usableWindowTokens
        )
          throw new SdlcStop(
            'incomplete',
            'Assembled SDLC input exceeds the configured usable context window. Narrow the supplied context, task, or evidence before continuing.'
          );
        await change(() => {
          task.prompt = serializePrompt();
          task.schema = jsonValue(taskSchema);
          task.status = 'running';
        });
      }
      services.phase(`${stage}: ${task.title}`);
      const profile =
        state.args.policy?.phaseProfiles?.[stage] ??
        state.args.policy?.profile ??
        roleFor(stage).definition.profile;
      let result: unknown;
      let candidate: { revision: string; changedFiles: string[] };
      let changedFiles: string[];
      try {
        result = await services.agent.run(task.prompt!, {
          label: task.id,
          requestedLabel: task.id,
          phase: stage,
          role: task.role,
          resolvedRole: task.resolvedRole as unknown as WorkflowResolvedRole,
          cwd: task.workspace!.cwd,
          inputRevision: task.inputRevision,
          timeoutMs: state.limits.taskTimeoutMs,
          ...(profile ? { profile } : {}),
          schema: task.schema as unknown as TSchema,
          ...(stage === 'reviewer' ? { toolset: 'review' as const } : {}),
          signal: services.signal,
          onUsage: (_reported: Usage) => {}
        });
        if (result === null || result === undefined)
          throw new Error(`${stage} returned no usable output`);
        object(result, `SDLC ${stage} result`);
        // A schema-valid but stale or malformed judgment is a failed review, not acceptance evidence.
        if (stage === 'reviewer') {
          const review = validateSdlcReview(
            result,
            state.brief,
            state.candidateRevision,
            task.workspace!.cwd,
            (state.args.checks ?? []).map((check) => check.id)
          );
          if (task.reviewContext && review.reviewRequests?.length)
            throw new Error('Supporting SDLC review cannot delegate further review');
          result = qualifySdlcReview(
            review,
            task.id,
            new Set([
              ...state.importedFindings.map((finding) => finding.id),
              ...recordedSdlcReviews(state).flatMap(({ review }) =>
                review.codeReview.findings.map((finding) => finding.id)
              )
            ])
          );
        } else workerDecision(task, result);
        const afterFiles = await services.observe(task.workspace!);
        changedFiles = changedSdlcFiles(task.filesBefore!, afterFiles);
        if (changedFiles.some((path) => stage !== 'implementer' || !ownsPath(task.writes, path)))
          throw new Error(`Unexpected file changes by ${task.id}; changes retained for inspection`);
        candidate = await services.inspect(task.workspace!);
        if (stage !== 'implementer' && candidate.revision !== task.candidateRevision)
          throw new Error(
            'Source changed during independent inspection; stale judgments cannot establish acceptance'
          );
        if (stage === 'implementer') {
          const output = object(result, 'SDLC implementation');
          if (
            changedFiles.length &&
            (output.plan !== undefined ||
              (Array.isArray(output.questions) && output.questions.length))
          )
            throw new Error(
              'Worker requested a handoff after mutation; inspect retained changes before continuation'
            );
        }
      } catch (error) {
        if (services.signal.aborted) throw error;
        const partial = await services.inspect(task.workspace!);
        const observed = await services.observe(task.workspace!);
        const changed = changedSdlcFiles(task.filesBefore!, observed);
        const violations = changed.filter(
          (path) => stage !== 'implementer' || !ownsPath(task.writes, path)
        );
        await change(() => {
          task.status = 'failed';
          task.outputRevision = partial.revision;
          task.changedFiles = changed;
          if (violations.length) task.ownershipViolations = violations;
          task.error = error instanceof Error ? error.message : String(error);
          state.consumed.failedTasks++;
          if (task.workspace!.owner === state.workspace.owner) {
            state.candidateRevision = partial.revision;
            state.changedFiles = partial.changedFiles;
          }
        });
        throw new SdlcStop(
          violations.length ? 'blocked' : 'incomplete',
          `${stage} ${task.id} failed: ${task.error}${violations.length ? `; unexpected file changes: ${violations.join(', ')}` : ''}`
        );
      }
      await change(() => {
        task.result = jsonValue(result);
        task.outputRevision = candidate.revision;
        task.changedFiles = changedFiles;
        task.status = 'completed';
        if (task.workspace!.owner === state.workspace.owner) {
          state.candidateRevision = candidate.revision;
          state.changedFiles = candidate.changedFiles;
        }
      });
      await usage();
    };

    const runBatch = async (tasks: SdlcTask[]) => {
      const outcomes = await Promise.allSettled(tasks.map((task) => runTask(task)));
      const failed = outcomes.find((outcome) => outcome.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    };
    const supportingReview = async (
      parent: SdlcTask,
      purpose: NonNullable<SdlcTask['reviewContext']>['purpose'],
      scope: string,
      sources: string[],
      findingIds: string[] = []
    ) => {
      let task = state.tasks.find(
        (item) =>
          item.kind === 'review' &&
          item.status === 'completed' &&
          item.candidateRevision === state.candidateRevision &&
          item.briefRevision === state.brief.revision &&
          item.reviewContext?.parentTaskId === parent.id &&
          item.reviewContext.purpose === purpose &&
          item.reviewContext.scope === scope
      );
      if (!task) {
        await admissible(1);
        await change(() => {
          const id = `${parent.id}-${purpose}-${state.tasks.length + 1}-c${state.continuation}`;
          task = createTask(
            simpleTask(
              id,
              purpose === 'verification'
                ? `Independently verify only the named historical or uncertain claims, then report the complete goal judgments. Do not assume a claim is confirmed because it was imported. ${scope}`
                : purpose === 'synthesis'
                  ? 'Independently assess the full goal using the bounded specialist evidence. Retain unresolved findings and limitations; close them only with concrete counterevidence. Do not request more reviewers.'
                  : `Inspect this specialist scope and report complete goal judgments. Do not request more reviewers: ${scope}`
            ),
            'review',
            state.plans.length
          );
          task.dependsOn = [...sources];
          task.reviewContext = {
            purpose,
            parentTaskId: parent.id,
            scope,
            sourceReviewIds: [...sources],
            findingIds: [...findingIds]
          };
          state.tasks.push(task);
          decision(`review-${purpose}`, scope, [id]);
        });
        await runTask(task!);
      }
      if (!state.evidence.some((item) => item.producingTask === task!.id && !item.invalidatedBy))
        await change(() =>
          evidence({
            id: `${task!.id}-evidence`,
            kind: 'review',
            producingTask: task!.id,
            inputRevision: task!.inputRevision!,
            candidateRevision: state.candidateRevision,
            scope: [scope],
            dependencies: [...sources],
            result: task!.result!,
            limitations: []
          })
        );
      return task!;
    };
    if (!state.plans.length) {
      if (state.args.plan) await change(() => addPlan(state.args.plan!));
      else if (
        state.args.planning === 'investigate' ||
        state.brief.unresolvedDecisions.length ||
        Math.ceil(JSON.stringify(state.brief).length / 4) + 12_000 >
          (state.args.policy?.contextTarget ?? 0.5) *
            (state.args.policy?.contextWindowTokens ?? 128_000)
      )
        await change(() =>
          addPlan(
            {
              reason: 'Material unknown decisions require bounded investigation and planning',
              tasks: [
                simpleTask(
                  'investigate',
                  'Resolve material uncertainties and select the smallest safe execution shape'
                )
              ]
            },
            'analysis'
          )
        );
      else
        await change(() =>
          addPlan({
            reason:
              'Supplied goal is actionable; coupled work needs one implementer, not an analyst',
            tasks: [
              simpleTask(
                'implement',
                state.brief.goal,
                state.questions.map((question) => question.id)
              )
            ]
          })
        );
    }
    for (const check of state.args.checks ?? [])
      if (
        !state.tasks.some((task) => task.kind === 'implementation' && task.inputRevision) &&
        !state.checks.some(
          (item) => item.phase === 'baseline' && item.result?.command.id === check.id
        )
      )
        await runCheck(check.id, state.workspace, state.candidateRevision, 'baseline', 'baseline');
    const gateChecks = async (
      observed: SdlcCheckResult[],
      workspace: SdlcWorkspace,
      revision: string,
      task?: SdlcTask
    ): Promise<boolean> => {
      const failures = observed.filter((check) => check.status !== 'passed');
      if (!failures.length) return true;
      const details = failures.map(
        (check) =>
          `Required check ${check.command.id}: ${check.status}; tests=${check.testCount ?? 'unknown'}; ${check.classification ?? 'missing-coverage'}`
      );
      if (
        failures.some((check) => check.status !== 'failed') ||
        (!task && failures.every((check) => check.classification === 'baseline-failure'))
      )
        throw new SdlcStop('incomplete', details.join('; '));
      if (state.consumed.corrections >= state.limits.correctionRounds)
        throw new SdlcStop(
          'incomplete',
          `${details.join('; ')}; Correction-round allowance exhausted`
        );
      const identity = sdlcIdentity({
        workspace: workspace.owner,
        revision,
        checks: failures.map((check) => check.command.id).sort()
      });
      if (
        state.decisions.some(
          (item) => item.kind === 'check-correction' && item.inputRevision === identity
        )
      )
        throw new SdlcStop(
          'incomplete',
          `${details.join('; ')}; No credible progress on failing checks`
        );
      await change(() => {
        state.consumed.corrections++;
        const contract = task
          ? {
              id: `correct-check-${state.consumed.corrections}`,
              title: task.title,
              outcome: task.outcome,
              writes: [...task.writes],
              dependsOn: [...task.dependsOn],
              inputs: [...task.inputs],
              checks: [...task.checks],
              questionIds: [...task.questionIds]
            }
          : simpleTask(`correct-check-${state.consumed.corrections}`, state.brief.goal);
        contract.inputs.push(...failures.map((check) => check.id));
        addPlan(
          {
            reason: 'Executed failures require correction before integration, dependents or review',
            tasks: [contract]
          },
          'implementation',
          false
        );
        const replacement = state.tasks.at(-1)!;
        if (workspace.owner !== state.workspace.owner) replacement.workspace = workspace;
        if (task) {
          saveArtifacts(task, object(task.result, 'SDLC implementation'));
          task.status = 'invalidated';
          task.settled = true;
          task.supersededBy = replacement.id;
          for (const other of state.tasks) {
            if (other.status === 'pending')
              other.dependsOn = other.dependsOn.map((id) => (id === task.id ? replacement.id : id));
            if (other.integration?.resolutionTaskId === task.id)
              other.integration.resolutionTaskId = replacement.id;
          }
        }
        for (const other of state.tasks)
          if (other.kind === 'review' && other.status === 'completed') other.status = 'invalidated';
        for (const item of state.evidence)
          if (item.kind === 'review') item.invalidatedBy = replacement.id;
        decision('check-correction', details.join('; '), [replacement.id]);
        state.decisions.at(-1)!.inputRevision = identity;
      });
      return false;
    };
    const settleOutputs = async () => {
      for (const task of state.tasks.filter(
        (task) => task.kind === 'implementation' && task.status === 'completed' && !task.settled
      )) {
        const { output, nextQuestions, plan } = workerDecision(task, task.result);
        if (
          output.plan !== undefined ||
          (Array.isArray(output.questions) && output.questions.length)
        ) {
          if (task.changedFiles?.length)
            throw new SdlcStop(
              'blocked',
              `Worker ${task.id} requested a handoff after mutation; inspect retained changes before continuation`
            );
          await change(() => {
            for (const question of nextQuestions) {
              if (state.questions.some((other) => other.id === question.id))
                throw new Error(`Duplicate SDLC question ${question.id}`);
              state.questions.push({ ...question, briefRevision: state.brief.revision });
            }
            state.brief.unresolvedDecisions = state.questions
              .filter((question) => question.answer === undefined)
              .map((question) => question.text);
            addPlan(plan!);
            // Work delegated by this task is not complete until its replacement tasks are.
            const delegated = state.plans.at(-1)!.taskIds;
            for (const other of state.tasks)
              if (other.status === 'pending' && other.dependsOn.includes(task.id))
                other.dependsOn.push(...delegated.filter((id) => !other.dependsOn.includes(id)));
            saveArtifacts(task, output);
            task.settled = true;
            decision(
              'handoff-applied',
              'Validated implementer clarification/decomposition recorded before dependent effects',
              [task.id]
            );
          });
          continue;
        }
        if (output.questions !== undefined) validateQuestions(output.questions);
        text(output.summary, 'SDLC implementation summary', 4000);
        strings(output.limitations, 'SDLC implementation limitations', 20);
        const observed: SdlcCheckResult[] = [];
        for (const check of task.checks)
          observed.push(
            await runCheck(check, task.workspace!, task.outputRevision!, 'task', task.id)
          );
        if (!(await gateChecks(observed, task.workspace!, task.outputRevision!, task))) continue;
        if (task.workspace?.owner !== state.workspace.owner) {
          if (!task.integration)
            await change(() => {
              task.integration = { expectedRevision: state.candidateRevision, status: 'intent' };
              decision('integration', `Integrate retained output ${task.id}`, [task.id]);
            });
          try {
            const integrated = await services.integrate(
              state.workspace,
              task.workspace!,
              task.integration!.expectedRevision
            );
            await change(() => {
              task.integration!.status = 'completed';
              task.integration!.outputRevision = integrated.revision;
              state.candidateRevision = integrated.revision;
              state.changedFiles = integrated.changedFiles;
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!/integration conflict/i.test(message)) throw error;
            if (state.consumed.corrections >= state.limits.correctionRounds)
              throw new SdlcStop(
                'incomplete',
                `Semantic integration needs correction allowance: ${message}`
              );
            await change(() => {
              state.consumed.corrections++;
              const resolution = simpleTask(
                `integration-${state.consumed.corrections}`,
                `Resolve semantic integration of the retained worker output into the evolving target without discarding target changes. Preserve every original obligation. Retained output: ${JSON.stringify({ task: task.id, workspace: task.workspace, base: task.forkBaseRevision, outputRevision: task.outputRevision, changedFiles: task.changedFiles, error: message })}`
              );
              resolution.inputs = [task.id];
              addPlan(
                {
                  reason:
                    'A local integration conflict requires one bounded implementation against the assembled target',
                  tasks: [resolution]
                },
                'implementation',
                false
              );
              task.integration!.status = 'conflict';
              task.integration!.error = message;
              task.integration!.resolutionTaskId = state.plans.at(-1)!.taskIds[0];
              saveArtifacts(task, output);
              task.settled = true;
              decision(
                'integration-conflict',
                'Retained output and conflict recorded before semantic resolution',
                [task.id, task.integration!.resolutionTaskId]
              );
            });
            continue;
          }
        }
        await change(() => {
          saveArtifacts(task, object(task.result, 'SDLC implementation'));
          task.settled = true;
          for (const prior of state.tasks)
            if (
              prior.integration?.status === 'conflict' &&
              prior.integration.resolutionTaskId === task.id
            ) {
              prior.integration.status = 'resolved';
              prior.integration.outputRevision = state.candidateRevision;
            }
        });
      }
    };

    for (;;) {
      if (services.signal.aborted) throw new Error('SDLC interrupted');
      const active = state.tasks.filter((task) => ['preparing', 'running'].includes(task.status));
      // Owned writers are reconciled first, without deriving a new identity from partial edits.
      if (active.length) {
        await runBatch(active);
        continue;
      }
      await settleOutputs();
      const analysis = state.tasks.find(
        (task) =>
          task.kind === 'analysis' &&
          task.status === 'completed' &&
          !state.decisions.some(
            (item) => item.kind === 'analysis-applied' && item.taskIds.includes(task.id)
          )
      );
      if (analysis) {
        const { output, nextQuestions, plan } = workerDecision(analysis, analysis.result);
        await change(() => {
          state.brief.assumptions.push(
            ...strings(output.assumptions, 'SDLC planning assumptions', 20)
          );
          for (const item of output.requirements as Array<Record<string, unknown>>) {
            const description = text(item.description, 'SDLC additional requirement');
            const checks = strings(item.checkIds, 'SDLC additional requirement checks');
            if (checks.some((id) => !state.args.checks?.some((check) => check.id === id)))
              throw new Error('Analyst proposed an unconfigured check');
            if (!['behavioral', 'inspection'].includes(item.verification as string))
              throw new Error('Invalid SDLC additional requirement verification');
            let index = state.brief.acceptance.length;
            while (
              state.brief.acceptance.some((requirement) => requirement.id === `derived-${index}`)
            )
              index++;
            state.brief.acceptance.push({
              id: `derived-${index}`,
              description,
              verification: item.verification as 'behavioral' | 'inspection',
              checkIds: checks
            });
          }
          for (const question of nextQuestions) {
            if (state.questions.some((other) => other.id === question.id))
              throw new Error(`Duplicate SDLC question ${question.id}`);
            state.questions.push({ ...question, briefRevision: state.brief.revision });
          }
          state.brief.unresolvedDecisions = state.questions
            .filter((item) => item.answer === undefined)
            .map((item) => item.text);
          addPlan(plan as SdlcPlanInput);
          saveArtifacts(analysis, output);
          decision(
            'analysis-applied',
            'Recorded validated planning decision before implementation effects',
            [analysis.id]
          );
        });
        continue;
      }
      const pending = state.tasks.filter(
        (task) => task.status === 'pending' && task.kind !== 'review'
      );
      const ready = pending.filter(
        (task) =>
          task.dependsOn.every((id) => {
            const dependency = state.tasks.find((other) => other.id === id);
            return (
              dependency?.status === 'completed' && dependency.integration?.status !== 'conflict'
            );
          }) &&
          !task.questionIds.some((id) =>
            state.questions.some((question) => question.id === id && question.answer === undefined)
          )
      );
      if (ready.length) {
        const batch: SdlcTask[] = [];
        for (const task of ready) {
          if (batch.length >= state.limits.concurrency) break;
          if (
            batch.every(
              (other) =>
                !task.writes.some((path) => ownsPath(other.writes, path)) &&
                !other.writes.some((path) => ownsPath(task.writes, path))
            )
          )
            batch.push(task);
        }
        const allowed = await admissible(batch.length);
        if (allowed < batch.length) {
          const waiting = batch.splice(allowed).map((task) => task.id);
          await change(() =>
            decision(
              'throttle',
              'Remaining task or soft token allowance admits fewer concurrent writers; ready work waits',
              waiting
            )
          );
        }
        if (batch.length > 1 && !state.workspace.repoRoot) {
          const waiting = batch.splice(1).map((task) => task.id);
          await change(() =>
            decision(
              'serialize',
              'This non-Git target cannot isolate concurrent writers; independent ready work runs serially',
              waiting
            )
          );
        }
        // Fork intents for all parallel writers are committed before the first fork/setup effect.
        if (batch.length > 1) {
          const revision = state.candidateRevision;
          await change(() => {
            decision(
              'parallel',
              'Independent dependency-ready writers use isolated workspaces based on the current candidate',
              batch.map((task) => task.id)
            );
            for (const task of batch) {
              task.forkBaseRevision = revision;
              task.status = 'preparing';
            }
          });
        }
        await runBatch(batch);
        await settleOutputs();
        continue;
      }
      const failed = state.tasks.filter((task) => task.status === 'failed');
      if (failed.length)
        return finish(
          'incomplete',
          failed.map((task) => `${task.id}: ${task.error ?? 'failed'}`)
        );
      if (state.questions.some((question) => question.answer === undefined))
        return finish(
          'needs-input',
          state.questions
            .filter((question) => question.answer === undefined)
            .map((question) => `${question.id}: ${question.text}`)
            .concat(
              pending.length
                ? ['Dependent work is paused until its recorded questions are answered']
                : []
            )
        );
      if (pending.length)
        return finish(
          'blocked',
          pending.map(
            (task) =>
              `${task.id} has unresolved dependencies: ${task.dependsOn.join(', ')}. Continue with a revised goal or restore the recorded outputs.`
          )
        );

      const current = await services.inspect(state.workspace);
      if (current.changedFiles.some((path) => !ownsPath(['*'], path)))
        throw new SdlcStop(
          'blocked',
          'Candidate contains changes outside the selected working directory. Restore those changes or select the correct target; they were not discarded.'
        );
      if (current.revision !== state.candidateRevision)
        throw new SdlcStop(
          'blocked',
          'Target changed after assembly; checks and reviews would be stale. Inspect the retained workspace.'
        );
      services.phase('Validate assembled candidate');
      const observed: SdlcCheckResult[] = [];
      for (const check of state.args.checks ?? [])
        observed.push(
          await runCheck(
            check.id,
            state.workspace,
            state.candidateRevision,
            'integration',
            'assembled'
          )
        );
      if (!(await gateChecks(observed, state.workspace, state.candidateRevision))) continue;
      let reviewTask = state.tasks.find(
        (task) =>
          task.kind === 'review' &&
          !task.reviewContext &&
          task.candidateRevision === state.candidateRevision &&
          task.briefRevision === state.brief.revision &&
          task.status === 'completed'
      );
      if (!reviewTask) {
        await admissible(1);
        await change(() => {
          const id = `review-${state.assessments.length + 1}-c${state.continuation}`;
          reviewTask = createTask(
            simpleTask(id, 'Independently judge code quality and complete goal achievement'),
            'review',
            state.plans.length
          );
          state.tasks.push(reviewTask);
          decision(
            'review',
            'Assembled candidate needs a separate independent reviewer conversation',
            [id]
          );
        });
        await runTask(reviewTask!);
      }
      let review = validateSdlcReview(
        reviewTask!.result,
        state.brief,
        state.candidateRevision,
        state.workspace.cwd,
        (state.args.checks ?? []).map((check) => check.id)
      );
      const primary = reviewTask!;
      const specialists: SdlcTask[] = [];
      for (const request of review.reviewRequests ?? [])
        specialists.push(
          await supportingReview(
            primary,
            'specialist',
            `${request.scope}\nReason: ${request.reason}`,
            [primary.id]
          )
        );
      if (specialists.length) {
        reviewTask = await supportingReview(
          primary,
          'synthesis',
          'Synthesize the initial independent review and bounded specialist inspections',
          [primary.id, ...specialists.map((item) => item.id)]
        );
        review = retainSupportingClaims(
          state,
          validateSdlcReview(
            reviewTask.result,
            state.brief,
            state.candidateRevision,
            state.workspace.cwd,
            (state.args.checks ?? []).map((check) => check.id)
          ),
          [primary, ...specialists],
          specialists
        );
      }
      review = retainOperationClaims(state, review);
      const uncertain = [
        ...new Set([
          ...review.codeReview.findings
            .filter((item) => item.verdict === 'UNCERTAIN')
            .map((item) => item.id),
          ...review.findingDispositions
            .filter(
              (item) =>
                item.disposition === 'uncertain' &&
                state.importedFindings.some((finding) => finding.id === item.id)
            )
            .map((item) => item.id)
        ])
      ];
      if (uncertain.length) {
        const beforeVerification = review;
        reviewTask = await supportingReview(
          reviewTask!,
          'verification',
          `Resolve these claims with current source evidence: ${uncertain.join(', ')}`,
          [reviewTask!.id],
          uncertain
        );
        review = validateSdlcReview(
          reviewTask.result,
          state.brief,
          state.candidateRevision,
          state.workspace.cwd,
          (state.args.checks ?? []).map((check) => check.id)
        );
        review = retainSupportingClaims(state, review, [
          { ...primary, result: jsonValue(beforeVerification) }
        ]);
        const unclosed = uncertain.filter((id) => {
          const finding = review.codeReview.findings.find((item) => item.id === id);
          const disposition = review.findingDispositions.find((item) => item.id === id);
          return (
            finding?.verdict === 'UNCERTAIN' ||
            disposition?.disposition === 'uncertain' ||
            (!finding && !disposition)
          );
        });
        if (unclosed.length)
          return finish(
            'incomplete',
            unclosed.map(
              (id) =>
                `Finding ${id} remains uncertain after one independent verification; supply the missing evidence`
            )
          );
      }
      review = retainOperationClaims(state, review);
      const assessment = assessSdlc(state, review, reviewTask!.id);
      if (!state.assessments.some((item) => item.reviewTask === reviewTask!.id))
        await change(() => {
          state.assessments.push(assessment);
          evidence({
            id: assessment.id,
            kind: 'review',
            producingTask: reviewTask!.id,
            inputRevision: reviewTask!.inputRevision!,
            candidateRevision: state.candidateRevision,
            scope: state.brief.acceptance.map((item) => item.id),
            dependencies: state.tasks
              .filter((task) => task.kind === 'implementation' && task.status === 'completed')
              .map((task) => task.id),
            result: jsonValue(review),
            limitations: assessment.coverageGaps
          });
          decision(
            'assessment',
            assessment.accepted
              ? 'Independent code and goal judgments satisfy acceptance policy'
              : 'Goal assessment retains unmet or unverified obligations',
            [reviewTask!.id]
          );
        });
      if (assessment.accepted) {
        const last = await services.inspect(state.workspace);
        if (last.revision !== assessment.candidateRevision)
          throw new SdlcStop(
            'blocked',
            'Candidate drifted before acceptance; prior judgments cannot accept the new source'
          );
        return finish('accepted', []);
      }
      const unresolved = [
        ...assessment.coverageGaps,
        ...review.codeReview.limitations.map((item) => `Review limitation: ${item}`),
        ...assessment.outcomes
          .filter((item) => item.status !== 'met')
          .map((item) => `${item.id}: ${item.status}: ${item.reason}`),
        ...review.codeReview.findings
          .filter((finding) => finding.verdict !== 'REFUTED')
          .map((finding) => `${finding.id}: ${finding.summary}`),
        ...review.findingDispositions
          .filter((item) => ['confirmed', 'uncertain'].includes(item.disposition))
          .map((item) => `${item.id}: ${item.disposition}: ${item.reason}`)
      ];
      if (review.codeReview.verdict === 'unverified')
        return finish('incomplete', unresolved.concat('Independent code review is unverified'));
      if (state.consumed.corrections >= state.limits.correctionRounds)
        return finish('incomplete', unresolved.concat('Correction-round allowance exhausted'));
      const missingEvidenceOnly =
        assessment.outcomes.every((item) => item.status !== 'not-met') &&
        review.codeReview.verdict === 'pass' &&
        !review.codeReview.findings.some((finding) => finding.verdict !== 'REFUTED') &&
        !review.findingDispositions.some(
          (item) =>
            ['confirmed', 'uncertain'].includes(item.disposition) &&
            state.importedFindings.some((finding) => finding.id === item.id)
        );
      if (missingEvidenceOnly) {
        const unverified = assessment.outcomes
          .filter((item) => item.status === 'unverified')
          .map((item) => item.id);
        const available = (state.args.checks ?? []).filter(
          (check) =>
            check.outcomes.some((id) => unverified.includes(id)) ||
            state.brief.acceptance.some(
              (requirement) =>
                unverified.includes(requirement.id) && requirement.checkIds.includes(check.id)
            ) ||
            review.outcomes.some(
              (outcome) => unverified.includes(outcome.id) && outcome.checkIds?.includes(check.id)
            )
        );
        const attempts = state.decisions.filter(
          (decision) =>
            decision.kind === 'verification' && decision.inputRevision === state.candidateRevision
        ).length;
        if (!available.length || attempts >= 1)
          return finish(
            'incomplete',
            unresolved.concat(
              'Required observable verification remains unavailable or inadequate. Continue with additional authorized checks; acceptance criteria are retained.'
            )
          );
        await change(() => {
          state.consumed.corrections++;
          decision(
            'verification',
            'Collect bounded observable evidence without assuming a code change is necessary',
            [reviewTask!.id]
          );
          state.decisions.at(-1)!.inputRevision = state.candidateRevision;
          reviewTask!.status = 'invalidated';
          for (const item of state.evidence)
            if (item.producingTask === reviewTask!.id)
              item.invalidatedBy = 'Additional observable verification requested';
        });
        const observed: SdlcCheckResult[] = [];
        for (const check of available)
          observed.push(
            await runCheck(
              check.id,
              state.workspace,
              state.candidateRevision,
              'integration',
              `verification-${state.assessments.length}`
            )
          );
        if (!observed.some((check) => check.status === 'passed'))
          return finish(
            'incomplete',
            unresolved.concat(
              observed.map(
                (check) =>
                  `Verification ${check.command.id}: ${check.status}; tests=${check.testCount ?? 'unknown'}`
              )
            )
          );
        continue;
      }
      const previous = state.assessments.slice(0, -1).filter(
        (item) =>
          decisiveAssessment(item) &&
          // Older assessments cannot prove that a correction occurred between two reviews.
          (item.correctionCount ?? state.consumed.corrections) < state.consumed.corrections
      );
      if (
        previous.some((item) => item.candidateRevision === state.candidateRevision) ||
        previous.some(
          (item) =>
            sdlcIdentity(
              item.outcomes.map(({ id, status, reason }) => ({ id, status, reason }))
            ) ===
              sdlcIdentity(
                assessment.outcomes.map(({ id, status, reason }) => ({ id, status, reason }))
              ) &&
            item.codeReview.findings.some((finding) =>
              review.codeReview.findings.some(
                (next) => next.summary === finding.summary && next.verdict !== 'REFUTED'
              )
            )
        )
      )
        return finish(
          'incomplete',
          unresolved.concat(
            'No credible progress: repeated candidate, unresolved cause, or oscillation'
          )
        );
      await change(() => {
        state.consumed.corrections++;
        const task = simpleTask(
          `correct-${state.consumed.corrections}`,
          'Correct the failed obligations without changing acceptance criteria. Read the independent assessment referenced in inputs and relevantEvidence. It records unmet outcomes, findings, dispositions, and coverage gaps. Preserve unrelated deferrals.'
        );
        task.inputs = [assessment.id];
        addPlan(
          {
            reason:
              'Independent code or complete-goal verification requires affected correction inside the same operation',
            tasks: [task]
          },
          'implementation',
          false
        );
        for (const task of state.tasks)
          if (task.kind === 'review' && task.status === 'completed') task.status = 'invalidated';
        for (const item of state.evidence)
          if (item.kind === 'review' || item.kind === 'check')
            item.invalidatedBy = `correction-${state.consumed.corrections}`;
      });
    }
  } catch (error) {
    if (services.signal.aborted) throw error;
    return finish(error instanceof SdlcStop ? error.outcome : 'blocked', [
      error instanceof Error ? error.message : String(error)
    ]);
  } finally {
    release?.();
  }
}

/** Read old unqualified records without changing their saved task identities or prompts. */
function recordedSdlcReviews(
  state: SdlcState
): Array<{ id: string; review: SdlcReview; closuresValid: boolean }> {
  const known = new Set(state.importedFindings.map((finding) => finding.id));
  const reviews: Array<{ id: string; review: SdlcReview; closuresValid: boolean }> = [];
  for (const task of state.tasks) {
    if (task.kind !== 'review' || !task.result) continue;
    const review = qualifySdlcReview(task.result as unknown as SdlcReview, task.id, known);
    for (const finding of review.codeReview.findings) known.add(finding.id);
    reviews.push({
      id: task.id,
      review,
      closuresValid:
        task.status === 'completed' &&
        task.briefRevision === state.brief.revision &&
        review.goalRevision === state.brief.goalRevision &&
        review.candidateRevision === state.candidateRevision &&
        !state.evidence.some((item) => item.producingTask === task.id && item.invalidatedBy)
    });
  }
  return reviews;
}

function supportedFindingClosure(review: SdlcReview, id: string): boolean {
  const finding = review.codeReview.findings.find((item) => item.id === id);
  if (finding) return finding.verdict === 'REFUTED' && finding.references.length > 0;
  const disposition = review.findingDispositions.find((item) => item.id === id);
  return (
    !!disposition &&
    ['resolved', 'refuted'].includes(disposition.disposition) &&
    !!disposition.observations?.length
  );
}

/** Review tasks are the durable claim history, including tasks invalidated by corrections. */
function pendingSdlcFindings(state: SdlcState): SdlcFinding[] {
  const pending = new Map<string, SdlcFinding>();
  for (const { review, closuresValid } of recordedSdlcReviews(state)) {
    for (const finding of review.codeReview.findings) {
      if (finding.verdict !== 'REFUTED') pending.set(finding.id, finding);
    }
    if (!closuresValid) continue;
    for (const id of pending.keys()) {
      if (supportedFindingClosure(review, id)) pending.delete(id);
    }
  }
  return [...pending.values()];
}

function supportedFindingDeferral(
  state: SdlcState,
  review: SdlcReview,
  finding: SdlcFinding
): boolean {
  const disposition = review.findingDispositions.find((item) => item.id === finding.id);
  if (disposition?.disposition !== 'deferred' || !disposition.observations?.length) return false;
  const changedFiles = [
    ...state.changedFiles,
    ...state.tasks
      .filter((task) => task.kind === 'implementation')
      .flatMap((task) => task.changedFiles ?? [])
  ];
  return [finding, ...finding.references, ...disposition.observations].every(
    (location) =>
      !changedFiles.some((path) =>
        ownsPath([path], posix.normalize(location.file.replace(/\\/g, '/')))
      )
  );
}

function retainOperationClaims(state: SdlcState, review: SdlcReview): SdlcReview {
  const result = structuredClone(review);
  for (const finding of pendingSdlcFindings(state))
    if (
      !result.codeReview.findings.some((item) => item.id === finding.id) &&
      !supportedFindingClosure(result, finding.id)
    )
      result.codeReview.findings.push(finding);
  result.codeReview.findings = result.codeReview.findings.filter(
    (finding) => !supportedFindingDeferral(state, result, finding)
  );
  if (
    result.codeReview.verdict === 'pass' &&
    result.codeReview.findings.some((item) => item.verdict !== 'REFUTED')
  )
    result.codeReview.verdict = 'changes-requested';
  return result;
}

function retainSupportingClaims(
  state: SdlcState,
  review: SdlcReview,
  sources: SdlcTask[],
  specialists: SdlcTask[] = []
): SdlcReview {
  const result = structuredClone(review);
  for (const source of sources) {
    const prior = source.result as unknown as SdlcReview;
    for (const finding of prior.codeReview.findings) {
      const closure = result.findingDispositions.find((item) => item.id === finding.id);
      if (
        finding.verdict !== 'REFUTED' &&
        !result.codeReview.findings.some((item) => item.id === finding.id) &&
        !supportedFindingClosure(result, finding.id)
      )
        result.codeReview.findings.push({
          ...finding,
          verdict:
            closure?.disposition === 'confirmed'
              ? 'CONFIRMED'
              : closure?.disposition === 'uncertain'
                ? 'UNCERTAIN'
                : finding.verdict,
          reason: closure?.reason ?? finding.reason
        });
    }
    for (const disposition of prior.findingDispositions)
      if (
        ['confirmed', 'uncertain'].includes(disposition.disposition) &&
        !result.findingDispositions.some((item) => item.id === disposition.id)
      )
        result.findingDispositions.push(disposition);
  }
  for (const source of specialists) {
    const prior = source.result as unknown as SdlcReview;
    result.codeReview.limitations.push(...prior.codeReview.limitations);
    if (prior.codeReview.verdict === 'unverified') result.codeReview.verdict = 'unverified';
  }
  result.codeReview.limitations = [...new Set(result.codeReview.limitations)];
  return retainOperationClaims(state, result);
}

function validateArtifacts(output: Record<string, unknown>): void {
  if (!Array.isArray(output.artifacts) || output.artifacts.length > 10)
    throw new Error('SDLC worker artifacts must be a bounded array');
  for (const item of output.artifacts) {
    const artifact = object(item, 'SDLC artifact');
    keys(artifact, ['name', 'content', 'references'], 'SDLC artifact');
    text(artifact.name, 'SDLC artifact name', 200);
    text(artifact.content, 'SDLC artifact content', 30_000);
    strings(artifact.references, 'SDLC artifact references', 20);
  }
}

/** A decisive negative judgment names unmet work or a non-refuted defect that needs correction. */
function decisiveAssessment(assessment: SdlcAssessment): boolean {
  return (
    assessment.outcomes.some((item) => item.status === 'not-met') ||
    assessment.codeReview.findings.some((finding) => finding.verdict !== 'REFUTED') ||
    (assessment.findingDispositions?.some((item) =>
      ['confirmed', 'uncertain'].includes(item.disposition)
    ) ??
      false)
  );
}

class SdlcStop extends Error {
  constructor(
    readonly outcome: 'incomplete' | 'blocked',
    message: string
  ) {
    super(message);
  }
}

/** The controller, not a schema-valid model response, decides product acceptance. */
export function assessSdlc(
  state: SdlcState,
  review: SdlcReview,
  reviewTask: string
): SdlcAssessment {
  review = retainOperationClaims(state, review);
  const gaps = [...review.coverageGaps];
  const currentEvidence = state.evidence.filter(
    (item) =>
      !item.invalidatedBy &&
      item.candidateRevision === state.candidateRevision &&
      item.goalRevision === state.brief.goalRevision
  );
  const checks = [...state.checks]
    .reverse()
    .filter(
      (item) =>
        item.phase === 'integration' &&
        item.candidateRevision === state.candidateRevision &&
        item.result &&
        item.id.endsWith(`:c${state.continuation}`)
    );
  for (const configured of state.args.checks ?? []) {
    const observed = checks.find((item) => item.result!.command.id === configured.id)?.result;
    if (!observed || observed.status !== 'passed')
      gaps.push(
        `Required check ${configured.id}: ${observed?.status ?? 'missing'}; tests=${observed?.testCount ?? 'unknown'}`
      );
  }
  const outcomes = state.brief.acceptance.map((requirement) => {
    const judgment = review.outcomes.find((item) => item.id === requirement.id);
    if (!judgment)
      return {
        id: requirement.id,
        status: 'unverified' as const,
        evidenceIds: [],
        observations: [],
        reason: 'Independent reviewer omitted this original goal obligation'
      };
    if (judgment.status !== 'met') return judgment;
    let adequate = true;
    if (judgment.evidenceIds.some((id) => !currentEvidence.some((item) => item.id === id)))
      adequate = false;
    if (requirement.verification === 'behavioral') {
      adequate &&= judgment.evidenceIds.some((id) =>
        checks.some(
          (item) =>
            item.id === id &&
            item.result!.status === 'passed' &&
            (item.result!.command.outcomes.includes(requirement.id) ||
              requirement.checkIds.includes(item.result!.command.id) ||
              ((judgment.checkIds ?? []).includes(item.result!.command.id) &&
                state.args.checks?.some((check) => check.id === item.result!.command.id)))
        )
      );
    } else adequate &&= judgment.observations.length > 0 || judgment.evidenceIds.length > 0;
    for (const checkId of requirement.checkIds)
      adequate &&= checks.some(
        (item) => item.result!.command.id === checkId && item.result!.status === 'passed'
      );
    if (!adequate) {
      gaps.push(`${requirement.id}: missing fresh observable evidence for this goal and candidate`);
      return {
        ...judgment,
        status: 'unverified' as const,
        reason: 'Controller rejected missing, stale, or inadequate evidence'
      };
    }
    return judgment;
  });
  for (const imported of state.importedFindings) {
    const disposition = review.findingDispositions.find((item) => item.id === imported.id);
    if (disposition?.disposition !== 'deferred' && !supportedFindingClosure(review, imported.id))
      gaps.push(
        `Historical claim ${imported.id} has no independently supported closure or explicit unrelated deferral`
      );
  }
  const blocking = review.codeReview.findings.some((finding) => finding.verdict !== 'REFUTED');
  return {
    id: `assessment-${state.assessments.length + 1}`,
    goalRevision: state.brief.goalRevision,
    candidateRevision: state.candidateRevision,
    reviewTask,
    correctionCount: state.consumed.corrections,
    findingDispositions: review.findingDispositions,
    codeReview: review.codeReview,
    outcomes,
    coverageGaps: [...new Set(gaps)],
    accepted:
      review.goalRevision === state.brief.goalRevision &&
      review.candidateRevision === state.candidateRevision &&
      review.codeReview.verdict === 'pass' &&
      !blocking &&
      !review.codeReview.limitations.length &&
      !gaps.length &&
      outcomes.every((item) => item.status === 'met')
  };
}
