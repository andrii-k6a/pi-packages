import type { ToolRegistration } from '@earendil-works/pi-durable';

const revisions = new WeakMap<ToolRegistration, string>();

/** Host-owned configuration identity. It is never taken from model arguments or tool names. */
export function pinWorkflowToolRevision(tool: ToolRegistration, revision: string): void {
  if (!revision.trim()) throw new Error('Workflow tool revisions must be nonempty');
  const previous = revisions.get(tool);
  if (previous !== undefined && previous !== revision)
    throw new Error(`Workflow tool ${tool.name} configuration changed after admission`);
  revisions.set(tool, revision);
}

export function workflowToolRevision(tool: ToolRegistration): string | undefined {
  return revisions.get(tool);
}
