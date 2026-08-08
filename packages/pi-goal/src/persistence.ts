import type { Clock } from './ids.js';
import {
  type CompletionClaim,
  type GoalState,
  type GoalStatus,
  pauseRestoredGoal
} from './state.js';

export const STATE_ENTRY = 'pi-goal-state';
export const TRANSITION_ENTRY = 'pi-goal-transition';
export const CLAIM_ENTRY = 'pi-goal-completion-claim';
export const VERIFICATION_ENTRY = 'pi-goal-verification';
export const COMMAND_RESULT_ENTRY = 'pi-goal-command-result';

export interface GoalTransitionRecord {
  goal_id: string;
  generation: number;
  from?: GoalStatus;
  to: GoalStatus;
  reason: string;
  createdAt: string;
}

export type BranchEntry = {
  type?: unknown;
  id?: string;
  customType?: unknown;
  data?: unknown;
  message?: unknown;
};

export interface RestoreResult {
  state?: GoalState;
  shouldPersistPause: boolean;
  interruptedClaim?: CompletionClaim;
}

export function restoreGoalFromBranch(
  branch: BranchEntry[],
  clock: Clock,
  reason: 'reload' | 'branch' | 'none'
): RestoreResult {
  const restored = readLatestGoalState(branch);
  if (!restored) return { shouldPersistPause: false };

  if ((reason === 'reload' || reason === 'branch') && isActiveOrVerifying(restored)) {
    return {
      state: pauseRestoredGoal(restored, clock, reason),
      shouldPersistPause: true,
      interruptedClaim: restored.status === 'verifying' ? restored.pendingClaim : undefined
    };
  }

  return { state: restored, shouldPersistPause: false };
}

export function readLatestGoalState(branch: BranchEntry[]): GoalState | undefined {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry.type !== 'custom' || entry.customType !== STATE_ENTRY) continue;
    const data = entry.data;
    if (!data || typeof data !== 'object') continue;
    const maybeState = (data as { state?: unknown }).state ?? data;
    if (isGoalState(maybeState)) return maybeState;
  }
  return undefined;
}

export function isGoalState(value: unknown): value is GoalState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<GoalState>;
  return (
    state.version === 1 &&
    typeof state.id === 'string' &&
    typeof state.generation === 'number' &&
    typeof state.branchAnchorId === 'string' &&
    typeof state.objective === 'string' &&
    isGoalStatus(state.status) &&
    typeof state.createdAt === 'string' &&
    typeof state.updatedAt === 'string' &&
    typeof state.tokensUsed === 'number' &&
    typeof state.tokenBudget === 'number' &&
    typeof state.elapsedActiveMs === 'number' &&
    typeof state.timeBudgetMs === 'number'
  );
}

export function getBranchLeafId(branch: BranchEntry[]): string | null {
  return branch.at(-1)?.id ?? null;
}

function isGoalStatus(value: unknown): value is GoalStatus {
  return (
    value === 'active' ||
    value === 'verifying' ||
    value === 'paused' ||
    value === 'blocked' ||
    value === 'complete' ||
    value === 'cleared' ||
    value === 'budget_limited'
  );
}

function isActiveOrVerifying(state: GoalState): boolean {
  return state.status === 'active' || state.status === 'verifying';
}
