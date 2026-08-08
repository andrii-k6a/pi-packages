import type { Clock } from './ids.js';
import { excerpt } from './sanitize.js';
import {
  type GoalState,
  type GoalStatus,
  getEffectiveElapsedActiveMs,
  isClosedStatus
} from './state.js';

export type GoalCommand =
  | { type: 'status' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'clear' }
  | { type: 'create'; objective: string };

export function parseGoalCommand(args: string): GoalCommand {
  const trimmed = args.trim();
  if (!trimmed || trimmed === 'status') return { type: 'status' };
  if (trimmed === 'pause') return { type: 'pause' };
  if (trimmed === 'resume') return { type: 'resume' };
  if (trimmed === 'clear') return { type: 'clear' };
  return { type: 'create', objective: trimmed };
}

export function canReplaceWithoutConfirmation(state: GoalState | undefined): boolean {
  return !state || isClosedStatus(state.status);
}

export function formatGoalStatus(state: GoalState | undefined, clock: Clock): string {
  if (!state) return 'No current goal on this branch.';

  const elapsed = getEffectiveElapsedActiveMs(state, clock);
  const lines = [
    `Goal ${state.id}`,
    `status: ${state.status}`,
    `generation: ${state.generation}`,
    `objective: ${excerpt(state.objective, 200)}`,
    `tokens: ${state.tokensUsed}/${state.tokenBudget}`,
    `active time: ${formatDuration(elapsed)}/${formatDuration(state.timeBudgetMs)}`,
    `updated: ${state.updatedAt}`
  ];

  if (state.doneCriteria && state.doneCriteria.length > 0) {
    lines.push(
      `done criteria: ${state.doneCriteria.map((criterion) => excerpt(criterion, 80)).join('; ')}`
    );
  }
  if (state.pendingClaim) {
    lines.push(`latest claim: ${excerpt(state.pendingClaim.summary, 200)}`);
    lines.push(`claim id: ${state.pendingClaim.claim_id}`);
    lines.push(`verifier attempt: ${state.pendingClaim.verifier_attempt_id}`);
  } else if (state.lastSummary) {
    lines.push(`latest claim: ${excerpt(state.lastSummary, 200)}`);
  }
  if (state.lastVerification) {
    lines.push(`latest verification: ${state.lastVerification.verdict}`);
    lines.push(`verification rationale: ${excerpt(state.lastVerification.rationale, 240)}`);
    if (state.lastVerification.next_action) {
      lines.push(`next action: ${excerpt(state.lastVerification.next_action, 200)}`);
    }
  }
  if (state.blockedReason) lines.push(`blocked reason: ${excerpt(state.blockedReason, 200)}`);
  if (state.pauseReason) lines.push(`pause reason: ${state.pauseReason}`);
  if (state.budgetReason) lines.push(`budget reason: ${state.budgetReason}`);

  return lines.join('\n');
}

export function compactStatus(state: GoalState | undefined, clock: Clock): string | undefined {
  if (!state) return undefined;
  const elapsed = getEffectiveElapsedActiveMs(state, clock);
  const prefix = iconForStatus(state.status);
  if (state.status === 'active') {
    return `${prefix} goal ${formatTokens(state.tokensUsed)}/${formatTokens(state.tokenBudget)} · ${formatMinutes(
      elapsed
    )}/${formatMinutes(state.timeBudgetMs)}`;
  }
  if (state.status === 'verifying') {
    return `${prefix} verifying · ${formatTokens(state.tokensUsed)}/${formatTokens(state.tokenBudget)} · ${formatMinutes(
      elapsed
    )}/${formatMinutes(state.timeBudgetMs)}`;
  }
  return `${prefix} goal ${state.status.replace('_', ' ')}`;
}

export function statusAllowsAutoContinue(status: GoalStatus): boolean {
  return status === 'active';
}

function iconForStatus(status: GoalStatus): string {
  switch (status) {
    case 'complete':
      return '✅';
    case 'blocked':
    case 'budget_limited':
      return '⚠️';
    case 'paused':
      return '⏸️';
    case 'verifying':
      return '🔍';
    default:
      return '🎯';
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function formatMinutes(ms: number): string {
  return `${Math.round(ms / 60_000)}m`;
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}m`;
}
