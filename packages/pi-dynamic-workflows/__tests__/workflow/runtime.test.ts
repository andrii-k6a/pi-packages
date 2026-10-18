import assert from 'node:assert/strict';
import type { Usage } from '@earendil-works/pi-ai';
import { test } from 'vitest';
import {
  type ResolvedWorkflowProfile,
  WorkflowProfileRoutingError
} from '../../src/profiles/contracts.js';
import { emptyUsage } from '../../src/shared/usage.js';
import type { WorkflowAgentExecutor } from '../../src/workflow/contracts.js';
import { runWorkflow } from '../../src/workflow/runtime.js';

const fakeAgent: WorkflowAgentExecutor = {
  async run(prompt) {
    return `result:${prompt}`;
  }
};

function profile(name: string): ResolvedWorkflowProfile {
  return { model: { provider: 'faux', id: name }, thinkingLevel: 'low' };
}

function resolver(name: string): ResolvedWorkflowProfile {
  if (!['workflow', 'phase', 'agent'].includes(name)) {
    throw new WorkflowProfileRoutingError(name, 'the profile is not approved');
  }
  return profile(name);
}

test('runWorkflow accepts metadata without phases and records runtime phases', async () => {
  const result = await runWorkflow(
    `export const meta = {
  name: 'dynamic_demo',
  description: 'Use runtime phases'
}

phase('Scan')
const scan = await agent('scan', { label: 'scan' })
return { scan }
`,
    { agent: fakeAgent }
  );

  assert.deepEqual(result.phases, ['Scan']);
  assert.equal(result.agentCount, 1);
  assert.equal((result.result as { scan: string }).scan, 'result:scan');
  assert.deepEqual(result.usage, emptyUsage());
});

test('runWorkflow aggregates parallel successes and failed agents, including their spent tokens', async () => {
  const agent: WorkflowAgentExecutor = {
    async run(prompt, options) {
      const tokens = prompt === 'fail' ? 30 : prompt === 'first' ? 10 : 20;
      const usage: Usage = {
        ...emptyUsage(),
        input: tokens - 1,
        output: 1,
        totalTokens: tokens,
        cost: { ...emptyUsage().cost, total: tokens / 100 }
      };
      options?.onUsage?.(usage);
      if (prompt === 'fail') throw new Error('spent before failure');
      return `result:${prompt}`;
    }
  };
  const result = await runWorkflow(
    `export const meta = { name: 'usage', description: 'Account for all agents' }
const results = await parallel(['first', 'fail', 'third'].map(name => () => agent(name)))
return { results, spent: budget.spent() }
`,
    { agent }
  );

  assert.deepEqual(JSON.parse(JSON.stringify(result.result)), {
    results: ['result:first', null, 'result:third'],
    spent: 60
  });
  assert.equal(result.usage.totalTokens, 60);
  assert.equal(result.usage.input, 57);
  assert.equal(result.usage.output, 3);
  assert.ok(Math.abs(result.usage.cost.total - 0.6) < 1e-12);
  assert.equal(result.logs.length, 1);
  assert.match(result.logs[0], /spent before failure/);
});

test('budget.spent uses reported tokens and estimates only successful runs without reported usage', async () => {
  const agent: WorkflowAgentExecutor = {
    async run(prompt, options) {
      if (prompt === 'reported') {
        options?.onUsage?.({ ...emptyUsage(), totalTokens: 40 });
        return 'a long result that would have a different token estimate';
      }
      if (prompt === 'zero') {
        options?.onUsage?.(emptyUsage());
        return '123456'; // Zero usage means none reported: JSON length 8 -> 2 tokens.
      }
      if (prompt === 'failed') throw new Error('no reported usage');
      return '12345678'; // JSON string length 10 -> estimated as 3 tokens.
    }
  };
  const result = await runWorkflow(
    `export const meta = { name: 'budget', description: 'Track actual tokens' }
await agent('reported')
const afterReported = budget.spent()
await agent('zero')
const afterZero = budget.spent()
await agent('failed')
const afterFailure = budget.spent()
await agent('fallback')
return { afterReported, afterZero, afterFailure, total: budget.spent() }
`,
    { agent }
  );

  assert.deepEqual(JSON.parse(JSON.stringify(result.result)), {
    afterReported: 40,
    afterZero: 42,
    afterFailure: 42,
    total: 45
  });
  assert.deepEqual(result.usage, { ...emptyUsage(), totalTokens: 40 });
});

test('runWorkflow normalizes string-shorthand meta.phases in the returned meta', async () => {
  const result = await runWorkflow(
    `export const meta = {
  name: 'shorthand_demo',
  description: 'Use plain-string phases',
  phases: ['Scan', 'Review']
}

phase('Scan')
await agent('scan', { label: 'scan' })
return { ok: true }
`,
    { agent: fakeAgent }
  );

  assert.deepEqual(result.meta.phases, [{ title: 'Scan' }, { title: 'Review' }]);
});

test('runWorkflow records loop-created phases without skipped conditional phases', async () => {
  const result = await runWorkflow(
    `export const meta = {
  name: 'loop_demo',
  description: 'Create phases from work items',
  phases: [{ title: 'Review' }]
}

if (args.needsReview) {
  phase('Review')
  await agent('review', { label: 'review' })
}

for (const area of args.areas) {
  phase('Inspect ' + area)
  await agent('inspect ' + area, { label: 'inspect ' + area })
}

return { ok: true }
`,
    {
      args: { needsReview: false, areas: ['API', 'UI'] },
      agent: fakeAgent
    }
  );

  assert.deepEqual(result.phases, ['Inspect API', 'Inspect UI']);
  assert.equal(result.agentCount, 2);
});

test('runWorkflow applies agent, phase, and workflow profiles with phase reset behavior', async () => {
  const calls: Array<{ prompt: string; route?: ResolvedWorkflowProfile }> = [];
  const agent: WorkflowAgentExecutor = {
    async run(prompt, options) {
      calls.push({ prompt, route: options.route });
      return `result:${prompt}`;
    }
  };

  await runWorkflow(
    `export const meta = {
  name: 'routing',
  description: 'Use profiles',
  profile: 'workflow'
}
await agent('workflow')
phase('Phase', { profile: 'phase' })
await agent('phase')
await agent('agent', { profile: 'agent' })
phase('Reset')
await agent('reset')
return true
`,
    { agent, profileResolver: resolver }
  );

  assert.deepEqual(
    calls.map((call) => [call.prompt, call.route?.model.id]),
    [
      ['workflow', 'workflow'],
      ['phase', 'phase'],
      ['agent', 'agent'],
      ['reset', 'workflow']
    ]
  );
});

test('runWorkflow reports the effective profile after agent, phase, and workflow precedence', async () => {
  const profiles: string[] = [];

  await runWorkflow(
    `export const meta = {
  name: 'profile_display',
  description: 'Report selected profiles',
  profile: 'workflow'
}
await agent('workflow')
phase('Phase', { profile: 'phase' })
await agent('phase')
await agent('agent', { profile: 'agent' })
return true
`,
    {
      agent: fakeAgent,
      profileResolver: resolver,
      onAgentStart(event) {
        profiles.push(event.profile ?? 'inherited');
      }
    }
  );

  assert.deepEqual(profiles, ['workflow', 'phase', 'agent']);
});

test('runWorkflow preserves session inheritance when no profile is selected', async () => {
  let override: unknown = 'unset';
  const agent: WorkflowAgentExecutor = {
    async run(_prompt, options) {
      override = options.route;
      return 'ok';
    }
  };

  await runWorkflow(
    "export const meta = { name: 'inherit', description: 'Keep defaults' }\nawait agent('scan')\nreturn true",
    { agent }
  );

  assert.equal(override, undefined);
});

test('runWorkflow fails profile routing at workflow, phase, and agent scope before a subagent runs', async () => {
  let calls = 0;
  let starts = 0;
  const agent: WorkflowAgentExecutor = {
    async run() {
      calls++;
      return 'unexpected';
    }
  };
  const rejectUnknown = (name: string) => {
    throw new WorkflowProfileRoutingError(name, 'the profile is not approved');
  };

  for (const script of [
    "export const meta = { name: 'workflow_bad', description: 'bad', profile: 'missing' }\nawait agent('scan')",
    "export const meta = { name: 'phase_bad', description: 'bad' }\nphase('Scan', { profile: 'missing' })\nawait agent('scan')",
    "export const meta = { name: 'agent_bad', description: 'bad' }\nawait agent('scan', { profile: 'missing' })"
  ]) {
    await assert.rejects(
      () =>
        runWorkflow(script, {
          agent,
          profileResolver: rejectUnknown,
          onAgentStart() {
            starts++;
          }
        }),
      /profile is not approved/
    );
  }
  assert.equal(calls, 0);
  assert.equal(starts, 0);
});

test('runWorkflow does not convert profile routing failures in parallel or pipeline to null', async () => {
  const rejectUnknown = (name: string) => {
    throw new WorkflowProfileRoutingError(name, 'the profile is not approved');
  };

  await assert.rejects(
    () =>
      runWorkflow(
        "export const meta = { name: 'parallel_bad', description: 'bad' }\nreturn await parallel([() => agent('scan', { profile: 'missing' })])",
        { agent: fakeAgent, profileResolver: rejectUnknown }
      ),
    /profile is not approved/
  );
  await assert.rejects(
    () =>
      runWorkflow(
        "export const meta = { name: 'pipeline_bad', description: 'bad' }\nreturn await pipeline([1], () => agent('scan', { profile: 'missing' }))",
        { agent: fakeAgent, profileResolver: rejectUnknown }
      ),
    /profile is not approved/
  );
});

test('runWorkflow rejects retired raw model options without putting them in instructions', async () => {
  await assert.rejects(
    () =>
      runWorkflow(
        "export const meta = { name: 'legacy_model', description: 'bad' }\nawait agent('scan', { model: 'raw-model' })",
        { agent: fakeAgent }
      ),
    /agent model selection was removed; select an approved named profile/
  );
});

test('runWorkflow rejects unawaited nested agent promises before returning details', async () => {
  let ended = 0;

  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = {
  name: 'promise_leak',
  description: 'Return an unawaited agent promise'
}

phase('Leak promise')
const scan = agent('scan', { label: 'scan' })
return { scan }
`,
        {
          agent: fakeAgent,
          onAgentEnd() {
            ended++;
          }
        }
      ),
    /workflow result must be structured-cloneable; did you forget to await agent\(\), parallel\(\), or pipeline\(\)\?.*Promise.*cloned/
  );

  assert.equal(ended, 1);
});

test('runWorkflow rejects non-string runtime phase titles', async () => {
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = {
  name: 'bad_phase',
  description: 'Use a non-string phase title'
}

phase(Promise.resolve('Scan'))
return { ok: true }
`,
        { agent: fakeAgent }
      ),
    /phase title must be a string/
  );
});

test('runWorkflow allows prompts that mention nondeterministic API names', async () => {
  const result = await runWorkflow(
    `export const meta = {
  name: 'prompt_mentions',
  description: 'Ask about Date.now(), Math.random(), and new Date() usage'
}

phase('Catalog mentions')
const scan = await agent('Catalog Date.now(), Math.random(), and new Date() usage', { label: 'scan' })
return { scan }
`,
    { agent: fakeAgent }
  );

  assert.equal(
    (result.result as { scan: string }).scan,
    'result:Catalog Date.now(), Math.random(), and new Date() usage'
  );
});

test('runWorkflow fails loudly for an unawaited profile-routing failure', async () => {
  const rejectUnknown = (name: string) => {
    throw new WorkflowProfileRoutingError(name, 'the profile is not approved');
  };

  await assert.rejects(
    () =>
      runWorkflow(
        "export const meta = { name: 'unawaited_bad', description: 'bad' }\nagent('scan', { profile: 'missing' })\nreturn true",
        { agent: fakeAgent, profileResolver: rejectUnknown }
      ),
    /profile is not approved/
  );
});

const header = "export const meta = { name: 'audit_fixes', description: 'regression coverage' }\n";

/** Values built inside the script's VM realm have foreign prototypes; compare them as JSON. */
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

test('log() and console.* record every argument, inspect objects, and bound long lines', async () => {
  const result = await runWorkflow(
    `${header}
console.log('count:', 5, { a: 1, nested: { b: [1, 2] } })
log({ a: 1 }, [1, 2], undefined, null)
console.warn('careful', 'now')
console.error('bad', new Error('boom'))
log('x'.repeat(5000))
await agent('go')
return true`,
    { agent: fakeAgent }
  );

  assert.deepEqual(result.logs.slice(0, 4), [
    'count: 5 { a: 1, nested: { b: [ 1, 2 ] } }',
    '{ a: 1 } [ 1, 2 ] undefined null',
    '[warn] careful now',
    '[error] bad Error: boom'
  ]);
  assert.equal(result.logs[4].length, 2000);
  assert.ok(result.logs[4].endsWith('…'));
});

test('a rejected phase profile changes nothing, even when the script swallows the error', async () => {
  const seen: Array<{ profile?: string; route?: ResolvedWorkflowProfile; phase?: string }> = [];
  const executor: WorkflowAgentExecutor = {
    async run(_prompt, options) {
      seen.push({ profile: options.profile, route: options.route, phase: options.phase });
      return 'ok';
    }
  };

  await assert.rejects(
    () =>
      runWorkflow(
        `${header}
phase('Good', { profile: 'phase' })
try { phase('Bad', { profile: 'missing' }) } catch (error) { log('swallowed') }
await agent('after')
return true`,
        { agent: executor, profileResolver: resolver }
      ),
    /profile is not approved/,
    'the routing failure still fails the workflow'
  );
  // The agent kept the previous phase, profile name, and route together; none was half-updated.
  assert.deepEqual(seen, [{ profile: 'phase', route: profile('phase'), phase: 'Good' }]);
});

test('agent schemas must be JSON Schema objects with an object root', async () => {
  const calls: unknown[] = [];
  const executor: WorkflowAgentExecutor = {
    async run(_prompt, options) {
      calls.push(options.schema);
      return { ok: true };
    }
  };
  for (const schema of [
    "{ type: 'array', items: { type: 'string' } }",
    "{ properties: { a: { type: 'string' } } }",
    "[{ type: 'object' }]",
    'null',
    "'object'"
  ]) {
    await assert.rejects(
      () =>
        runWorkflow(`${header}await agent('x', { schema: ${schema} })\nreturn 1`, {
          agent: executor
        }),
      /JSON Schema object with `type: "object"` at its root/,
      schema
    );
  }
  assert.deepEqual(calls, [], 'the executor is never invoked for an unusable schema');

  const ok = await runWorkflow(
    `${header}return await agent('x', { schema: { type: 'object', properties: {} } })`,
    { agent: executor }
  );
  assert.deepEqual(plain(ok.result), { ok: true });
  assert.equal(calls.length, 1);
});

test('maxAgents rejects agent() calls beyond the limit, without calling the executor', async () => {
  let runs = 0;
  const executor: WorkflowAgentExecutor = {
    async run() {
      runs++;
      return 'ok';
    }
  };
  const result = await runWorkflow(
    `${header}
const outcomes = []
for (let i = 0; i < 4; i++) {
  try { outcomes.push(await agent('call ' + i)) } catch (error) { outcomes.push(error.message) }
}
return outcomes`,
    { agent: executor, maxAgents: 2 }
  );

  assert.equal(runs, 2);
  assert.deepEqual(plain(result.result), [
    'ok',
    'ok',
    'workflow agent limit reached: at most 2 agent() calls are allowed per attempt',
    'workflow agent limit reached: at most 2 agent() calls are allowed per attempt'
  ]);
});

test('an agent() call that fails validation does not use up the agent limit', async () => {
  const result = await runWorkflow(
    `${header}
try { await agent(42) } catch {}
try { await agent('x', { isolation: 'nope' }) } catch {}
return await agent('real')`,
    { agent: fakeAgent, maxAgents: 1 }
  );
  assert.equal(result.result, 'result:real');
});

test('tokenBudget feeds budget.total/remaining and stops agent() once spent', async () => {
  const executor: WorkflowAgentExecutor = {
    async run(_prompt, options) {
      options.onUsage?.({ ...emptyUsage(), input: 40, output: 10, totalTokens: 50 });
      return 'ok';
    }
  };
  const result = await runWorkflow(
    `${header}
const before = { total: budget.total, remaining: budget.remaining() }
await agent('one')
const middle = budget.remaining()
await agent('two')
let after
try { await agent('three') } catch (error) { after = error.message }
return { before, middle, spent: budget.spent(), after }`,
    { agent: executor, tokenBudget: 100 }
  );
  assert.deepEqual(plain(result.result), {
    before: { total: 100, remaining: 100 },
    middle: 50,
    spent: 100,
    after: 'workflow token budget exhausted'
  });
});

test('a non-finite concurrency falls back to the default limit instead of disabling it', async () => {
  let active = 0;
  let peak = 0;
  const executor: WorkflowAgentExecutor = {
    async run() {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return 'ok';
    }
  };
  await runWorkflow(
    `${header}await parallel(Array.from({ length: 40 }, (_, i) => () => agent('p' + i)))\nreturn 1`,
    { agent: executor, concurrency: Number.NaN }
  );
  assert.ok(peak >= 1 && peak <= 16, `peak concurrency ${peak} stays within the hard limit`);
});

test('scripts cannot block the event loop through Atomics or shared memory', async () => {
  const result = await runWorkflow(
    `${header}await agent('x')\nreturn [typeof Atomics, typeof SharedArrayBuffer, typeof ArrayBuffer]`,
    { agent: fakeAgent }
  );
  assert.deepEqual(plain(result.result), ['undefined', 'undefined', 'function']);
});

test('a long synchronous stretch before the first await is interrupted', async () => {
  await assert.rejects(
    () =>
      runWorkflow(
        // Not a constant-true loop, so the parser accepts it; only the runtime bound can stop it.
        `${header}for (let i = 0; i < 1e15; i++) {}\nreturn await agent('x')`,
        { agent: fakeAgent, syncTimeoutMs: 50 }
      ),
    /ran for more than \d+s before its first await/
  );
});
