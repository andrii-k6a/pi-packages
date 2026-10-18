import type { JsonValue } from '@earendil-works/chord';
import type { Extension } from '@earendil-works/pi-durable';
import type { TSchema } from 'typebox';
import { canonicalJson, createOutputExtension } from '../subagent.js';
import { createAgentTask } from './agent.js';
import type { WorkflowTaskServices } from './contracts.js';
import { createRunTask } from './run.js';

/** Wire the two task machines to a per-run structured-output extension cache. */
export function createWorkflowTasks(services: WorkflowTaskServices) {
  const outputExtensions = new Map<string, Extension>();
  const outputExtension = (schema: JsonValue): Extension => {
    const key = canonicalJson(schema);
    let extension = outputExtensions.get(key);
    if (!extension) {
      extension = createOutputExtension(schema as unknown as TSchema);
      outputExtensions.set(key, extension);
      services.install(extension);
    }
    return extension;
  };
  const AgentTask = createAgentTask(services, outputExtension);
  const RunTask = createRunTask(services, AgentTask, outputExtension);
  return { RunTask, AgentTask, outputExtension };
}

export type WorkflowTasks = ReturnType<typeof createWorkflowTasks>;
