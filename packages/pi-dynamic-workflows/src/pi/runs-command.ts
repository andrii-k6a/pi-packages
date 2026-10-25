import { writeFileSync } from 'node:fs';
import type { ExtensionAPI, ExtensionCommandContext, Theme } from '@earendil-works/pi-coding-agent';
import {
  type Focusable,
  Input,
  Key,
  type Keybinding,
  type KeybindingsManager,
  matchesKey,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
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
import {
  terminalLine as sanitize,
  terminalInput,
  terminalMultiline
} from '../shared/terminal-text.js';
import { formatCost, formatDuration, formatTokens } from './display.js';
import { resolveEditorCommand, viewInExternalEditor } from './external-editor.js';

/** Lines a page scroll keeps from the previous page, as in Pi's fullscreen viewport. */
const PAGE_SCROLL_OVERLAP = 4;

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
    (tui, theme, keybindings, done) =>
      new WorkflowRunsBrowser(
        tui,
        theme,
        keybindings,
        host,
        (value) => done(value),
        async (text, filename) =>
          viewInExternalEditor(tui, text, { command: resolveEditorCommand(ctx.cwd), filename }),
        runId
      ),
    // Fullscreen mode handles the user's `tui.altScreen.*` scroll keys before the focused
    // component, except while an overlay has focus. Without the overlay they never reach the view.
    { overlay: true, overlayOptions: { width: '100%', maxHeight: '100%', anchor: 'bottom-left' } }
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
      conversationId: number;
      items?: WorkflowTranscriptItem[];
      offset: number;
      /** First line of each user message in the last rendered layout. */
      prompts?: number[];
      back: Extract<BrowserMode, { kind: 'detail' }>;
      /** Present while the agent runs in this session: the transcript streams and can be steered. */
      live?: { busy: boolean; pinned: boolean; stop?: () => void };
    };

export class WorkflowRunsBrowser implements Focusable {
  #mode: BrowserMode;
  #message: { text: string; tone: 'muted' | 'warning' | 'error' } | undefined;
  #pendingDelete: string | undefined;
  #pendingCancel: number | undefined;
  #cache: { width: number; lines: string[] } | undefined;
  #editing = false;
  #compose: Input | undefined;
  #focused = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: Pick<KeybindingsManager, 'matches' | 'getKeys'>,
    private readonly host: WorkflowHost,
    private readonly done: (result: { resume?: string } | undefined) => void,
    private readonly viewInEditor: (text: string, filename: string) => Promise<void>,
    initialRunId?: string
  ) {
    this.#mode = { kind: 'list', runs: host.list(), selected: 0 };
    if (initialRunId) this.#openDetail(initialRunId);
  }

  get focused(): boolean {
    return this.#focused;
  }

  set focused(value: boolean) {
    this.#focused = value;
    if (this.#compose) this.#compose.focused = value;
  }

  handleInput(data: string): void {
    if (this.#editing) return;
    if (this.#compose) {
      this.#compose.handleInput(data);
      if (this.#compose) {
        const value = this.#compose.getValue();
        if (terminalInput(value) !== value) this.#compose.setValue(terminalInput(value));
      }
      this.#refresh();
      return;
    }
    if (!matchesKey(data, 'x')) this.#pendingCancel = undefined;
    const mode = this.#mode;
    if (mode.kind === 'list') this.#listInput(mode, data);
    else if (mode.kind === 'detail') this.#detailInput(mode, data);
    else this.#transcriptInput(mode, data);
  }

  /** Fullscreen mode delivers wheel events; regular mode leaves them to the terminal. */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const mode = this.#mode;
    if (event.type !== 'wheel' || !event.wheelDelta || mode.kind !== 'transcript' || this.#editing)
      return undefined;
    if (mode.live && event.wheelDelta < 0) mode.live.pinned = false;
    mode.offset = Math.max(0, mode.offset + event.wheelDelta);
    this.#refresh();
    return { handled: true };
  }

  render(width: number): string[] {
    if (this.#cache?.width === width) return this.#cache.lines;
    const body = this.#body(width, this.#bodyHeight());
    const lines = [
      this.theme.fg('accent', '─'.repeat(Math.max(0, width))),
      this.#title(),
      '',
      ...body,
      '',
      this.#compose
        ? ` ${this.theme.fg('accent', 'steer ▸')} ${this.#compose.render(Math.max(1, width - 10))[0]}`
        : this.#message
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

  #bodyHeight(): number {
    return Math.max(3, this.#rows() - 6);
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
          : `${mode.runId} · ${mode.title}${mode.live ? (mode.live.busy ? ' · ● live' : ' · finished') : ''}`;
    return `${this.theme.fg('accent', ` ${this.theme.bold('/workflows')}`)}${this.theme.fg('muted', ` · ${sanitize(label)}`)}`;
  }

  #help(): string {
    switch (this.#mode.kind) {
      case 'list':
        return ' ↑/↓ move • Enter inspect • r resume • a abort • d delete • g refresh • q/Esc close';
      case 'detail':
        return ' ↑/↓ agent • Enter transcript • x cancel agent • [/] attempt • r resume • a abort • g refresh • Esc back';
      default:
        return this.#transcriptHelp();
    }
  }

  /** Scroll hints show the keys the user has bound in Pi's fullscreen mode. */
  #transcriptHelp(): string {
    const pair = (first: Keybinding, second: Keybinding, label: string): string | undefined => {
      const [a] = this.keybindings.getKeys(first);
      const [b] = this.keybindings.getKeys(second);
      if (!a || !b) return a || b ? `${a ?? b} ${label}` : undefined;
      const split = a.lastIndexOf('+') + 1;
      return b.startsWith(a.slice(0, split)) && !b.slice(split).includes('+')
        ? `${a}/${b.slice(split)} ${label}`
        : `${a}/${b} ${label}`;
    };
    const live = this.#mode.kind === 'transcript' && this.#mode.live;
    // Esc first: a narrow terminal cuts the end of the line, and the way out must stay visible.
    return ` ${[
      'Esc back',
      '↑/↓ scroll',
      pair('tui.altScreen.pageUp', 'tui.altScreen.pageDown', 'page'),
      pair('tui.altScreen.top', 'tui.altScreen.bottom', 'top/bottom'),
      ...(live ? ['m steer', 'x cancel agent'] : []),
      'e editor'
    ]
      .filter(Boolean)
      .join(' • ')}`;
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
    const { lines, prompts } = transcriptLayout(mode.items, width);
    mode.prompts = prompts;
    const last = Math.max(0, lines.length - height);
    if (mode.live?.pinned) mode.offset = last;
    mode.offset = Math.max(0, Math.min(mode.offset, last));
    // Scrolling back down to the end resumes following.
    if (mode.live) mode.live.pinned = mode.offset >= last;
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
    if (matchesKey(data, 'x')) {
      const row = rows[mode.selected];
      if (row?.conversationId === undefined || row.status !== 'running') {
        this.#notify('Only a running agent can be cancelled.');
        return;
      }
      void this.#cancelAgent(mode.runId, row.conversationId, `#${row.index} ${row.label}`, () =>
        this.#openDetail(mode.runId, mode)
      );
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
        conversationId: row.conversationId,
        offset: 0,
        back: mode,
        ...(row.status === 'running' && this.host.isActive(mode.runId)
          ? { live: { busy: true, pinned: true } }
          : {})
      };
      this.#mode = transcript;
      this.#message = undefined;
      this.#refresh();
      if (transcript.live) this.#follow(transcript);
      else this.#loadTranscript(transcript);
    }
  }

  #loadTranscript(transcript: Extract<BrowserMode, { kind: 'transcript' }>): void {
    void this.host
      .transcript(transcript.runId, transcript.conversationId)
      .then((items) => {
        transcript.items = items;
        this.#refresh();
      })
      .catch((error) => this.#notify(errorText(error), 'error'));
  }

  /** Stream the transcript; if the agent can no longer be followed, show it as a snapshot. */
  #follow(transcript: Extract<BrowserMode, { kind: 'transcript' }>): void {
    void this.host
      .follow(transcript.runId, transcript.conversationId, ({ items, busy }) => {
        transcript.items = items;
        if (transcript.live) transcript.live.busy = busy;
        this.#refresh();
      })
      .then((stop) => {
        if (this.#mode === transcript && transcript.live) transcript.live.stop = stop;
        else stop();
      })
      .catch(() => {
        delete transcript.live;
        this.#loadTranscript(transcript);
      });
  }

  #transcriptInput(mode: Extract<BrowserMode, { kind: 'transcript' }>, data: string): void {
    this.#message = undefined;
    if (matchesKey(data, Key.escape) || matchesKey(data, 'q')) {
      mode.live?.stop?.();
      this.#mode = mode.back;
      this.#refresh();
      return;
    }
    if (matchesKey(data, 'm')) {
      this.#startCompose(mode);
      return;
    }
    if (matchesKey(data, 'x')) {
      if (!mode.live?.busy) {
        this.#notify('Only a running agent can be cancelled.');
        return;
      }
      void this.#cancelAgent(mode.runId, mode.conversationId, mode.title);
      return;
    }
    if (matchesKey(data, 'e')) {
      void this.#openInEditor(mode);
      return;
    }
    const scroll = this.#scrollRequest(data);
    if (scroll === undefined) return;
    if (scroll === 'bottom') {
      mode.offset = Number.MAX_SAFE_INTEGER;
      if (mode.live) mode.live.pinned = true;
    } else if (scroll === 'top') {
      mode.offset = 0;
      if (mode.live) mode.live.pinned = false;
    } else if (scroll.prompt) {
      // Like Pi: move to the nearest user message above or below the first visible line.
      const rows = mode.prompts ?? [];
      const row =
        scroll.prompt < 0
          ? rows.filter((candidate) => candidate < mode.offset).at(-1)
          : rows.find((candidate) => candidate > mode.offset);
      if (row === undefined) return;
      mode.offset = row;
      if (mode.live && scroll.prompt < 0) mode.live.pinned = false;
    } else {
      mode.offset = Math.max(0, mode.offset + scroll.lines);
      if (mode.live && scroll.lines < 0) mode.live.pinned = false;
    }
    this.#refresh();
  }

  /** The scroll the user's Pi fullscreen bindings (and the arrow keys) ask for. */
  #scrollRequest(
    data: string
  ):
    | { lines: number; prompt?: never }
    | { prompt: -1 | 1; lines?: never }
    | 'top'
    | 'bottom'
    | undefined {
    const keys = this.keybindings;
    const height = this.#bodyHeight();
    const page = Math.max(1, height - PAGE_SCROLL_OVERLAP);
    const half = Math.max(1, Math.floor(height / 2));
    if (keys.matches(data, 'tui.altScreen.top')) return 'top';
    if (keys.matches(data, 'tui.altScreen.bottom')) return 'bottom';
    if (keys.matches(data, 'tui.altScreen.previousPrompt')) return { prompt: -1 };
    if (keys.matches(data, 'tui.altScreen.nextPrompt')) return { prompt: 1 };
    if (keys.matches(data, 'tui.altScreen.pageUp')) return { lines: -page };
    if (keys.matches(data, 'tui.altScreen.pageDown') || matchesKey(data, Key.space))
      return { lines: page };
    if (keys.matches(data, 'tui.altScreen.halfPageUp')) return { lines: -half };
    if (keys.matches(data, 'tui.altScreen.halfPageDown')) return { lines: half };
    if (keys.matches(data, 'tui.altScreen.lineUp')) return { lines: -1 };
    if (keys.matches(data, 'tui.altScreen.lineDown')) return { lines: 1 };
    if (moveKey(data) !== 0) return { lines: moveKey(data) };
    return undefined;
  }

  #startCompose(mode: Extract<BrowserMode, { kind: 'transcript' }>): void {
    if (!mode.live) {
      this.#notify('Only an agent running in this session can be steered.');
      return;
    }
    if (!mode.live.busy) {
      this.#notify('This agent is not working right now.');
      return;
    }
    const input = new Input();
    input.focused = this.#focused;
    input.onSubmit = (value) => {
      this.#compose = undefined;
      const text = terminalInput(value).trim();
      if (text) void this.#steer(mode, text);
    };
    input.onEscape = () => {
      this.#compose = undefined;
    };
    this.#compose = input;
    this.#refresh();
  }

  async #steer(mode: Extract<BrowserMode, { kind: 'transcript' }>, text: string): Promise<void> {
    try {
      await this.host.steer(mode.runId, mode.conversationId, text);
      this.#notify('Sent. The agent reads it after its current tool round.');
    } catch (error) {
      this.#notify(errorText(error), 'error');
    }
  }

  /** The first call asks for confirmation, like delete; the second cancels. */
  async #cancelAgent(
    runId: string,
    conversationId: number,
    label: string,
    afterwards?: () => void
  ): Promise<void> {
    if (this.#pendingCancel !== conversationId) {
      this.#pendingCancel = conversationId;
      this.#notify(
        `Press x again to cancel ${label}. Its agent() call fails; the run continues.`,
        'warning'
      );
      return;
    }
    this.#pendingCancel = undefined;
    try {
      await this.host.cancelAgent(runId, conversationId);
      afterwards?.();
      this.#notify(`Cancelled ${label}.`);
    } catch (error) {
      this.#notify(errorText(error), 'error');
    }
  }

  /** The whole transcript, unwrapped and untruncated, in the user's editor. */
  async #openInEditor(mode: Extract<BrowserMode, { kind: 'transcript' }>): Promise<void> {
    if (!mode.items) {
      this.#notify('The transcript is still loading.');
      return;
    }
    this.#editing = true;
    try {
      await this.viewInEditor(
        renderTranscriptText(`${mode.runId} · ${mode.title}`, mode.items),
        `${mode.runId}-transcript.md`
      );
      this.#message = undefined;
      this.#refresh();
    } catch (error) {
      this.#notify(`Could not open the editor: ${errorText(error)}`, 'error');
    } finally {
      this.#editing = false;
    }
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
  return transcriptLayout(items, width).lines;
}

/** The wrapped lines, and the first line of each user message. */
function transcriptLayout(
  items: readonly WorkflowTranscriptItem[],
  width: number
): { lines: string[]; prompts: number[] } {
  const inner = Math.max(20, width - 4);
  const lines: string[] = [];
  const prompts: number[] = [];
  for (const item of items) {
    if (item.role === 'user') prompts.push(lines.length);
    lines.push(` ${itemLabel(item)}`);
    const text = terminalMultiline(item.text);
    const limited =
      item.role === 'tool-result' && text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
    for (const paragraph of limited.split('\n')) {
      for (const line of wrapTextWithAnsi(paragraph || ' ', inner)) lines.push(`   ${line}`);
    }
    lines.push('');
  }
  return { lines: lines.length ? lines : ['   (empty transcript)'], prompts };
}

/** The transcript as Markdown for an editor: a `## n. label` heading per item, text in full. */
export function renderTranscriptText(
  title: string,
  items: readonly WorkflowTranscriptItem[]
): string {
  const sections = items.map(
    (item, index) => `## ${index + 1}. ${itemLabel(item)}\n\n${terminalMultiline(item.text)}\n`
  );
  return `# ${sanitize(title)}\n\n${sections.length ? sections.join('\n') : '(empty transcript)\n'}`;
}

function itemLabel(item: WorkflowTranscriptItem): string {
  const label =
    item.role === 'tool-call'
      ? `→ ${item.toolName ?? 'tool'}`
      : item.role === 'tool-result'
        ? `← ${item.toolName ?? 'tool'}${item.running ? ' (running)' : ''}${item.isError ? ' (error)' : ''}`
        : item.role;
  return sanitize(label);
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
