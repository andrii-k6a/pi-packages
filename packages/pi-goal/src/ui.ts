import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { compactStatus, formatGoalStatus } from './commands.js';
import type { Clock } from './ids.js';
import type { GoalState } from './state.js';

const STATUS_KEY = 'pi-goal';

export function updateGoalUi(
  ctx: ExtensionContext,
  state: GoalState | undefined,
  clock: Clock
): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(STATUS_KEY, compactStatus(state, clock));
}

export function notifyGoal(
  ctx: ExtensionContext,
  message: string,
  type: 'info' | 'warning' | 'error' = 'info'
): void {
  if (!ctx.hasUI) return;
  ctx.ui.notify(message, type);
}

export function notifyGoalStatus(
  ctx: ExtensionContext,
  state: GoalState | undefined,
  clock: Clock
): void {
  notifyGoal(ctx, formatGoalStatus(state, clock), state ? 'info' : 'warning');
}
