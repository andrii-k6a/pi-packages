import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Usage } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { formatGoalStatus, parseGoalCommand } from './commands.js';
import {
  clearSettledDispatch,
  filterStaleContinuationMessages,
  markDispatchInTurn,
  maybeDispatchContinuation
} from './continuation.js';
import { type Clock, type IdProvider, systemClock, systemIdProvider } from './ids.js';
import {
  assistantUsageToTokens,
  estimateTokensFromModelPayload,
  usageMetadataToTokens
} from './jsonl.js';
import {
  CLAIM_ENTRY,
  COMMAND_RESULT_ENTRY,
  type GoalTransitionRecord,
  getBranchLeafId,
  restoreGoalFromBranch,
  STATE_ENTRY,
  TRANSITION_ENTRY,
  VERIFICATION_ENTRY
} from './persistence.js';
import { sanitizeText, TEXT_LIMITS } from './sanitize.js';
import {
  addTokenUsage,
  applyVerificationError,
  applyVerifierReport,
  branchContainsLeaf,
  type CompletionClaim,
  clearGoal,
  createGoal,
  type GoalState,
  getBudgetExhaustion,
  isActiveTimeStatus,
  isClosedStatus,
  isReportCurrent,
  isVerifierAttemptCurrent,
  limitBudget,
  pauseGoal,
  type RuntimeState,
  resumeGoal,
  type VerificationReport
} from './state.js';
import { registerGoalTools } from './tools.js';
import { notifyGoal, notifyGoalStatus, updateGoalUi } from './ui.js';
import {
  remainingVerifierTime,
  resolveSourceModel,
  runVerifierSubprocess,
  type VerifierRunInput,
  type VerifierRunResult,
  verificationErrorMessage
} from './verifier.js';

export interface GoalExtensionOptions {
  ids?: IdProvider;
  clock?: Clock;
  runVerifier?: (input: VerifierRunInput) => Promise<VerifierRunResult>;
}

type InterruptedVerificationReason = 'pause' | 'branch' | 'reload';

type CommitExtra = {
  claim?: CompletionClaim;
  interruptedVerification?: {
    claim: CompletionClaim;
    reason: InterruptedVerificationReason;
  };
};

export function registerGoalExtension(pi: ExtensionAPI, options: GoalExtensionOptions = {}): void {
  const ids = options.ids ?? systemIdProvider;
  const clock = options.clock ?? systemClock;
  const runVerifier = options.runVerifier ?? runVerifierSubprocess;
  const runtime: RuntimeState = {};

  const commitState = (
    next: GoalState,
    ctx: ExtensionContext,
    reason: string,
    extra?: CommitExtra
  ) => {
    const previous = runtime.goal;
    const transition: GoalTransitionRecord = {
      goal_id: next.id,
      generation: next.generation,
      from: previous?.status,
      to: next.status,
      reason,
      createdAt: clock.nowIso()
    };

    pi.appendEntry(STATE_ENTRY, { state: next });
    pi.appendEntry(TRANSITION_ENTRY, transition);
    if (extra?.claim) {
      pi.appendEntry(CLAIM_ENTRY, {
        goal_id: extra.claim.goal_id,
        generation: extra.claim.generation,
        claim: extra.claim
      });
    }
    if (extra?.interruptedVerification) {
      appendInterruptedVerificationRecord(
        pi,
        extra.interruptedVerification.claim,
        extra.interruptedVerification.reason
      );
    }

    runtime.goal = next;
    updateGoalUi(ctx, next, clock);
  };

  const clearContinuationDispatch = () => {
    runtime.continuationDispatch = undefined;
  };

  const abortVerifier = () => {
    runtime.verifierRunning?.abortController.abort();
    runtime.verifierRunning = undefined;
  };

  const invalidateRuntime = () => {
    clearContinuationDispatch();
    runtime.activeGoalRun = undefined;
    abortVerifier();
  };

  registerGoalTools(pi, {
    getGoal: () => runtime.goal,
    commit: commitState,
    clearContinuationDispatch,
    ids,
    clock
  });

  pi.registerCommand('goal', {
    description: 'Set, inspect, pause, resume, or clear one verifier-gated branch-local goal',
    handler: async (args, ctx) => {
      const command = parseGoalCommand(args);

      try {
        if (command.type === 'status') {
          notifyGoalStatus(ctx, runtime.goal, clock);
          appendCommandResult(pi, runtime.goal, formatGoalStatus(runtime.goal, clock));
          return;
        }

        if (command.type === 'create') {
          await handleCreate(command.objective, ctx);
          return;
        }

        if (command.type === 'pause') {
          handlePause(ctx);
          return;
        }

        if (command.type === 'resume') {
          handleResume(ctx);
          return;
        }

        await handleClear(ctx);
      } catch (error) {
        notifyGoal(ctx, error instanceof Error ? error.message : String(error), 'error');
      }
    }
  });

  pi.on('session_start', (event, ctx) => {
    invalidateRuntime();
    const restored = restoreGoalFromBranch(ctx.sessionManager.getBranch(), clock, 'reload');
    if (restored.state && restored.shouldPersistPause) {
      commitState(
        restored.state,
        ctx,
        `restore_${event.reason}`,
        interruptedVerificationExtra(restored.interruptedClaim, 'reload')
      );
      notifyGoal(ctx, 'Restored goal paused. Run /goal resume to continue.', 'warning');
    } else {
      runtime.goal = restored.state;
      updateGoalUi(ctx, runtime.goal, clock);
    }
  });

  pi.on('session_before_tree', (_event, ctx) => {
    const state = runtime.goal;
    const interruptedClaim = state?.status === 'verifying' ? state.pendingClaim : undefined;
    invalidateRuntime();
    if (state && isActiveTimeStatus(state.status)) {
      commitState(
        pauseGoal(state, clock, 'branch'),
        ctx,
        'branch',
        interruptedVerificationExtra(interruptedClaim, 'branch')
      );
    }
  });

  pi.on('session_tree', (_event, ctx) => {
    invalidateRuntime();
    const restored = restoreGoalFromBranch(ctx.sessionManager.getBranch(), clock, 'branch');
    if (restored.state && restored.shouldPersistPause) {
      commitState(
        restored.state,
        ctx,
        'branch_restore',
        interruptedVerificationExtra(restored.interruptedClaim, 'branch')
      );
    } else {
      runtime.goal = restored.state;
      updateGoalUi(ctx, runtime.goal, clock);
    }
  });

  pi.on('session_shutdown', (_event, ctx) => {
    const state = runtime.goal;
    const interruptedClaim = state?.status === 'verifying' ? state.pendingClaim : undefined;
    invalidateRuntime();
    if (state && isActiveTimeStatus(state.status)) {
      commitState(
        pauseGoal(state, clock, 'reload'),
        ctx,
        'shutdown',
        interruptedVerificationExtra(interruptedClaim, 'reload')
      );
    }
  });

  pi.on('agent_start', (_event, ctx) => {
    const state = runtime.goal;
    if (state && isActiveTimeStatus(state.status)) {
      runtime.activeGoalRun = {
        launchLeafId: getBranchLeafId(ctx.sessionManager.getBranch()),
        goal_id: state.id,
        generation: state.generation,
        countedMessageIds: []
      };
    }
    markDispatchInTurn(runtime, state);
  });

  pi.on('before_provider_request', (event, ctx) => {
    const run = runtime.activeGoalRun;
    if (!isCurrentActiveGoalRun(ctx) || !run) return;
    run.pendingProviderRequestTokenEstimate = estimateTokensFromModelPayload(event.payload);
  });

  pi.on('message_end', (event, ctx) => {
    if (!isAssistantMessage(event.message)) return;
    const run = runtime.activeGoalRun;
    const usage = assistantUsageToTokens(event.message.usage, messageText(event.message));
    const tokens = usage.estimated
      ? (run?.pendingProviderRequestTokenEstimate ?? 0) + usage.tokens
      : usage.tokens;
    if (run) run.pendingProviderRequestTokenEstimate = undefined;
    accountGoalTokens(ctx, tokens);
  });

  pi.on('tool_result', (event, ctx) => {
    const tokens = usageMetadataToTokens(event.usage);
    if (tokens !== undefined) accountGoalTokens(ctx, tokens);
  });

  pi.on('agent_settled', (_event, ctx) => {
    runtime.activeGoalRun = undefined;
    clearSettledDispatch(runtime, runtime.goal);

    if (runtime.goal?.status === 'verifying') {
      startVerifierIfNeeded(ctx);
      return;
    }

    maybeDispatchContinuation({ pi, runtime, ctx, clock, ids, commit: commitState });
  });

  pi.on('context', (event) => ({
    messages: filterStaleContinuationMessages(event.messages, runtime.goal)
  }));

  async function handleCreate(objective: string, ctx: ExtensionContext): Promise<void> {
    if (Array.from(objective).length > TEXT_LIMITS.objective) {
      notifyGoal(
        ctx,
        `Goal objective must be at most ${TEXT_LIMITS.objective} characters.`,
        'error'
      );
      return;
    }

    const current = runtime.goal;
    if (current && !isClosedStatus(current.status)) {
      if (!ctx.hasUI) {
        notifyGoal(
          ctx,
          'A non-closed goal already exists. Run /goal clear or finish it before replacing in no-UI mode.',
          'warning'
        );
        return;
      }

      const expectedId = current.id;
      const expectedGeneration = current.generation;
      const ok = await ctx.ui.confirm(
        'Replace current goal?',
        `Current goal: ${current.objective}\n\nReplace it with: ${objective}`
      );
      if (!ok) return;
      if (runtime.goal?.id !== expectedId || runtime.goal?.generation !== expectedGeneration) {
        notifyGoal(
          ctx,
          'Goal changed while waiting for confirmation. Run /goal again if needed.',
          'warning'
        );
        return;
      }
    }

    invalidateRuntime();
    const next = createGoal({
      objective,
      branchAnchorId: getBranchLeafId(ctx.sessionManager.getBranch()),
      ids,
      clock
    });
    commitState(next, ctx, current && !isClosedStatus(current.status) ? 'replace' : 'create');
    notifyGoal(ctx, `Goal started: ${next.objective}`, 'info');
    maybeDispatchContinuation({ pi, runtime, ctx, clock, ids, commit: commitState });
  }

  function handlePause(ctx: ExtensionContext): void {
    const state = runtime.goal;
    if (!state) {
      notifyGoal(ctx, 'No current goal to pause.', 'warning');
      return;
    }
    if (!isActiveTimeStatus(state.status)) {
      notifyGoal(ctx, `Cannot pause a ${state.status} goal.`, 'warning');
      return;
    }
    const interruptedClaim = state.status === 'verifying' ? state.pendingClaim : undefined;
    invalidateRuntime();
    const next = pauseGoal(state, clock, 'user');
    commitState(next, ctx, 'pause', interruptedVerificationExtra(interruptedClaim, 'pause'));
    notifyGoal(ctx, 'Goal paused. Run /goal resume to continue.', 'info');
  }

  function handleResume(ctx: ExtensionContext): void {
    const state = runtime.goal;
    if (!state) {
      notifyGoal(ctx, 'No current goal to resume.', 'warning');
      return;
    }
    if (state.status === 'budget_limited') {
      notifyGoal(
        ctx,
        'Budget-limited goals cannot be resumed. Clear or start a new goal.',
        'warning'
      );
      return;
    }
    const next = resumeGoal(state, clock);
    invalidateRuntime();
    commitState(next, ctx, 'resume');
    notifyGoal(ctx, 'Goal resumed.', 'info');
    maybeDispatchContinuation({ pi, runtime, ctx, clock, ids, commit: commitState });
  }

  async function handleClear(ctx: ExtensionContext): Promise<void> {
    const state = runtime.goal;
    if (!state || isClosedStatus(state.status)) {
      notifyGoal(ctx, 'No non-closed goal to clear.', 'info');
      return;
    }

    const clearCurrent = (current: GoalState) => {
      invalidateRuntime();
      const next = clearGoal(current, clock);
      commitState(next, ctx, 'clear');
      notifyGoal(ctx, 'Goal cleared.', 'info');
    };

    if (ctx.hasUI && isActiveTimeStatus(state.status)) {
      const expectedId = state.id;
      const expectedGeneration = state.generation;
      const expectedStatus = state.status;
      const ok = await ctx.ui.confirm('Clear current goal?', state.objective);
      if (!ok) return;
      const current = runtime.goal;
      if (
        !current ||
        current.id !== expectedId ||
        current.generation !== expectedGeneration ||
        current.status !== expectedStatus
      ) {
        notifyGoal(
          ctx,
          'Goal changed while waiting for confirmation. Run /goal clear again if needed.',
          'warning'
        );
        return;
      }
      clearCurrent(current);
      return;
    }

    clearCurrent(state);
  }

  function accountGoalTokens(ctx: ExtensionContext, tokens: number): void {
    if (!Number.isFinite(tokens) || tokens <= 0) return;
    const state = runtime.goal;
    if (!isCurrentActiveGoalRun(ctx) || !state) return;

    const withUsage = addTokenUsage(state, clock, tokens);
    const budget = getBudgetExhaustion(withUsage, clock);
    if (budget) {
      invalidateRuntime();
      commitState(limitBudget(withUsage, clock, budget), ctx, `budget_${budget}`);
      notifyGoal(ctx, `Goal stopped: ${budget} budget exhausted.`, 'warning');
      return;
    }

    pi.appendEntry(STATE_ENTRY, { state: withUsage });
    runtime.goal = withUsage;
    updateGoalUi(ctx, withUsage, clock);
  }

  function isCurrentActiveGoalRun(ctx: ExtensionContext): boolean {
    const run = runtime.activeGoalRun;
    const state = runtime.goal;
    if (!run || !state || !isActiveTimeStatus(state.status)) return false;
    if (run.goal_id !== state.id || run.generation !== state.generation) return false;
    return branchContainsLeaf(ctx.sessionManager.getBranch(), run.launchLeafId);
  }

  function startVerifierIfNeeded(ctx: ExtensionContext): void {
    const state = runtime.goal;
    const claim = state?.pendingClaim;
    if (!state || state.status !== 'verifying' || !claim || runtime.verifierRunning) return;

    const budget = getBudgetExhaustion(state, clock);
    if (budget) {
      commitState(limitBudget(state, clock, budget), ctx, `budget_${budget}`);
      return;
    }

    const source = resolveSourceModel(ctx.model, ctx.thinkingLevel ?? pi.getThinkingLevel());
    if (!source) {
      commitState(applyVerificationError(state, clock), ctx, 'verification_error');
      notifyGoal(ctx, 'Verifier could not resolve the source model/thinking level.', 'warning');
      return;
    }

    const launchLeafId = getBranchLeafId(ctx.sessionManager.getBranch());
    const abortController = new AbortController();
    runtime.verifierRunning = {
      launchLeafId,
      goal_id: state.id,
      generation: state.generation,
      claim_id: claim.claim_id,
      verifier_attempt_id: claim.verifier_attempt_id,
      abortController
    };

    updateGoalUi(ctx, state, clock);
    void runVerifier({
      state,
      claim,
      launchLeafId,
      cwd: ctx.cwd,
      source,
      remainingTimeMs: remainingVerifierTime(state, clock),
      signal: abortController.signal,
      clock
    })
      .then((result) => applyVerifierResult(ctx, claim, launchLeafId, result))
      .catch((error) =>
        applyVerifierResult(ctx, claim, launchLeafId, {
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
          usageTokens: 0,
          diagnostics: []
        })
      );
  }

  function applyVerifierResult(
    ctx: ExtensionContext,
    claim: CompletionClaim,
    launchLeafId: string | null,
    result: VerifierRunResult
  ): void {
    const running = runtime.verifierRunning;
    if (
      !running ||
      running.goal_id !== claim.goal_id ||
      running.generation !== claim.generation ||
      running.claim_id !== claim.claim_id ||
      running.verifier_attempt_id !== claim.verifier_attempt_id
    ) {
      return;
    }

    runtime.verifierRunning = undefined;
    if ((!result.ok && result.invalidated) || running.abortController.signal.aborted) return;

    const state = runtime.goal;
    if (!state || !isVerifierAttemptCurrent(state, claim)) return;
    if (!branchContainsLeaf(ctx.sessionManager.getBranch(), launchLeafId)) return;

    let next = addTokenUsage(state, clock, result.usageTokens);
    const budget = getBudgetExhaustion(next, clock);
    if (budget) {
      appendVerificationRecord(pi, claim, result);
      commitState(limitBudget(next, clock, budget), ctx, `budget_${budget}`);
      notifyGoal(ctx, `Goal stopped: ${budget} budget exhausted during verification.`, 'warning');
      return;
    }

    appendVerificationRecord(pi, claim, result);
    if (result.ok) {
      if (!isReportCurrent(next, result.report)) {
        const message = verificationErrorMessage('verifier report did not match current claim', []);
        commitState(applyVerificationError(next, clock, message), ctx, 'verification_error');
        notifyGoal(ctx, `Goal blocked by verifier error: ${message}`, 'warning');
        return;
      }

      try {
        next = applyVerifierReport(next, clock, result.report);
      } catch (error) {
        const message = verificationErrorMessage(
          error instanceof Error ? error.message : String(error),
          []
        );
        commitState(applyVerificationError(next, clock, message), ctx, 'verification_error');
        notifyGoal(ctx, `Goal blocked by verifier error: ${message}`, 'warning');
        return;
      }

      commitState(next, ctx, `verifier_${result.report.verdict}`);
      notifyForVerifierReport(ctx, result.report);
      if (next.status === 'active') {
        maybeDispatchContinuation({ pi, runtime, ctx, clock, ids, commit: commitState });
      }
      return;
    }

    const message = verificationErrorMessage(result.reason, result.diagnostics);
    commitState(applyVerificationError(next, clock, message), ctx, 'verification_error');
    notifyGoal(ctx, `Goal blocked by verifier error: ${message}`, 'warning');
  }
}

export default function goalExtension(pi: ExtensionAPI): void {
  registerGoalExtension(pi);
}

function appendCommandResult(pi: ExtensionAPI, state: GoalState | undefined, text: string): void {
  pi.appendEntry(COMMAND_RESULT_ENTRY, {
    goal_id: state?.id,
    generation: state?.generation,
    text: sanitizeText(text, {
      maxLength: 4000,
      allowNewlines: true,
      collapseWhitespace: false
    })
  });
}

function appendVerificationRecord(
  pi: ExtensionAPI,
  claim: CompletionClaim,
  result: VerifierRunResult
): void {
  pi.appendEntry(VERIFICATION_ENTRY, {
    goal_id: claim.goal_id,
    generation: claim.generation,
    claim_id: claim.claim_id,
    verifier_attempt_id: claim.verifier_attempt_id,
    ok: result.ok,
    usageTokens: result.usageTokens,
    diagnostics: result.diagnostics.slice(0, 20).map((diagnostic) =>
      sanitizeText(diagnostic, {
        maxLength: 1000,
        allowNewlines: true,
        collapseWhitespace: false
      })
    ),
    report: result.ok ? result.report : undefined,
    reason: result.ok ? undefined : sanitizeVerificationReason(result.reason)
  });
}

function appendInterruptedVerificationRecord(
  pi: ExtensionAPI,
  claim: CompletionClaim,
  reason: InterruptedVerificationReason
): void {
  pi.appendEntry(VERIFICATION_ENTRY, {
    goal_id: claim.goal_id,
    generation: claim.generation,
    claim_id: claim.claim_id,
    verifier_attempt_id: claim.verifier_attempt_id,
    ok: false,
    usageTokens: 0,
    diagnostics: [],
    interrupted: true,
    reason: sanitizeVerificationReason(`interrupted: ${reason}`)
  });
}

function interruptedVerificationExtra(
  claim: CompletionClaim | undefined,
  reason: InterruptedVerificationReason
): CommitExtra | undefined {
  return claim ? { interruptedVerification: { claim, reason } } : undefined;
}

function sanitizeVerificationReason(reason: string): string {
  return sanitizeText(reason, {
    maxLength: 1000,
    allowNewlines: false,
    collapseWhitespace: true
  });
}

function notifyForVerifierReport(ctx: ExtensionContext, report: VerificationReport): void {
  if (report.verdict === 'pass') {
    notifyGoal(ctx, 'Goal complete after independent verification.', 'info');
  } else if (report.verdict === 'fail') {
    notifyGoal(ctx, 'Verification failed. Goal returned to active with feedback.', 'warning');
  } else {
    notifyGoal(ctx, 'Verification uncertain. Goal blocked for user input.', 'warning');
  }
}

function isAssistantMessage(
  message: AgentMessage
): message is AgentMessage & { role: 'assistant'; usage?: Usage } {
  const record = message as unknown as { role?: unknown };
  return record.role === 'assistant';
}

function messageText(message: AgentMessage): string {
  const record = message as unknown as { content?: unknown };
  return Array.isArray(record.content) ? contentText(record.content) : '';
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((part): string[] => {
      if (!part || typeof part !== 'object') return [];
      const record = part as Record<string, unknown>;
      if (record.type === 'text' && typeof record.text === 'string') return [record.text];
      return [];
    })
    .join('\n');
}
