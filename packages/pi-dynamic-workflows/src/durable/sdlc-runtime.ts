import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '@earendil-works/chord';
import type { TaskRuntime } from '@earendil-works/pi-durable';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { getOrThrow } from '@earendil-works/pi-durable/env';
import type { WorkflowAgentExecutor } from '../workflow/contracts.js';
import type { StoredUsage } from './docs.js';
import { runSdlcController, sdlcIdentity } from './sdlc.js';
import { runSdlcCheck } from './sdlc-checks.js';
import { observeSdlcFiles } from './sdlc-observation.js';
import { WorkflowSdlcDoc } from './sdlc-state.js';
import {
  ensureSdlcWorkspace,
  forkSdlcWorkspace,
  inspectSdlcWorkspace,
  integrateSdlcWorkspace,
  type SdlcWorkspace
} from './sdlc-workspace.js';
import type {
  RunCheckpoint,
  WorkflowRunInput,
  WorkflowRunTaskResult,
  WorkflowTaskServices
} from './tasks/contracts.js';

/** Process-only capabilities; the operation's decisions and inputs remain in SQLite. */
export type DurableSdlcServices = {
  acquire(workspace: SdlcWorkspace): () => void;
  env(cwd: string): ExecutionEnv;
  usage(): Promise<StoredUsage>;
};
const hosts = new WeakMap<WorkflowTaskServices, DurableSdlcServices>();
export function bindSdlcServices(services: WorkflowTaskServices, host: DurableSdlcServices): void {
  hosts.set(services, host);
}
type Runtime = TaskRuntime<WorkflowRunInput, RunCheckpoint, WorkflowRunTaskResult, object>;

export async function executeDurableSdlc(
  services: WorkflowTaskServices,
  runtime: Runtime,
  agent: WorkflowAgentExecutor,
  phase: (title: string) => void,
  context: Context
) {
  const host = hosts.get(services);
  if (!host) throw new Error('SDLC host effects are unavailable');
  const saved = await runtime.snapshot(WorkflowSdlcDoc, context);
  if (!saved?.state)
    throw new Error(
      'This run has no SDLC operation record. Start sdlc explicitly instead of reinterpreting a legacy run.'
    );
  const state = structuredClone(saved.state);
  return runSdlcController({
    state,
    agent,
    save: async (state) => {
      await runtime.commit(async (tx) => {
        (await tx.doc(WorkflowSdlcDoc)).state = state;
      }, context);
    },
    resolveRole: services.roles?.resolve,
    usage: () => host.usage(),
    now: () => runtime.now(),
    signal: runtime.signal,
    phase,
    artifact: async (evidence) => {
      const directory = join(state.workspace.storageDir, 'evidence');
      await mkdir(directory, { recursive: true });
      const path = join(
        directory,
        `${sdlcIdentity(evidence.id).slice(0, 24)}-${sdlcIdentity(evidence.result).slice(0, 24)}.json`
      );
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(evidence.result), { mode: 0o600 });
      await rename(temporary, path);
      return path;
    },
    acquire: host.acquire,
    ensure: ensureSdlcWorkspace,
    inspect: inspectSdlcWorkspace,
    observe: (workspace) => observeSdlcFiles(workspace, host.env, context),
    fork: forkSdlcWorkspace,
    integrate: integrateSdlcWorkspace,
    check: async (checkId, workspace, evidenceId, revision) => {
      const check = state.args.checks?.find((check) => check.id === checkId);
      if (!check) throw new Error(`Unknown configured SDLC check ${checkId}`);
      let env = host.env(workspace.cwd);
      if (check.cwd) env = host.env(getOrThrow(await env.joinPath([env.cwd, check.cwd], context)));
      return runSdlcCheck({
        id: evidenceId,
        check,
        env,
        candidateRevision: revision,
        timeoutMs: state.limits.checkTimeoutMs,
        now: () => runtime.now(),
        context
      });
    }
  });
}
