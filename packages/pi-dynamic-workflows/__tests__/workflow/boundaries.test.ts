import assert from 'node:assert/strict';
import { test } from 'vitest';
import { runWorkflow } from '../../src/workflow/runtime.js';

const meta = "export const meta = { name: 'boundaries', description: 'Runtime boundaries' }\n";
const agent = { run: async (prompt: string) => prompt };

test.each([
  'const clock = Date; return clock.now()',
  'const clock = Date; return new clock()',
  'const clock = Date; return clock()',
  'const random = Math.random; return random()',
  'const { random } = Math; return random()',
  "return globalThis['Date']['now']()",
  "return Math[['ran', 'dom'].join('')]()",
  'return new Date.prototype.constructor()'
])('runtime rejects aliased clock/random use: %s', async (body) => {
  await assert.rejects(runWorkflow(meta + body, { agent }), /must be deterministic/);
});

test.each([
  "return eval('1 + 1')",
  "return Function('return 1')()",
  "return (() => {}).constructor('return 1')()",
  "return (async () => {}).constructor('return 1')()"
])('runtime disables string code generation: %s', async (body) => {
  await assert.rejects(
    runWorkflow(meta + body, { agent }),
    /Code generation from strings disallowed/
  );
});

test('runtime disables WebAssembly code generation', async () => {
  await assert.rejects(
    runWorkflow(
      `${meta}return new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))`,
      { agent }
    ),
    /Wasm code generation disallowed/
  );
});

test('VM built-in mutations stay local and deterministic Date helpers still work', async () => {
  const floor = Math.floor;
  const stringify = JSON.stringify;
  const result = await runWorkflow(
    meta +
      `
    Math.floor = () => 42;
    JSON.stringify = () => 'changed';
    Array.prototype.workflowProbe = true;
    Object.prototype.workflowProbe = true;
    return [Math.floor(1.5), Date.parse('2020-01-01T00:00:00Z'), Date.UTC(2020, 0, 1)];`,
    { agent }
  );
  assert.deepEqual(structuredClone(result.result), [1, 1577836800000, 1577836800000]);
  assert.equal(Math.floor, floor);
  assert.equal(JSON.stringify, stringify);
  assert.equal(Object.hasOwn(Array.prototype, 'workflowProbe'), false);
  assert.equal(Object.hasOwn(Object.prototype, 'workflowProbe'), false);
  const next = await runWorkflow(`${meta}return JSON.stringify([1])`, { agent });
  assert.equal(next.result, '[1]');
});

test('unsupported isolation modes reject before invoking the executor', async () => {
  await assert.rejects(
    runWorkflow(`${meta}return await agent('p', { isolation: 'container' })`, { agent }),
    /non-enforced prompt hint/
  );
});

test('ordinary executor and parallel/pipeline branch failures return null', async () => {
  const result = await runWorkflow(
    meta +
      `
    return {
      agent: await agent('fail'),
      parallel: await parallel([() => { throw new Error('branch'); }, () => agent('ok')]),
      pipeline: await pipeline([1, 2], item => { if (item === 1) throw new Error('stage'); return item; })
    };`,
    {
      agent: {
        run: async (prompt) => {
          if (prompt === 'fail') throw new Error('ordinary failure');
          return prompt;
        }
      }
    }
  );
  assert.deepEqual(structuredClone(result.result), {
    agent: null,
    parallel: [null, 'ok'],
    pipeline: [null, 2]
  });
});
