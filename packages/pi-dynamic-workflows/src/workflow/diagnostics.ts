import { terminalLine } from '../shared/terminal-text.js';
import type { WorkflowFailureKind } from './contracts.js';
import type { WorkflowSnapshot } from './snapshot.js';

/** Error summaries are public UI/model text, not a dump of provider response metadata. */
export function diagnosticText(value: string, max = 300): string {
  const safe = terminalLine(
    value
      .replace(
        /(authorization|proxy-authorization|set-cookie|cookie)\s*["']?\s*[:=][^\r\n]*/gi,
        '$1: [redacted]'
      )
      .replace(
        /(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|account[_ -]?id|organization[_ -]?id|tenant[_ -]?id)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi,
        '$1[redacted]'
      )
      .replace(/\bBearer\s+[^\s,;"'}]+/gi, 'Bearer [redacted]')
      .replace(/https?:\/\/[^\s]+/gi, '[provider URL redacted]')
      .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[account redacted]')
  );
  return safe.length > max ? `${safe.slice(0, max - 1)}…` : safe;
}

export function classifyWorkflowFailure(error: unknown): WorkflowFailureKind {
  if (error && typeof error === 'object') {
    const value = error as Record<string, unknown>;
    const code = value.code ?? value.type;
    if (['budget_exceeded', 'insufficient_quota', 'quota_exceeded'].includes(String(code)))
      return 'quota';
    if (
      ['authentication_error', 'invalid_api_key', 'token_expired'].includes(String(code)) ||
      value.status === 401
    )
      return 'authentication';
    for (const key of ['error', 'cause', 'detail']) {
      if (value[key] && value[key] !== error) {
        const kind = classifyWorkflowFailure(value[key]);
        if (kind !== 'unknown') return kind;
      }
    }
    return classifyWorkflowFailure(value.message ?? '');
  }
  const text = String(error ?? '');
  if (/workflow token budget exhausted/i.test(text)) return 'unknown';
  if (
    /budget_exceeded|insufficient_quota|quota[_ ]exceeded|(?:budget|quota|credits?)[^\n]{0,50}(?:exhausted|depleted)|premium.model budget|exceeded[^\n]{0,30}(?:budget|quota)/i.test(
      text
    )
  )
    return 'quota';
  if (
    /OAuth refresh failed|SSO cookies expired|(?:authentication|access token|refresh token|API key)[^\n]{0,40}(?:expired|invalid|failed)|invalid[_ ]api[_ ]key|\b401\b/i.test(
      text
    )
  )
    return 'authentication';
  if (
    /invalid review|unusable output|without calling structured_output|structured.output.*(?:invalid|limit|failed)/i.test(
      text
    )
  )
    return 'invalid-output';
  if (/\b(?:aborted|cancelled|canceled)\b/i.test(text)) return 'cancellation';
  if (/\b(?:429|502|503|504)\b|rate.limit|temporarily unavailable|ECONNRESET|ETIMEDOUT/i.test(text))
    return 'transient';
  return 'unknown';
}

/** Shared by tool errors/status, live progress, the inspector, and background notices. */
export function workflowFailureSummary(snapshot: WorkflowSnapshot, error?: string): string[] {
  const failed = snapshot.agents.filter(
    (agent) => agent.status === 'error' || agent.status === 'skipped'
  );
  const groups = new Map<
    string,
    { kind: WorkflowFailureKind; cause: string; phase: string; route: string; agents: string[] }
  >();
  for (const agent of failed) {
    const kind = agent.failureKind ?? classifyWorkflowFailure(agent.error);
    const cause = diagnosticText(
      agent.error ?? (agent.status === 'skipped' ? 'cancelled' : 'Unknown error')
    );
    const route = [
      agent.profile ? `profile ${diagnosticText(agent.profile, 80)}` : '',
      diagnosticText(agent.model ?? 'route unknown', 120)
    ]
      .filter(Boolean)
      .join(', ');
    const phase = agent.phase ? diagnosticText(agent.phase, 80) : 'Unphased';
    const key = JSON.stringify([kind, cause, phase, route]);
    const group = groups.get(key) ?? { kind, cause, phase, route, agents: [] };
    group.agents.push(diagnosticText(agent.label, 80));
    groups.set(key, group);
  }
  const lines: string[] = [];
  let shown = 0;
  for (const group of groups.values()) {
    if (shown++ === 6) {
      lines.push(
        `${groups.size - 6} more failure group(s). Inspect individual agents with /workflows ${snapshot.runId}.`
      );
      break;
    }
    lines.push(
      `${group.phase}: ${group.agents.slice(0, 6).join(', ')}${group.agents.length > 6 ? ` (+${group.agents.length - 6})` : ''} [${group.route}] ${group.kind}: ${group.cause}`
    );
  }
  if (error) lines.unshift(diagnosticText(error));
  if (!groups.size && snapshot.currentPhase)
    lines.push(`Stage: ${diagnosticText(snapshot.currentPhase, 80)}.`);
  lines.push(
    `${snapshot.doneCount} completed reusable agent result(s) saved${snapshot.agents.some((agent) => agent.reusedFrom !== undefined) ? ' (including earlier attempts)' : ''}.`
  );
  const kinds = new Set([...groups.values()].map((group) => group.kind));
  if (groups.size === 0 && error) kinds.add(classifyWorkflowFailure(error));
  if (kinds.has('authentication'))
    lines.push(
      'Sign in to the affected provider with Pi /login before resuming. Credentials can expire during work.'
    );
  if (kinds.has('quota'))
    lines.push(
      'Provider quota is exhausted. Wait for quota to reset, or explicitly choose an approved resumeProfile for unfinished work.'
    );
  if (kinds.has('transient'))
    lines.push(
      'A transient provider failure was reported. Retry when the provider is available. HTTP 429 alone does not establish exhausted quota.'
    );
  if (kinds.has('invalid-output'))
    lines.push(
      'Review output was invalid. Inspect structured_output errors in the agent transcript before choosing recovery.'
    );
  if (kinds.has('unknown'))
    lines.push('The cause is not classified. Inspect the reported error before choosing recovery.');
  if (snapshot.runId)
    lines.push(
      `Same-profile resume: { "resume": "${snapshot.runId}" }. Explicit recovery: { "resume": "${snapshot.runId}", "resumeProfile": "<approved-profile>" }. Completed calls are reused. Recorded input is not recaptured.`
    );
  return lines;
}
