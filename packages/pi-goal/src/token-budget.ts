const TOKEN_BUDGET_EXAMPLES = 'Use positive values like 50k, 100k, 1M, or 10M.';

export const TOKEN_BUDGET_ENV = 'PI_GOAL_TOKEN_BUDGET';

export function parseOptionalTokenBudget(
  value: unknown,
  label = 'token budget'
): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return parseTokenBudget(value, label);
}

export function parseTokenBudget(value: unknown, label = 'token budget'): number {
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value) && value > 0) return value;
    throw invalidTokenBudget(value, label);
  }

  if (typeof value !== 'string') throw invalidTokenBudget(value, label);

  const text = value.trim();
  const match = text.match(/^(\d+)([kKmM]?)$/);
  if (!match) throw invalidTokenBudget(value, label);

  const amount = Number(match[1]);
  const suffix = match[2]?.toLowerCase();
  const multiplier = suffix === 'm' ? 1_000_000 : suffix === 'k' ? 1_000 : 1;
  const budget = amount * multiplier;

  if (!Number.isSafeInteger(budget) || budget <= 0) throw invalidTokenBudget(value, label);
  return budget;
}

function invalidTokenBudget(value: unknown, label: string): Error {
  return new Error(`Invalid ${label} ${formatBudgetValue(value)}. ${TOKEN_BUDGET_EXAMPLES}`);
}

function formatBudgetValue(value: unknown): string {
  if (value === undefined) return '<missing>';
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') {
    const chars = Array.from(value.replaceAll('\n', ' '));
    const text = chars.length > 80 ? `${chars.slice(0, 80).join('')}…` : chars.join('');
    return JSON.stringify(text);
  }
  if (Array.isArray(value)) return '<array>';
  return `<${typeof value}>`;
}
