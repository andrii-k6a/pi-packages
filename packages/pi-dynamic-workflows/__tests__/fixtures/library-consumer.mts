import {
  WorkflowHost,
  createMcpProvider,
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
  resolveProfile: () => { throw new Error('no profiles approved'); },
  promptContext: async () => ({ contextFiles: [], skills: '', append: '' })
};
const handle = await host.start({ script: 'trusted script', cwd: '/workspace' }, binding);
const outcome: WorkflowAttemptOutcome = await handle.wait();
if (outcome.status === 'completed' && outcome.usageReceipt) {
  // Real consumers persist the outcome before acknowledging.
  await handle.acknowledgeUsage(outcome.usageReceipt.id);
}
await handle.close();
await host.closeAll();
