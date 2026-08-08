// biome-ignore lint/complexity/useRegexLiterals: control-character escapes trigger noControlCharactersInRegex as a literal.
const ANSI_PATTERN = new RegExp(
  String.raw`\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))`,
  'g'
);
// biome-ignore lint/complexity/useRegexLiterals: control-character escapes trigger noControlCharactersInRegex as a literal.
const CONTROL_PATTERN = new RegExp(String.raw`[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]`, 'g');
const BIDI_PATTERN = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

export interface SanitizeOptions {
  maxLength: number;
  allowNewlines?: boolean;
  collapseWhitespace?: boolean;
}

export const TEXT_LIMITS = {
  objective: 4000,
  summary: 4000,
  evidence: 8000,
  reason: 4000,
  rationale: 4000,
  verifierItem: 1000,
  nextAction: 2000,
  statusExcerpt: 120,
  diagnostic: 4000
} as const;

export function sanitizeText(input: unknown, options: SanitizeOptions): string {
  if (typeof input !== 'string') return '';

  let text = input.replace(ANSI_PATTERN, '').replace(BIDI_PATTERN, '').replace(CONTROL_PATTERN, '');

  if (options.allowNewlines === false) {
    text = text.replace(/[\r\n\t]+/g, ' ');
  } else {
    text = text.replace(/\r\n?/g, '\n');
  }

  if (options.collapseWhitespace) {
    text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
  }

  return truncateText(text.trim(), options.maxLength);
}

export function truncateText(input: string, maxLength: number): string {
  const chars = Array.from(input);
  if (chars.length <= maxLength) return input;
  if (maxLength <= 14) return `${chars.slice(0, Math.max(0, maxLength - 1)).join('')}…`;
  return `${chars.slice(0, maxLength - 14).join('')}… [truncated]`;
}

export function sanitizeStringArray(
  input: unknown,
  options: SanitizeOptions & { maxItems: number }
): string[] | undefined {
  if (!Array.isArray(input)) return undefined;

  const values = input
    .slice(0, options.maxItems)
    .map((item) => sanitizeText(item, options))
    .filter((item) => item.length > 0);

  return values.length > 0 ? values : undefined;
}

export function excerpt(
  input: string | undefined,
  maxLength: number = TEXT_LIMITS.statusExcerpt
): string {
  if (!input) return '(none)';
  return sanitizeText(input, { maxLength, allowNewlines: false, collapseWhitespace: true });
}
