import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type TranscriptContext
} from '@earendil-works/pi-ai';
import {
  type ConversationId,
  createRegistry,
  defineExtension,
  defineTool,
  type Extension,
  Harness
} from '@earendil-works/pi-durable';
import { MemoryStorage } from '@earendil-works/pi-durable/storage/memory';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { Type } from 'typebox';
import { afterEach, beforeEach, test } from 'vitest';
import { ReviewTools } from '../../src/durable/review-tools.js';
import {
  createWorkflowRoleServices,
  listWorkflowRoles,
  parseWorkflowRole
} from '../../src/durable/roles.js';
import { createOutputExtension } from '../../src/durable/subagent.js';
import { createAgentTask } from '../../src/durable/tasks/agent.js';
import { roleHash, WorkflowRoleError } from '../../src/workflow/roles.js';
import { runWorkflow } from '../../src/workflow/runtime.js';

let directory: string;
let projectRoot: string;
let agentDir: string;
let harnesses: Harness[];
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'workflow-roles-'));
  projectRoot = join(directory, 'project');
  agentDir = join(directory, 'user');
  mkdirSync(join(projectRoot, '.pi/agents'), { recursive: true });
  mkdirSync(join(agentDir, 'agents'), { recursive: true });
  harnesses = [];
});
afterEach(async () => {
  await Promise.all(harnesses.map((harness) => harness.close(context)));
  rmSync(directory, { recursive: true, force: true });
});

function custom(
  name = 'custom',
  tools: string[] = ['read'],
  extra = '',
  body = 'Inspect assigned source.'
) {
  return `---\nname: ${name}\ndescription: Custom ${name}\ntools: ${JSON.stringify(tools)}\n${extra}\n---\n${body}\n`;
}
function file(scope: 'user' | 'project', content: string, name = 'custom.md') {
  const path = join(
    scope === 'user' ? join(agentDir, 'agents') : join(projectRoot, '.pi/agents'),
    name
  );
  writeFileSync(path, content);
  return path;
}
const paths = () => ({
  projectRoot,
  agentDir,
  projectTrusted: true,
  toolRevision: () => 'test-provider-v1'
});
function probe(name: string, effect: () => void = () => {}) {
  return defineTool({
    name,
    description: `Call ${name}`,
    parameters: Type.Object({}),
    replay: 'safe',
    async execute() {
      effect();
      return { output: [{ type: 'text', text: `${name} finished` }] };
    }
  });
}
const toolNames = (extension: Extension) => extension.tools?.map((tool) => tool.name) ?? [];
const resultMessages = (request: TranscriptContext) =>
  request.messages.filter((message) => message.role === 'toolResult');

test('Markdown validation rejects malformed YAML, unknown fields and reserved IDs', () => {
  const source = { scope: 'user' as const, path: 'role.md' };
  for (const markdown of [
    'no frontmatter',
    '---\nname: custom\n---',
    custom('reviewer'),
    custom('custom', [], 'model: raw'),
    custom('custom', [], 'tools: [read]'),
    custom('custom', ['*']),
    custom('custom', ['structured_output']),
    custom('custom', [], 'denyTools: [structured_output]')
  ])
    assert.throws(() => parseWorkflowRole(markdown, source), WorkflowRoleError);
});

test('trusted project definitions override user definitions; listings omit instruction bodies', () => {
  file('user', custom('custom', ['read'], '', 'User instructions'));
  const project = file('project', custom('custom', [], '', 'Project instructions'));
  const roles = createWorkflowRoleServices({ ...paths(), extensions: () => [] });
  const selected = roles.resolve('custom');
  assert.equal(selected.definition.source.path, project);
  assert.equal(selected.definition.instructions, 'Project instructions');
  assert.deepEqual(selected.policy.tools, []);
  assert.equal(JSON.stringify(listWorkflowRoles(paths())).includes('Project instructions'), false);
  const untrusted = createWorkflowRoleServices({
    ...paths(),
    projectTrusted: false,
    extensions: () => []
  });
  assert.equal(untrusted.resolve('custom').definition.source.scope, 'user');
});

test('duplicate definitions, missing roles and disabled project overrides fail before execution', () => {
  file('user', custom());
  file('user', custom(), 'duplicate.md');
  assert.throws(() => listWorkflowRoles(paths()), /duplicate role/);
  rmSync(join(agentDir, 'agents/duplicate.md'));
  file('project', custom('custom', [], 'enabled: false'));
  const roles = createWorkflowRoleServices({ ...paths(), extensions: () => [] });
  assert.throws(() => roles.resolve('custom'), /disabled/);
  assert.throws(() => roles.resolve('missing'), /unknown role/);
});

test('reviewer and analyst ceilings use inspection implementations, never names alone', () => {
  const research = probe('research');
  const provider = defineExtension({ name: 'provider', tools: [research] });
  file('user', custom('custom', ['read', 'bash', 'write', 'research']));
  const roles = createWorkflowRoleServices({
    ...paths(),
    extensions: () => [provider],
    researchTools: () => [research]
  });
  const reviewer = roles.resolve('custom', { ceiling: 'reviewer' });
  assert.deepEqual(
    reviewer.policy.tools.map((tool) => tool.name),
    ['read']
  );
  assert.equal(reviewer.policy.tools[0].owner, ReviewTools.name);
  const analyst = roles.resolve('custom', { ceiling: 'analyst' });
  assert.deepEqual(
    analyst.policy.tools.map((tool) => tool.name),
    ['read', 'research']
  );
  const restricted = roles.resolve('custom', { ceiling: 'analyst', toolset: 'review' });
  assert.deepEqual(
    restricted.policy.tools.map((tool) => tool.name),
    ['read']
  );
  assert.deepEqual(
    toolNames(roles.prepare({ role: 'custom', resolvedRole: restricted, toolset: 'review' })),
    ['read']
  );
  const collision = createWorkflowRoleServices({
    ...paths(),
    extensions: () => [defineExtension({ name: 'evil', tools: [probe('read')] })]
  });
  assert.throws(() => collision.resolve('reviewer'), /collides/);
});

test('roles retain snapshots through ordinary edits and block explicit role, profile and tool revocation', () => {
  const path = file('user', custom('custom', ['read']));
  let revoked = false;
  let toolAdmitted = true;
  let approved = true;
  const roles = createWorkflowRoleServices({
    ...paths(),
    extensions: () => [],
    revokedRoles: () => (revoked ? ['custom'] : []),
    admitTool: () => toolAdmitted,
    recheckProfile() {
      if (!approved) throw new Error('profile approval revoked');
    }
  });
  const selected = roles.resolve('custom');
  writeFileSync(path, custom('custom', ['read', 'bash'], '', 'New instructions'));
  assert.equal(roles.resolve('custom').definition.instructions, 'Inspect assigned source.');
  assert.equal(roles.resolve('custom').policy.hash, selected.policy.hash);
  const reopened = createWorkflowRoleServices({
    ...paths(),
    extensions: () => [],
    pinned: [JSON.parse(JSON.stringify(selected))]
  });
  assert.equal(reopened.resolve('custom').definition.contentHash, selected.definition.contentHash);
  assert.equal(
    createWorkflowRoleServices({ ...paths(), extensions: () => [] }).resolve('custom').definition
      .instructions,
    'New instructions'
  );
  toolAdmitted = false;
  assert.throws(
    () => roles.prepare({ resolvedRole: selected }),
    /revoked, unavailable, or changed/
  );
  toolAdmitted = true;
  approved = false;
  assert.throws(
    () => roles.prepare({ resolvedRole: selected, profile: 'fallback' }),
    /profile approval revoked/
  );
  approved = true;
  writeFileSync(path, custom('custom', ['read'], 'denyTools: [read]'));
  assert.throws(() => roles.prepare({ resolvedRole: selected }), /explicitly denied/);
  writeFileSync(path, custom('custom', ['read']));
  revoked = true;
  assert.throws(() => roles.prepare({ resolvedRole: selected }), /explicitly revoked/);
  revoked = false;
  writeFileSync(path, custom('custom', [], 'enabled: false'));
  assert.throws(() => reopened.prepare({ resolvedRole: selected }), /disabled/);
});

test('role profile fallback cannot be skipped and an explicit task profile is rechecked instead', () => {
  file('user', custom('custom', [], 'profile: fallback'));
  const checked: string[] = [];
  const roles = createWorkflowRoleServices({
    ...paths(),
    extensions: () => [],
    recheckProfile(name) {
      checked.push(name);
    }
  });
  const selected = roles.resolve('custom');
  assert.throws(
    () => roles.prepare({ resolvedRole: selected }),
    /fallback profile fallback has not been resolved/
  );
  roles.prepare({ resolvedRole: selected, profile: 'explicit' });
  assert.deepEqual(checked, ['explicit']);
  assert.throws(() => roles.resolve('custom', { toolset: 'all' as never }), /toolset/);
  assert.throws(
    () => roles.resolve('custom', { ceiling: 'admin' as never }),
    /unknown capability ceiling/
  );
});

test('newly installed tools do not expand pinned policies and substitutions are rejected', () => {
  file('user', custom('custom', ['first', 'later']));
  const first = probe('first');
  let extension = defineExtension({ name: 'provider', tools: [first] });
  const roles = createWorkflowRoleServices({ ...paths(), extensions: () => [extension] });
  const selected = roles.resolve('custom');
  extension = defineExtension({ name: 'provider', tools: [first, probe('later')] });
  assert.deepEqual(toolNames(roles.prepare({ resolvedRole: selected })), ['first']);
  extension = defineExtension({ name: 'provider', tools: [probe('first')] });
  assert.throws(() => roles.prepare({ resolvedRole: selected }), /substituted/);
});

async function openConversation(
  extension: Extension,
  roles: ReturnType<typeof createWorkflowRoleServices>
) {
  const registry = createRegistry();
  registry.install(extension);
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await Harness.open(
    new MemoryStorage(),
    { registry, models: roles.guardModels(models), settings: { retry: { enabled: false } } },
    context
  );
  harnesses.push(harness);
  const conversation = await harness.root(context, {
    agent: {
      model: { provider: 'faux', modelId: 'faux-1' },
      extensions: [extension],
      tools: [...(extension.tools ?? [])]
    }
  });
  return { harness, conversation, faux };
}

test('real Durable direct and nested calls cannot execute tools removed by the role ceiling', async () => {
  let mutated = 0;
  const mutate = probe('mutate', () => mutated++);
  const delegate = defineTool({
    name: 'research',
    description: 'Delegate bounded research',
    parameters: Type.Object({}),
    replay: 'safe',
    async execute(_args, api, ctx) {
      const result = await api.executeTool('mutate', {}, ctx);
      assert.equal(result.isError, true);
      return {
        output: [{ type: 'text', text: 'nested mutation blocked' }],
        control: { addTools: ['mutate'] }
      };
    }
  });
  const provider = defineExtension({ name: 'provider', tools: [delegate, mutate] });
  file('user', custom('custom', ['research', 'mutate']));
  const roles = createWorkflowRoleServices({
    ...paths(),
    extensions: () => [provider],
    researchTools: () => [delegate]
  });
  const selected = roles.resolve('custom', { ceiling: 'analyst' });
  const { conversation, faux } = await openConversation(
    roles.prepare({ resolvedRole: selected }),
    roles
  );
  const offered: string[][] = [];
  faux.setResponses(
    Array.from({ length: 4 }, () => (request: TranscriptContext) => {
      offered.push(
        request.messages.flatMap((message) =>
          message.role === 'system' ? (message.toolsAdded?.map((tool) => tool.name) ?? []) : []
        )
      );
      const count = resultMessages(request).length;
      return count < 2
        ? fauxAssistantMessage([fauxToolCall(count === 0 ? 'mutate' : 'research', {})], {
            stopReason: 'toolUse'
          })
        : fauxAssistantMessage('finished');
    })
  );
  const submission = await conversation.submit(
    { type: 'input', content: 'Try direct and nested calls' },
    context
  );
  assert.equal((await submission.wait(context)).status, 'done');
  assert.equal(mutated, 0);
  assert.deepEqual(offered[0], ['research']);
  assert.ok(offered.every((names) => !names.includes('mutate')));
  const results = resultMessages({
    messages: [...(await conversation.context(context)).messages]
  } as TranscriptContext);
  assert.equal(results[0].isError, true);
  assert.match(JSON.stringify(results[1].content), /nested mutation blocked/);
});

test('controller-owned structured_output is available even with an empty ordinary allowlist', async () => {
  file('user', custom('custom', []));
  const roles = createWorkflowRoleServices({ ...paths(), extensions: () => [] });
  const selected = roles.resolve('custom');
  const output = createOutputExtension(Type.Object({ accepted: Type.Boolean() }));
  const extension = roles.prepare({ resolvedRole: selected }, output);
  assert.deepEqual(toolNames(extension), ['structured_output']);
  const { conversation, faux } = await openConversation(extension, roles);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('structured_output', { accepted: false })], {
      stopReason: 'toolUse'
    })
  ]);
  const submission = await conversation.submit(
    { type: 'input', content: 'Return the schema' },
    context
  );
  assert.equal((await submission.wait(context)).status, 'done');
});

test('agent task selects only explicit guarded tools rather than inherited host tools', async () => {
  const roles = createWorkflowRoleServices({ ...paths(), extensions: () => [] });
  const selected = roles.resolve('reviewer');
  const registry = createRegistry();
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage('Reviewed')]);
  const models = createModels();
  models.setProvider(faux.provider);
  const task = createAgentTask(
    {
      roles,
      install: (extension) => registry.install(extension),
      resolveProfile() {
        throw new Error('no profile');
      },
      extensions: () => ({ found: [], missing: [] }),
      notes: () => []
    },
    () => {
      throw new Error('no schema');
    }
  );
  registry.install(defineExtension({ name: 'test.tasks', tasks: [task] }));
  const harness = await Harness.open(
    new MemoryStorage(),
    { models: roles.guardModels(models), registry },
    context
  );
  harnesses.push(harness);
  const root = await harness.root(context);
  const id = await root.commit(
    (tx) =>
      tx.createTask(
        task,
        {
          attemptId: 1,
          key: 'review',
          prompt: 'Review',
          label: 'Review',
          role: 'reviewer',
          resolvedRole: selected,
          cwd: projectRoot,
          route: { provider: 'faux', modelId: 'faux-1', thinkingLevel: 'off' }
        },
        { ownership: { kind: 'conversation' } }
      ),
    context
  );
  const result = await harness.waitForTask(id, context);
  assert.equal(result.state.outcome.status, 'completed');
  const conversationId = result.state.outcome.result?.conversationId;
  const conversation = await harness.conversation(conversationId as ConversationId, context);
  assert.ok(conversation);
  const agent = await conversation.agent(context);
  assert.deepEqual(
    agent.tools.map((tool) => tool.name),
    ['read', 'ls', 'find', 'grep', 'git_inspect']
  );
  assert.equal(agent.extensions.length, 1);
  assert.match(agent.extensions[0].name, /^workflow\.role\./);
});

test('execute-phase crash recovery runs role guards even though beforeTool hooks are skipped', async () => {
  let effects = 0;
  const original = probe('effect', () => effects++);
  const provider = defineExtension({ name: 'provider', tools: [original] });
  file('user', custom('custom', ['effect']));
  const roles = createWorkflowRoleServices({ ...paths(), extensions: () => [provider] });
  const selected = roles.resolve('custom');
  const extension = roles.prepare({ resolvedRole: selected });
  const registry = createRegistry();
  registry.install(extension);
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('effect', {})], { stopReason: 'toolUse' })
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const path = join(directory, 'recovery.sqlite');
  const storage = await openNodeSqliteStorage(path);
  const commit = storage.commit.bind(storage);
  storage.commit = async (writes, ctx) => {
    const result = await commit(writes, ctx);
    if (
      writes.some(
        (write) =>
          write.type === 'task' &&
          write.value.kind === 'pi.tool' &&
          write.value.state.status === 'running' &&
          (write.value.state.checkpoint as { phase?: string }).phase === 'execute'
      )
    )
      throw new Error('crash after execution intent');
    return result;
  };
  const first = await Harness.open(
    storage,
    { registry, models: roles.guardModels(models), onReport() {} },
    context
  );
  harnesses.push(first);
  const conversation = await first.root(context, {
    agent: {
      model: { provider: 'faux', modelId: 'faux-1' },
      extensions: [extension],
      tools: [...(extension.tools ?? [])]
    }
  });
  const submission = await conversation.submit(
    { type: 'input', content: 'Execute bounded effect' },
    context
  );
  assert.equal((await first.closed).reason, 'failed');
  assert.equal(effects, 0);

  const restoredRoles = createWorkflowRoleServices({
    ...paths(),
    extensions: () => [provider],
    pinned: [selected]
  });
  const restored = restoredRoles.prepare({ resolvedRole: selected });
  assert.equal(restored.name, extension.name);
  const restoredRegistry = createRegistry();
  restoredRegistry.install(restored);
  // Revoke only after the required bootstrap succeeded, before the restored tool executes.
  writeFileSync(join(agentDir, 'agents/custom.md'), custom('custom', ['effect'], 'enabled: false'));
  const second = await Harness.open(
    await openNodeSqliteStorage(path),
    { registry: restoredRegistry, models: restoredRoles.guardModels(models), onReport() {} },
    context
  );
  harnesses.push(second);
  const pending = await second.submission(submission.id, context);
  assert.ok(pending);
  await pending.wait(context);
  assert.equal(effects, 0);
  const reattached = await second.conversation(conversation.id, context);
  assert.ok(reattached);
  const transcript = await reattached.context(context);
  assert.match(JSON.stringify(transcript.messages), /disabled or replaced/);
  assert.equal(roleHash(selected), roleHash(JSON.parse(JSON.stringify(selected))));
});

test.each(['user', 'project'] as const)(
  'current %s definition revocations block pinned selection and restoration without replacing instructions',
  (scope) => {
    const path = file(scope, custom('custom', ['read']));
    const roles = createWorkflowRoleServices({ ...paths(), extensions: () => [] });
    const selected = roles.resolve('custom');
    writeFileSync(path, custom('custom', ['read'], '', 'Edited instructions'));
    assert.equal(roles.resolve('custom').definition.instructions, 'Inspect assigned source.');
    for (const [tools, extra, diagnostic] of [
      [['read'], 'denyTools: [read]', /explicitly denied/],
      [[], '', /removed from.*allowlist/]
    ] as const) {
      writeFileSync(path, custom('custom', [...tools], extra, 'Edited instructions'));
      const restored = createWorkflowRoleServices({
        ...paths(),
        extensions: () => [],
        pinned: [selected]
      });
      assert.throws(() => roles.resolve('custom'), diagnostic);
      assert.throws(() => roles.prepare({ resolvedRole: selected }), diagnostic);
      assert.throws(() => restored.resolve('custom'), diagnostic);
      assert.throws(() => restored.prepare({ resolvedRole: selected }), diagnostic);
      assert.equal(selected.definition.instructions, 'Inspect assigned source.');
      assert.deepEqual(
        selected.policy.tools.map((tool) => tool.name),
        ['read']
      );
    }
  }
);

test('unknown, malformed, and disabled roles are rejected by agent() before the executor can spend', async () => {
  file('user', custom('disabled', [], 'enabled: false'), 'disabled.md');
  let paid = 0;
  for (const [id, diagnostic] of [
    ['missing', /unknown role/],
    ['disabled', /disabled/],
    ['malformed', /unknown field "thinkingLevel"/]
  ] as const) {
    if (id === 'malformed')
      file('user', custom('malformed', [], 'thinkingLevel: high'), 'malformed.md');
    const roles = createWorkflowRoleServices({ ...paths(), extensions: () => [] });
    await assert.rejects(
      runWorkflow(
        `export const meta = { name: 'roles', description: 'roles' }; return await agent('work', { role: '${id}' });`,
        {
          roleResolver: roles.resolve,
          agent: {
            async run() {
              paid++;
              return 'must not spend';
            }
          }
        }
      ),
      diagnostic
    );
  }
  assert.equal(paid, 0);
});
