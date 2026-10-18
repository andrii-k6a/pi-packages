/** Environment variable that overrides the cap on `agent()` calls per workflow attempt. */
export const WORKFLOW_MAX_AGENTS_ENV = 'PI_WORKFLOW_MAX_AGENTS';

/**
 * Reads the agent-call cap from the environment: a positive integer, or `unlimited`. Unset or empty
 * keeps the host default. A malformed value fails loudly, like the package's configuration files.
 */
export function loadWorkflowMaxAgents(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env[WORKFLOW_MAX_AGENTS_ENV]?.trim();
  if (!raw) return undefined;
  if (raw.toLowerCase() === 'unlimited') return Number.POSITIVE_INFINITY;
  if (!/^[1-9][0-9]{0,8}$/.test(raw)) {
    throw new Error(
      `${WORKFLOW_MAX_AGENTS_ENV} must be a positive integer or "unlimited" (got ${JSON.stringify(raw.slice(0, 40))})`
    );
  }
  return Number(raw);
}
