import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEventResult
} from '@earendil-works/pi-coding-agent';
import {
  assertCurrentGoalInput,
  type BlockedInput,
  BlockedParams,
  type ClaimDoneInput,
  ClaimDoneParams,
  isCurrentTerminalInput,
  TERMINAL_GOAL_TOOL_NAMES
} from './claims.js';
import type { Clock, IdProvider } from './ids.js';
import type { BranchEntry } from './persistence.js';
import { blockGoal, type CompletionClaim, claimGoalDone, type GoalState } from './state.js';

export type GoalToolCommit = (
  next: GoalState,
  ctx: ExtensionContext,
  reason: string,
  extra?: { claim?: CompletionClaim }
) => void;

export interface GoalToolEnvironment {
  getGoal(): GoalState | undefined;
  commit: GoalToolCommit;
  clearContinuationDispatch(): void;
  ids: IdProvider;
  clock: Clock;
}

export interface GoalToolDetails {
  state: GoalState;
  claim?: CompletionClaim;
}

export function registerGoalTools(pi: ExtensionAPI, env: GoalToolEnvironment): void {
  pi.registerTool({
    name: 'pi_goal_claim_done',
    label: 'Goal Claim Done',
    description:
      'Submit a completion claim for the current Pi goal. This starts independent verification and does not mark the goal complete.',
    promptSnippet: 'Submit a verifier-gated completion claim for the current Pi goal',
    promptGuidelines: [
      'Use pi_goal_claim_done only when the current Pi goal appears complete and you have concise evidence.',
      'pi_goal_claim_done submits a claim for verification; it does not finalize the goal.'
    ],
    parameters: ClaimDoneParams,
    executionMode: 'sequential',
    async execute(_toolCallId, params: ClaimDoneInput, _signal, _onUpdate, ctx) {
      const current = getCurrentActiveGoal(env.getGoal(), params);
      const { state, claim } = claimGoalDone(current, env.clock, env.ids, params);
      env.clearContinuationDispatch();
      env.commit(state, ctx, 'claim_done', { claim });
      return {
        content: [
          {
            type: 'text',
            text: `Completion claim recorded for goal ${state.id}. Independent verification will run after the parent turn settles.`
          }
        ],
        details: { state, claim } satisfies GoalToolDetails,
        terminate: true
      };
    }
  });

  pi.registerTool({
    name: 'pi_goal_blocked',
    label: 'Goal Blocked',
    description: 'Report that the current Pi goal is blocked and needs user input or approval.',
    promptSnippet: 'Stop the current Pi goal with a blocker that needs user input',
    promptGuidelines: [
      'Use pi_goal_blocked when the current Pi goal needs user input, credentials, approval, or cannot make useful progress.'
    ],
    parameters: BlockedParams,
    executionMode: 'sequential',
    async execute(_toolCallId, params: BlockedInput, _signal, _onUpdate, ctx) {
      const current = getCurrentActiveGoal(env.getGoal(), params);
      const state = blockGoal(current, env.clock, params.reason, params.evidence);
      env.clearContinuationDispatch();
      env.commit(state, ctx, 'blocked');
      return {
        content: [{ type: 'text', text: `Goal ${state.id} is blocked: ${state.blockedReason}` }],
        details: { state } satisfies GoalToolDetails,
        terminate: true
      };
    }
  });

  pi.on('tool_call', (event, ctx) =>
    shouldBlockTerminalGoalBatch({
      eventToolName: event.toolName,
      eventToolCallId: event.toolCallId,
      eventInput: event.input,
      branch: ctx.sessionManager.getBranch(),
      state: env.getGoal()
    })
  );
}

export interface TerminalBatchGuardInput {
  eventToolName: string;
  eventToolCallId: string;
  eventInput: Record<string, unknown>;
  branch: BranchEntry[];
  state: GoalState | undefined;
}

export function shouldBlockTerminalGoalBatch(
  input: TerminalBatchGuardInput
): ToolCallEventResult | undefined {
  const batch = findAssistantToolBatch(input.branch, input.eventToolCallId);
  if (!batch || batch.length === 0) return undefined;

  const terminalBlocks = batch.filter((block) => TERMINAL_GOAL_TOOL_NAMES.has(block.name));
  if (terminalBlocks.length === 0) return undefined;

  const validTerminalBlocks = terminalBlocks.filter((block) =>
    isCurrentTerminalInput(input.state, block.name, asRecord(block.arguments))
  );
  const allowedTerminalId = validTerminalBlocks[0]?.id;

  if (!TERMINAL_GOAL_TOOL_NAMES.has(input.eventToolName)) {
    return {
      block: true,
      terminate: true,
      reason:
        'Blocked sibling tool call because a terminal pi-goal tool was emitted in the same assistant batch.'
    };
  }

  if (!allowedTerminalId) {
    return {
      block: true,
      terminate: true,
      reason: 'Blocked stale or invalid terminal pi-goal tool call.'
    };
  }

  if (input.eventToolCallId !== allowedTerminalId) {
    return {
      block: true,
      terminate: true,
      reason: 'Blocked duplicate terminal pi-goal tool call in the same assistant batch.'
    };
  }

  if (!isCurrentTerminalInput(input.state, input.eventToolName, input.eventInput)) {
    return {
      block: true,
      terminate: true,
      reason: 'Blocked stale or invalid terminal pi-goal tool call.'
    };
  }

  return undefined;
}

export interface ToolCallBlock {
  id: string;
  name: string;
  arguments: unknown;
}

export function findAssistantToolBatch(
  branch: BranchEntry[],
  eventToolCallId: string
): ToolCallBlock[] | undefined {
  let fallback: ToolCallBlock[] | undefined;

  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry.type !== 'message') continue;
    const message = entry.message;
    if (!message || typeof message !== 'object') continue;
    const record = message as Record<string, unknown>;
    if (record.role !== 'assistant' || !Array.isArray(record.content)) continue;

    const blocks = record.content.flatMap((part): ToolCallBlock[] => {
      if (!part || typeof part !== 'object') return [];
      const block = part as Record<string, unknown>;
      if (block.type !== 'toolCall') return [];
      if (typeof block.id !== 'string' || typeof block.name !== 'string') return [];
      return [{ id: block.id, name: block.name, arguments: block.arguments }];
    });

    if (blocks.length === 0) continue;
    fallback = fallback ?? blocks;
    if (blocks.some((block) => block.id === eventToolCallId)) return blocks;
  }

  return fallback;
}

function getCurrentActiveGoal(
  state: GoalState | undefined,
  input: { goal_id?: unknown; generation?: unknown }
): GoalState {
  assertCurrentGoalInput(state, input);
  return state;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
