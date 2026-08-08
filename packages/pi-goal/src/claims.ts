import { StringEnum } from '@earendil-works/pi-ai';
import { type Static, Type } from 'typebox';
import { sanitizeStringArray, sanitizeText, TEXT_LIMITS } from './sanitize.js';
import type { CheckEvidence, GoalState, VerificationReport } from './state.js';

export const GOAL_TOOL_NAMES = ['pi_goal_claim_done', 'pi_goal_blocked'] as const;
export const TERMINAL_GOAL_TOOL_NAMES = new Set<string>(GOAL_TOOL_NAMES);

export const ClaimDoneParams = Type.Object(
  {
    goal_id: Type.String({ minLength: 1, maxLength: 128 }),
    generation: Type.Integer({ minimum: 0 }),
    summary: Type.String({ minLength: 1, maxLength: 4000 }),
    evidence: Type.String({ minLength: 1, maxLength: 8000 }),
    changed_files: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 50 })
    ),
    checks: Type.Optional(
      Type.Array(
        Type.Object(
          {
            command: Type.String({ minLength: 1, maxLength: 1000 }),
            exit_code: Type.Optional(Type.Integer()),
            output_excerpt: Type.Optional(Type.String({ maxLength: 2000 }))
          },
          { additionalProperties: false }
        ),
        { maxItems: 20 }
      )
    )
  },
  { additionalProperties: false }
);

export const BlockedParams = Type.Object(
  {
    goal_id: Type.String({ minLength: 1, maxLength: 128 }),
    generation: Type.Integer({ minimum: 0 }),
    reason: Type.String({ minLength: 1, maxLength: 4000 }),
    evidence: Type.Optional(Type.String({ maxLength: 8000 }))
  },
  { additionalProperties: false }
);

export const VerificationReportParams = Type.Object(
  {
    goal_id: Type.String({ minLength: 1, maxLength: 128 }),
    generation: Type.Integer({ minimum: 0 }),
    claim_id: Type.String({ minLength: 1, maxLength: 128 }),
    verifier_attempt_id: Type.String({ minLength: 1, maxLength: 128 }),
    verdict: StringEnum(['pass', 'fail', 'uncertain'] as const),
    rationale: Type.String({ minLength: 1, maxLength: 4000 }),
    evidence_reviewed: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), {
      maxItems: 20
    }),
    missing_evidence: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 20 })
    ),
    risks: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 20 })
    ),
    next_action: Type.Optional(Type.String({ maxLength: 2000 }))
  },
  { additionalProperties: false }
);

export type ClaimDoneInput = Static<typeof ClaimDoneParams>;
export type BlockedInput = Static<typeof BlockedParams>;
export type VerificationReportInput = Static<typeof VerificationReportParams>;

export function assertCurrentGoalInput(
  state: GoalState | undefined,
  input: { goal_id?: unknown; generation?: unknown }
): asserts state is GoalState {
  const error = describeGoalIdentityError(state, input);
  if (error) throw new Error(error);
}

export function isCurrentTerminalInput(
  state: GoalState | undefined,
  toolName: string,
  input: Record<string, unknown>
): boolean {
  return describeTerminalGoalInputError(state, toolName, input) === undefined;
}

export function describeTerminalGoalInputError(
  state: GoalState | undefined,
  toolName: string,
  input: Record<string, unknown>
): string | undefined {
  const identityError = describeGoalIdentityError(state, input);
  if (identityError) return identityError;

  if (toolName === 'pi_goal_claim_done') {
    const missing: string[] = [];
    if (
      sanitizeText(input.summary, {
        maxLength: TEXT_LIMITS.summary,
        allowNewlines: true,
        collapseWhitespace: true
      }).length === 0
    ) {
      missing.push('summary');
    }
    if (
      sanitizeText(input.evidence, {
        maxLength: TEXT_LIMITS.evidence,
        allowNewlines: true,
        collapseWhitespace: false
      }).length === 0
    ) {
      missing.push('evidence');
    }
    if (missing.length > 0) {
      return `Invalid pi_goal_claim_done input: ${missing.join(' and ')} ${
        missing.length === 1 ? 'is' : 'are'
      } required after sanitization. ${describeGoalInputContext(state, input)}`;
    }
    return undefined;
  }

  if (toolName === 'pi_goal_blocked') {
    if (
      sanitizeText(input.reason, {
        maxLength: TEXT_LIMITS.reason,
        allowNewlines: true,
        collapseWhitespace: true
      }).length === 0
    ) {
      return `Invalid pi_goal_blocked input: reason is required after sanitization. ${describeGoalInputContext(
        state,
        input
      )}`;
    }
    return undefined;
  }

  return `Unsupported terminal goal tool: ${formatDiagnosticValue(toolName)}. ${describeGoalInputContext(
    state,
    input
  )}`;
}

function describeGoalIdentityError(
  state: GoalState | undefined,
  input: { goal_id?: unknown; generation?: unknown }
): string | undefined {
  if (!state) return `No current goal. ${describeGoalInputContext(state, input)}`;
  if (state.status !== 'active') {
    return `Current goal status is ${state.status}; terminal goal tools require active. ${describeGoalInputContext(
      state,
      input
    )}`;
  }
  if (input.goal_id !== state.id || input.generation !== state.generation) {
    return `Stale goal id or generation. ${describeGoalInputContext(state, input)}`;
  }
  return undefined;
}

function describeGoalInputContext(
  state: GoalState | undefined,
  input: { goal_id?: unknown; generation?: unknown }
): string {
  const provided = `provided goal_id=${formatDiagnosticValue(
    input.goal_id
  )}, generation=${formatDiagnosticValue(input.generation)}`;
  if (!state) return `Current goal status=none; ${provided}.`;

  return `Current goal status=${state.status}; expected goal_id=${formatDiagnosticValue(
    state.id
  )}, generation=${state.generation}; ${provided}.`;
}

function formatDiagnosticValue(value: unknown): string {
  if (value === undefined) return '<missing>';
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') {
    const chars = Array.from(value.replaceAll('\n', ' '));
    const text = chars.length > 64 ? `${chars.slice(0, 64).join('')}…` : chars.join('');
    return JSON.stringify(text);
  }
  if (Array.isArray(value)) return '<array>';
  return `<${typeof value}>`;
}

export function parseVerificationReportText(text: string, createdAt: string): VerificationReport {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    throw new Error('Verifier final output must be exactly one JSON object.');
  }
  if (trimmed.startsWith('```') || trimmed.endsWith('```')) {
    throw new Error('Verifier final output must not use Markdown fences.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Verifier final output is not valid JSON: ${message}`);
  }

  return parseVerificationReportObject(parsed, createdAt);
}

export function parseVerificationReportObject(
  value: unknown,
  createdAt: string
): VerificationReport {
  assertPlainObject(value, 'Verifier report must be a JSON object.');
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    'goal_id',
    'generation',
    'claim_id',
    'verifier_attempt_id',
    'verdict',
    'rationale',
    'evidence_reviewed',
    'missing_evidence',
    'risks',
    'next_action'
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new Error(`Verifier report contains unsupported field: ${key}`);
  }

  const verdict = record.verdict;
  if (verdict !== 'pass' && verdict !== 'fail' && verdict !== 'uncertain') {
    throw new Error('Verifier report verdict must be pass, fail, or uncertain.');
  }

  const report: VerificationReport = {
    goal_id: boundedRequiredString(record.goal_id, 'goal_id', 128),
    generation: boundedInteger(record.generation, 'generation', 0),
    claim_id: boundedRequiredString(record.claim_id, 'claim_id', 128),
    verifier_attempt_id: boundedRequiredString(
      record.verifier_attempt_id,
      'verifier_attempt_id',
      128
    ),
    verdict,
    rationale: boundedRequiredString(record.rationale, 'rationale', TEXT_LIMITS.rationale),
    evidence_reviewed: boundedRequiredStringArray(
      record.evidence_reviewed,
      'evidence_reviewed',
      20
    ),
    missing_evidence: boundedOptionalStringArray(record.missing_evidence, 20),
    risks: boundedOptionalStringArray(record.risks, 20),
    next_action: boundedOptionalString(record.next_action, TEXT_LIMITS.nextAction),
    createdAt
  };

  return report;
}

export function sanitizeChangedFiles(input: unknown): string[] | undefined {
  return sanitizeStringArray(input, {
    maxItems: 50,
    maxLength: 1000,
    allowNewlines: false,
    collapseWhitespace: true
  });
}

export function sanitizeCheckEvidence(input: unknown): CheckEvidence[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const checks = input.slice(0, 20).flatMap((item): CheckEvidence[] => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const command = sanitizeText(record.command, {
      maxLength: 1000,
      allowNewlines: false,
      collapseWhitespace: true
    });
    if (!command) return [];
    const check: CheckEvidence = { command };
    if (typeof record.exit_code === 'number' && Number.isInteger(record.exit_code)) {
      check.exit_code = record.exit_code;
    }
    const output = sanitizeText(record.output_excerpt, {
      maxLength: 2000,
      allowNewlines: true,
      collapseWhitespace: false
    });
    if (output) check.output_excerpt = output;
    return [check];
  });
  return checks.length > 0 ? checks : undefined;
}

function boundedRequiredString(value: unknown, name: string, maxLength: number): string {
  assertRawString(value, name, maxLength);
  const text = sanitizeText(value, {
    maxLength,
    allowNewlines: true,
    collapseWhitespace: true
  });
  if (!text) throw new Error(`Verifier report ${name} is required.`);
  return text;
}

function boundedOptionalString(value: unknown, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  assertRawString(value, 'optional string field', maxLength);
  const text = sanitizeText(value, {
    maxLength,
    allowNewlines: true,
    collapseWhitespace: true
  });
  return text || undefined;
}

function boundedInteger(value: unknown, name: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
    throw new Error(`Verifier report ${name} must be an integer >= ${minimum}.`);
  }
  return value;
}

function boundedRequiredStringArray(value: unknown, name: string, maxItems: number): string[] {
  const items = boundedOptionalStringArray(value, maxItems);
  if (!items || items.length === 0) {
    throw new Error(`Verifier report ${name} must be a non-empty array.`);
  }
  return items;
}

function boundedOptionalStringArray(value: unknown, maxItems: number): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('Verifier report array field must be an array.');
  if (value.length > maxItems) {
    throw new Error(`Verifier report array field must contain at most ${maxItems} items.`);
  }
  const items = value.map((item) => {
    assertRawString(item, 'array item', TEXT_LIMITS.verifierItem);
    return sanitizeText(item, {
      maxLength: TEXT_LIMITS.verifierItem,
      allowNewlines: false,
      collapseWhitespace: true
    });
  });
  if (items.some((item) => item.length === 0)) {
    throw new Error('Verifier report array items must be non-empty strings.');
  }
  return items.length > 0 ? items : undefined;
}

function assertRawString(value: unknown, name: string, maxLength: number): asserts value is string {
  if (typeof value !== 'string') throw new Error(`Verifier report ${name} must be a string.`);
  if (Array.from(value).length > maxLength) {
    throw new Error(`Verifier report ${name} must be at most ${maxLength} characters.`);
  }
}

function assertPlainObject(
  value: unknown,
  message: string
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
}
