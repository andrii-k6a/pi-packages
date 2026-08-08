import type { Clock, IdProvider } from './ids.js';
import { sanitizeStringArray, sanitizeText, TEXT_LIMITS } from './sanitize.js';

export const DEFAULT_TOKEN_BUDGET = 10_000_000;
export const DEFAULT_TIME_BUDGET_MS = 3_600_000;

export const goalStatuses = [
  'active',
  'verifying',
  'paused',
  'blocked',
  'complete',
  'cleared',
  'budget_limited'
] as const;

export type GoalStatus = (typeof goalStatuses)[number];
export type BudgetReason = 'tokens' | 'time';
export type PauseReason = 'user' | 'reload' | 'branch' | 'tool_policy' | 'error' | 'verification';
export type VerificationVerdict = 'pass' | 'fail' | 'uncertain';
export type DispatchState = 'queued' | 'sent' | 'in_turn';

export interface CheckEvidence {
  command: string;
  exit_code?: number;
  output_excerpt?: string;
}

export interface CompletionClaim {
  goal_id: string;
  generation: number;
  claim_id: string;
  verifier_attempt_id: string;
  summary: string;
  evidence: string;
  changed_files?: string[];
  checks?: CheckEvidence[];
  createdAt: string;
}

export interface VerificationReport {
  goal_id: string;
  generation: number;
  claim_id: string;
  verifier_attempt_id: string;
  verdict: VerificationVerdict;
  rationale: string;
  evidence_reviewed: string[];
  missing_evidence?: string[];
  risks?: string[];
  next_action?: string;
  createdAt: string;
}

export interface GoalState {
  version: 1;
  id: string;
  generation: number;
  branchAnchorId: string;
  objective: string;
  doneCriteria?: string[];
  status: GoalStatus;
  createdAt: string;
  updatedAt: string;
  tokensUsed: number;
  tokenBudget: number;
  elapsedActiveMs: number;
  timeBudgetMs: number;
  activeStartedAt?: string;
  pendingClaim?: CompletionClaim;
  lastVerification?: VerificationReport;
  lastSummary?: string;
  lastEvidence?: string;
  blockedReason?: string;
  pauseReason?: PauseReason;
  budgetReason?: BudgetReason;
}

export interface ContinuationDispatch {
  dispatch_id: string;
  launchLeafId: string | null;
  goal_id: string;
  generation: number;
  state: DispatchState;
}

export interface VerifierRunning {
  launchLeafId: string | null;
  goal_id: string;
  generation: number;
  claim_id: string;
  verifier_attempt_id: string;
  abortController: AbortController;
}

export interface ActiveGoalRun {
  launchLeafId: string | null;
  goal_id: string;
  generation: number;
  countedMessageIds: string[];
  pendingProviderRequestTokenEstimate?: number;
}

export interface RuntimeState {
  goal?: GoalState;
  continuationDispatch?: ContinuationDispatch;
  activeGoalRun?: ActiveGoalRun;
  verifierRunning?: VerifierRunning;
}

export interface CreateGoalInput {
  objective: string;
  branchAnchorId: string | null;
  ids: IdProvider;
  clock: Clock;
  tokenBudget?: number;
}

export function isClosedStatus(status: GoalStatus): boolean {
  return status === 'complete' || status === 'cleared';
}

export function isActiveTimeStatus(status: GoalStatus): boolean {
  return status === 'active' || status === 'verifying';
}

export function createGoal(input: CreateGoalInput): GoalState {
  const objective = sanitizeText(input.objective, {
    maxLength: TEXT_LIMITS.objective,
    allowNewlines: true,
    collapseWhitespace: false
  });
  if (!objective) throw new Error('Goal objective is required.');
  if (Array.from(input.objective).length > TEXT_LIMITS.objective) {
    throw new Error(`Goal objective must be at most ${TEXT_LIMITS.objective} characters.`);
  }

  const now = input.clock.nowIso();
  const doneCriteria = extractDoneCriteria(objective);

  return {
    version: 1,
    id: input.ids.nextId('goal'),
    generation: 0,
    branchAnchorId: input.branchAnchorId ?? 'root',
    objective,
    doneCriteria: doneCriteria.length > 0 ? doneCriteria : undefined,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    tokensUsed: 0,
    tokenBudget: input.tokenBudget ?? DEFAULT_TOKEN_BUDGET,
    elapsedActiveMs: 0,
    timeBudgetMs: DEFAULT_TIME_BUDGET_MS,
    activeStartedAt: now
  };
}

export function extractDoneCriteria(objective: string): string[] {
  const lines = objective.split('\n');
  const checklist = lines
    .map((line) => line.match(/^\s*[-*]\s+\[[ xX-]\]\s+(.+)$/)?.[1])
    .filter((line): line is string => !!line)
    .map((line) =>
      sanitizeText(line, { maxLength: 500, allowNewlines: false, collapseWhitespace: true })
    )
    .filter(Boolean);

  if (checklist.length > 0) return uniqueStrings(checklist).slice(0, 20);

  const criteria: string[] = [];
  let inDoneWhen = false;

  for (const line of lines) {
    const heading = line.match(/^\s*(?:#{1,6}\s*)?done\s+when\s*:\s*(.*)$/i);
    if (heading) {
      inDoneWhen = true;
      if (heading[1]?.trim()) criteria.push(heading[1]);
      continue;
    }

    if (!inDoneWhen) continue;
    if (/^\s*#{1,6}\s+\S/.test(line)) break;
    if (!line.trim()) {
      if (criteria.length > 0) break;
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.*)$/)?.[1] ?? line.trim();
    criteria.push(bullet);
  }

  return uniqueStrings(
    criteria
      .map((line) =>
        sanitizeText(line, { maxLength: 500, allowNewlines: false, collapseWhitespace: true })
      )
      .filter(Boolean)
  ).slice(0, 20);
}

export function pauseGoal(state: GoalState, clock: Clock, pauseReason: PauseReason): GoalState {
  if (!isActiveTimeStatus(state.status))
    return { ...state, pauseReason, updatedAt: clock.nowIso() };

  return {
    ...accumulateActiveTime(state, clock),
    status: 'paused',
    generation: state.generation + 1,
    pendingClaim: undefined,
    pauseReason,
    budgetReason: undefined,
    updatedAt: clock.nowIso()
  };
}

export function pauseRestoredGoal(
  state: GoalState,
  clock: Clock,
  pauseReason: Extract<PauseReason, 'reload' | 'branch'>
): GoalState {
  if (!isActiveTimeStatus(state.status)) return state;
  return {
    ...state,
    status: 'paused',
    generation: state.generation + 1,
    activeStartedAt: undefined,
    pendingClaim: undefined,
    pauseReason,
    updatedAt: clock.nowIso()
  };
}

export function resumeGoal(state: GoalState, clock: Clock): GoalState {
  if (state.status === 'budget_limited') {
    throw new Error('Budget-limited goals cannot be resumed. Start a new goal instead.');
  }
  if (state.status !== 'paused' && state.status !== 'blocked') {
    throw new Error(`Cannot resume a ${state.status} goal.`);
  }

  return {
    ...state,
    status: 'active',
    generation: state.generation + 1,
    activeStartedAt: clock.nowIso(),
    pendingClaim: undefined,
    blockedReason: undefined,
    pauseReason: undefined,
    budgetReason: undefined,
    updatedAt: clock.nowIso()
  };
}

export function clearGoal(state: GoalState, clock: Clock): GoalState {
  const next = isActiveTimeStatus(state.status) ? accumulateActiveTime(state, clock) : state;
  return {
    ...next,
    status: 'cleared',
    generation: state.generation + 1,
    activeStartedAt: undefined,
    pendingClaim: undefined,
    pauseReason: undefined,
    budgetReason: undefined,
    updatedAt: clock.nowIso()
  };
}

export function blockGoal(
  state: GoalState,
  clock: Clock,
  reason: string,
  evidence?: string
): GoalState {
  assertActiveCurrent(state);
  const cleanReason = sanitizeText(reason, {
    maxLength: TEXT_LIMITS.reason,
    allowNewlines: true,
    collapseWhitespace: true
  });
  if (!cleanReason) throw new Error('Blocker reason is required.');

  return {
    ...accumulateActiveTime(state, clock),
    status: 'blocked',
    pendingClaim: undefined,
    blockedReason: cleanReason,
    lastEvidence: sanitizeText(evidence, {
      maxLength: TEXT_LIMITS.evidence,
      allowNewlines: true,
      collapseWhitespace: false
    }),
    updatedAt: clock.nowIso()
  };
}

export function claimGoalDone(
  state: GoalState,
  clock: Clock,
  ids: IdProvider,
  input: {
    summary: string;
    evidence: string;
    changed_files?: unknown;
    checks?: unknown;
  }
): { state: GoalState; claim: CompletionClaim } {
  assertActiveCurrent(state);

  const summary = sanitizeText(input.summary, {
    maxLength: TEXT_LIMITS.summary,
    allowNewlines: true,
    collapseWhitespace: true
  });
  const evidence = sanitizeText(input.evidence, {
    maxLength: TEXT_LIMITS.evidence,
    allowNewlines: true,
    collapseWhitespace: false
  });
  if (!summary) throw new Error('Completion claim summary is required.');
  if (!evidence) throw new Error('Completion claim evidence is required.');

  const now = clock.nowIso();
  const claim: CompletionClaim = {
    goal_id: state.id,
    generation: state.generation,
    claim_id: ids.nextId('claim'),
    verifier_attempt_id: ids.nextId('attempt'),
    summary,
    evidence,
    changed_files: sanitizeStringArray(input.changed_files, {
      maxItems: 50,
      maxLength: 1000,
      allowNewlines: false,
      collapseWhitespace: true
    }),
    checks: sanitizeChecks(input.checks),
    createdAt: now
  };

  return {
    claim,
    state: {
      ...state,
      status: 'verifying',
      pendingClaim: claim,
      lastSummary: summary,
      lastEvidence: evidence,
      updatedAt: now
    }
  };
}

export function applyVerifierReport(
  state: GoalState,
  clock: Clock,
  report: VerificationReport
): GoalState {
  assertCurrentReport(state, report);

  if (report.verdict === 'pass') {
    return {
      ...accumulateActiveTime(state, clock),
      status: 'complete',
      pendingClaim: undefined,
      lastVerification: report,
      lastSummary: state.pendingClaim?.summary,
      lastEvidence: state.pendingClaim?.evidence,
      blockedReason: undefined,
      pauseReason: undefined,
      updatedAt: clock.nowIso()
    };
  }

  if (report.verdict === 'fail') {
    const accumulated = accumulateActiveTime(state, clock);
    return {
      ...accumulated,
      status: 'active',
      generation: state.generation + 1,
      pendingClaim: undefined,
      lastVerification: report,
      activeStartedAt: clock.nowIso(),
      blockedReason: undefined,
      pauseReason: undefined,
      updatedAt: clock.nowIso()
    };
  }

  return {
    ...accumulateActiveTime(state, clock),
    status: 'blocked',
    pendingClaim: undefined,
    lastVerification: report,
    blockedReason: report.next_action || 'verification_uncertain',
    updatedAt: clock.nowIso()
  };
}

export function applyVerificationError(
  state: GoalState,
  clock: Clock,
  message = 'verification_error'
): GoalState {
  if (state.status !== 'verifying') return state;
  return {
    ...accumulateActiveTime(state, clock),
    status: 'blocked',
    pendingClaim: undefined,
    blockedReason: sanitizeText(message, {
      maxLength: TEXT_LIMITS.reason,
      allowNewlines: false,
      collapseWhitespace: true
    }),
    updatedAt: clock.nowIso()
  };
}

export function addTokenUsage(state: GoalState, clock: Clock, tokens: number): GoalState {
  if (!Number.isFinite(tokens) || tokens <= 0) return state;
  return {
    ...state,
    tokensUsed: Math.max(0, Math.ceil(state.tokensUsed + tokens)),
    updatedAt: clock.nowIso()
  };
}

export function limitBudget(state: GoalState, clock: Clock, budgetReason: BudgetReason): GoalState {
  const next = isActiveTimeStatus(state.status) ? accumulateActiveTime(state, clock) : state;
  return {
    ...next,
    status: 'budget_limited',
    pendingClaim: undefined,
    activeStartedAt: undefined,
    budgetReason,
    updatedAt: clock.nowIso()
  };
}

export function getEffectiveElapsedActiveMs(state: GoalState, clock: Clock): number {
  if (!state.activeStartedAt || !isActiveTimeStatus(state.status)) return state.elapsedActiveMs;
  const started = Date.parse(state.activeStartedAt);
  const now = clock.now().getTime();
  if (!Number.isFinite(started) || now <= started) return state.elapsedActiveMs;
  return state.elapsedActiveMs + (now - started);
}

export function remainingActiveTimeMs(state: GoalState, clock: Clock): number {
  return Math.max(0, state.timeBudgetMs - getEffectiveElapsedActiveMs(state, clock));
}

export function getBudgetExhaustion(state: GoalState, clock: Clock): BudgetReason | undefined {
  if (state.tokensUsed >= state.tokenBudget) return 'tokens';
  if (getEffectiveElapsedActiveMs(state, clock) >= state.timeBudgetMs) return 'time';
  return undefined;
}

export function isReportCurrent(state: GoalState, report: VerificationReport): boolean {
  const claim = state.pendingClaim;
  return (
    state.status === 'verifying' &&
    !!claim &&
    report.goal_id === state.id &&
    report.generation === state.generation &&
    report.claim_id === claim.claim_id &&
    report.verifier_attempt_id === claim.verifier_attempt_id
  );
}

export function isVerifierAttemptCurrent(
  state: GoalState,
  attempt: Pick<CompletionClaim, 'goal_id' | 'generation' | 'claim_id' | 'verifier_attempt_id'>
): boolean {
  const claim = state.pendingClaim;
  return (
    state.status === 'verifying' &&
    !!claim &&
    attempt.goal_id === state.id &&
    attempt.generation === state.generation &&
    attempt.claim_id === claim.claim_id &&
    attempt.verifier_attempt_id === claim.verifier_attempt_id
  );
}

export function branchContainsLeaf(
  branch: Array<{ id?: string }>,
  launchLeafId: string | null | undefined
): boolean {
  if (launchLeafId === null || launchLeafId === undefined) return true;
  return branch.some((entry) => entry.id === launchLeafId);
}

export function summarizeStatusBehavior(status: GoalStatus): {
  autoContinue: boolean;
  verifierMayRun: boolean;
  resumable: boolean;
  clearIsNoop: boolean;
  replaceNeedsConfirmation: boolean;
} {
  return {
    autoContinue: status === 'active',
    verifierMayRun: status === 'verifying',
    resumable: status === 'paused' || status === 'blocked',
    clearIsNoop: status === 'complete' || status === 'cleared',
    replaceNeedsConfirmation: !isClosedStatus(status)
  };
}

function accumulateActiveTime(state: GoalState, clock: Clock): GoalState {
  if (!state.activeStartedAt) return { ...state, activeStartedAt: undefined };
  const started = Date.parse(state.activeStartedAt);
  const now = clock.now().getTime();
  const elapsed = Number.isFinite(started) && now > started ? now - started : 0;
  return {
    ...state,
    elapsedActiveMs: state.elapsedActiveMs + elapsed,
    activeStartedAt: undefined
  };
}

function assertActiveCurrent(state: GoalState): void {
  if (state.status !== 'active') {
    throw new Error(`Goal is ${state.status}; executor tools require an active goal.`);
  }
}

function assertCurrentReport(state: GoalState, report: VerificationReport): void {
  if (!isReportCurrent(state, report)) {
    throw new Error('Verification report is stale for the current goal.');
  }
}

function sanitizeChecks(input: unknown): CheckEvidence[] | undefined {
  if (!Array.isArray(input)) return undefined;

  const checks = input.slice(0, 20).flatMap((item): CheckEvidence[] => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const command = sanitizeText(record.command, {
      maxLength: 1000,
      allowNewlines: false,
      collapseWhitespace: true
    });
    if (!command) return [];

    const check: CheckEvidence = { command };
    if (typeof record.exit_code === 'number' && Number.isInteger(record.exit_code)) {
      check.exit_code = record.exit_code;
    }
    const output = sanitizeText(record.output_excerpt, {
      maxLength: 2000,
      allowNewlines: true,
      collapseWhitespace: false
    });
    if (output) check.output_excerpt = output;
    return [check];
  });

  return checks.length > 0 ? checks : undefined;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}
