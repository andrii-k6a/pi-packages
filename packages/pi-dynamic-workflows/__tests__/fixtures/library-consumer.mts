import {
  WorkflowHost,
  createMcpProvider,
  SDLC_SCRIPT,
  validateSdlcArgs,
  createSdlcBrief,
  SDLC_REVIEW_SCHEMA,
  SDLC_REVIEW_INSTRUCTIONS,
  validateSdlcReview,
  createWorkflowRoleServices,
  listWorkflowRoles,
  parseWorkflowRole,
  type WorkflowRoleServices,
  type WorkflowRoleServiceOptions,
  type McpProviderOptions,
  type McpTransportFactory,
  type SdlcResult,
  type SdlcReview,
  type SdlcCheck,
  type SdlcArgs,
  type ContinueSdlcOptions,
  type SdlcState,
  type SdlcWorkspace,
  type WorkflowRoleSnapshot,
  type WorkflowRoleResolver,
  type WorkflowRunBinding,
  type WorkflowExtensionProvider,
  type WorkflowAttemptOutcome
} from '@andrii-k6a/pi-dynamic-workflows';
import { createModels } from '@earendil-works/pi-ai';
import { defineExtension } from '@earendil-works/pi-durable';

const provider: WorkflowExtensionProvider = {
  name: 'consumer',
  async open(context) {
    const cwd: string = context.cwd;
    return {
      extensions: [defineExtension({ name: 'consumer.tools' })],
      notes: [`tools available in ${cwd}`],
      close: async () => {}
    };
  }
};
const host = new WorkflowHost({
  providers: [provider, createMcpProvider({ allowlist: { servers: {} } })]
});
const binding: WorkflowRunBinding = {
  models: createModels(),
  route: { provider: 'faux', modelId: 'faux-1', thinkingLevel: 'off' },
  resolveProfile: () => {
    throw new Error('no profiles approved');
  },
  promptContext: async () => ({ contextFiles: [], skills: '', append: '' }),
  // Exact recorded SDLC destination, announced before any task or checkout setup.
  onWorkspaceSelected(workspace: SdlcWorkspace) {
    const destination: string = workspace.cwd;
    const mode: 'existing' | 'isolated' = workspace.mode;
    const branch: string | undefined = workspace.branch;
    void [destination, mode, branch];
  }
};
const handle = await host.start({ script: 'trusted script', cwd: '/workspace' }, binding);
const outcome: WorkflowAttemptOutcome = await handle.wait();
if (outcome.status === 'completed' && outcome.usageReceipt) {
  // Real consumers persist the outcome before acknowledging.
  await handle.acknowledgeUsage(outcome.usageReceipt.id);
}
await handle.close();
await host.closeAll();

const sdlcArgs: SdlcArgs = {
  goal: 'Preserve the public API',
  workspace: { mode: 'existing' },
  policy: { roles: { reviewer: 'api-reviewer' }, limits: { maxTasks: 10 } }
};
validateSdlcArgs(sdlcArgs);
const operation = await host.start(
  { script: SDLC_SCRIPT, args: sdlcArgs, cwd: '/workspace' },
  binding
);
const inspected: SdlcState = await host.inspectSdlc(operation.runId, binding);
const result: SdlcResult | undefined = inspected.result;
const check: SdlcCheck = { id: 'api', argv: ['npm', 'test'], kind: 'test', outcomes: ['goal'] };
void result;
await host.answerSdlc(
  operation.runId,
  {
    questionId: 'direction',
    briefRevision: inspected.brief.revision,
    answer: 'Keep compatibility'
  },
  binding
);
const continuation: ContinueSdlcOptions = {
  checks: [check],
  limits: { maxTasks: 20 }
};
const continued = await host.continueSdlc(operation.runId, continuation, binding);
await continued.close();
const roleResolver: WorkflowRoleResolver = (_id) => {
  throw new Error('No roles admitted');
};
const snapshot: WorkflowRoleSnapshot | undefined = undefined;
void roleResolver;
void snapshot;
const brief = createSdlcBrief(sdlcArgs);
const artifact = await host.sdlcArtifact(operation.runId, 'evidence-id');
void artifact;
void SDLC_REVIEW_SCHEMA;
void SDLC_REVIEW_INSTRUCTIONS;
const review: SdlcReview = validateSdlcReview({}, brief, inspected.candidateRevision, '/workspace', [
  check.id
]);
const judgment: SdlcReview['outcomes'][number] = {
  id: 'goal',
  status: 'met',
  checkIds: [check.id],
  evidenceIds: ['check-evidence'],
  observations: [],
  reason: 'The API check exercises the required behavior'
};
review.outcomes.push(judgment);
const closure: SdlcReview['findingDispositions'][number] = {
  id: 'review-1-c0:F1',
  disposition: 'resolved',
  reason: 'The final page is consumed before termination',
  observations: [{ file: 'src/api.ts', line: 1, observation: 'All cursor pages are consumed' }]
};
review.findingDispositions.push(closure);
const transport: McpTransportFactory = (_target) => {
  throw new Error('This declaration-only consumer does not connect to a server');
};
const mcpOptions: McpProviderOptions = {
  allowlist: { servers: {} },
  createTransport: transport,
  transportRevision: 'backend-and-config-1'
};
void createMcpProvider(mcpOptions);
const roleOptions: WorkflowRoleServiceOptions = {
  projectRoot: '/workspace',
  extensions: () => [],
  admitTool: (_owner, tool) => tool.name !== 'bash'
};
const services: WorkflowRoleServices = createWorkflowRoleServices(roleOptions);
void services;
void listWorkflowRoles(roleOptions);
void parseWorkflowRole('---\\nname: local\\ntools: []\\n---\\nInspect.', {
  scope: 'user',
  path: '/agents/local.md'
});
const configured = new WorkflowHost({
  roles: {
    agentDir: '/agents',
    projectRoot: '/workspace',
    revokedRoles: () => ['disabled'],
    admitTool: (_owner, tool) => tool.name !== 'bash',
    toolRevision: () => 'revision-1',
    researchTools: (extensions) => extensions.flatMap((extension) => extension.tools ?? [])
  }
});
await configured.closeAll();
