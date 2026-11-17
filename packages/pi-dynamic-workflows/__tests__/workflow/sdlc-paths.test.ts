import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ownsPath, validatePlan } from '../../src/workflow/sdlc/validation.js';

function task(id: string, writes: string[]) {
  return {
    id,
    title: id,
    outcome: id,
    writes,
    dependsOn: [],
    inputs: [],
    checks: [],
    questionIds: []
  };
}

test('literal route filenames with brackets are valid ownership, not glob grants', () => {
  const path = 'app/[id]/page.tsx';
  assert.doesNotThrow(() =>
    validatePlan(
      {
        reason: 'Independent route files',
        tasks: [task('route', [path]), task('other', ['app/other.ts'])]
      },
      new Set(),
      new Set()
    )
  );
  assert.equal(ownsPath([path], path), true);
  assert.equal(ownsPath([path], 'app/123/page.tsx'), false);
});

test('relative directory aliases retain their intended scope and reject overlapping writers', () => {
  assert.equal(ownsPath(['./src/'], 'src/api.ts'), true);
  assert.equal(ownsPath(['.'], 'src/api.ts'), true);
  assert.equal(ownsPath(['src//api/'], 'src/api/index.ts'), true);
  assert.equal(ownsPath(['./src/'], 'other/api.ts'), false);
  assert.throws(
    () =>
      validatePlan(
        {
          reason: 'Invalid independent ownership',
          tasks: [task('root', ['.']), task('nested', ['./src/'])]
        },
        new Set(),
        new Set()
      ),
    /Overlapping/
  );
});

test('root grants never include traversal, absolute paths, or reserved Git metadata identities', () => {
  for (const path of [
    '../outside.ts',
    '/outside.ts',
    'C:/outside.ts',
    '../[git-index]',
    '../[git-head]',
    ''
  ])
    assert.equal(ownsPath(['*'], path), false);
  assert.equal(ownsPath([''], 'src/api.ts'), false);
});
