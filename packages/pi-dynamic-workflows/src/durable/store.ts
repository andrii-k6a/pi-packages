import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { WorkflowRunStatus } from '../workflow/contracts.js';

export type { WorkflowRunStatus } from '../workflow/contracts.js';

/**
 * Filesystem layout of durable workflow runs:
 *
 *   <agentDir>/pi-dynamic-workflows/runs/<runId>/run.sqlite   Pi Durable Session (authoritative)
 *   <agentDir>/pi-dynamic-workflows/runs/<runId>/run.lock     owner metadata (diagnostic only)
 *   <agentDir>/pi-dynamic-workflows/runs/.locks/<runId>.sqlite  OS-backed exclusive lease
 *   <agentDir>/pi-dynamic-workflows/runs/<runId>/index.json   listing cache, rewritten from the Session
 *   <agentDir>/pi-dynamic-workflows/runs/<runId>/reports.log  runtime reports (JSON lines)
 *
 * Pi Durable has no cross-process locking. A separate SQLite connection holds BEGIN EXCLUSIVE
 * for the run's lifetime. The OS releases it on process death; no stale-file deletion or heartbeat
 * is involved. Guard files live outside run directories and MUST NOT be deleted, even on deleteRun:
 * removing a guard would let another process lock a new inode while an old owner still holds it.
 */

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const RUN_DATABASE_FILE = 'run.sqlite';
const LOCK_FILE = 'run.lock';
const INDEX_FILE = 'index.json';
const REPORTS_FILE = 'reports.log';
const MAX_REPORT_BYTES = 4000;

/** Listing summary of a run; a cache of its Session, never the source of truth. */
export type WorkflowRunIndex = {
  version: 1;
  runId: string;
  name: string;
  description: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  status: WorkflowRunStatus;
  attempts: number;
  agents: { total: number; done: number; error: number; running: number };
  error?: string;
  parentSessionFile?: string;
};

export type WorkflowRunLockOwner = { pid: number; host: string; acquiredAt: number };

export class WorkflowRunLockedError extends Error {
  constructor(
    readonly runId: string,
    readonly owner: WorkflowRunLockOwner
  ) {
    super(
      `workflow run ${runId} is open in another Pi process (${owner.pid ? `pid ${owner.pid} on ${owner.host}` : 'owner metadata unavailable'}); finish or close it there first`
    );
    this.name = 'WorkflowRunLockedError';
  }
}

export function workflowRunsRoot(agentDir = getAgentDir()): string {
  return join(agentDir, 'pi-dynamic-workflows', 'runs');
}

export function isValidRunId(runId: unknown): runId is string {
  return typeof runId === 'string' && RUN_ID_PATTERN.test(runId) && !runId.includes('..');
}

export function assertValidRunId(runId: unknown): asserts runId is string {
  if (!isValidRunId(runId)) throw new Error(`invalid workflow run id: ${JSON.stringify(runId)}`);
}

/** Sortable, readable, collision-resistant: `20261012-185628-inspect_project-3f9a`. */
export function createRunId(name: string, now = Date.now()): string {
  const date = new Date(now);
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'workflow';
  return `${stamp}-${slug}-${randomBytes(2).toString('hex')}`;
}

export function runDirectory(root: string, runId: string): string {
  assertValidRunId(runId);
  return join(root, runId);
}

export function runDatabasePath(root: string, runId: string): string {
  return join(runDirectory(root, runId), RUN_DATABASE_FILE);
}

/** Whether the run's directory exists, even if it holds no database (yet). */
export function runDirectoryExists(root: string, runId: string): boolean {
  return existsSync(runDirectory(root, runId));
}

export function runExists(root: string, runId: string): boolean {
  return isValidRunId(runId) && existsSync(runDatabasePath(root, runId));
}

/** Current owner, determined by the OS-backed lease, not by possibly stale owner metadata. */
export function runLockOwner(root: string, runId: string): WorkflowRunLockOwner | undefined {
  const path = join(runDirectory(root, runId), LOCK_FILE);
  const guard = lockDatabasePath(root, runId);
  if (existsSync(guard)) {
    const database = new DatabaseSync(guard);
    try {
      // A probe that is still busy after a short retry reports the run as owned (fail closed).
      if (!beginExclusive(database, PROBE_ATTEMPTS)) return readLock(path) ?? unknownOwner();
    } finally {
      database.close();
    }
  }
  return legacyLockOwner(path);
}

/** Exclusive until release or process death. Owner metadata is never used to steal a lease. */
export function acquireRunLock(root: string, runId: string): () => void {
  const directory = runDirectory(root, runId);
  mkdirSync(join(root, '.locks'), { recursive: true, mode: 0o700 });
  const path = join(directory, LOCK_FILE);
  const database = new DatabaseSync(lockDatabasePath(root, runId));
  try {
    if (!beginExclusive(database, ACQUIRE_ATTEMPTS)) {
      throw new WorkflowRunLockedError(runId, readLock(path) ?? unknownOwner());
    }
    // Refuse a live pre-lease owner during upgrades. An unreadable legacy lock fails closed.
    const legacy = legacyLockOwner(path);
    if (legacy) throw new WorkflowRunLockedError(runId, legacy);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${randomBytes(8).toString('hex')}`;
    try {
      writeFileSync(
        temporary,
        JSON.stringify({
          protocol: 'sqlite',
          pid: process.pid,
          host: hostname(),
          acquiredAt: Date.now()
        }),
        { mode: 0o600 }
      );
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
  } catch (error) {
    database.close();
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      // Still holding the lease: no successor can have published metadata yet.
      try {
        unlinkSync(path);
      } catch {
        /* The run may have been deleted under this lease. */
      }
    } finally {
      database.close();
    }
  };
}

function lockDatabasePath(root: string, runId: string): string {
  assertValidRunId(runId);
  return join(root, '.locks', `${runId}.sqlite`);
}

function unknownOwner(): WorkflowRunLockOwner {
  return { pid: 0, host: hostname(), acquiredAt: 0 };
}

const ACQUIRE_ATTEMPTS = 30;
const PROBE_ATTEMPTS = 3;

/**
 * BEGIN EXCLUSIVE with a bounded retry. SQLite reports BUSY immediately, without consulting a busy
 * handler, when two connections that both hold a SHARED lock try to upgrade (deadlock avoidance).
 * With several contenders every one of them can lose that race even though nobody owns the lease,
 * so BUSY alone does not mean "owned". Only a lease that stays busy across the retries does.
 * Retrying never weakens exclusivity: success still means this connection holds the lock.
 */
function beginExclusive(database: DatabaseSync, attempts: number): boolean {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      database.exec('BEGIN EXCLUSIVE');
      return true;
    } catch (error) {
      if (!isSqliteBusy(error)) throw error;
      sleep(5 + Math.floor(Math.random() * 15));
    }
  }
  return false;
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isSqliteBusy(error: unknown): boolean {
  const code = (error as { errcode?: number }).errcode;
  return code !== undefined && [5, 6].includes(code & 0xff);
}

function legacyLockOwner(path: string): WorkflowRunLockOwner | undefined {
  const owner = readLock(path);
  if (owner?.protocol === 'sqlite') return undefined;
  if (owner) return isAlive(owner) ? owner : undefined;
  return existsSync(path) ? unknownOwner() : undefined;
}

export function writeRunIndex(root: string, index: WorkflowRunIndex): void {
  const directory = runDirectory(root, index.runId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, INDEX_FILE);
  const temporary = join(
    directory,
    `.${INDEX_FILE}.${process.pid}.${randomBytes(4).toString('hex')}`
  );
  writeFileSync(temporary, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function readRunIndex(root: string, runId: string): WorkflowRunIndex | undefined {
  try {
    const value = JSON.parse(readFileSync(join(runDirectory(root, runId), INDEX_FILE), 'utf8'));
    return validRunIndex(value, runId) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every run with its listing summary, newest first. A run whose index says `running` but whose
 * lock no live process holds was interrupted (crash, quit, or reload) and can be resumed.
 */
export function listRuns(
  root: string,
  /** Runs this process holds open: their lease is known to be held, so it is not probed. */
  openHere: (runId: string) => boolean = () => false
): WorkflowRunIndex[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const runs: WorkflowRunIndex[] = [];
  for (const runId of names) {
    if (!isValidRunId(runId) || !existsSync(join(root, runId, RUN_DATABASE_FILE))) continue;
    // Keep intact databases discoverable even when the cache was lost/corrupted. Inspecting or
    // resuming the run rebuilds its summary from the Session; do not guess that it completed.
    const index = readRunIndex(root, runId) ?? uncachedRunIndex(root, runId);
    const status =
      index.status === 'running' && !openHere(runId) && !runLockOwner(root, runId)
        ? 'interrupted'
        : index.status;
    runs.push({ ...index, status });
  }
  return runs.sort((a, b) => b.createdAt - a.createdAt || (a.runId < b.runId ? 1 : -1));
}

/** Append one runtime failure to the run's report log. Never throws. */
export function appendRunReport(
  root: string,
  runId: string,
  error: unknown,
  at = Date.now()
): void {
  try {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    let line = JSON.stringify({ at, message, ...(stack ? { stack } : {}) });
    if (Buffer.byteLength(line) + 1 > MAX_REPORT_BYTES) {
      const record = { at, message: '', ...(stack ? { stack: '' } : {}), truncated: true };
      // Reserve the JSON envelope and final LF. Budget the serialized fields, including escapes,
      // rather than slicing JSON or treating UTF-16 character counts as UTF-8 bytes.
      const budget = MAX_REPORT_BYTES - Buffer.byteLength(JSON.stringify(record)) - 1;
      record.message = truncateReportText(message, stack ? Math.floor(budget / 2) : budget);
      if (stack) record.stack = truncateReportText(stack, budget - reportTextBytes(record.message));
      line = JSON.stringify(record);
    }
    appendFileSync(join(runDirectory(root, runId), REPORTS_FILE), `${line}\n`, { mode: 0o600 });
  } catch {
    // Reporting must never fail the run.
  }
}

/** UTF-8 bytes of a JSON string's contents, including JSON escaping but excluding its quotes. */
function reportTextBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text)) - 2;
}

function truncateReportText(text: string, maxBytes: number): string {
  if (reportTextBytes(text) <= maxBytes) return text;
  const marker = '… [truncated]';
  const limit = maxBytes - reportTextBytes(marker);
  let bytes = 0;
  let end = 0;
  // Iterate code points so truncation never splits a surrogate pair or a JSON escape.
  for (const character of text) {
    bytes += reportTextBytes(character);
    if (bytes > limit) break;
    end += character.length;
  }
  return `${text.slice(0, end)}${marker}`;
}

/** Remove a run's directory without the lock check; for a run this process just created and abandoned. */
export function removeRunDirectory(root: string, runId: string): void {
  rmSync(runDirectory(root, runId), { recursive: true, force: true });
}

export function deleteRun(root: string, runId: string): void {
  const release = acquireRunLock(root, runId);
  try {
    removeRunDirectory(root, runId);
  } finally {
    release();
  }
}

function validRunIndex(value: unknown, runId: string): value is WorkflowRunIndex {
  if (!value || typeof value !== 'object') return false;
  const index = value as WorkflowRunIndex;
  return (
    index.version === 1 &&
    index.runId === runId &&
    [index.name, index.description, index.cwd].every((item) => typeof item === 'string') &&
    [index.createdAt, index.updatedAt, index.attempts].every(Number.isFinite) &&
    ['running', 'completed', 'failed', 'aborted', 'interrupted'].includes(index.status) &&
    !!index.agents &&
    ['total', 'done', 'error', 'running'].every((key) =>
      Number.isFinite(index.agents[key as keyof WorkflowRunIndex['agents']])
    ) &&
    (index.error === undefined || typeof index.error === 'string')
  );
}

function uncachedRunIndex(root: string, runId: string): WorkflowRunIndex {
  const at = statSync(runDatabasePath(root, runId)).birthtimeMs;
  return {
    version: 1,
    runId,
    name: runId,
    description: 'Listing cache unavailable; inspect to recover',
    cwd: '',
    createdAt: at,
    updatedAt: at,
    status: 'running',
    attempts: 0,
    agents: { total: 0, done: 0, error: 0, running: 0 },
    error: 'Listing cache missing or invalid; inspect this run to rebuild it from SQLite.'
  };
}

function readLock(path: string): (WorkflowRunLockOwner & { protocol?: string }) | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return typeof value?.pid === 'number' && typeof value.host === 'string'
      ? (value as WorkflowRunLockOwner)
      : undefined;
  } catch {
    return undefined;
  }
}

function isAlive(owner: WorkflowRunLockOwner): boolean {
  // A lock from another host cannot be checked; treat it as held.
  if (owner.host !== hostname()) return true;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
