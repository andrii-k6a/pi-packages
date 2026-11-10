/** Human-readable saved output. The machine-readable result envelope stays unchanged. */
export function workflowResultText(value: unknown): string {
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as { report?: unknown }).report === 'string'
  ) {
    return (value as { report: string }).report;
  }
  return typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? 'null');
}
