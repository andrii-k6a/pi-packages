import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'vitest';

const require = createRequire(import.meta.url);
const compiler = join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
const packageDir = join(import.meta.dirname, '..');

function node(args: string[]) {
  const result = spawnSync(process.execPath, args, { cwd: packageDir, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

test('editor declarations match runtime nullability and schema output', () => {
  node([compiler, '-p', '__tests__/fixtures/tsconfig.workflow.json']);
});

test('built package root is importable by a plain Node ESM consumer', () => {
  // A clean build must mirror src/, not retain artifacts of moved/deleted internal modules.
  rmSync(join(packageDir, 'dist'), { recursive: true, force: true });
  node([compiler, '-p', 'tsconfig.build.json']);
  const rootArtifacts = readdirSync(join(packageDir, 'dist'), { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  assert.deepEqual(rootArtifacts.sort(), [
    'dynamic-workflows.d.ts',
    'dynamic-workflows.js',
    'library.d.ts',
    'library.js'
  ]);
  node([compiler, '-p', '__tests__/fixtures/tsconfig.library.json']);
  const stdout = node([
    '--input-type=module',
    '-e',
    `
    import assert from 'node:assert/strict';
    import { WorkflowHost, createMcpProvider, runWorkflow } from '@andrii-k6a/pi-dynamic-workflows';
    const host = new WorkflowHost({ providers: [createMcpProvider({ allowlist: { servers: {} } })] });
    assert.equal(typeof host.start, 'function');
    await host.closeAll();
    const result = await runWorkflow("export const meta = { name: 'consumer', description: 'smoke' }\\nreturn await agent('ok')", {
      agent: { run: async (prompt) => prompt }
    });
    assert.equal(result.result, 'ok');
    console.log('consumer ok');
  `
  ]);
  assert.match(stdout, /consumer ok/);
}, 30_000);
