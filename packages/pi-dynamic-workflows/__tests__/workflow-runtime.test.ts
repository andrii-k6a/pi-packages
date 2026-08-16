import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { WorkflowAgent } from '../src/agent.js';
import { type ResolvedWorkflowProfile, WorkflowProfileRoutingError } from '../src/profiles.js';
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
