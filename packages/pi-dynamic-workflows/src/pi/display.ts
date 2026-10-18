import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { terminalLine } from '../shared/terminal-text.js';
import type { WorkflowAgentStatus } from '../workflow/contracts.js';
import type { WorkflowAgentSnapshot, WorkflowSnapshot } from '../workflow/snapshot.js';

export interface WorkflowDisplay {
  update(snapshot: WorkflowSnapshot): void;
  complete(snapshot: WorkflowSnapshot): void;
  clear(): void;
}

export interface WorkflowDisplayOptions {
  key?: string;
  placement?: 'aboveEditor' | 'belowEditor';
  maxAgents?: number;
  maxLogs?: number;
  showStatus?: boolean;
  showResultPreviews?: boolean;
  /** Show the run id, attempt, and spend footer when the snapshot has a run id (default true). */
  showRunInfo?: boolean;
}

export function createWidgetWorkflowDisplay(
  ctx: Pick<ExtensionContext, 'ui' | 'hasUI'>,
  options: WorkflowDisplayOptions = {}
): WorkflowDisplay {
  const key = options.key ?? 'workflow';
  const placement = options.placement ?? 'belowEditor';
  const showStatus = options.showStatus ?? false;

  let lastRendered: string | undefined;
  const render = (snapshot: WorkflowSnapshot, completed = false) => {
    if (!ctx.hasUI) return;
    const status = showStatus ? statusLine(snapshot, completed) : undefined;
    const lines = renderWorkflowLines(snapshot, options);
    // Snapshots arrive on a timer; redraw only when the picture changed.
    const rendered = `${status ?? ''}\n${lines.join('\n')}`;
    if (rendered === lastRendered) return;
    lastRendered = rendered;
    if (status !== undefined) ctx.ui.setStatus(key, status);
    ctx.ui.setWidget(key, lines, { placement });
  };

  return {
    update(snapshot) {
      render(snapshot, false);
    },
    complete(snapshot) {
      render(snapshot, true);
    },
    clear() {
      if (!ctx.hasUI) return;
      lastRendered = undefined;
      if (showStatus) ctx.ui.setStatus(key, undefined);
      ctx.ui.setWidget(key, undefined);
    }
  };
}

export function createToolUpdateWorkflowDisplay(
  onUpdate:
    | ((result: { content: Array<{ type: 'text'; text: string }>; details: unknown }) => void)
    | undefined,
  ctx?: Pick<ExtensionContext, 'ui' | 'hasUI'>,
  options: WorkflowDisplayOptions & { streamToolUpdates?: boolean } = {}
): WorkflowDisplay {
  const widget = ctx ? createWidgetWorkflowDisplay(ctx, options) : undefined;
  const streamToolUpdates = options.streamToolUpdates ?? !ctx?.hasUI;

  let lastText: string | undefined;
  const emit = (snapshot: WorkflowSnapshot, completed = false) => {
    if (streamToolUpdates) {
      const text = renderWorkflowText(snapshot, completed, options);
      // Each update reaches RPC and JSON clients as an event; skip those that look identical.
      if (completed || text !== lastText) {
        lastText = text;
        onUpdate?.({ content: [{ type: 'text', text }], details: snapshot });
      }
    }
    if (completed) widget?.complete(snapshot);
    else widget?.update(snapshot);
  };

  return {
    update(snapshot) {
      emit(snapshot, false);
    },
    complete(snapshot) {
      emit(snapshot, true);
    },
    clear() {
      widget?.clear();
    }
  };
}

export function renderWorkflowLines(
  snapshot: WorkflowSnapshot,
  options: WorkflowDisplayOptions = {}
): string[] {
  const maxAgents = options.maxAgents ?? 8;
  const maxLogs = options.maxLogs ?? 2;
  const showResultPreviews = options.showResultPreviews ?? false;
  const state =
    snapshot.errorCount > 0
      ? `, ${snapshot.errorCount} errors`
      : snapshot.runningCount > 0
        ? `, ${snapshot.runningCount} running`
        : '';
  const lines = [
    `◆ Workflow: ${terminalLine(snapshot.name)} (${snapshot.doneCount}/${snapshot.agentCount} done${state})`
  ];

  const agentPhaseNames = snapshot.agents
    .map((agent) => agent.phase)
    .filter((phase): phase is string => Boolean(phase));
  const phaseNames = unique([
    ...snapshot.phases,
    ...(snapshot.currentPhase ? [snapshot.currentPhase] : []),
    ...agentPhaseNames
  ]);
  const rendered = new Set<WorkflowAgentSnapshot>();

  for (const phase of phaseNames) {
    const agents = snapshot.agents.filter((agent) => agent.phase === phase);
    if (agents.length === 0 && snapshot.currentPhase !== phase) continue;
    for (const agent of agents) rendered.add(agent);
    const done = agents.filter((agent) => agent.status === 'done').length;
    const running = agents.filter((agent) => agent.status === 'running').length;
    const errors = agents.filter((agent) => agent.status === 'error').length;
    const skipped = agents.filter((agent) => agent.status === 'skipped').length;
    const complete = agents.length > 0 && done + errors + skipped === agents.length;
    const marker =
      running > 0 || (!complete && snapshot.currentPhase === phase) ? '▶' : complete ? '✓' : ' ';
    lines.push(
      `  ${marker} ${terminalLine(phase)} ${done}/${agents.length}${running ? ` · ${running} running` : ''}${errors ? ` · ${errors} errors` : ''}${skipped ? ` · ${skipped} skipped` : ''}`
    );

    const visibleAgents = agents.slice(-maxAgents);
    for (const agent of visibleAgents) lines.push(agentLine(agent, showResultPreviews));
    if (agents.length > visibleAgents.length)
      lines.push(`    … ${agents.length - visibleAgents.length} earlier agents`);
  }

  const unphased = snapshot.agents.filter((agent) => !rendered.has(agent));
  if (unphased.length) {
    lines.push('  Unphased');
    for (const agent of unphased.slice(-maxAgents))
      lines.push(agentLine(agent, showResultPreviews));
  }

  const visibleLogs = snapshot.logs.slice(-maxLogs);
  if (visibleLogs.length) {
    if (lines.length > 1) lines.push('');
    for (const log of visibleLogs) lines.push(`  log: ${terminalLine(log)}`);
  }
  if ((options.showRunInfo ?? true) && snapshot.runId) lines.push(runInfoLine(snapshot));
  return lines;
}

function agentLine(agent: WorkflowAgentSnapshot, showResultPreviews: boolean): string {
  const result =
    showResultPreviews && agent.resultPreview ? ` — ${terminalLine(agent.resultPreview)}` : '';
  const facts = [
    agent.reusedFrom !== undefined ? `reused from attempt ${agent.reusedFrom}` : undefined,
    agent.durationMs !== undefined && agent.reusedFrom === undefined
      ? formatDuration(agent.durationMs)
      : undefined,
    agent.tokens ? `${formatTokens(agent.tokens)} tok` : undefined
  ].filter(Boolean);
  const activity =
    agent.status === 'running' && agent.activity ? ` — ${shorten(agent.activity, 48)}` : '';
  return `    #${agent.id} ${statusIcon(agent.status, agent)} ${shorten(agent.label, 48)}${profileSuffix(agent)}${facts.length ? ` · ${facts.join(' · ')}` : ''}${activity}${agent.warning ? ` · ⚠ ${shorten(agent.warning, 80)}` : ''}${result}`;
}

function runInfoLine(snapshot: WorkflowSnapshot): string {
  const parts = [`run ${terminalLine(snapshot.runId ?? '')}`];
  if (snapshot.attempt && snapshot.attempt > 1) parts.push(`attempt ${snapshot.attempt}`);
  if (snapshot.durationMs !== undefined) parts.push(formatDuration(snapshot.durationMs));
  if (snapshot.usage?.totalTokens) parts.push(`${formatTokens(snapshot.usage.totalTokens)} tok`);
  if (snapshot.usage?.cost?.total) parts.push(formatCost(snapshot.usage.cost.total));
  return `  ${parts.join(' · ')}`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(Math.round(tokens));
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

export function formatCost(cost: number): string {
  return cost >= 0.01 ? `$${cost.toFixed(2)}` : `$${cost.toFixed(4)}`;
}

export function renderWorkflowText(
  snapshot: WorkflowSnapshot,
  completed = false,
  options: WorkflowDisplayOptions = {}
): string {
  const header = !completed
    ? 'Workflow running'
    : snapshot.status && snapshot.status !== 'completed'
      ? `Workflow ${snapshot.status}`
      : 'Workflow completed';
  return [header, ...renderWorkflowLines(snapshot, options)].join('\n');
}

function statusLine(snapshot: WorkflowSnapshot, completed: boolean): string {
  const name = terminalLine(snapshot.name);
  if (completed) return `workflow ✓ ${name}: ${snapshot.doneCount}/${snapshot.agentCount}`;
  if (snapshot.runningCount > 0)
    return `workflow ${name}: ${snapshot.runningCount} running, ${snapshot.doneCount}/${snapshot.agentCount} done`;
  return `workflow ${name}: ${snapshot.doneCount}/${snapshot.agentCount} done`;
}

function profileSuffix(agent: WorkflowAgentSnapshot): string {
  return agent.profile ? ` · profile: ${shorten(agent.profile, 32)}` : '';
}

function statusIcon(status: WorkflowAgentStatus, agent?: WorkflowAgentSnapshot): string {
  if (status === 'done' && agent?.reusedFrom !== undefined) return '↺';
  switch (status) {
    case 'queued':
      return '○';
    case 'running':
      return '●';
    case 'done':
      return '✓';
    case 'error':
      return '✗';
    case 'skipped':
      return '-';
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function shorten(value: string, max: number): string {
  const text = terminalLine(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
