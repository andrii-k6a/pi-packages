import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssistantMessage, Usage } from '@earendil-works/pi-ai';
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager
} from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { WorkflowAgent } from '../src/agent.js';
import { emptyUsage, sumMessageUsage } from '../src/usage.js';
import { runWorkflow } from '../src/workflow.js';

let directory: string;
let cwd: string;
let agentDir: string;
let modelRuntime: ModelRuntime;
let settingsManager: SettingsManager;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pi-workflow-test-'));
  cwd = join(directory, 'workspace');
  agentDir = join(directory, 'agent');
  await mkdir(cwd);
  await mkdir(agentDir);
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
  settingsManager = SettingsManager.inMemory({ codemode: { mode: 'only' } });
  settingsManager.setProjectTrusted(true);
  modelRuntime = await ModelRuntime.create({
    authPath: join(directory, 'auth.json'),
    modelsPath: null,
    modelsStorePath: join(directory, 'models-cache'),
    refreshOnCreate: false
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

test.each([false, true])('session resource overrides work with codemode=%s', async (codemode) => {
  const overrideCwd = join(directory, 'override-workspace');
  const overrideAgentDir = join(directory, 'override-agent');
  await mkdir(overrideCwd);
  await writeFile(join(cwd, 'AGENTS.md'), 'DEFAULT_WORKSPACE');
  await writeFile(join(overrideCwd, 'AGENTS.md'), 'OVERRIDDEN_WORKSPACE');
  for (const [dir, marker] of [
    [agentDir, 'default'],
    [overrideAgentDir, 'overridden']
  ]) {
    await mkdir(join(dir, 'extensions'), { recursive: true });
    // Handle input before any model request; record which resources the real SDK loaded.
    await writeFile(
      join(dir, 'extensions', 'probe.ts'),
      `export default function(pi) {
        pi.on('input', (_event, ctx) => {
          const workspace = ctx.getSystemPrompt().includes('OVERRIDDEN_WORKSPACE');
          pi.setSessionName('${marker}:' + workspace);
          return { action: 'handled' };
        });
      }`
    );
  }
  const sessionManager = SessionManager.inMemory(overrideCwd);
  await new WorkflowAgent({
    cwd,
    tools: [],
    codemode,
    session: {
      cwd: overrideCwd,
      agentDir: overrideAgentDir,
      settingsManager,
      sessionManager,
      modelRuntime,
      model: modelRuntime.getModels()[0]
    }
  }).run('Intercept without a model call');

  assert.equal(sessionManager.getSessionName(), 'overridden:true');
});

test('workflow usage counts complete entries from each reused-session run exactly once', async () => {
  const sessionManager = SessionManager.inMemory(cwd);
  const model = modelRuntime.getModels()[0];
  const usage = (tokens: number): Usage => ({
    ...emptyUsage(),
    input: tokens,
    totalTokens: tokens,
    cost: { ...emptyUsage().cost, input: tokens / 1000, total: tokens / 1000 }
  });
  const assistant = (tokens: number): AssistantMessage => ({
    role: 'assistant',
    content: [{ type: 'text', text: 'done' }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: usage(tokens),
    stopReason: 'stop',
    timestamp: Date.now()
  });

  // Seed billed history that predates this workflow and must not be reported again.
  sessionManager.appendMessage({ role: 'user', content: 'Earlier task', timestamp: Date.now() });
  sessionManager.appendMessage(assistant(100));
  sessionManager.appendUsage('cache_warm', model.provider, model.id, usage(41));

  let runNumber = 0;
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      (pi) => {
        pi.on('input', () => {
          runNumber++;
          sessionManager.appendMessage(assistant(20));
          sessionManager.appendMessage({
            role: 'toolResult',
            toolCallId: `nested-call-${runNumber}`,
            toolName: 'nested',
            content: [],
            usage: usage(4),
            isError: false,
            timestamp: Date.now()
          });
          const firstKeptId = sessionManager.appendMessage({
            role: 'user',
            content: `Run ${runNumber}`,
            timestamp: Date.now()
          });
          sessionManager.appendCompaction(
            `Summary ${runNumber}`,
            firstKeptId,
            24,
            undefined,
            false,
            usage(10)
          );
          sessionManager.branchWithSummary(
            sessionManager.getLeafId(),
            `Branch ${runNumber}`,
            undefined,
            false,
            usage(5)
          );
          sessionManager.appendUsage('cache_warm', model.provider, model.id, usage(2));
          return { action: 'handled' };
        });
      }
    ]
  });
  await resourceLoader.reload();

  const result = await runWorkflow(
    `export const meta = { name: 'usage', description: 'Count each reused-session run once' };
     await agent('First intercepted run');
     await agent('Second intercepted run');
     return budget.spent();`,
    {
      cwd,
      tools: [],
      session: { settingsManager, sessionManager, resourceLoader, modelRuntime, model }
    }
  );

  assert.equal(runNumber, 2);
  assert.equal(result.agentCount, 2);
  assert.equal(result.result, 82);
  assert.equal(result.usage.totalTokens, 82);
  assert.equal(result.usage.input, 82);
  assert.ok(Math.abs(result.usage.cost.total - 0.082) < 1e-12);
  // Both assistants were compacted away from live context, but their billed usage was retained.
  assert.equal(sumMessageUsage(sessionManager.buildSessionContext().messages).totalTokens, 0);
});
