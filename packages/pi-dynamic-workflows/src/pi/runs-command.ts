import { writeFileSync } from 'node:fs';
import type { ExtensionAPI, ExtensionCommandContext, Theme } from '@earendil-works/pi-coding-agent';
import {
  Key,
  matchesKey,
  type TUI,
  truncateToWidth,
  wrapTextWithAnsi
} from '@earendil-works/pi-tui';
import type { WorkflowAgentRow } from '../durable/docs.js';
import type { WorkflowHost } from '../durable/host.js';
import {
  attemptRows,
  type WorkflowRunReport,
  type WorkflowTranscriptItem
} from '../durable/report.js';
import type { WorkflowRunIndex } from '../durable/store.js';
import { terminalLine as sanitize, terminalMultiline } from '../shared/terminal-text.js';
import { formatCost, formatDuration, formatTokens } from './display.js';

const STATUS_ICONS: Record<string, string> = {
  running: '●',
  interrupted: '⏸',
  completed: '✓',
  failed: '✗',
  aborted: '-',
  queued: '○',
  done: '✓',
  error: '✗',
  skipped: '-'
};

/** `/workflows`: list, inspect, resume, abort, and delete durable workflow runs. */
export async function openWorkflowRuns(
  pi: Pick<ExtensionAPI, 'sendUserMessage' | 'sendMessage'>,
  ctx: ExtensionCommandContext,
  host: WorkflowHost,
  args = ''
): Promise<void> {
  const runId = args.trim() || undefined;
  if (ctx.mode !== 'tui') {
    await printWorkflowRuns(pi, ctx, host, runId);
    return;
  }
  const result = await ctx.ui.custom<{ resume?: string } | undefined>(
    (tui, theme, _keybindings, done) =>
      new WorkflowRunsBrowser(tui, theme, host, (value) => done(value), runId)
  );
  if (result?.resume) {
    const message = resumeInstruction(result.resume);
    if (ctx.isIdle()) pi.sendUserMessage(message);
    else pi.sendUserMessage(message, { deliverAs: 'followUp' });
  }
}

export function resumeInstruction(runId: string): string {
  return `Resume the durable workflow run ${runId}: call the workflow tool with { "resume": "${runId}" }. Completed agent results are reused.`;
}

/** Text output for non-interactive modes. */
async function printWorkflowRuns(
  pi: Pick<ExtensionAPI, 'sendMessage'>,
  ctx: ExtensionCommandContext,
  host: WorkflowHost,
  runId: string | undefined
): Promise<void> {
  const output = (text: string, type: 'info' | 'error') => {
    const safeText = terminalMultiline(text);
    if (ctx.mode === 'rpc') {
      ctx.ui.notify(safeText, type);
    } else if (ctx.mode === 'json') {
      // Native message events preserve Pi's JSONL framing without starting a model turn.
      pi.sendMessage(
        {
          customType: 'workflow-runs',
          content: safeText,
          display: true,
          details: { ...(runId ? { runId } : {}), isError: type === 'error' }
        },
        { triggerTurn: false }
      );
    } else {
      // Pi redirects process.stdout.write() to stderr in non-interactive modes. Write directly
      // to the caller's descriptors: summaries on stdout, errors on stderr.
      writeFileSync(type === 'error' ? 2 : 1, `${safeText}\n`);
    }
  };
  try {
    if (!runId) {
      const runs = host.list();
      output(
        runs.length
          ? runs
              .slice(0, 20)
              .map((run) => runListLine(run, Date.now()))
              .join('\n')
          : 'No workflow runs yet.',
        'info'
      );
      return;
    }
    const report = await host.report(runId);
    output(
      renderRunDetailLines(report, report.attempts.length - 1, -1, Date.now()).join('\n'),
      'info'
    );
  } catch (error) {
    output(errorText(error), 'error');
  }
}

type BrowserMode =
  | { kind: 'list'; runs: WorkflowRunIndex[]; selected: number }
  | {
      kind: 'detail';
      runId: string;
      report?: WorkflowRunReport;
      attempt: number;
      selected: number;
    }
  | {
      kind: 'transcript';
      runId: string;
      title: string;
      items?: WorkflowTranscriptItem[];
      offset: number;
      back: Extract<BrowserMode, { kind: 'detail' }>;
    };

export class WorkflowRunsBrowser {
  #mode: BrowserMode;
  #message: { text: string; tone: 'muted' | 'warning' | 'error' } | undefined;
  #pendingDelete: string | undefined;
  #cache: { width: number; lines: string[] } | undefined;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly host: WorkflowHost,
    private readonly done: (result: { resume?: string } | undefined) => void,
    initialRunId?: string
  ) {
    this.#mode = { kind: 'list', runs: host.list(), selected: 0 };
    if (initialRunId) this.#openDetail(initialRunId);
  }

  handleInput(data: string): void {
    const mode = this.#mode;
    if (mode.kind === 'list') this.#listInput(mode, data);
    else if (mode.kind === 'detail') this.#detailInput(mode, data);
    else this.#transcriptInput(mode, data);
  }

  render(width: number): string[] {
    if (this.#cache?.width === width) return this.#cache.lines;
    const rows = this.#rows();
    const body = this.#body(width, Math.max(3, rows - 6));
    const lines = [
      this.theme.fg('accent', '─'.repeat(Math.max(0, width))),
      this.#title(),
      '',
      ...body,
      '',
      this.#message
        ? this.theme.fg(this.#message.tone, ` ${this.#message.text}`)
        : this.theme.fg('dim', this.#help()),
      this.theme.fg('accent', '─'.repeat(Math.max(0, width)))
    ].map((line) => truncateToWidth(line, width, ''));
    this.#cache = { width, lines };
    return lines;
  }

  invalidate(): void {
    this.#cache = undefined;
  }

  #refresh(): void {
    this.invalidate();
    this.tui.requestRender();
  }

  #notify(text: string, tone: 'muted' | 'warning' | 'error' = 'muted'): void {
    this.#message = { text: sanitize(text), tone };
    this.#refresh();
  }

  #rows(): number {
    return (this.tui as TUI & { terminal?: { rows: number } }).terminal?.rows ?? 24;
  }

  #title(): string {
    const mode = this.#mode;
    const label =
      mode.kind === 'list'
        ? `${mode.runs.length} run(s)`
        : mode.kind === 'detail'
          ? mode.runId
          : `${mode.runId} · ${mode.title}`;
    return `${this.theme.fg('accent', ` ${this.theme.bold('/workflows')}`)}${this.theme.fg('muted', ` · ${sanitize(label)}`)}`;
  }

  #help(): string {
    switch (this.#mode.kind) {
      case 'list':
        return ' ↑/↓ move • Enter inspect • r resume • a abort • d delete • g refresh • q/Esc close';
      case 'detail':
        return ' ↑/↓ agent • Enter transcript • [/] attempt • r resume • a abort • g refresh • Esc back';
      default:
        return ' ↑/↓ scroll • PgUp/PgDn page • Home/End • Esc back';
    }
  }

  #body(width: number, height: number): string[] {
    const mode = this.#mode;
    const now = Date.now();
    if (mode.kind === 'list') {
      if (mode.runs.length === 0) return [this.theme.fg('muted', '  No workflow runs yet.')];
      const start = windowStart(mode.selected, mode.runs.length, height);
      return mode.runs.slice(start, start + height).map((run, offset) => {
        const selected = start + offset === mode.selected;
        const line = `${selected ? '>' : ' '} ${runListLine(run, now)}`;
        return selected ? this.theme.fg('accent', line) : this.theme.fg(toneFor(run.status), line);
      });
    }
    if (mode.kind === 'detail') {
      if (!mode.report) return [this.theme.fg('muted', '  Loading…')];
      const sections = runDetailSections(mode.report, mode.attempt, mode.selected, now);
      // Keep the selected agent's facts on screen while only the agent list scrolls. On short
      // terminals, trim the run header first and reserve at least one row for the selected agent.
      const details = sections.details.slice(0, Math.max(0, height - 1));
      const header = sections.header.slice(0, Math.max(0, height - details.length - 1));
      const listHeight = height - header.length - details.length;
      const selectedLine = sections.agents.findIndex((line) => line.startsWith('>'));
      const start =
        selectedLine < 0 ? 0 : windowStart(selectedLine, sections.agents.length, listHeight);
      return [...header, ...sections.agents.slice(start, start + listHeight), ...details].map(
        (line) => (line.startsWith('>') ? this.theme.fg('accent', line) : line)
      );
    }
    if (!mode.items) return [this.theme.fg('muted', '  Loading…')];
    const lines = renderTranscriptLines(mode.items, width);
    mode.offset = Math.max(0, Math.min(mode.offset, Math.max(0, lines.length - height)));
    return lines.slice(mode.offset, mode.offset + height);
  }

  #listInput(mode: Extract<BrowserMode, { kind: 'list' }>, data: string): void {
    const run = mode.runs[mode.selected];
    if (matchesKey(data, Key.escape) || matchesKey(data, 'q')) {
      this.done(undefined);
      return;
    }
    if (moveKey(data) !== 0) {
      mode.selected = clamp(mode.selected + moveKey(data), mode.runs.length);
      this.#pendingDelete = undefined;
      this.#message = undefined;
      this.#refresh();
      return;
    }
    if (matchesKey(data, 'g')) {
      mode.runs = this.host.list();
      mode.selected = clamp(mode.selected, mode.runs.length);
      this.#notify('Refreshed.');
      return;
    }
    if (!run) return;
    if (matchesKey(data, Key.enter)) {
      this.#openDetail(run.runId);
      return;
    }
    if (matchesKey(data, 'r')) {
      this.#resume(run.runId, run.status);
      return;
    }
    if (matchesKey(data, 'a')) {
      void this.#abort(run.runId);
      return;
    }
    if (matchesKey(data, 'd')) {
      if (this.#pendingDelete !== run.runId) {
        this.#pendingDelete = run.runId;
        this.#notify(`Press d again to delete run ${run.runId} permanently.`, 'warning');
        return;
      }
      this.#pendingDelete = undefined;
      try {
        this.host.delete(run.runId);
        mode.runs = this.host.list();
        mode.selected = clamp(mode.selected, mode.runs.length);
        this.#notify(`Deleted ${run.runId}.`);
      } catch (error) {
        this.#notify(errorText(error), 'error');
      }
    }
  }

  #detailInput(mode: Extract<BrowserMode, { kind: 'detail' }>, data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, 'q')) {
      this.#mode = { kind: 'list', runs: this.host.list(), selected: 0 };
      const index = this.#mode.runs.findIndex((run) => run.runId === mode.runId);
      this.#mode.selected = Math.max(0, index);
      this.#message = undefined;
      this.#refresh();
      return;
    }
    const report = mode.report;
    if (!report) return;
    const rows = attemptRows(report.attempts[mode.attempt] ?? { agents: {} });
    if (moveKey(data) !== 0) {
      mode.selected = clamp(mode.selected + moveKey(data), rows.length);
      this.#refresh();
      return;
    }
    if (matchesKey(data, '[') || matchesKey(data, ']')) {
      mode.attempt = clamp(mode.attempt + (matchesKey(data, '[') ? -1 : 1), report.attempts.length);
      mode.selected = 0;
      this.#refresh();
      return;
    }
    if (matchesKey(data, 'g')) {
      this.#openDetail(mode.runId, mode);
      return;
    }
    if (matchesKey(data, 'r')) {
      this.#resume(mode.runId, report.status);
      return;
    }
    if (matchesKey(data, 'a')) {
      void this.#abort(mode.runId, mode);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const row = rows[mode.selected];
      if (row?.conversationId === undefined) {
        this.#notify('This agent has no transcript yet.');
        return;
      }
      const transcript: Extract<BrowserMode, { kind: 'transcript' }> = {
        kind: 'transcript',
        runId: mode.runId,
        title: `#${row.index} ${row.label}`,
        offset: 0,
        back: mode
      };
      this.#mode = transcript;
      this.#message = undefined;
      this.#refresh();
      void this.host
        .transcript(mode.runId, row.conversationId)
        .then((items) => {
          transcript.items = items;
          this.#refresh();
        })
        .catch((error) => this.#notify(errorText(error), 'error'));
    }
  }

  #transcriptInput(mode: Extract<BrowserMode, { kind: 'transcript' }>, data: string): void {
    const page = Math.max(1, this.#rows() - 8);
    if (matchesKey(data, Key.escape) || matchesKey(data, 'q')) {
      this.#mode = mode.back;
      this.#refresh();
      return;
    }
    if (moveKey(data) !== 0) mode.offset = Math.max(0, mode.offset + moveKey(data));
    else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.space)) mode.offset += page;
    else if (matchesKey(data, Key.pageUp)) mode.offset = Math.max(0, mode.offset - page);
    else if (matchesKey(data, Key.home)) mode.offset = 0;
    else if (matchesKey(data, Key.end)) mode.offset = Number.MAX_SAFE_INTEGER;
    else return;
    this.#refresh();
  }

  #openDetail(runId: string, previous?: Extract<BrowserMode, { kind: 'detail' }>): void {
    const detail: Extract<BrowserMode, { kind: 'detail' }> = {
      kind: 'detail',
      runId,
      attempt: previous?.attempt ?? -1,
      selected: previous?.selected ?? 0
    };
    this.#mode = detail;
    this.#message = undefined;
    this.#refresh();
    void this.host
      .report(runId)
      .then((report) => {
        detail.report = report;
        if (detail.attempt < 0 || detail.attempt >= report.attempts.length)
          detail.attempt = report.attempts.length - 1;
        this.#refresh();
      })
      .catch((error) => this.#notify(errorText(error), 'error'));
  }

  #resume(runId: string, status: string): void {
    if (status === 'completed') {
      this.#notify('This run already completed.', 'warning');
      return;
    }
    if (status === 'running' && this.host.isActive(runId)) {
      this.#notify('This run is already running in this session.', 'warning');
      return;
    }
    this.done({ resume: runId });
  }

  async #abort(runId: string, detail?: Extract<BrowserMode, { kind: 'detail' }>): Promise<void> {
    this.#notify(`Aborting ${runId}…`);
    try {
      const result = await this.host.abort(runId);
      this.#notify(
        result === 'aborted' ? `Aborted ${runId}.` : 'Nothing to abort: the run is not live.'
      );
      if (detail) this.#openDetail(runId, detail);
      else if (this.#mode.kind === 'list') this.#mode.runs = this.host.list();
      this.#refresh();
    } catch (error) {
      this.#notify(errorText(error), 'error');
    }
  }
}

/** One listing row: status, name, agents, age, attempts, and run id. */
export function runListLine(run: WorkflowRunIndex, now: number): string {
  const agents = `${run.agents.done}/${run.agents.total} agents${run.agents.error ? `, ${run.agents.error} failed` : ''}`;
  const attempts = run.attempts > 1 ? ` · ${run.attempts} attempts` : '';
  return `${STATUS_ICONS[run.status] ?? '?'} ${sanitize(run.name)} · ${run.status} · ${agents}${attempts} · ${formatAge(now - run.createdAt)} ago · ${run.runId}`;
}

/** Run details: header, attempt summary, agent rows (selected row starts with `>`), and the selected agent's facts. */
export function renderRunDetailLines(
  report: WorkflowRunReport,
  attemptIndex: number,
  selected: number,
  now: number
): string[] {
  const { header, agents, details } = runDetailSections(report, attemptIndex, selected, now);
  return [...header, ...agents, ...details];
}

function runDetailSections(
  report: WorkflowRunReport,
  attemptIndex: number,
  selected: number,
  now: number
): { header: string[]; agents: string[]; details: string[] } {
  const attempt = report.attempts[attemptIndex];
  const lines = [
    ` ${STATUS_ICONS[report.status] ?? '?'} ${sanitize(report.run.name)} — ${sanitize(report.run.description)}`,
    `   status ${report.status}${report.active ? ' (running here)' : ''} · ${report.attempts.length} attempt(s) · created ${formatAge(now - report.run.createdAt)} ago`,
    `   cwd ${sanitize(report.run.cwd)}`,
    `   spend ${formatTokens(report.usage.totalTokens)} tok${report.usage.cost.total ? ` · ${formatCost(report.usage.cost.total)}` : ''}`
  ];
  if (!attempt)
    return { header: [...lines, '', '   No attempts recorded.'], agents: [], details: [] };
  const rows = attemptRows(attempt);
  lines.push(
    '',
    ` Attempt ${attempt.number}/${report.attempts.length} · ${attempt.status} · ${formatDuration((attempt.endedAt ?? now) - attempt.startedAt)}${attempt.error ? ` · ${sanitize(oneLine(attempt.error))}` : ''}`
  );
  if (attempt.logs.length)
    lines.push(`   last log: ${sanitize(oneLine(attempt.logs.at(-1) ?? ''))}`);
  lines.push('');
  const agents: string[] = [];
  let phase: string | undefined;
  rows.forEach((row, index) => {
    if (row.phase !== phase) {
      phase = row.phase;
      agents.push(`  ${sanitize(row.phase ?? 'Unphased')}`);
    }
    agents.push(`${index === selected ? '>' : ' '}   ${agentDetailLine(row, now)}`);
  });
  const details: string[] = [];
  const current = rows[selected];
  if (current) {
    details.push('', ` #${current.index} ${sanitize(current.label)}`);
    if (current.model)
      details.push(
        `   model ${sanitize(current.model)}${current.thinkingLevel ? ` · thinking ${current.thinkingLevel}` : ''}`
      );
    details.push(`   prompt ${sanitize(oneLine(current.prompt)).slice(0, 400)}`);
    if (current.preview) details.push(`   result ${sanitize(oneLine(current.preview))}`);
    if (current.error) details.push(`   error ${sanitize(oneLine(current.error))}`);
    const compactionFailure =
      current.conversationId === undefined
        ? undefined
        : attempt.compactionFailures?.[current.conversationId];
    if (compactionFailure)
      details.push(`   warning: compaction failed: ${sanitize(oneLine(compactionFailure))}`);
  }
  return { header: lines, agents, details };
}

function agentDetailLine(row: WorkflowAgentRow, now: number): string {
  const facts = [
    row.reusedFrom !== undefined ? `reused from attempt ${row.reusedFrom}` : undefined,
    row.startedAt !== undefined && row.reusedFrom === undefined
      ? formatDuration((row.endedAt ?? now) - row.startedAt)
      : undefined,
    row.usage?.totalTokens ? `${formatTokens(row.usage.totalTokens)} tok` : undefined,
    row.usage?.cost?.total ? formatCost(row.usage.cost.total) : undefined,
    row.profile ? `profile ${sanitize(row.profile)}` : undefined
  ].filter(Boolean);
  const icon = row.reusedFrom !== undefined ? '↺' : (STATUS_ICONS[row.status] ?? '?');
  return `#${row.index} ${icon} ${sanitize(row.label)}${facts.length ? ` · ${facts.join(' · ')}` : ''}`;
}

/** Transcript items as wrapped, labelled lines. */
export function renderTranscriptLines(
  items: readonly WorkflowTranscriptItem[],
  width: number
): string[] {
  const inner = Math.max(20, width - 4);
  const lines: string[] = [];
  for (const item of items) {
    const label =
      item.role === 'tool-call'
        ? `→ ${item.toolName ?? 'tool'}`
        : item.role === 'tool-result'
          ? `← ${item.toolName ?? 'tool'}${item.isError ? ' (error)' : ''}`
          : item.role;
    lines.push(` ${sanitize(label)}`);
    const text = terminalMultiline(item.text);
    const limited =
      item.role === 'tool-result' && text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
    for (const paragraph of limited.split('\n')) {
      for (const line of wrapTextWithAnsi(paragraph || ' ', inner)) lines.push(`   ${line}`);
    }
    lines.push('');
  }
  return lines.length ? lines : ['   (empty transcript)'];
}

function toneFor(status: string): 'text' | 'muted' | 'warning' | 'error' {
  if (status === 'failed') return 'error';
  if (status === 'interrupted') return 'warning';
  if (status === 'running') return 'text';
  return 'muted';
}

function moveKey(data: string): number {
  if (matchesKey(data, Key.up) || matchesKey(data, 'k')) return -1;
  if (matchesKey(data, Key.down) || matchesKey(data, 'j')) return 1;
  return 0;
}

function clamp(index: number, length: number): number {
  return Math.max(0, Math.min(index, Math.max(0, length - 1)));
}

function windowStart(selected: number, length: number, height: number): number {
  return Math.max(0, Math.min(selected - Math.floor(height / 2), length - height));
}

function formatAge(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60000);
  if (minutes < 1) return 'moments';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function oneLine(text: string): string {
  return sanitize(text);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
