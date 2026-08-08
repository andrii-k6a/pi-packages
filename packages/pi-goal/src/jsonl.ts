import type { Message, Usage } from '@earendil-works/pi-ai';
import { parseVerificationReportText } from './claims.js';
import { sanitizeText, TEXT_LIMITS } from './sanitize.js';
import type { VerificationReport } from './state.js';

const MAX_STDOUT_CHARS = 200_000;
const MAX_ASSISTANT_MESSAGES = 20;
const MAX_ASSISTANT_TEXT_CHARS = 40_000;
const MAX_DIAGNOSTICS = 20;
const MAX_MODEL_PAYLOAD_TEXT_CHARS = 120_000;
const MAX_MODEL_PAYLOAD_DEPTH = 24;
const MAX_MODEL_PAYLOAD_NODES = 20_000;

export interface AssistantSummary {
  text: string;
  provider?: string;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  usageTokens: number;
  usageEstimated: boolean;
}

export interface JsonlCollectorResult {
  assistantMessages: AssistantSummary[];
  diagnostics: string[];
  usageTokens: number;
  usageEstimated: boolean;
}

export interface UsageTokenAccounting {
  tokens: number;
  estimated: boolean;
}

export interface FinalReportParseOptions {
  exitCode: number;
  stderr?: string;
  requestedProvider?: string;
  requestedModel?: string;
  createdAt: string;
  invalidated?: boolean;
}

export type FinalReportResult =
  | { ok: true; report: VerificationReport; usageTokens: number; diagnostics: string[] }
  | {
      ok: false;
      reason: string;
      usageTokens: number;
      diagnostics: string[];
      invalidated?: boolean;
    };

export class PiJsonlCollector {
  #buffer = '';
  #assistantMessages: AssistantSummary[] = [];
  #diagnostics: string[] = [];
  #usageTokens = 0;
  #usageEstimated = false;
  #stdoutChars = 0;
  #stdoutTruncated = false;

  write(chunk: string | Buffer): void {
    if (this.#stdoutTruncated) return;
    let text = chunk.toString();
    this.#stdoutChars += text.length;
    if (this.#stdoutChars > MAX_STDOUT_CHARS) {
      const keep = Math.max(0, text.length - (this.#stdoutChars - MAX_STDOUT_CHARS));
      text = text.slice(0, keep);
      this.#stdoutTruncated = true;
      this.#pushDiagnostic('stdout exceeded verifier output cap; remaining output ignored');
    }
    this.#buffer += text;
    const lines = this.#buffer.split('\n');
    this.#buffer = lines.pop() ?? '';
    for (const line of lines) this.#processLine(line);
  }

  finish(): JsonlCollectorResult {
    if (this.#buffer.trim()) this.#processLine(this.#buffer);
    this.#buffer = '';
    return {
      assistantMessages: [...this.#assistantMessages],
      diagnostics: [...this.#diagnostics],
      usageTokens: this.#usageTokens,
      usageEstimated: this.#usageEstimated
    };
  }

  #processLine(line: string): void {
    if (!line.trim()) return;
    let event: unknown;
    try {
      event = JSON.parse(line) as unknown;
    } catch {
      this.#pushDiagnostic(`non-json stdout: ${line}`);
      return;
    }

    if (!event || typeof event !== 'object') return;
    const record = event as Record<string, unknown>;
    if (record.type !== 'message_end' || !record.message || typeof record.message !== 'object')
      return;

    const message = record.message as Partial<Message> & Record<string, unknown>;
    if (message.role !== 'assistant') return;

    const text = sanitizeText(assistantText(message), {
      maxLength: MAX_ASSISTANT_TEXT_CHARS,
      allowNewlines: true,
      collapseWhitespace: false
    });
    const usage = assistantUsageToTokens(message.usage as Usage | undefined, text);
    this.#usageTokens += usage.tokens;
    this.#usageEstimated = this.#usageEstimated || usage.estimated;
    this.#assistantMessages.push({
      text,
      provider: typeof message.provider === 'string' ? message.provider : undefined,
      model: typeof message.model === 'string' ? message.model : undefined,
      stopReason: typeof message.stopReason === 'string' ? message.stopReason : undefined,
      errorMessage: typeof message.errorMessage === 'string' ? message.errorMessage : undefined,
      usageTokens: usage.tokens,
      usageEstimated: usage.estimated
    });
    if (this.#assistantMessages.length > MAX_ASSISTANT_MESSAGES) {
      this.#assistantMessages.splice(0, this.#assistantMessages.length - MAX_ASSISTANT_MESSAGES);
      this.#pushDiagnostic(
        'assistant message history exceeded cap; older verifier messages omitted'
      );
    }
  }

  #pushDiagnostic(text: string): void {
    if (this.#diagnostics.length >= MAX_DIAGNOSTICS) return;
    this.#diagnostics.push(boundedDiagnostic(text));
  }
}

export function parseFinalVerifierReport(
  collected: JsonlCollectorResult,
  options: FinalReportParseOptions
): FinalReportResult {
  const diagnostics = [...collected.diagnostics];
  const stderr = sanitizeText(options.stderr, {
    maxLength: TEXT_LIMITS.diagnostic,
    allowNewlines: true,
    collapseWhitespace: false
  });
  if (stderr) diagnostics.push(`stderr: ${stderr}`);

  if (options.invalidated) {
    return {
      ok: false,
      reason: 'invalidated',
      usageTokens: collected.usageTokens,
      diagnostics,
      invalidated: true
    };
  }

  if (options.exitCode !== 0) {
    return {
      ok: false,
      reason: `verifier exited with code ${options.exitCode}`,
      usageTokens: collected.usageTokens,
      diagnostics
    };
  }

  const final = collected.assistantMessages.at(-1);
  if (!final) {
    return {
      ok: false,
      reason: 'verifier produced no assistant message',
      usageTokens: 0,
      diagnostics
    };
  }

  if (
    final.stopReason === 'length' ||
    final.stopReason === 'error' ||
    final.stopReason === 'aborted'
  ) {
    return {
      ok: false,
      reason: `verifier stopped with ${final.stopReason}`,
      usageTokens: collected.usageTokens,
      diagnostics
    };
  }

  if (options.requestedProvider && final.provider && final.provider !== options.requestedProvider) {
    return {
      ok: false,
      reason: `verifier provider mismatch: requested ${options.requestedProvider}, got ${final.provider}`,
      usageTokens: collected.usageTokens,
      diagnostics
    };
  }

  if (options.requestedModel && final.model && final.model !== options.requestedModel) {
    return {
      ok: false,
      reason: `verifier model mismatch: requested ${options.requestedModel}, got ${final.model}`,
      usageTokens: collected.usageTokens,
      diagnostics
    };
  }

  try {
    return {
      ok: true,
      report: parseVerificationReportText(final.text, options.createdAt),
      usageTokens: collected.usageTokens,
      diagnostics
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      usageTokens: collected.usageTokens,
      diagnostics
    };
  }
}

export function assistantText(message: Partial<Message> & Record<string, unknown>): string {
  if (!Array.isArray(message.content)) return '';
  return message.content
    .flatMap((part): string[] => {
      if (!part || typeof part !== 'object') return [];
      const record = part as unknown as Record<string, unknown>;
      return record.type === 'text' && typeof record.text === 'string' ? [record.text] : [];
    })
    .join('\n');
}

export function assistantUsageToTokens(
  usage: Usage | undefined,
  fallbackText?: string
): UsageTokenAccounting {
  const metadataTokens = usageMetadataToTokens(usage);
  if (metadataTokens !== undefined) return { tokens: metadataTokens, estimated: false };
  return { tokens: estimateTokensFromText(fallbackText ?? ''), estimated: true };
}

export function usageToTokens(usage: Usage | undefined, fallbackText?: string): number {
  return assistantUsageToTokens(usage, fallbackText).tokens;
}

export function usageMetadataToTokens(usage: Usage | undefined): number | undefined {
  if (!usage) return undefined;
  if (typeof usage.totalTokens === 'number' && Number.isFinite(usage.totalTokens)) {
    const totalTokens = Math.max(0, Math.ceil(usage.totalTokens));
    if (totalTokens > 0) return totalTokens;
  }
  const input = finiteTokenCount(usage.input);
  const output = finiteTokenCount(usage.output);
  const cacheRead = finiteTokenCount(usage.cacheRead);
  const cacheWrite = finiteTokenCount(usage.cacheWrite);
  const total = Math.max(0, Math.ceil(input + output + cacheRead + cacheWrite));
  return total > 0 ? total : undefined;
}

export function estimateTokensFromModelPayload(payload: unknown): number {
  const state: PayloadTextState = {
    chars: 0,
    nodes: 0,
    parts: [],
    seen: new WeakSet<object>()
  };
  collectPayloadText(payload, state, 0);
  return estimateTokensFromText(state.parts.join('\n'));
}

export function estimateTokensFromText(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 3));
}

interface PayloadTextState {
  chars: number;
  nodes: number;
  parts: string[];
  seen: WeakSet<object>;
}

function finiteTokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function collectPayloadText(value: unknown, state: PayloadTextState, depth: number): void {
  if (
    state.chars >= MAX_MODEL_PAYLOAD_TEXT_CHARS ||
    state.nodes >= MAX_MODEL_PAYLOAD_NODES ||
    depth > MAX_MODEL_PAYLOAD_DEPTH
  ) {
    return;
  }

  state.nodes += 1;
  if (typeof value === 'string') {
    appendPayloadText(value, state);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (state.seen.has(value)) return;
  state.seen.add(value);

  const children = Array.isArray(value) ? value : Object.values(value);
  for (const child of children) {
    collectPayloadText(child, state, depth + 1);
    if (state.chars >= MAX_MODEL_PAYLOAD_TEXT_CHARS || state.nodes >= MAX_MODEL_PAYLOAD_NODES) {
      return;
    }
  }
}

function appendPayloadText(text: string, state: PayloadTextState): void {
  if (!text) return;
  const remaining = MAX_MODEL_PAYLOAD_TEXT_CHARS - state.chars;
  if (remaining <= 0) return;
  const bounded = text.slice(0, remaining);
  state.parts.push(bounded);
  state.chars += bounded.length;
}

function boundedDiagnostic(text: string): string {
  return sanitizeText(text, {
    maxLength: TEXT_LIMITS.diagnostic,
    allowNewlines: false,
    collapseWhitespace: true
  });
}
