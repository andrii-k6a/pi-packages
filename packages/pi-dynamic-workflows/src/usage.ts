import type { Usage } from '@earendil-works/pi-ai';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  };
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: finite(a.input) + finite(b.input),
    output: finite(a.output) + finite(b.output),
    cacheRead: finite(a.cacheRead) + finite(b.cacheRead),
    cacheWrite: finite(a.cacheWrite) + finite(b.cacheWrite),
    ...(a.cacheWrite1h !== undefined || b.cacheWrite1h !== undefined
      ? { cacheWrite1h: finite(a.cacheWrite1h) + finite(b.cacheWrite1h) }
      : {}),
    ...(a.reasoning !== undefined || b.reasoning !== undefined
      ? { reasoning: finite(a.reasoning) + finite(b.reasoning) }
      : {}),
    totalTokens: finite(a.totalTokens) + finite(b.totalTokens),
    cost: {
      input: finite(a.cost?.input) + finite(b.cost?.input),
      output: finite(a.cost?.output) + finite(b.cost?.output),
      cacheRead: finite(a.cost?.cacheRead) + finite(b.cost?.cacheRead),
      cacheWrite: finite(a.cost?.cacheWrite) + finite(b.cost?.cacheWrite),
      total: finite(a.cost?.total) + finite(b.cost?.total)
    }
  };
}

export function hasUsage(usage: Usage): boolean {
  return (
    finite(usage.input) > 0 ||
    finite(usage.output) > 0 ||
    finite(usage.cacheRead) > 0 ||
    finite(usage.cacheWrite) > 0 ||
    finite(usage.cacheWrite1h) > 0 ||
    finite(usage.reasoning) > 0 ||
    finite(usage.totalTokens) > 0 ||
    finite(usage.cost?.total) > 0
  );
}

/** Sum billed work from full session history, including summaries and non-message usage. */
export function sumSessionUsage(entries: readonly SessionEntry[]): Usage {
  const messages = entries
    .filter((entry) => entry.type === 'message')
    .map((entry) => entry.message);
  let sum = sumMessageUsage(messages);
  for (const entry of entries) {
    if (
      (entry.type === 'usage' || entry.type === 'compaction' || entry.type === 'branch_summary') &&
      entry.usage
    ) {
      sum = addUsage(sum, entry.usage);
    }
  }
  return sum;
}

export function sumMessageUsage(messages: readonly unknown[]): Usage {
  let sum = emptyUsage();
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const { role, usage } = message as { role?: unknown; usage?: unknown };
    if (role !== 'assistant' && role !== 'toolResult') continue;
    if (!usage || typeof usage !== 'object') continue;
    sum = addUsage(sum, usage as Usage);
  }
  return sum;
}
