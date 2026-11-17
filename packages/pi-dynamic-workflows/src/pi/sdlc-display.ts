import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { SdlcState } from '../durable/sdlc-state.js';
import { terminalLine } from '../shared/terminal-text.js';
import type { SdlcArgs } from '../workflow/sdlc/contracts.js';
import { formatCost, formatTokens } from './display.js';

/** Bounded projection for tool details. Full records remain in durable storage. */
export function compactSdlc(state: SdlcState) {
  const pending = state.questions.filter((question) => question.answer === undefined);
  return {
    operationId: state.operationId,
    activity: state.activity,
    outcome: state.outcome,
    briefRevision: state.brief.revision,
    goalRevision: state.brief.goalRevision,
    workspace: {
      cwd: state.workspace.cwd,
      mode: state.workspace.mode,
      branch: state.workspace.branch
    },
    pendingQuestions: pending.slice(0, 5).map((question) => ({
      id: question.id,
      briefRevision: question.briefRevision,
      text: question.text.slice(0, 500),
      choices: question.choices?.slice(0, 10)
    })),
    pendingQuestionCount: pending.length,
    limits: state.limits,
    consumed: state.consumed,
    usage: state.usage,
    importedUsage: state.importedUsage,
    unresolvedWork:
      state.result?.unresolvedWork.slice(0, 5) ?? (state.stopReason ? [state.stopReason] : [])
  };
}

export type SdlcSummary = ReturnType<typeof compactSdlc>;

export function renderSdlcStatusLines(state: SdlcSummary): string[] {
  const clean = (value: string) => terminalLine(value);
  const lines = [
    `SDLC ${state.outcome ?? 'active'} · ${clean(state.activity)} · goal revision ${state.goalRevision}`,
    `Workspace: ${clean(state.workspace.cwd)} (${state.workspace.mode}${state.workspace.branch ? `, branch ${clean(state.workspace.branch)}` : ''}).`,
    `Limits: tasks ${state.consumed.tasks}/${state.limits.maxTasks}, corrections ${state.consumed.corrections}/${state.limits.correctionRounds}, replans ${state.consumed.replans}/${state.limits.replans}, concurrency ${state.limits.concurrency}.`,
    `Timeouts: task ${state.limits.taskTimeoutMs}ms, check ${state.limits.checkTimeoutMs}ms.`,
    `Usage: ${formatTokens(state.usage.totalTokens)}/${formatTokens(state.limits.tokenBudget)} tokens (soft allowance, in-flight work can overshoot) · ${formatCost(state.usage.cost.total)}.`,
    ...(state.importedUsage.totalTokens
      ? [
          `Imported review usage (separate): ${formatTokens(state.importedUsage.totalTokens)} tokens · ${formatCost(state.importedUsage.cost.total)}.`
        ]
      : [])
  ];
  for (const question of state.pendingQuestions) {
    lines.push(
      `Question ${clean(question.id)} (brief revision ${question.briefRevision}): ${clean(question.text)}`
    );
    if (question.choices?.length) lines.push(`Choices: ${question.choices.map(clean).join(' | ')}`);
  }
  if (state.pendingQuestionCount > state.pendingQuestions.length)
    lines.push(
      `${state.pendingQuestionCount - state.pendingQuestions.length} more pending questions. Inspect the operation for full records.`
    );
  if (state.pendingQuestionCount)
    lines.push(
      'Unanswered questions are not approval. Record answers explicitly, then continue the operation.'
    );
  for (const unresolved of state.unresolvedWork)
    lines.push(`Unresolved: ${clean(unresolved).slice(0, 500)}`);
  if (state.outcome)
    lines.push(
      `Resume returns stored results after runtime completion. Use { "continue": "${state.operationId}" } for additional SDLC work.`
    );
  return lines;
}

/** Preflight policy notice. The host announces the exact durable destination before scheduling. */
export async function sdlcStartWorkspaceNotice(args: SdlcArgs, cwd: string): Promise<string> {
  if (args.workspace?.mode === 'isolated') {
    return 'SDLC isolation: operation-owned checkout. The host will announce its exact destination before setup. Output is not automatically applied to the source checkout.';
  }
  return sdlcWorkspaceNotice({
    cwd: await realpath(resolve(cwd, args.workspace?.cwd ?? '.')),
    mode: 'existing',
    branch: undefined
  });
}

export function sdlcWorkspaceNotice(workspace: SdlcSummary['workspace']): string {
  return `SDLC destination: ${terminalLine(workspace.cwd)}. ${
    workspace.mode === 'isolated'
      ? `Operation-owned isolated checkout${workspace.branch ? `, branch ${terminalLine(workspace.branch)}` : ''}. The source checkout is not the target.`
      : 'Existing checkout. Authorized implementation changes this directory.'
  } Tool permissions and worktrees are not an OS sandbox.`;
}
