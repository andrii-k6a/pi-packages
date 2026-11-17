import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall
} from '@earendil-works/pi-ai';
import {
  type ConversationId,
  createRegistry,
  defineExtension,
  defineTool,
  Harness
} from '@earendil-works/pi-durable';
import { MemoryStorage } from '@earendil-works/pi-durable/storage/memory';
import { Type } from 'typebox';
import { test } from 'vitest';
import { createWorkflowRoleServices } from '../../src/durable/roles.js';
import { createAgentTask } from '../../src/durable/tasks/agent.js';

/** Current admission can change after a request was sent but before its tool call executes. */
test.each([
  'tool',
  'nested-tool',
  'profile',
  'role',
  'definition-deny',
  'definition-remove',
  'implementation',
  'owner'
] as const)('current %s revocation blocks effects and the next provider request', async (kind) => {
  const directory = mkdtempSync(join(tmpdir(), 'role-admission-'));
  let harness: Harness | undefined;
  try {
    const agentDir = join(directory, 'user');
    mkdirSync(join(agentDir, 'agents'), { recursive: true });
    const path = join(agentDir, 'agents/custom.md');
    writeFileSync(
      path,
      '---\nname: custom\ndescription: Bounded tool caller\ntools: [effect, delegate]\n---\nCall the assigned tool.'
    );
    let admitted = true;
    let requests = 0;
    let effects = 0;
    let preparations = 0;
    const tool = defineTool({
      name: 'effect',
      description: 'A host effect',
      parameters: Type.Object({}),
      replay: 'safe',
      prepareArguments() {
        preparations++;
        return {};
      },
      async execute() {
        effects++;
        return { output: [] };
      }
    });
    const delegate = defineTool({
      name: 'delegate',
      description: 'Call the assigned effect',
      parameters: Type.Object({}),
      replay: 'safe',
      async execute(_args, api, ctx) {
        admitted = false;
        const result = await api.executeTool('effect', {}, ctx);
        assert.equal(result.isError, true);
        return { output: [{ type: 'text', text: JSON.stringify(result.diagnostics) }] };
      }
    });
    const provider = defineExtension({ name: 'provider', tools: [tool, delegate] });
    const roles = createWorkflowRoleServices({
      projectRoot: directory,
      agentDir,
      extensions: () => [
        kind === 'owner' && !admitted ? { ...provider, name: 'substituted-owner' } : provider
      ],
      admitTool: () => (kind !== 'tool' && kind !== 'nested-tool') || admitted,
      revokedRoles: () => (kind === 'role' && !admitted ? ['custom'] : []),
      toolRevision: () =>
        kind === 'implementation' && !admitted ? 'revoked-revision' : 'original-revision',
      recheckProfile() {
        if (kind === 'profile' && !admitted) throw new Error('profile approval revoked');
      }
    });
    const selected = roles.resolve('custom');
    const registry = createRegistry();
    const task = createAgentTask(
      {
        roles,
        install: (extension) => registry.install(extension),
        resolveProfile() {
          throw new Error('unused');
        },
        extensions: () => ({ found: [], missing: [] }),
        notes: () => []
      },
      () => {
        throw new Error('unused');
      }
    );
    registry.install(defineExtension({ name: 'test.tasks', tasks: [task] }));
    const faux = fauxProvider();
    faux.setResponses(
      Array.from({ length: 3 }, () => () => {
        requests++;
        if (kind !== 'nested-tool') admitted = false;
        if (kind === 'definition-deny')
          writeFileSync(
            path,
            '---\nname: custom\ndescription: Bounded tool caller\ntools: [effect]\ndenyTools: [effect]\n---\nNew instructions must not replace the pinned instructions.'
          );
        if (kind === 'definition-remove')
          writeFileSync(
            path,
            '---\nname: custom\ndescription: Bounded tool caller\ntools: []\n---\nNew instructions must not replace the pinned instructions.'
          );
        return fauxAssistantMessage(
          [fauxToolCall(kind === 'nested-tool' ? 'delegate' : 'effect', {})],
          { stopReason: 'toolUse' }
        );
      })
    );
    const models = createModels();
    models.setProvider(faux.provider);
    harness = await Harness.open(
      new MemoryStorage(),
      { registry, models: roles.guardModels(models), settings: { retry: { enabled: false } } },
      context
    );
    const root = await harness.root(context);
    const id = await root.commit(
      (tx) =>
        tx.createTask(
          task,
          {
            attemptId: 1,
            key: 'revocation',
            prompt: 'Perform the authorized bounded effect',
            label: 'Effect',
            role: 'custom',
            resolvedRole: selected,
            profile: 'approved',
            cwd: directory,
            route: { provider: 'faux', modelId: 'faux-1', thinkingLevel: 'off' }
          },
          { ownership: { kind: 'conversation' } }
        ),
      context
    );
    const result = await harness.waitForTask(id, context);
    assert.equal(result.state.outcome.status, 'failed');
    if (result.state.outcome.status === 'failed')
      assert.deepEqual(result.state.outcome.error.detail, { kind: 'workflow-role' });
    const conversation = await harness.conversation(
      result.state.outcome.result?.conversationId as ConversationId,
      context
    );
    assert.ok(conversation);
    assert.equal(effects, 0);
    assert.equal(preparations, 0);
    assert.equal(requests, 1);
    assert.match(
      JSON.stringify((await conversation.context(context)).messages),
      /revoked|explicitly denied|removed from/
    );
  } finally {
    await harness?.close(context);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('role-bearing agent tasks fail closed without host role services before any generation', async () => {
  const registry = createRegistry();
  const task = createAgentTask(
    {
      install: (extension) => registry.install(extension),
      resolveProfile() {
        throw new Error('unused');
      },
      extensions: () => ({ found: [], missing: [] }),
      notes: () => []
    },
    () => {
      throw new Error('unused');
    }
  );
  registry.install(defineExtension({ name: 'test.tasks', tasks: [task] }));
  const harness = await Harness.open(
    new MemoryStorage(),
    { registry, models: createModels() },
    context
  );
  try {
    const root = await harness.root(context);
    const id = await root.commit(
      (tx) =>
        tx.createTask(
          task,
          {
            attemptId: 1,
            key: 'role',
            prompt: 'Review',
            label: 'Review',
            role: 'reviewer',
            cwd: '/tmp'
          },
          { ownership: { kind: 'conversation' } }
        ),
      context
    );
    const result = await harness.waitForTask(id, context);
    assert.equal(result.state.outcome.status, 'failed');
    assert.match(JSON.stringify(result.state.outcome), /role enforcement is unavailable/);
  } finally {
    await harness.close(context);
  }
});
