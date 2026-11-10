import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, test } from 'vitest';
import {
  captureCodeReviewChanges,
  parseCodeReviewCommand
} from '../../src/pi/code-review-input.js';
import { MAX_REVIEW_DIFF_CHARS } from '../../src/workflow/builtins/code-review-input.js';

const exec = promisify(execFile);
let directory: string;
let cwd: string;
const git = async (...args: string[]) => (await exec('git', args, { cwd })).stdout;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'review-capture-'));
  cwd = join(directory, 'repo');
  await exec('git', ['init', '-q', cwd]);
  await writeFile(join(cwd, 'tracked.ts'), 'old\n');
  await writeFile(join(cwd, 'other.ts'), 'old\n');
  await writeFile(join(cwd, '.gitignore'), 'ignored/\n');
  await git('add', '.');
  await git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '-qm',
    'base'
  );
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

test.each([
  ['', { mode: 'changes', trackedOnly: false }],
  ['--files', { mode: 'files', path: undefined, trackedOnly: false }],
  [
    '--files --profile "deep review" "src with spaces;$(echo no)"',
    {
      mode: 'files',
      profile: 'deep review',
      path: 'src with spaces;$(echo no)',
      trackedOnly: false
    }
  ],
  [
    "--profile thorough --tracked-only 'src [x]'",
    { mode: 'changes', profile: 'thorough', path: 'src [x]', trackedOnly: true }
  ],
  ['-- --files', { mode: 'changes', path: '--files', trackedOnly: false }],
  ['"a\\\\b.ts"', { mode: 'changes', path: 'a\\b.ts', trackedOnly: false }],
  ['src\\ path', { mode: 'changes', path: 'src path', trackedOnly: false }],
  [
    '--base origin/main --goal "Review \\"XYZ\\"; $(touch nope)\nfailures" "src dir"',
    {
      mode: 'changes',
      base: 'origin/main',
      goal: 'Review "XYZ"; $(touch nope)\nfailures',
      path: 'src dir',
      trackedOnly: false
    }
  ]
])('parses literal arguments without a shell: %s', (input, expected) => {
  assert.deepEqual(parseCodeReviewCommand(input as string), {
    path: undefined,
    profile: undefined,
    base: undefined,
    goal: undefined,
    ...(expected as object)
  });
});

test.each([
  '--files --tracked-only',
  '--profile',
  '--profile " "',
  '--profile --files',
  '--unknown',
  'src second',
  'src --files',
  '"unterminated',
  '""',
  '--profile first --profile second',
  '--base',
  '--base " "',
  '--base --files',
  '--base main --base other',
  '--files --base main',
  '--goal',
  '--goal " "',
  '--goal one --goal two',
  '--files --files',
  '--tracked-only --tracked-only'
])('rejects invalid arguments: %s', (input) => {
  assert.throws(
    () => parseCodeReviewCommand(input),
    /cannot be combined|requires|Unknown|one literal path|Unclosed|only one/
  );
});

test('captures staged, unstaged, intent-to-add, and untracked text without modifying the index or checkout', async () => {
  await writeFile(join(cwd, 'tracked.ts'), 'staged\n');
  await git('add', 'tracked.ts');
  await writeFile(join(cwd, 'other.ts'), 'unstaged\n');
  await writeFile(join(cwd, 'intent.ts'), 'intent to add\n');
  await git('add', '-N', 'intent.ts');
  await writeFile(join(cwd, 'new.anything'), 'unreferenced addition\n');
  await mkdir(join(cwd, 'ignored'));
  await writeFile(join(cwd, 'ignored/cache'), 'ignored cache\n');
  const beforeIndex = await git('ls-files', '--stage', '-z');
  const beforeStatus = await git('status', '--porcelain=v1', '-z');
  const input = await captureCodeReviewChanges(cwd, undefined, false);
  assert.ok(input?.args.diff);
  for (const content of ['staged', 'unstaged', 'intent to add', 'unreferenced addition']) {
    assert.ok(input.args.diff.includes(`+${content}\n`));
  }
  assert.equal(input.args.diff.split('diff --git a/intent.ts ').length - 1, 1);
  assert.doesNotMatch(input.args.diff, /ignored cache/);
  assert.deepEqual(input.args.capture?.includedAdditions, ['new.anything']);
  assert.equal(input.args.capture?.untracked, 'included');
  assert.equal(await git('ls-files', '--stage', '-z'), beforeIndex);
  assert.equal(await git('status', '--porcelain=v1', '-z'), beforeStatus);
  assert.equal(await readFile(join(cwd, 'new.anything'), 'utf8'), 'unreferenced addition\n');
});

test('untracked-only scopes start reviews, while tracked-only explicitly excludes them', async () => {
  await writeFile(join(cwd, 'new.ts'), 'new code\n');
  assert.ok(
    (await captureCodeReviewChanges(cwd, undefined, false))?.args.diff?.includes('+new code')
  );
  assert.equal(await captureCodeReviewChanges(cwd, undefined, true), undefined);
  await writeFile(join(cwd, 'tracked.ts'), 'tracked edit\n');
  const input = await captureCodeReviewChanges(cwd, undefined, true);
  assert.ok(input?.args.diff);
  assert.doesNotMatch(input.args.diff, /new code/);
  assert.equal(input.args.capture?.untracked, 'excluded');
});

test('preserves empty files, missing final newlines, and unusual filenames as valid new-file patches', async () => {
  const files = new Map([
    ['empty file.ts', ''],
    ['new\t[x];$(echo no).ts', 'no newline'],
    ['line\nbreak.ts', 'line\n'],
    ['back\\slash"é.ts', 'unicode café\n']
  ]);
  for (const [name, content] of files) await writeFile(join(cwd, name), content);
  const input = await captureCodeReviewChanges(cwd, undefined, false);
  assert.ok(input?.args.diff);
  assert.deepEqual(new Set(input.args.capture?.includedAdditions), new Set(files.keys()));
  assert.match(input.args.diff, /\\ No newline at end of file/);
  const patch = join(directory, 'captured.patch');
  await writeFile(patch, input.args.diff);
  const destination = join(directory, 'apply');
  await exec('git', ['init', '-q', destination]);
  await exec('git', ['apply', patch], { cwd: destination });
  for (const [name, content] of files)
    assert.equal(await readFile(join(destination, name), 'utf8'), content);
});

test('records binary and symlink exclusions instead of claiming content coverage', async () => {
  await writeFile(join(cwd, 'new.ts'), 'review me\n');
  await writeFile(join(cwd, 'binary'), Buffer.from([0, 1, 2]));
  await writeFile(join(cwd, 'non-utf8'), Buffer.from([0xff, 0xfe]));
  const outside = join(directory, 'outside');
  await writeFile(outside, 'private content that must not be read\n');
  await symlink(outside, join(cwd, 'link'));
  const input = await captureCodeReviewChanges(cwd, undefined, false);
  assert.deepEqual(input?.args.capture?.includedAdditions, ['new.ts']);
  assert.deepEqual(input?.args.capture?.exclusions, [
    { path: 'binary', reason: 'binary or non-UTF-8 content' },
    { path: 'link', reason: 'symlink not followed' },
    { path: 'non-utf8', reason: 'binary or non-UTF-8 content' }
  ]);
  assert.doesNotMatch(input?.args.diff ?? '', /private content/);
});

test.each([0, 0xff])(
  'large clearly binary additions are excluded before the text size limit (byte %i)',
  async (byte) => {
    await writeFile(join(cwd, 'tracked.ts'), 'tracked edit\n');
    await writeFile(join(cwd, 'new.ts'), 'new addition\n');
    await writeFile(join(cwd, 'large.bin'), Buffer.alloc(900 * 1024, byte));
    const beforeIndex = await git('ls-files', '--stage', '-z');
    const beforeStatus = await git('status', '--porcelain=v1', '-z');
    const input = await captureCodeReviewChanges(cwd, undefined, false);
    assert.match(input?.args.diff ?? '', /\+tracked edit/);
    assert.match(input?.args.diff ?? '', /\+new addition/);
    assert.deepEqual(input?.args.capture?.includedAdditions, ['new.ts']);
    assert.deepEqual(input?.args.capture?.exclusions, [
      { path: 'large.bin', reason: 'binary or non-UTF-8 content' }
    ]);
    assert.equal(await git('ls-files', '--stage', '-z'), beforeIndex);
    assert.equal(await git('status', '--porcelain=v1', '-z'), beforeStatus);
  }
);

test('a scope containing only unsupported content does not become a clean review', async () => {
  await writeFile(join(cwd, 'binary'), Buffer.from([0, 1]));
  await assert.rejects(
    captureCodeReviewChanges(cwd, undefined, false),
    /No content-reviewable changes.*not content-reviewed/i
  );
});

test('literal filtering from a repository subdirectory keeps repository-relative locations and the correct run directory', async () => {
  const subdirectory = join(cwd, 'sub [x];dir');
  await mkdir(subdirectory);
  await writeFile(join(subdirectory, 'new.ts'), 'selected\n');
  await writeFile(join(cwd, 'unrelated.ts'), 'outside selected path\n');
  for (const path of ['.', subdirectory]) {
    const input = await captureCodeReviewChanges(subdirectory, path, false);
    assert.equal(input?.cwd, await realpath(cwd));
    assert.equal(input?.args.capture?.target, 'sub [x];dir');
    assert.match(input?.args.diff ?? '', /selected/);
    assert.doesNotMatch(input?.args.diff ?? '', /outside selected path/);
    assert.deepEqual(input?.args.capture?.includedAdditions, ['sub [x];dir/new.ts']);
  }
});

test('combined and individual limits reject rather than dropping a large addition', async () => {
  await writeFile(join(cwd, 'tracked.ts'), 't'.repeat(MAX_REVIEW_DIFF_CHARS - 1000));
  await writeFile(join(cwd, 'new.ts'), 'a'.repeat(2000));
  await assert.rejects(
    captureCodeReviewChanges(cwd, undefined, false),
    /capture limit.*smaller path/
  );
  await writeFile(join(cwd, 'new.ts'), 'a'.repeat(MAX_REVIEW_DIFF_CHARS * 4 + 1));
  await assert.rejects(
    captureCodeReviewChanges(cwd, undefined, false),
    /capture limit.*smaller path/
  );
});

test('a UTF-8 character split at the binary probe boundary does not exclude oversized text', async () => {
  await writeFile(join(cwd, 'tracked.ts'), 'tracked edit\n');
  await writeFile(
    join(cwd, 'new.ts'),
    `${'a'.repeat(8191)}é${'b'.repeat(MAX_REVIEW_DIFF_CHARS * 4)}`
  );
  await assert.rejects(
    captureCodeReviewChanges(cwd, undefined, false),
    /capture limit.*smaller path/
  );
});

test('capture within an existing worktree uses its own exact base and checkout', async () => {
  const worktree = join(directory, 'worktree');
  await git('worktree', 'add', '--detach', worktree, 'HEAD');
  await writeFile(join(worktree, 'tracked.ts'), 'worktree edit\n');
  await writeFile(join(worktree, 'new.ts'), 'worktree addition\n');
  const input = await captureCodeReviewChanges(worktree, undefined, false);
  assert.equal(input?.cwd, await realpath(worktree));
  assert.equal(input?.args.baseCommit, (await git('rev-parse', 'HEAD')).trim());
  assert.match(input?.args.diff ?? '', /worktree edit/);
  assert.match(input?.args.diff ?? '', /worktree addition/);
  assert.equal(await readFile(join(cwd, 'tracked.ts'), 'utf8'), 'old\n');
  assert.equal(await git('status', '--porcelain'), '');
});

test('branch capture uses the merge base and includes local changes without mutating Git state', async () => {
  const ancestor = (await git('rev-parse', 'HEAD')).trim();
  await git('branch', '-M', 'main');
  await git('checkout', '-qb', 'feature');
  await writeFile(join(cwd, 'feature.ts'), 'feature commit\n');
  await git('add', 'feature.ts');
  await git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '-qm',
    'feature'
  );
  const head = (await git('rev-parse', 'HEAD')).trim();
  await git('checkout', '-q', 'main');
  await writeFile(join(cwd, 'main-only.ts'), 'main commit\n');
  await git('add', 'main-only.ts');
  await git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '-qm',
    'main'
  );
  const baseTip = (await git('rev-parse', 'HEAD')).trim();
  await git('update-ref', 'refs/remotes/origin/main', baseTip);
  await git('checkout', '-q', 'feature');
  const clean = await captureCodeReviewChanges(cwd, undefined, false, { base: 'main' });
  assert.match(clean?.args.diff ?? '', /\+feature commit/);
  assert.doesNotMatch(clean?.args.diff ?? '', /main-only|main commit/);
  assert.equal(clean?.args.capture?.comparison?.localChanges, false);

  await writeFile(join(cwd, 'tracked.ts'), 'staged\n');
  await git('add', 'tracked.ts');
  await writeFile(join(cwd, 'other.ts'), 'unstaged\n');
  await writeFile(join(cwd, 'new.ts'), 'untracked\n');
  const index = await git('ls-files', '--stage', '-z');
  const status = await git('status', '--porcelain=v1', '-z');
  const refs = await git('show-ref');
  for (const trackedOnly of [false, true]) {
    const input = await captureCodeReviewChanges(cwd, undefined, trackedOnly, {
      base: 'origin/main'
    });
    assert.ok(input?.args.diff);
    for (const content of ['feature commit', 'staged', 'unstaged'])
      assert.ok(input.args.diff.includes(`+${content}\n`));
    assert.equal(input.args.diff.includes('+untracked\n'), !trackedOnly);
    assert.doesNotMatch(input.args.diff, /main-only/);
    assert.equal(input.args.baseCommit, ancestor);
    assert.deepEqual(input.args.capture?.comparison, {
      headCommit: head,
      baseRef: 'origin/main',
      baseTipCommit: baseTip,
      commit: ancestor,
      localChanges: true
    });
  }
  assert.equal(await git('ls-files', '--stage', '-z'), index);
  assert.equal(await git('status', '--porcelain=v1', '-z'), status);
  assert.equal(await git('show-ref'), refs);
  assert.equal(await readFile(join(cwd, 'tracked.ts'), 'utf8'), 'staged\n');
});

test('unborn repositories require explicit file mode instead of silently widening the scope', async () => {
  const unborn = join(directory, 'unborn');
  await exec('git', ['init', '-q', unborn]);
  await writeFile(join(unborn, 'new.ts'), 'new\n');
  await assert.rejects(
    captureCodeReviewChanges(unborn, undefined, false),
    /Cannot capture changes.*--files/
  );
});
