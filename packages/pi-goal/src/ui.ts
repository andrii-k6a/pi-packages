import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Box, Text } from '@earendil-works/pi-tui';
import { compactStatus, formatGoalStatus } from './commands.js';
import type { Clock } from './ids.js';
import { CLAIM_ENTRY, VERIFICATION_ENTRY } from './persistence.js';
import { excerpt, sanitizeText } from './sanitize.js';
import type { CheckEvidence, CompletionClaim, GoalState, VerificationReport } from './state.js';

const STATUS_KEY = 'pi-goal';
export const GOAL_WIDGET_KEY = 'pi-goal-detail';

export interface VerifierProgressUi {
  startedAt: string;
  sourceLabel: string;
  remainingTimeMs: number;
}

interface ClaimEntryData {
  goal_id?: string;
  generation?: number;
  claim?: CompletionClaim;
}

interface VerificationEntryData {
  goal_id?: string;
  generation?: number;
  claim_id?: string;
  verifier_attempt_id?: string;
  ok?: boolean;
  usageTokens?: number;
  diagnostics?: string[];
  interrupted?: boolean;
  report?: VerificationReport;
  reason?: string;
  claim_summary?: string;
  claim_evidence?: string;
  changed_files?: string[];
  checks?: CheckEvidence[];
}

export function registerGoalUi(pi: Pick<ExtensionAPI, 'registerEntryRenderer'>): void {
  pi.registerEntryRenderer<ClaimEntryData>(CLAIM_ENTRY, (entry, { expanded }, theme) => {
    const claim = entry.data?.claim;
    if (!claim) return undefined;

    const lines = [
      theme.fg('accent', theme.bold('📌 Completion claim submitted')),
      `${theme.fg('muted', 'Summary:')} ${excerpt(claim.summary, 180)}`,
      `${theme.fg('muted', 'Evidence:')} ${excerpt(claim.evidence, 220)}`
    ];

    if (expanded) {
      lines.push(theme.fg('dim', `Goal ${claim.goal_id} · generation ${claim.generation}`));
      addChangedFiles(lines, claim.changed_files, theme);
      addChecks(lines, claim.checks, theme);
    }

    return boxed(lines, theme);
  });

  pi.registerEntryRenderer<VerificationEntryData>(
    VERIFICATION_ENTRY,
    (entry, { expanded }, theme) => {
      const data = entry.data;
      if (!data) return undefined;

      const report = data.report;
      const title = verificationTitle(data);
      const color = verificationColor(data);
      const lines = [theme.fg(color, theme.bold(title))];

      if (data.claim_summary) {
        lines.push(`${theme.fg('muted', 'Summary:')} ${excerpt(data.claim_summary, 180)}`);
      }
      if (report?.rationale) {
        lines.push(`${theme.fg('muted', 'Verifier:')} ${excerpt(report.rationale, 220)}`);
      } else if (data.reason) {
        lines.push(`${theme.fg('muted', 'Reason:')} ${excerpt(data.reason, 220)}`);
      }
      if (report?.next_action) {
        lines.push(`${theme.fg('muted', 'Next:')} ${excerpt(report.next_action, 180)}`);
      }

      if (expanded) {
        if (data.claim_evidence) {
          lines.push(`${theme.fg('dim', 'Claim evidence:')} ${excerpt(data.claim_evidence, 240)}`);
        }
        addChangedFiles(lines, data.changed_files, theme);
        addChecks(lines, data.checks, theme);
        addReportDetails(lines, report, theme);
        if (data.diagnostics && data.diagnostics.length > 0) {
          lines.push(
            `${theme.fg('dim', 'Diagnostics:')} ${data.diagnostics
              .map((item) => excerpt(item, 120))
              .join('; ')}`
          );
        }
        if (typeof data.usageTokens === 'number') {
          lines.push(theme.fg('dim', `Verifier tokens: ${data.usageTokens}`));
        }
        if (data.goal_id) {
          lines.push(
            theme.fg(
              'dim',
              `Goal ${data.goal_id} · generation ${data.generation ?? '?'} · claim ${
                data.claim_id ?? '?'
              } · attempt ${data.verifier_attempt_id ?? '?'}`
            )
          );
        }
      }

      return boxed(lines, theme);
    }
  );
}

export function updateGoalUi(
  ctx: ExtensionContext,
  state: GoalState | undefined,
  clock: Clock
): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(STATUS_KEY, compactStatus(state, clock));
  ctx.ui.setWidget(GOAL_WIDGET_KEY, goalWidgetLines(state));
}

export function updateVerifierProgressUi(
  ctx: ExtensionContext,
  state: GoalState,
  clock: Clock,
  progress: VerifierProgressUi
): void {
  if (!ctx.hasUI) return;
  const base = compactStatus(state, clock) ?? '🔍 verifying';
  const elapsed = elapsedSince(progress.startedAt, clock);
  ctx.ui.setStatus(STATUS_KEY, `${base} · ${formatDuration(elapsed)} elapsed`);
  ctx.ui.setWidget(GOAL_WIDGET_KEY, goalWidgetLines(state, progress, clock));
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

function goalWidgetLines(
  state: GoalState | undefined,
  progress?: VerifierProgressUi,
  clock?: Clock
): string[] | undefined {
  if (!state) return undefined;

  const objective = `Objective: ${excerpt(state.objective, 150)}`;

  if (state.status === 'verifying') {
    const lines = ['🔍 Verifying goal', objective];
    if (state.pendingClaim) lines.push(`Claim: ${excerpt(state.pendingClaim.summary, 180)}`);
    if (progress && clock) {
      lines.push(
        `Verifier: running ${formatDuration(elapsedSince(progress.startedAt, clock))} · ${formatDuration(
          progress.remainingTimeMs
        )} remaining`
      );
      lines.push(`Model: ${excerpt(progress.sourceLabel, 100)} · read-only tools`);
    } else {
      lines.push('Verifier: waiting for the parent turn to settle');
    }
    return lines;
  }

  if (state.status === 'complete') {
    const lines = ['✅ Goal complete'];
    if (state.lastSummary) lines.push(`Summary: ${excerpt(state.lastSummary, 180)}`);
    if (state.lastVerification?.rationale) {
      lines.push(`Verifier: ${excerpt(state.lastVerification.rationale, 220)}`);
    }
    if (state.lastEvidence) lines.push(`Evidence: ${excerpt(state.lastEvidence, 220)}`);
    return lines;
  }

  if (state.status === 'blocked') {
    const title =
      state.lastVerification?.verdict === 'uncertain'
        ? '⚠️ Verification uncertain'
        : '⚠️ Goal blocked';
    const lines = [title, objective];
    if (state.lastVerification?.rationale) {
      lines.push(`Verifier: ${excerpt(state.lastVerification.rationale, 220)}`);
    }
    if (state.lastVerification?.next_action) {
      lines.push(`Next: ${excerpt(state.lastVerification.next_action, 180)}`);
    } else if (state.blockedReason) {
      lines.push(`Reason: ${excerpt(state.blockedReason, 180)}`);
    }
    return lines;
  }

  if (state.status === 'paused') {
    const lines = ['⏸️ Goal paused', objective];
    if (state.pauseReason) lines.push(`Reason: ${state.pauseReason}`);
    lines.push('Run /goal resume to continue.');
    return lines;
  }

  if (state.status === 'budget_limited') {
    const lines = ['⚠️ Goal budget exhausted', objective];
    if (state.budgetReason) lines.push(`Budget: ${state.budgetReason}`);
    lines.push('Start a new goal or clear this one.');
    return lines;
  }

  if (state.status === 'active' && state.lastVerification?.verdict !== undefined) {
    const lines = ['🎯 Goal active after verifier feedback', objective];
    lines.push(`Verifier: ${excerpt(state.lastVerification.rationale, 220)}`);
    if (state.lastVerification.next_action) {
      lines.push(`Next: ${excerpt(state.lastVerification.next_action, 180)}`);
    }
    return lines;
  }

  return undefined;
}

function boxed(lines: string[], theme: EntryTheme): Box {
  const box = new Box(1, 1, (text) => theme.bg('customMessageBg', text));
  box.addChild(new Text(lines.join('\n'), 0, 0));
  return box;
}

interface EntryTheme {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
}

function verificationTitle(data: VerificationEntryData): string {
  if (data.interrupted) return '⏸️ Goal verification interrupted';
  if (data.ok && data.report?.verdict === 'pass') return '✅ Goal complete after verification';
  if (data.ok && data.report?.verdict === 'fail') return '⚠️ Verification failed';
  if (data.ok && data.report?.verdict === 'uncertain') return '⚠️ Verification uncertain';
  return '⚠️ Verifier error';
}

function verificationColor(data: VerificationEntryData): 'success' | 'warning' | 'error' {
  if (data.ok && data.report?.verdict === 'pass') return 'success';
  if (!data.ok && !data.interrupted) return 'error';
  return 'warning';
}

function addChangedFiles(
  lines: string[],
  changedFiles: string[] | undefined,
  theme: EntryTheme
): void {
  if (!changedFiles || changedFiles.length === 0) return;
  lines.push(
    `${theme.fg('dim', 'Changed files:')} ${changedFiles.map((file) => excerpt(file, 80)).join(', ')}`
  );
}

function addChecks(lines: string[], checks: CheckEvidence[] | undefined, theme: EntryTheme): void {
  if (!checks || checks.length === 0) return;
  lines.push(
    `${theme.fg('dim', 'Checks:')} ${checks
      .map((check) => {
        const exit = check.exit_code === undefined ? '?' : String(check.exit_code);
        return `${excerpt(check.command, 80)} (${exit})`;
      })
      .join('; ')}`
  );
}

function addReportDetails(
  lines: string[],
  report: VerificationReport | undefined,
  theme: EntryTheme
): void {
  if (!report) return;
  if (report.evidence_reviewed.length > 0) {
    lines.push(
      `${theme.fg('dim', 'Evidence reviewed:')} ${report.evidence_reviewed
        .map((item) => excerpt(item, 100))
        .join('; ')}`
    );
  }
  if (report.missing_evidence && report.missing_evidence.length > 0) {
    lines.push(
      `${theme.fg('dim', 'Missing evidence:')} ${report.missing_evidence
        .map((item) => excerpt(item, 100))
        .join('; ')}`
    );
  }
  if (report.risks && report.risks.length > 0) {
    lines.push(
      `${theme.fg('dim', 'Risks:')} ${report.risks.map((item) => excerpt(item, 100)).join('; ')}`
    );
  }
}

function elapsedSince(startedAt: string, clock: Clock): number {
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return 0;
  return Math.max(0, clock.now().getTime() - started);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

export function sanitizeVerificationClaimDetails(claim: CompletionClaim): {
  claim_summary: string;
  claim_evidence: string;
  changed_files?: string[];
  checks?: CheckEvidence[];
} {
  return {
    claim_summary: sanitizeText(claim.summary, {
      maxLength: 1000,
      allowNewlines: true,
      collapseWhitespace: true
    }),
    claim_evidence: sanitizeText(claim.evidence, {
      maxLength: 2000,
      allowNewlines: true,
      collapseWhitespace: false
    }),
    changed_files: claim.changed_files?.slice(0, 20).map((file) =>
      sanitizeText(file, {
        maxLength: 1000,
        allowNewlines: false,
        collapseWhitespace: true
      })
    ),
    checks: claim.checks?.slice(0, 10).map((check) => ({
      command: sanitizeText(check.command, {
        maxLength: 1000,
        allowNewlines: false,
        collapseWhitespace: true
      }),
      exit_code: check.exit_code,
      output_excerpt: sanitizeText(check.output_excerpt, {
        maxLength: 1000,
        allowNewlines: true,
        collapseWhitespace: false
      })
    }))
  };
}
