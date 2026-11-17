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
  Harness,
  type TaskId,
  UsageDoc
} from '@earendil-works/pi-durable';
import { MemoryStorage } from '@earendil-works/pi-durable/storage/memory';
import { Type } from 'typebox';
import { test } from 'vitest';
import { createWorkflowRoleServices, guardWorkflowRoleModels } from '../../src/durable/roles.js';
import { createAgentTask } from '../../src/durable/tasks/agent.js';
import type { AgentCheckpoint } from '../../src/durable/tasks/contracts.js';
import { emptyUsage } from '../../src/shared/usage.js';

/** The clock advances at the effect, not with test-machine scheduling. */
test.each(['timeout', 'cancel'] as const)(
  '%s aborts owned role tools and retains already incurred usage',
  async (ending) => {
    const directory = mkdtempSync(join(tmpdir(), 'role-execution-'));
    let harness: Harness | undefined;
    try {
      const agentDir = join(directory, 'user');
      mkdirSync(join(agentDir, 'agents'), { recursive: true });
      writeFileSync(
        join(agentDir, 'agents/custom.md'),
        '---\nname: custom\ndescription: Bounded caller\ntools: [wait]\n---\nWait for the assigned effect.'
      );
      let now = 1000;
      let cancelled = false;
      let started!: () => void;
      const running = new Promise<void>((resolve) => {
        started = resolve;
      });
      const wait = defineTool({
        name: 'wait',
        description: 'Wait for cancellation',
        parameters: Type.Object({}),
        replay: 'safe',
        async execute(_args, _api, ctx) {
          if (ending === 'timeout') now = 1001;
          started();
          await new Promise<void>((resolve) => {
            const abort = () => {
              cancelled = true;
              resolve();
            };
            if (ctx.abortSignal?.aborted) abort();
            else ctx.abortSignal?.addEventListener('abort', abort, { once: true });
          });
          return { output: [] };
        }
      });
      const provider = defineExtension({ name: 'provider', tools: [wait] });
      const roles = createWorkflowRoleServices({
        projectRoot: directory,
        agentDir,
        toolRevision: () => 'wait-fixture-v1',
        extensions: () => [provider]
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
      const faux = fauxProvider({
        models: [{ id: 'faux-1', cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }]
      });
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall('wait', {})], { stopReason: 'toolUse' })
      ]);
      const models = createModels();
      models.setProvider(faux.provider);
      // Faux computes token estimates but always zero cost. Fix the transport's billed usage here.
      const usage = {
        ...emptyUsage(),
        input: 30,
        output: 7,
        totalTokens: 37,
        cost: { ...emptyUsage().cost, input: 0.1, total: 0.1 }
      };
      const stream = models.streamSimple.bind(models);
      models.streamSimple = (...args) => {
        const events = stream(...args);
        const result = events.result.bind(events);
        events.result = async () => ({ ...(await result()), usage });
        return events;
      };
      // Exercise the same late bootstrap binding needed by WorkflowHost.
      harness = await Harness.open(
        new MemoryStorage(),
        { registry, models: guardWorkflowRoleModels(models, () => roles), now: () => now },
        context
      );
      const root = await harness.root(context);
      const id = await root.commit(
        (tx) =>
          tx.createTask(
            task,
            {
              attemptId: 1,
              key: ending,
              prompt: 'Wait',
              label: 'Wait',
              role: 'custom',
              resolvedRole: selected,
              cwd: directory,
              timeoutMs: ending === 'timeout' ? 1 : 10_000,
              route: { provider: 'faux', modelId: 'faux-1', thinkingLevel: 'off' }
            },
            { ownership: { kind: 'conversation' } }
          ),
        context
      );
      const settled = harness.waitForTask(id, context);
      settled.catch(() => {});
      await running;
      const record = await harness.getTask(id, context);
      assert.ok(record);
      const checkpoint = record.state.checkpoint as AgentCheckpoint;
      assert.ok(checkpoint.phase !== 'start');
      const recorded = await harness.snapshot(
        UsageDoc,
        checkpoint.conversationId as ConversationId,
        context
      );
      const incurred = Object.values(recorded?.models ?? {})[0];
      assert.deepEqual(incurred, usage);
      if (ending === 'cancel') await harness.abortTask(id as TaskId, context);
      const result = await settled;
      assert.equal(result.state.outcome.status, ending === 'timeout' ? 'failed' : 'aborted');
      if (result.state.outcome.status === 'failed')
        assert.match(result.state.outcome.error.message, /execution time limit exhausted/);
      assert.equal(cancelled, true);
      assert.deepEqual(result.state.outcome.result?.usage, incurred);
      assert.equal(faux.state.callCount, 1);
    } finally {
      await harness?.close(context);
      rmSync(directory, { recursive: true, force: true });
    }
  }
);
