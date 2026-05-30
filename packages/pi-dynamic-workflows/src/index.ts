import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createWorkflowTool } from './workflow-tool.js';

export default function extension(pi: ExtensionAPI) {
  const workflowTool = createWorkflowTool();
  pi.registerTool(workflowTool);

  pi.on('session_start', () => {
    const active = pi.getActiveTools();
    if (!active.includes(workflowTool.name)) {
      pi.setActiveTools([...active, workflowTool.name]);
    }
  });
}

export type { AgentRunOptions, AgentRunResult, WorkflowAgentOptions } from './agent.js';
export { WorkflowAgent } from './agent.js';
export type {
  WorkflowAgentSnapshot,
  WorkflowAgentStatus,
  WorkflowDisplay,
  WorkflowDisplayOptions,
  WorkflowSnapshot
} from './display.js';
export {
  createToolUpdateWorkflowDisplay,
  createWidgetWorkflowDisplay,
  createWorkflowSnapshot,
  preview,
  recomputeWorkflowSnapshot,
  renderWorkflowLines,
  renderWorkflowText
} from './display.js';
export type { StructuredOutputCapture, StructuredOutputToolOptions } from './structured-output.js';
export { createStructuredOutputTool } from './structured-output.js';
export type {
  AgentOptions,
  WorkflowMeta,
  WorkflowMetaPhase,
  WorkflowRunOptions,
  WorkflowRunResult
} from './workflow.js';
export { parseWorkflowScript, runWorkflow } from './workflow.js';
export type { WorkflowToolInput, WorkflowToolOptions } from './workflow-tool.js';
export { createWorkflowTool } from './workflow-tool.js';
