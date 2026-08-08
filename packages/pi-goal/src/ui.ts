import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Box, Text } from '@earendil-works/pi-tui';
import { compactStatus, formatGoalStatus } from './commands.js';
import type { Clock } from './ids.js';
import { CLAIM_ENTRY, VERIFICATION_ENTRY } from './persistence.js';
import { excerpt, sanitizeText, TEXT_LIMITS } from './sanitize.js';
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

    const lines = [theme.fg('accent', theme.bold('📌 Completion claim submitted'))];
    addThemedSection(lines, theme, 'muted', 'Summary', claim.summary);
    addThemedSection(lines, theme, 'muted', 'Evidence', claim.evidence);

    if (expanded) {
      lines.push('', theme.fg('dim', `Goal ${claim.goal_id} · generation ${claim.generation}`));
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

      addThemedSection(lines, theme, 'muted', 'Summary', data.claim_summary);
      if (report?.rationale) {
        addThemedSection(lines, theme, 'muted', 'Verifier', report.rationale);
      } else {
        addThemedSection(lines, theme, 'muted', 'Reason', data.reason);
      }
      addThemedSection(lines, theme, 'muted', 'Next', report?.next_action);

      if (expanded) {
        addThemedSection(lines, theme, 'dim', 'Claim evidence', data.claim_evidence);
        addChangedFiles(lines, data.changed_files, theme);
        addChecks(lines, data.checks, theme);
        addReportDetails(lines, report, theme);
        addThemedList(lines, theme, 'dim', 'Diagnostics', data.diagnostics);
        if (typeof data.usageTokens === 'number') {
          lines.push('', theme.fg('dim', `Verifier tokens: ${data.usageTokens}`));
        }
        if (data.goal_id) {
          lines.push(
            '',
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
    addPlainSection(lines, 'Summary', state.lastSummary);
    addPlainSection(lines, 'Verifier', state.lastVerification?.rationale);
    addPlainSection(lines, 'Evidence', state.lastEvidence);
    return lines;
  }

  if (state.status === 'blocked') {
    const title =
      state.lastVerification?.verdict === 'uncertain'
        ? '⚠️ Verification uncertain'
        : '⚠️ Goal blocked';
    const lines = [title, objective];
    addPlainSection(lines, 'Verifier', state.lastVerification?.rationale);
    if (state.lastVerification?.next_action) {
      addPlainSection(lines, 'Next', state.lastVerification.next_action);
    } else {
      addPlainSection(lines, 'Reason', state.blockedReason);
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
    addPlainSection(lines, 'Verifier', state.lastVerification.rationale);
    addPlainSection(lines, 'Next', state.lastVerification.next_action);
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

function addPlainSection(lines: string[], label: string, value: string | undefined): void {
  const text = displayBlock(value);
  if (!text) return;
  lines.push('', `${label}:`, ...text.split('\n'));
}

function addThemedSection(
  lines: string[],
  theme: EntryTheme,
  color: string,
  label: string,
  value: string | undefined
): void {
  const text = displayBlock(value);
  if (!text) return;
  lines.push('', theme.fg(color, `${label}:`), ...text.split('\n'));
}

function addThemedList(
  lines: string[],
  theme: EntryTheme,
  color: string,
  label: string,
  values: string[] | undefined
): void {
  const texts = values?.map(displayBlock).filter((text) => text.length > 0);
  if (!texts || texts.length === 0) return;
  lines.push('', theme.fg(color, `${label}:`));
  for (const text of texts) addListItem(lines, text);
}

function addChangedFiles(
  lines: string[],
  changedFiles: string[] | undefined,
  theme: EntryTheme
): void {
  addThemedList(lines, theme, 'dim', 'Changed files', changedFiles?.map(displayInline));
}

function addChecks(lines: string[], checks: CheckEvidence[] | undefined, theme: EntryTheme): void {
  if (!checks || checks.length === 0) return;
  lines.push('', theme.fg('dim', 'Checks:'));
  for (const check of checks) {
    const exit = check.exit_code === undefined ? '?' : String(check.exit_code);
    addListItem(lines, `${displayInline(check.command)} (${exit})`);
  }
}

function addReportDetails(
  lines: string[],
  report: VerificationReport | undefined,
  theme: EntryTheme
): void {
  if (!report) return;
  addThemedList(lines, theme, 'dim', 'Evidence reviewed', report.evidence_reviewed);
  addThemedList(lines, theme, 'dim', 'Missing evidence', report.missing_evidence);
  addThemedList(lines, theme, 'dim', 'Risks', report.risks);
}

function addListItem(lines: string[], text: string): void {
  const [first = '', ...rest] = text.split('\n');
  lines.push(`- ${first}`);
  for (const line of rest) lines.push(`  ${line}`);
}

function displayBlock(value: string | undefined): string {
  return sanitizeText(value, {
    maxLength: Number.MAX_SAFE_INTEGER,
    allowNewlines: true,
    collapseWhitespace: false
  });
}

function displayInline(value: string | undefined): string {
  return sanitizeText(value, {
    maxLength: Number.MAX_SAFE_INTEGER,
    allowNewlines: false,
    collapseWhitespace: true
  });
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
      maxLength: TEXT_LIMITS.summary,
      allowNewlines: true,
      collapseWhitespace: true
    }),
    claim_evidence: sanitizeText(claim.evidence, {
      maxLength: TEXT_LIMITS.evidence,
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
        maxLength: 2000,
        allowNewlines: true,
        collapseWhitespace: false
      })
    }))
  };
}
