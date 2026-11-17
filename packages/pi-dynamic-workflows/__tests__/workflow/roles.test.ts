import assert from 'node:assert/strict';
import { test } from 'vitest';
import { WorkflowProfileRoutingError } from '../../src/profiles/contracts.js';
import type { WorkflowAgentRunOptions } from '../../src/workflow/contracts.js';
import {
  assertResolvedRole,
  createRolePolicy,
  resolveStageRoles,
  roleContentHash,
  roleHash,
  validateRoleFields,
  WorkflowRoleError
} from '../../src/workflow/roles.js';
import { runWorkflow } from '../../src/workflow/runtime.js';

const source = { scope: 'user' as const, path: '/agents/custom.md' };
function definition(profile?: string) {
  const { enabled: _enabled, ...snapshot } = validateRoleFields(
    {
      name: 'custom',
      description: 'A custom role',
      tools: ['read', 'bash'],
      denyTools: ['bash'],
      profile
    },
    'Inspect the assignment.',
    source,
    roleContentHash('definition')
  );
  return snapshot;
}
const identity = (name: string) => ({ name, owner: 'admitted', implementation: name });
const resolved = () =>
  createRolePolicy(definition('fallback'), {}, [
    identity('read'),
    identity('bash'),
    identity('new-tool')
  ]);
const header = "export const meta = { name: 'role_test', description: 'Roles' }\n";

test('policies retain exact allowlists, denials, hashes and immutable snapshots', () => {
  const snapshot = definition();
  const result = createRolePolicy(snapshot, {}, [
    identity('read'),
    identity('bash'),
    identity('new-tool')
  ]);
  assert.deepEqual(
    result.policy.tools.map((tool) => tool.name),
    ['read']
  );
  assert.equal(result.policy.roleHash, roleHash(snapshot));
  snapshot.instructions = 'Changed after selection';
  assert.equal(result.definition.instructions, 'Inspect the assignment.');
  assertResolvedRole(JSON.parse(JSON.stringify(result)));
  result.definition.instructions = 'Corrupt saved snapshot';
  assert.throws(() => assertResolvedRole(result), /corrupt or unsupported/);
});

test('strict definitions reject unknown fields, wildcards, absent tools and controller output grants/denials', () => {
  const valid = { name: 'custom', description: 'Custom', tools: [] };
  for (const fields of [
    { ...valid, model: 'raw-model' },
    { ...valid, thinkingLevel: 'high' },
    { ...valid, tools: undefined },
    { ...valid, tools: 'read,bash' },
    { ...valid, tools: ['mcp_*'] },
    { ...valid, tools: ['read', 'read'] },
    { ...valid, tools: ['structured_output'] },
    { ...valid, denyTools: ['structured_output'] },
    { ...valid, enabled: 'false' },
    { ...valid, profile: '' }
  ])
    assert.throws(
      () => validateRoleFields(fields, 'Instructions', source, 'hash'),
      WorkflowRoleError
    );
  assert.deepEqual(validateRoleFields(valid, 'Instructions', source, 'hash').tools, []);
});

test('stage mappings reject unknown stages and incompatible packaged selections before scheduling', () => {
  let calls = 0;
  assert.throws(
    () =>
      resolveStageRoles({ typo: 'custom' } as never, () => {
        calls++;
        return resolved();
      }),
    /unknown stage/
  );
  assert.equal(calls, 0);
  assert.throws(
    () => resolveStageRoles({ analyst: 'custom' }, resolved),
    /resolver did not enforce/
  );
  const packaged = {
    ...definition(),
    id: 'implementer',
    source: { scope: 'packaged' as const, path: 'packaged:implementer' }
  };
  assert.throws(() => createRolePolicy(packaged, { ceiling: 'reviewer' }, []), /incompatible/);
});

test('runtime resolves roles before execution and preserves legacy prompt hints', async () => {
  const seen: WorkflowAgentRunOptions[] = [];
  const result = await runWorkflow(
    header +
      `
const enforced = await agent('inspect', { role: 'custom', toolset: 'review' });
const legacy = await agent('legacy', { agentType: 'reviewer' });
return [enforced, legacy];`,
    {
      agent: {
        async run(_prompt, options) {
          seen.push(options);
          return 'done';
        }
      },
      roleResolver(id, selection) {
        assert.equal(id, 'custom');
        assert.deepEqual(selection, { toolset: 'review' });
        return createRolePolicy(definition(), selection ?? {}, [identity('read')]);
      }
    }
  );
  assert.deepEqual(JSON.parse(JSON.stringify(result.result)), ['done', 'done']);
  assert.equal(seen[0].role, 'custom');
  assert.equal(seen[0].resolvedRole?.policy.reviewOnly, true);
  assert.match(seen[1].instructions ?? '', /Act as workflow subagent type: reviewer/);
  assert.equal(seen[1].resolvedRole, undefined);
});

test('runtime rejects missing resolvers, simultaneous selectors and script-owned internal policies', async () => {
  let paid = 0;
  for (const options of [
    "{ role: 'custom' }",
    "{ role: 'custom', agentType: 'legacy' }",
    "{ role: '' }",
    '{ resolvedRole: {} }',
    "{ cwd: '/tmp' }",
    '{ timeoutMs: 1 }',
    "{ ceiling: 'implementer' }"
  ]) {
    await assert.rejects(
      runWorkflow(`${header}return await agent('work', ${options});`, {
        agent: {
          async run() {
            paid++;
            return 'bad';
          }
        }
      }),
      WorkflowRoleError
    );
  }
  assert.equal(paid, 0);
});

test('role fallback follows task, phase and workflow routing and otherwise inherits the session', async () => {
  const seen: Array<string | undefined> = [];
  const route = (name: string) => ({
    model: { provider: 'faux', id: name },
    thinkingLevel: 'off' as const
  });
  const agent = {
    async run(_prompt: string, options: WorkflowAgentRunOptions) {
      seen.push(options.profile);
      return 'ok';
    }
  };
  const body = `
await agent('workflow', { role: 'custom' });
phase('phase', { profile: 'phase' });
await agent('phase', { role: 'custom' });
await agent('task', { role: 'custom', profile: 'task' });
return 'done';`;
  await runWorkflow(
    `export const meta = {name:'routing',description:'routing',profile:'workflow'}\n${body}`,
    { agent, roleResolver: resolved, profileResolver: route }
  );
  await runWorkflow(`${header}return await agent('fallback', {role:'custom'});`, {
    agent,
    roleResolver: resolved,
    profileResolver: route
  });
  await runWorkflow(`${header}return await agent('inherit', {role:'custom'});`, {
    agent,
    roleResolver: () => createRolePolicy(definition(), {}, [])
  });
  assert.deepEqual(seen, ['workflow', 'phase', 'task', 'fallback', undefined]);
  await assert.rejects(
    runWorkflow(`${header}return await agent('denied', {role:'custom'});`, {
      agent,
      roleResolver: resolved,
      profileResolver(name) {
        throw new WorkflowProfileRoutingError(name, 'not approved');
      }
    }),
    /not approved/
  );
});

test('role failures cannot be swallowed by parallel branches or script catch blocks', async () => {
  for (const body of [
    "return await parallel([() => agent('work', {role:'missing'})]);",
    "try { await agent('work', {role:'missing'}); } catch {} return 'accepted';",
    "return await pipeline([1], () => agent('work', {role:'missing'}));"
  ])
    await assert.rejects(
      runWorkflow(header + body, {
        agent: {
          async run() {
            throw new Error('must not run');
          }
        },
        roleResolver() {
          throw new WorkflowRoleError('missing definition');
        }
      }),
      /missing definition/
    );
});
