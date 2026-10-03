import assert from 'node:assert/strict';
import type { Usage } from '@earendil-works/pi-ai';
import { test } from 'vitest';
import type { WorkflowAgent } from '../src/agent.js';
import { type ResolvedWorkflowProfile, WorkflowProfileRoutingError } from '../src/profiles.js';
import { emptyUsage } from '../src/usage.js';
import { runWorkflow } from '../src/workflow.js';

const fakeAgent: Pick<WorkflowAgent, 'run'> = {
  async run(prompt: string): Promise<never> {
    return `result:${prompt}` as never;
  }
};

function profile(name: string): ResolvedWorkflowProfile {
  return { model: { id: name } as never, thinkingLevel: 'low' };
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
  const agent: Pick<WorkflowAgent, 'run'> = {
    async run(prompt, options): Promise<never> {
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
      return `result:${prompt}` as never;
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
  const agent: Pick<WorkflowAgent, 'run'> = {
    async run(prompt, options): Promise<never> {
      if (prompt === 'reported') {
        options?.onUsage?.({ ...emptyUsage(), totalTokens: 40 });
        return 'a long result that would have a different token estimate' as never;
      }
      if (prompt === 'zero') {
        options?.onUsage?.(emptyUsage());
        return '123456' as never; // Zero usage means none reported: JSON length 8 -> 2 tokens.
      }
      if (prompt === 'failed') throw new Error('no reported usage');
      return '12345678' as never; // JSON string length 10 -> estimated as 3 tokens.
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
  const calls: Array<{ prompt: string; sessionOverride?: ResolvedWorkflowProfile }> = [];
  const agent: Pick<WorkflowAgent, 'run'> = {
    async run(prompt, options): Promise<never> {
      calls.push({
        prompt,
        sessionOverride: (options as { sessionOverride?: ResolvedWorkflowProfile }).sessionOverride
      });
      return `result:${prompt}` as never;
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
    calls.map((call) => [call.prompt, call.sessionOverride?.model.id]),
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
  const agent: Pick<WorkflowAgent, 'run'> = {
    async run(_prompt, options): Promise<never> {
      override = (options as { sessionOverride?: unknown }).sessionOverride;
      return 'ok' as never;
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
  const agent: Pick<WorkflowAgent, 'run'> = {
    async run(): Promise<never> {
      calls++;
      return 'unexpected' as never;
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
