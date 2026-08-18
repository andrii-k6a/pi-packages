import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { openWorkflowProfileManager } from './profile-manager.js';
import { loadWorkflowProfiles } from './profiles.js';
import { createWorkflowTool } from './workflow-tool.js';

export default function extension(pi: ExtensionAPI) {
  const workflowTool = createWorkflowTool({ profiles: loadWorkflowProfiles() });
  pi.registerTool(workflowTool);
  pi.registerCommand('workflow-profiles', {
    description: 'Create, edit, delete, and reload approved workflow routing profiles',
    handler: async (_args, ctx) => openWorkflowProfileManager(ctx)
  });

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
export { nextProfileIndex, selectedProfileIndex } from './profile-manager.js';
export type {
  ResolvedWorkflowProfile,
  WorkflowProfile,
  WorkflowProfileResolver,
  WorkflowProfileResolverContext
} from './profiles.js';
export {
  createWorkflowProfileResolver,
  loadWorkflowProfiles,
  parseWorkflowProfiles,
  saveWorkflowProfiles,
  WorkflowProfileRoutingError,
  workflowProfilesPath
} from './profiles.js';
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
