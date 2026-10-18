import type { Usage } from '@earendil-works/pi-ai';

/** Shape shared by pi-ai `Usage` and its strict-JSON document representation. */
type UsageLike = {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  cacheWrite1h?: unknown;
  reasoning?: unknown;
  totalTokens?: unknown;
  cost?: {
    input?: unknown;
    output?: unknown;
    cacheRead?: unknown;
    cacheWrite?: unknown;
    total?: unknown;
  } | null;
};

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

export function addUsage(a: UsageLike, b: UsageLike): Usage {
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

/** `a - b` per counter, floored at zero: the part of `a` not yet covered by `b`. */
export function subtractUsage(a: UsageLike, b: UsageLike): Usage {
  const minus = (x: unknown, y: unknown) => Math.max(0, finite(x) - finite(y));
  return {
    input: minus(a.input, b.input),
    output: minus(a.output, b.output),
    cacheRead: minus(a.cacheRead, b.cacheRead),
    cacheWrite: minus(a.cacheWrite, b.cacheWrite),
    ...(a.cacheWrite1h !== undefined
      ? { cacheWrite1h: minus(a.cacheWrite1h, b.cacheWrite1h) }
      : {}),
    ...(a.reasoning !== undefined ? { reasoning: minus(a.reasoning, b.reasoning) } : {}),
    totalTokens: minus(a.totalTokens, b.totalTokens),
    cost: {
      input: minus(a.cost?.input, b.cost?.input),
      output: minus(a.cost?.output, b.cost?.output),
      cacheRead: minus(a.cost?.cacheRead, b.cost?.cacheRead),
      cacheWrite: minus(a.cost?.cacheWrite, b.cost?.cacheWrite),
      total: minus(a.cost?.total, b.cost?.total)
    }
  };
}

export function hasUsage(usage: UsageLike): boolean {
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

/**
 * Total spend of a Pi Durable `pi.usage` ledger (or `Harness.usage()`): every model bucket plus
 * every tool bucket. Missing or malformed buckets count as zero.
 */
export function sumUsageState(
  state: { models?: Record<string, UsageLike>; tools?: Record<string, UsageLike> } | undefined
): Usage {
  let sum = emptyUsage();
  for (const bucket of [state?.models, state?.tools]) {
    for (const usage of Object.values(bucket ?? {})) {
      if (usage && typeof usage === 'object') sum = addUsage(sum, usage);
    }
  }
  return sum;
}
