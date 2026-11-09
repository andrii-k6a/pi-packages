import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager
} from '@earendil-works/pi-coding-agent';
import { test, vi } from 'vitest';
import * as mcpConfig from '../../src/durable/mcp/config.js';
import * as store from '../../src/durable/store.js';
import extension from '../../src/dynamic-workflows.js';
import * as profilesConfig from '../../src/profiles/config.js';

vi.mock('../../src/durable/mcp/config.js', { spy: true });
vi.mock('../../src/profiles/config.js', { spy: true });
vi.mock('../../src/durable/store.js', { spy: true });

const SCRIPT = `export const meta = { name: 'session_background', description: 'Session integration' }
return await agent('child work', { label: 'child' })`;

test.each([
  'idle',
  'busy',
  'busy-aborted',
  'settling',
  'settling-many',
  'compacting',
  'compacting-failed',
  'compacting-aborted'
] as const)(
  'the installed extension persists completion and native usage when the parent is %s',
  async (parentState) => {
    const directory = await mkdtemp(join(tmpdir(), 'workflow-background-session-'));
    vi.mocked(mcpConfig.loadWorkflowMcpAllowlist).mockReturnValue({ servers: {} });
    vi.mocked(profilesConfig.loadWorkflowProfiles).mockReturnValue([]);
    vi.mocked(store.workflowRunsRoot).mockReturnValue(join(directory, 'runs'));
    let session: AgentSession | undefined;
    let releaseChild!: () => void;
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    let releaseParent!: () => void;
    const parentGate = new Promise<void>((resolve) => {
      releaseParent = resolve;
    });
    let parentStarted!: () => void;
    const busyParent = new Promise<void>((resolve) => {
      parentStarted = resolve;
    });
    let parentPrompt: Promise<void> | undefined;
    let manualCompaction: ReturnType<AgentSession['compact']> | undefined;
    let compactionStarted!: () => void;
    const compacting = new Promise<void>((resolve) => {
      compactionStarted = resolve;
    });
    let releaseCompaction!: () => void;
    const compactionGate = new Promise<void>((resolve) => {
      releaseCompaction = resolve;
    });
    const workflowCount = parentState === 'settling-many' ? 2 : 1;
    const compactionScenario = parentState.startsWith('compacting');
    let finishWhileSettling = false;
    let childCalls = 0;
    let starts = 0;
    const collections: string[] = [];
    const faux = fauxProvider({ models: [{ id: 'faux-1' }] });
    faux.setResponses(
      Array.from({ length: 20 }, () => async (context, options) => {
        const contents = context.messages.map((message) =>
          typeof message.content === 'string'
            ? message.content
            : message.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
        );
        const content = contents.at(-1);
        if (
          parentState === 'compacting-failed' &&
          (content?.startsWith('<conversation>') || content?.startsWith('# Conversation'))
        ) {
          return fauxAssistantMessage('', {
            stopReason: 'error',
            errorMessage: 'summary provider failed'
          });
        }
        if (content === 'child work') {
          childCalls++;
          await childGate;
          return fauxAssistantMessage('child result');
        }
        if (content === 'Busy work') {
          parentStarted();
          await new Promise<void>((resolve, reject) => {
            const abort = () => reject(new Error('parent aborted'));
            if (options?.signal?.aborted) return abort();
            options?.signal?.addEventListener('abort', abort, { once: true });
            void parentGate.then(() => {
              options?.signal?.removeEventListener('abort', abort);
              resolve();
            });
          });
          return fauxAssistantMessage('Busy work finished');
        }
        if (content === 'Start background') {
          return fauxAssistantMessage(
            fauxToolCall(
              'workflow',
              { script: SCRIPT, background: true },
              { id: `start-${++starts}` }
            ),
            { stopReason: 'toolUse' }
          );
        }
        if (content?.includes('Background workflow session_background completed')) {
          const calls = [];
          for (let index = contents.length - 1; index >= 0; index--) {
            const id = /Background workflow.*completed.*\n.*"result":"([^"]+)"/.exec(
              contents[index]
            )?.[1];
            if (!id) break;
            collections.push(id);
            calls.push(
              fauxToolCall('workflow', { result: id }, { id: `collect-${collections.length}` })
            );
          }
          return fauxAssistantMessage(calls, { stopReason: 'toolUse' });
        }
        if (content === 'Other work') return fauxAssistantMessage('Other work finished');
        return fauxAssistantMessage('Acknowledged');
      })
    );
    try {
      const runtime = await ModelRuntime.create({
        authPath: join(directory, 'auth.json'),
        modelsPath: null,
        modelsStorePath: join(directory, 'models-cache'),
        refreshOnCreate: false
      });
      runtime.registerNativeProvider(faux.provider);
      const settings = SettingsManager.inMemory({
        cacheWarming: 'off',
        ...(compactionScenario ? { compaction: { enabled: false, keepRecentTokens: 1 } } : {})
      });
      const loader = new DefaultResourceLoader({
        cwd: directory,
        agentDir: directory,
        settingsManager: settings,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        extensionFactories: [
          extension,
          (pi) => {
            pi.on('agent_before_settle', async () => {
              if (!finishWhileSettling) return;
              finishWhileSettling = false;
              releaseChild();
              await vi.waitFor(() => {
                const runs = store.listRuns(join(directory, 'runs'));
                assert.equal(runs.length, workflowCount);
                for (const run of runs) {
                  assert.equal(run.status, 'completed');
                  assert.equal(store.runLockOwner(join(directory, 'runs'), run.runId), undefined);
                }
              });
            });
            pi.on('session_before_compact', async (event) => {
              if (!compactionScenario || event.reason !== 'manual') return;
              compactionStarted();
              await compactionGate;
              if (parentState === 'compacting-aborted') return { cancel: true };
              if (parentState === 'compacting-failed') return;
              return {
                compaction: {
                  summary: 'The workflow is running in the background.',
                  firstKeptEntryId: event.preparation.firstKeptEntryId,
                  tokensBefore: event.preparation.tokensBefore
                }
              };
            });
          }
        ]
      });
      await loader.reload();
      const sm = SessionManager.create(directory, join(directory, 'sessions'));
      ({ session } = await createAgentSession({
        cwd: directory,
        agentDir: directory,
        modelRuntime: runtime,
        model: faux.getModel(),
        thinkingLevel: 'off',
        resourceLoader: loader,
        settingsManager: settings,
        sessionManager: sm,
        noTools: 'builtin'
      }));
      const errors: string[] = [];
      await session.bindExtensions({ mode: 'rpc', onError: (error) => errors.push(error.error) });
      await session.prompt('Start background');
      await vi.waitFor(() => assert.equal(childCalls, 1));
      assert.equal(session.isStreaming, false, 'the parent settles while the child is pending');
      if (workflowCount === 2) {
        await session.prompt('Start background');
        await vi.waitFor(() => assert.equal(childCalls, workflowCount));
      }
      finishWhileSettling = parentState === 'settling' || parentState === 'settling-many';
      await session.prompt('Other work');
      if (parentState !== 'settling' && parentState !== 'settling-many') {
        assert.equal(session.getLastAssistantText(), 'Other work finished');
      }
      if (parentState === 'busy' || parentState === 'busy-aborted') {
        parentPrompt = session.prompt('Busy work');
        await busyParent;
      }
      if (compactionScenario) {
        manualCompaction = session.compact();
        await compacting;
        assert.equal(session.isCompacting, true);
      }
      releaseChild();
      if (parentState === 'busy' || parentState === 'busy-aborted' || compactionScenario) {
        await vi.waitFor(() => {
          const run = store.listRuns(join(directory, 'runs'))[0];
          assert.equal(run.status, 'completed');
          assert.equal(store.runLockOwner(join(directory, 'runs'), run.runId), undefined);
        });
        assert.equal(
          sm.getEntries().some((entry) => entry.type === 'custom_message'),
          false,
          'completion has not reached persisted history while the parent is busy'
        );
        if (parentState === 'busy-aborted') {
          // Esc clears the real Pi queue before aborting the main agent.
          session.clearQueue();
          await session.abort();
          await parentPrompt;
          assert.equal(session.agent.hasQueuedMessages(), false);
          assert.equal(
            sm.getEntries().some((entry) => entry.type === 'custom_message'),
            false,
            'Esc must not immediately restart the parent to deliver the completion'
          );
          await session.prompt('Other work');
        } else if (compactionScenario) {
          releaseCompaction();
          assert.ok(manualCompaction);
          if (parentState === 'compacting-aborted') {
            await assert.rejects(manualCompaction, /Compaction cancelled/);
            assert.equal(
              sm.getEntries().some((entry) => entry.type === 'custom_message'),
              false,
              'cancelling compaction must not immediately restart the parent'
            );
            await session.prompt('Other work');
          } else if (parentState === 'compacting-failed') {
            await assert.rejects(manualCompaction, /summary provider failed/);
          } else {
            await manualCompaction;
          }
          manualCompaction = undefined;
          assert.equal(session.isCompacting, false);
        } else {
          releaseParent();
          await parentPrompt;
        }
      }
      await vi.waitFor(() => {
        assert.ok(
          (session?.messages.filter(
            (message) => message.role === 'toolResult' && message.toolCallId.startsWith('collect-')
          ).length ?? 0) >= workflowCount
        );
      });
      await session.waitForIdle();
      assert.deepEqual(errors, []);
      const results = sm
        .getEntries()
        .filter(
          (entry) =>
            entry.type === 'message' &&
            entry.message.role === 'toolResult' &&
            entry.message.toolCallId.startsWith('collect-')
        );
      assert.equal(results.length, workflowCount, 'each completed workflow is collected once');
      for (const result of results) {
        assert.ok(result.type === 'message' && result.message.role === 'toolResult');
        assert.ok(result.message.usage?.totalTokens);
        assert.ok(JSON.stringify(result.message.details).includes('usageReceipt'));
      }
      assert.equal(childCalls, workflowCount);
      assert.equal(new Set(collections).size, workflowCount);
      assert.equal(store.listRuns(join(directory, 'runs'))[0].status, 'completed');
      await session.prompt('Other work');
      const notifications = sm.getEntries().filter((entry) => entry.type === 'custom_message');
      assert.equal(
        notifications.length,
        workflowCount,
        'a persisted completion must not be delivered twice on subsequent turns'
      );
      assert.equal(
        new Set(notifications.map((entry) => (entry.details as { deliveryId: string }).deliveryId))
          .size,
        workflowCount
      );
    } finally {
      releaseChild();
      releaseParent();
      releaseCompaction();
      await manualCompaction?.catch(() => {});
      session?.clearQueue();
      await session?.abort();
      await parentPrompt;
      session?.dispose();
      vi.restoreAllMocks();
      await rm(directory, { recursive: true, force: true });
    }
  }
);
