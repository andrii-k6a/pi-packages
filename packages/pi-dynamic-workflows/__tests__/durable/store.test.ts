import assert from 'node:assert/strict';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, test, vi } from 'vitest';
import {
  acquireRunLock,
  appendRunReport,
  createRunId,
  deleteRun,
  isValidRunId,
  listRuns,
  RUN_DATABASE_FILE,
  runDirectory,
  runLockOwner,
  WorkflowRunLockedError,
  writeRunIndex
} from '../../src/durable/store.js';

let root: string;
let children: ChildProcess[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pi-workflow-store-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  await Promise.all(
    children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    })
  );
  children = [];
  await rm(root, { recursive: true, force: true });
});

function deadPid(): number {
  // A child that has exited: its pid is free (and not reused this quickly in practice).
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  return Number(child.stdout.toString());
}

test('run ids are sortable, readable, and path-safe', () => {
  const id = createRunId('Inspect Project!', new Date(2026, 9, 12, 18, 56, 28).getTime());
  assert.match(id, /^20261012-185628-inspect_project-[0-9a-f]{4}$/);
  assert.equal(isValidRunId(id), true);
  for (const bad of ['', '../x', 'a/b', '.hidden', 'a..b', 'x'.repeat(200), 42]) {
    assert.equal(isValidRunId(bad), false, String(bad));
  }
  assert.throws(() => runDirectory(root, '../escape'), /invalid workflow run id/);
});

test('a run lock is exclusive while held and released on demand', () => {
  const release = acquireRunLock(root, 'run-a');
  assert.equal(runLockOwner(root, 'run-a')?.pid, process.pid);
  assert.throws(() => acquireRunLock(root, 'run-a'), WorkflowRunLockedError);
  release();
  assert.equal(runLockOwner(root, 'run-a'), undefined);
  acquireRunLock(root, 'run-a')();
});

test('a lock left by a crashed process is taken over; a lock from another host is respected', async () => {
  const directory = runDirectory(root, 'run-b');
  await import('node:fs/promises').then((fs) => fs.mkdir(directory, { recursive: true }));
  const lock = join(directory, 'run.lock');
  await writeFile(
    lock,
    JSON.stringify({ pid: deadPid(), host: (await import('node:os')).hostname(), acquiredAt: 1 })
  );
  assert.equal(runLockOwner(root, 'run-b'), undefined);
  const release = acquireRunLock(root, 'run-b');
  assert.equal(JSON.parse(await readFile(lock, 'utf8')).pid, process.pid);
  release();

  await writeFile(lock, JSON.stringify({ pid: 1, host: 'some-other-host', acquiredAt: 1 }));
  assert.throws(
    () => acquireRunLock(root, 'run-b'),
    /open in another Pi process \(pid 1 on some-other-host\)/
  );
});

test('a lease cannot be stolen before owner metadata is published, or after metadata is removed', async () => {
  const rename = fs.renameSync;
  vi.spyOn(fs, 'renameSync').mockImplementationOnce((...args) => {
    assert.throws(() => acquireRunLock(root, 'initializing'), WorkflowRunLockedError);
    assert.throws(() => deleteRun(root, 'initializing'), WorkflowRunLockedError);
    rename(...args);
  });
  syncBuiltinESMExports();
  const release = acquireRunLock(root, 'initializing');
  try {
    await rm(join(root, 'initializing', 'run.lock'));
    assert.ok(runLockOwner(root, 'initializing'));
    assert.throws(() => acquireRunLock(root, 'initializing'), WorkflowRunLockedError);
  } finally {
    release();
  }
  assert.equal(runLockOwner(root, 'initializing'), undefined);
  acquireRunLock(root, 'initializing')();
});

async function worker(runId: string): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [
      '--experimental-transform-types',
      join(import.meta.dirname, '../fixtures', 'run-lock.mjs'),
      pathToFileURL(join(import.meta.dirname, '../../src/durable/store.ts')).href,
      root,
      runId
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }
  );
  children.push(child);
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += chunk;
  });
  await Promise.race([
    once(child, 'message'),
    once(child, 'exit').then(() => {
      throw new Error(`lock worker exited: ${stderr}`);
    })
  ]);
  return child;
}

async function command(
  child: ChildProcess,
  value: string
): Promise<{ ok: boolean; error?: string }> {
  const reply = once(child, 'message');
  child.send(value);
  return (await reply)[0];
}

test('process contention, SIGKILL recovery, and deletion all use the same exclusive lease', async () => {
  const runId = 'process-race';
  const workers = await Promise.all([worker(runId), worker(runId), worker(runId)]);
  const acquired = await Promise.all(workers.map((child) => command(child, 'acquire')));
  assert.equal(acquired.filter((result) => result.ok).length, 1);
  const winner = acquired.findIndex((result) => result.ok);
  const survivor = workers[(winner + 1) % workers.length];
  assert.equal((await command(survivor, 'delete')).ok, false);
  assert.throws(() => acquireRunLock(root, runId), WorkflowRunLockedError);

  const exited = once(workers[winner], 'exit');
  workers[winner].kill('SIGKILL');
  await exited;
  // Old metadata remains, but the OS has released the lease. Competing recovery still has one winner.
  const live = workers.filter((_, index) => index !== winner);
  const recovered = await Promise.all(live.map((child) => command(child, 'acquire')));
  assert.equal(recovered.filter((result) => result.ok).length, 1);
  await command(live[recovered.findIndex((result) => result.ok)], 'release');
  assert.equal((await command(survivor, 'delete')).ok, true);
  assert.equal(fs.existsSync(join(root, runId)), false);
  assert.equal(fs.existsSync(join(root, '.locks', `${runId}.sqlite`)), true);
  assert.equal((await command(survivor, 'acquire')).ok, true);
  assert.throws(() => acquireRunLock(root, runId), WorkflowRunLockedError);
}, 15000);

test('short runtime reports retain their message, stack, and timestamp', async () => {
  const release = acquireRunLock(root, 'reports');
  release();
  const error = new Error('ordinary failure');
  appendRunReport(root, 'reports', error, 42);
  appendRunReport(root, 'reports', 'plain failure', 43);
  const records = (await readFile(join(root, 'reports', 'reports.log'), 'utf8'))
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(records, [
    { at: 42, message: error.message, stack: error.stack },
    { at: 43, message: 'plain failure' }
  ]);
});

test.each(['x', '😀汉', '"\\\n\u0000'])(
  'long runtime reports remain valid, byte-bounded JSONL with truncation markers: %j',
  async (text) => {
    acquireRunLock(root, 'long-reports')();
    const message = text.repeat(5000);
    const error = new Error(message);
    error.stack = `Error: ${message}\n    at fixture`;
    appendRunReport(root, 'long-reports', error, 42);
    appendRunReport(root, 'long-reports', message, 43);
    const lines = (await readFile(join(root, 'long-reports', 'reports.log'), 'utf8')).split('\n');
    assert.equal(lines.length, 3);
    assert.equal(lines[2], '');
    for (const [index, line] of lines.slice(0, -1).entries()) {
      const record = JSON.parse(line);
      assert.ok(Buffer.byteLength(`${line}\n`, 'utf8') <= 4000);
      assert.equal(record.at, 42 + index);
      assert.equal(record.truncated, true);
      assert.ok(record.message.startsWith(text));
      assert.match(record.message, /\[truncated\]$/);
      if (index === 0) {
        assert.ok(record.stack.startsWith(`Error: ${text}`));
        assert.match(record.stack, /\[truncated\]$/);
      } else {
        assert.equal(record.stack, undefined);
      }
    }
  }
);

test('reporting failures never throw', () => {
  assert.doesNotThrow(() => appendRunReport(join(root, 'missing'), 'reports', new Error('boom')));
  assert.doesNotThrow(() => appendRunReport(root, '../invalid', 'boom'));
});

test('listRuns reports runs whose owner is gone as interrupted, newest first', async () => {
  const index = (runId: string, createdAt: number, status: 'running' | 'completed') => ({
    version: 1 as const,
    runId,
    name: runId,
    description: 'd',
    cwd: '/repo',
    createdAt,
    updatedAt: createdAt,
    status,
    attempts: 1,
    agents: { total: 2, done: 1, error: 0, running: 1 }
  });
  for (const [runId, createdAt, status] of [
    ['old-done', 1, 'completed'],
    ['crashed', 2, 'running'],
    ['live', 3, 'running']
  ] as const) {
    writeRunIndex(root, index(runId, createdAt, status));
    await writeFile(join(runDirectory(root, runId), RUN_DATABASE_FILE), '');
  }
  const release = acquireRunLock(root, 'live');
  try {
    assert.deepEqual(
      listRuns(root).map((run) => [run.runId, run.status]),
      [
        ['live', 'running'],
        ['crashed', 'interrupted'],
        ['old-done', 'completed']
      ]
    );
  } finally {
    release();
  }
});

test('listRuns trusts the caller about runs it holds open instead of probing their lease', async () => {
  writeRunIndex(root, {
    version: 1,
    runId: 'held-here',
    name: 'held-here',
    description: 'd',
    cwd: '/repo',
    createdAt: 1,
    updatedAt: 1,
    status: 'running',
    attempts: 1,
    agents: { total: 1, done: 0, error: 0, running: 1 }
  });
  await writeFile(join(runDirectory(root, 'held-here'), RUN_DATABASE_FILE), '');

  // No lease is held anywhere, so a probe would call this run interrupted; the caller knows better.
  assert.equal(listRuns(root)[0].status, 'interrupted');
  assert.equal(listRuns(root, (runId) => runId === 'held-here')[0].status, 'running');
  assert.equal(listRuns(root, () => false)[0].status, 'interrupted');
});
