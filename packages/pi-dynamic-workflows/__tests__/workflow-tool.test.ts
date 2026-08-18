import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createWorkflowSessionOptions, createWorkflowTool } from '../src/workflow-tool.js';

test('createWorkflowSessionOptions passes Pi 0.84 model runtime metadata to subagents', () => {
  const runtime = {
    getAuth() {},
    getModel() {},
    getAvailable() {},
    hasConfiguredAuth() {},
    streamSimple() {}
  };
  const model = { provider: 'test', id: 'model' };
  const scopedModels = [{ model, thinkingLevel: 'high' }];

  const options = createWorkflowSessionOptions({
    modelRegistry: { runtime },
    model,
    thinkingLevel: 'medium',
    scopedModels
  } as never);

  assert.equal(options.modelRuntime, runtime);
  assert.equal(options.model, model);
  assert.equal(options.thinkingLevel, 'medium');
  assert.deepEqual(options.scopedModels, scopedModels);
  assert.notEqual(options.scopedModels, scopedModels);
});

test('createWorkflowSessionOptions fails clearly when Pi runtime is unavailable', () => {
  assert.throws(
    () =>
      createWorkflowSessionOptions({
        modelRegistry: {},
        model: undefined,
        thinkingLevel: undefined,
        scopedModels: []
      } as never),
    /workflow requires Pi ModelRuntime/
  );
});

test('createWorkflowTool describes phases as optional and dynamic', () => {
  const tool = createWorkflowTool();

  assert.match(
    tool.promptSnippet ?? '',
    /export const meta = \{ name: 'short_snake_case', description:/
  );
  assert.doesNotMatch(tool.promptSnippet ?? '', /phases: \[/);
  assert.ok(
    tool.promptGuidelines?.some((line) => line.includes('meta.phases is optional metadata'))
  );
  assert.ok(
    tool.promptGuidelines?.some((line) =>
      line.includes('Phase names may be conditional or built in a loop')
    )
  );
});

test('createWorkflowTool omits profile guidance when no profiles are configured', () => {
  const guidance = createWorkflowTool().promptGuidelines?.join('\n') ?? '';

  assert.doesNotMatch(guidance, /Available profiles:/);
  assert.doesNotMatch(guidance, /Profile precedence/);
});

test('createWorkflowTool exposes profile names and descriptions without routing internals', () => {
  const tool = createWorkflowTool({
    profiles: [
      {
        name: 'fast',
        description: 'Quick repository triage',
        provider: 'SENTINEL_PROVIDER',
        model: 'SENTINEL_RAW_MODEL',
        thinkingLevel: 'xhigh'
      },
      {
        name: 'thorough',
        description: 'Careful architecture review',
        provider: 'SECOND_SENTINEL_PROVIDER',
        model: 'SECOND_SENTINEL_RAW_MODEL',
        thinkingLevel: 'high'
      }
    ]
  });
  const guidance = tool.promptGuidelines?.at(-1) ?? '';

  assert.match(guidance, /^- "fast" — Quick repository triage$/m);
  assert.match(guidance, /^- "thorough" — Careful architecture review$/m);
  assert.match(guidance, /profile order has no meaning/);
  assert.match(
    guidance,
    /profile: "<profile-name>".*phase\("Review", \{ profile: "<profile-name>" \}\).*agent\("\.\.\.", \{ profile: "<profile-name>" \}\)/s
  );
  assert.match(guidance, /agent > phase > workflow > active session/);
  assert.match(guidance, /`phase\("Next phase"\)` without `profile` resets routing/);
  assert.match(guidance, /`meta\.phases` is documentation only/);
  assert.doesNotMatch(guidance, /SENTINEL_PROVIDER|SENTINEL_RAW_MODEL|xhigh|high/);
});
