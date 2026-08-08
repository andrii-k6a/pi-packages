import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Clock, IdProvider } from './ids.js';
import { getBranchLeafId } from './persistence.js';
import { buildContinuationPrompt } from './prompts.js';
import {
  branchContainsLeaf,
  type ContinuationDispatch,
  type GoalState,
  getBudgetExhaustion,
  limitBudget,
  pauseGoal,
  type RuntimeState
} from './state.js';

export const GOAL_CONTINUATION_MESSAGE = 'pi-goal-continuation';

export type ContinuationCommit = (next: GoalState, ctx: ExtensionContext, reason: string) => void;

export interface DispatchContinuationInput {
  pi: ExtensionAPI;
  runtime: RuntimeState;
  ctx: ExtensionContext;
  clock: Clock;
  ids: IdProvider;
  commit: ContinuationCommit;
}

export type DispatchResult =
  | 'sent'
  | 'not_active'
  | 'already_queued'
  | 'not_idle'
  | 'pending_messages'
  | 'budget_limited'
  | 'tool_policy'
  | 'stale_branch';

export function maybeDispatchContinuation(input: DispatchContinuationInput): DispatchResult {
  const state = input.runtime.goal;
  if (!state || state.status !== 'active') return 'not_active';
  if (input.runtime.continuationDispatch) return 'already_queued';

  const branch = input.ctx.sessionManager.getBranch();
  if (!branchContainsLeaf(branch, state.branchAnchorId === 'root' ? null : state.branchAnchorId)) {
    return 'stale_branch';
  }

  const budget = getBudgetExhaustion(state, input.clock);
  if (budget) {
    input.commit(limitBudget(state, input.clock, budget), input.ctx, `budget_${budget}`);
    return 'budget_limited';
  }

  if (!input.ctx.isIdle()) return 'not_idle';
  if (input.ctx.hasPendingMessages()) return 'pending_messages';

  const tools = ensureGoalToolsActive(input.pi);
  if (!tools.ok) {
    if (input.ctx.hasUI) {
      input.ctx.ui.notify(
        'Goal paused because required tools are unavailable. Enable pi_goal_claim_done and pi_goal_blocked, then run /goal resume.',
        'warning'
      );
    }
    input.commit(pauseGoal(state, input.clock, 'tool_policy'), input.ctx, 'tool_policy');
    return 'tool_policy';
  }

  const dispatch: ContinuationDispatch = {
    dispatch_id: input.ids.nextId('dispatch'),
    launchLeafId: getBranchLeafId(branch),
    goal_id: state.id,
    generation: state.generation,
    state: 'queued'
  };
  input.runtime.continuationDispatch = dispatch;

  try {
    input.pi.sendMessage(
      {
        customType: GOAL_CONTINUATION_MESSAGE,
        content: buildContinuationPrompt(state, input.clock),
        display: false,
        details: {
          dispatch_id: dispatch.dispatch_id,
          launchLeafId: dispatch.launchLeafId,
          goal_id: state.id,
          generation: state.generation
        }
      },
      { deliverAs: 'followUp', triggerTurn: true }
    );
    if (dispatch.state === 'queued') dispatch.state = 'sent';
    return 'sent';
  } catch {
    input.runtime.continuationDispatch = undefined;
    return 'not_idle';
  }
}

export function ensureGoalToolsActive(
  pi: Pick<ExtensionAPI, 'getActiveTools' | 'getAllTools' | 'setActiveTools'>
): {
  ok: boolean;
  added: string[];
} {
  try {
    const required = ['pi_goal_claim_done', 'pi_goal_blocked'];
    const allNames = new Set(pi.getAllTools().map((tool) => tool.name));
    if (!required.every((name) => allNames.has(name))) return { ok: false, added: [] };

    const active = pi.getActiveTools();
    const missing = required.filter((name) => !active.includes(name));
    if (missing.length === 0) return { ok: true, added: [] };

    pi.setActiveTools([...new Set([...active, ...missing])]);
    const nextActive = pi.getActiveTools();
    const ok = required.every((name) => nextActive.includes(name));
    return { ok, added: ok ? missing : [] };
  } catch {
    return { ok: false, added: [] };
  }
}

export function markDispatchInTurn(runtime: RuntimeState, state: GoalState | undefined): void {
  const dispatch = runtime.continuationDispatch;
  if (!dispatch || !state) return;
  if (dispatch.state !== 'queued' && dispatch.state !== 'sent') return;
  if (dispatch.goal_id !== state.id || dispatch.generation !== state.generation) return;
  dispatch.state = 'in_turn';
}

export function clearSettledDispatch(runtime: RuntimeState, state: GoalState | undefined): void {
  const dispatch = runtime.continuationDispatch;
  if (!dispatch) return;
  if (!state || dispatch.goal_id !== state.id || dispatch.generation !== state.generation) {
    runtime.continuationDispatch = undefined;
    return;
  }
  if (dispatch.state === 'in_turn') {
    runtime.continuationDispatch = undefined;
  }
}

export function filterStaleContinuationMessages(
  messages: AgentMessage[],
  state: GoalState | undefined
): AgentMessage[] {
  return messages.filter((message) => {
    if (!isGoalContinuationMessage(message)) return true;
    if (!state || state.status !== 'active') return false;
    const details = asRecord((message as unknown as Record<string, unknown>).details);
    return details.goal_id === state.id && details.generation === state.generation;
  });
}

function isGoalContinuationMessage(message: AgentMessage): boolean {
  if (!message || typeof message !== 'object') return false;
  const record = message as unknown as Record<string, unknown>;
  return record.role === 'custom' && record.customType === GOAL_CONTINUATION_MESSAGE;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
