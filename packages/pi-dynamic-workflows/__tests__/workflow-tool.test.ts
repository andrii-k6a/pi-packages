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
