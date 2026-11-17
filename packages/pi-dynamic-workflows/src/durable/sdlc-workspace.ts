import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  writeFile
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { acquireRunLock, WorkflowRunLockedError, workflowRunsRoot } from './store.js';
import { ensureWorktree, validateWorktree } from './worktree.js';

const exec = promisify(execFile);
const MAX_BUFFER = 32 * 1024 * 1024;

/** Workspace intent is saved by the controller before setup or a writer is admitted. */
export type SdlcWorkspace = {
  operationId: string;
  owner: string;
  sourceCwd: string;
  cwd: string;
  mode: 'existing' | 'isolated';
  storageDir: string;
  sourceRevision: string;
  sourceRef?: string;
  branch?: string;
  baseCommit?: string;
  repoRoot?: string;
  commonDir?: string;
  path?: string;
  subdirectory?: string;
  /** Candidate tree supplying operation-owned paths absent from the source's real index. */
  sourceTrackingTree?: string;
};

type Setup = {
  version: 1;
  identity: string;
  commit?: string;
  tree?: string;
  files?: Record<string, string>;
  directoryIdentity?: string;
  trackingTree?: string;
};
type GitState = { head: string; tree: string; index: string; revision: string };

async function git(
  cwd: string,
  args: string[],
  extra: NodeJS.ProcessEnv = {},
  input?: string
): Promise<string> {
  const command = exec('git', ['-C', cwd, ...args], {
    timeout: 30_000,
    maxBuffer: MAX_BUFFER,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...extra }
  });
  const written = new Promise<void>((resolve, reject) => {
    const stdin = command.child.stdin;
    if (!stdin) {
      reject(new Error('Git stdin is unavailable'));
      return;
    }
    stdin.once('error', reject);
    stdin.end(input, resolve);
  });
  const [{ stdout }] = await Promise.all([command, written]);
  return stdout.replace(/\r?\n$/, '');
}

const treePathCache = new Map<string, string[]>();
async function treePaths(root: string, tree: string): Promise<string[]> {
  const known = treePathCache.get(tree);
  if (known) return known;
  const paths = (await git(root, ['ls-tree', '-r', '--name-only', '-z', tree]))
    .split('\0')
    .filter(Boolean);
  if (treePathCache.size >= 4) {
    const oldest = treePathCache.keys().next().value;
    if (oldest !== undefined) treePathCache.delete(oldest);
  }
  treePathCache.set(tree, paths);
  return paths;
}

function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function identity(workspace: SdlcWorkspace): string {
  return hash(JSON.stringify(workspace));
}

function recordPath(workspace: SdlcWorkspace): string {
  return join(workspace.storageDir, 'workspaces', `${hash(workspace.owner).slice(0, 24)}.json`);
}

async function saved<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`Cannot read workspace recovery record ${path}: ${String(error)}`);
  }
}

async function save(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value));
  await rename(temporary, path);
}

async function sourceIdentity(
  cwd: string
): Promise<{ repoRoot: string; commonDir: string; head: string } | undefined> {
  try {
    await git(cwd, ['rev-parse', '--git-dir']);
  } catch (error) {
    if ((error as { code?: number }).code === 128) return undefined;
    throw error;
  }
  const [repoRoot, commonDir, head] = await Promise.all([
    git(cwd, ['rev-parse', '--show-toplevel']).then((path) => realpath(path)),
    git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']).then((path) =>
      realpath(path)
    ),
    git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'])
  ]);
  return { repoRoot, commonDir, head };
}

async function gitRef(cwd: string): Promise<string> {
  try {
    return await git(cwd, ['symbolic-ref', '-q', 'HEAD']);
  } catch (error) {
    if ((error as { code?: number }).code === 1) return 'HEAD';
    throw error;
  }
}

async function sourceIndex(root: string) {
  const [staged, sparse] = await Promise.all([
    git(root, ['ls-files', '--stage', '-v', '-z']),
    git(root, ['config', '--get', 'core.sparseCheckout']).catch((error: unknown) => {
      if ((error as { code?: number }).code !== 1) throw error;
      return '';
    })
  ]);
  const records = staged.split('\0').filter(Boolean);
  if (records.some((record) => /^[A-Za-z] [0-7]{6} [0-9a-f]+ [1-3]\t/.test(record)))
    throw new Error('SDLC workspace cannot capture an unmerged index. Resolve conflicts first.');
  if (records.some((record) => /^[A-Za-z] 160000 /.test(record)))
    throw new Error(
      'SDLC workspace capture does not support submodules. Select a checkout without gitlinks.'
    );
  if (sparse === 'true')
    throw new Error('SDLC workspace capture does not support sparse checkouts.');
  if (records.some((record) => /^[a-zS] /.test(record)))
    throw new Error(
      'SDLC workspace capture does not support assume-unchanged or skip-worktree entries.'
    );
  if (records.some((record) => !/^[A-Z] [0-7]{6} [0-9a-f]+ 0\t/.test(record)))
    throw new Error('SDLC workspace has an unsupported Git index entry.');
  return {
    fingerprint: hash(staged),
    entries: records.map((record) => record.slice(2)).join('\0') + (records.length ? '\0' : ''),
    tracked: new Set(records.map((record) => record.slice(record.indexOf('\t') + 1)))
  };
}

/** A temporary index captures final working contents without changing the user's staged state. */
async function captureTree(
  root: string,
  trackingTree?: string
): Promise<{ tree: string; index: string }> {
  const source = await sourceIndex(root);
  const index = join(
    await git(root, ['rev-parse', '--path-format=absolute', '--git-dir']),
    `pi-sdlc-index-${randomUUID()}`
  );
  const env = { GIT_INDEX_FILE: index };
  try {
    // Rebuild entries without copying stat caches that can hide same-size racy edits.
    await git(
      root,
      ['-c', 'core.ignorestat=false', 'update-index', '-z', '--index-info'],
      env,
      source.entries
    );
    await git(
      root,
      [
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.untrackedCache=false',
        '-c',
        'core.ignorestat=false',
        'add',
        '-A',
        '--',
        '.'
      ],
      env
    );
    if (trackingTree) {
      const owned = (await treePaths(root, trackingTree)).filter(
        (path) => !source.tracked.has(path)
      );
      const present: string[] = [];
      for (const path of owned) {
        try {
          await lstat(join(root, path));
          present.push(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      for (let offset = 0; offset < present.length; offset += 100)
        await git(root, ['add', '-f', '--', ...present.slice(offset, offset + 100)], env);
    }
    return { tree: await git(root, ['write-tree'], env), index: source.fingerprint };
  } finally {
    await rm(index, { force: true });
    await rm(`${index}.lock`, { force: true });
  }
}

async function gitState(root: string, trackingTree?: string): Promise<GitState> {
  const head = await git(root, ['rev-parse', 'HEAD']);
  const { tree, index } = await captureTree(root, trackingTree);
  const [afterHead, afterIndex] = await Promise.all([
    git(root, ['rev-parse', 'HEAD']),
    git(root, ['ls-files', '--stage', '-v', '-z']).then(hash)
  ]);
  if (head !== afterHead || index !== afterIndex)
    throw new Error('Workspace changed during capture. Retry after external writers stop.');
  return { head, index, tree, revision: hash(JSON.stringify({ head, tree, index })) };
}

async function commitTree(root: string, tree: string, parent: string): Promise<string> {
  return git(root, ['commit-tree', tree, '-p', parent, '-m', 'SDLC captured candidate'], {
    GIT_AUTHOR_NAME: 'Pi SDLC',
    GIT_AUTHOR_EMAIL: 'sdlc@localhost',
    GIT_COMMITTER_NAME: 'Pi SDLC',
    GIT_COMMITTER_EMAIL: 'sdlc@localhost',
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z'
  });
}

async function localState(
  cwd: string
): Promise<{ revision: string; files: Record<string, string> }> {
  const files: Record<string, string> = {};
  let count = 0;
  const walk = async (path: string): Promise<void> => {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      if (entry.name === '.git') continue;
      const file = join(path, entry.name);
      const info = await lstat(file);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isSymbolicLink()) files[relative(cwd, file)] = `link:${await readlink(file)}`;
      else if (entry.isFile()) {
        if (info.size > MAX_BUFFER)
          throw new Error(`File is too large for a non-Git SDLC workspace: ${file}`);
        files[relative(cwd, file)] = `${info.mode}:${hash(await readFile(file))}`;
      } else throw new Error(`Unsupported workspace input: ${file}`);
      if (++count > 50_000)
        throw new Error(
          'Non-Git workspace exceeds the 50000-file capture limit. Select a smaller directory.'
        );
    }
  };
  await walk(cwd);
  return { revision: hash(JSON.stringify(files)), files };
}

export async function planSdlcWorkspace(options: {
  operationId: string;
  sourceCwd: string;
  storageDir: string;
  mode: 'existing' | 'isolated';
  sourceTrackingTree?: string;
}): Promise<SdlcWorkspace> {
  const sourceCwd = await realpath(options.sourceCwd);
  const source = await sourceIdentity(sourceCwd);
  if (!source && options.mode === 'isolated')
    throw new Error('SDLC isolated workspaces require a Git repository with a commit.');
  const owner = options.operationId;
  if (!source)
    return {
      ...options,
      owner,
      sourceCwd,
      cwd: sourceCwd,
      sourceRevision: (await localState(sourceCwd)).revision
    };
  const subdirectory = relative(source.repoRoot, sourceCwd);
  if (isAbsolute(subdirectory) || subdirectory === '..' || subdirectory.startsWith(`..${sep}`))
    throw new Error('SDLC cwd must be within the recorded repository.');
  const sourceRevision = (await gitState(source.repoRoot, options.sourceTrackingTree)).revision;
  const id = hash(`${options.operationId}:${source.repoRoot}`).slice(0, 24);
  const path =
    options.mode === 'existing' ? source.repoRoot : join(source.commonDir, 'pi-sdlc-worktrees', id);
  return {
    ...options,
    owner,
    sourceCwd,
    sourceRevision,
    subdirectory,
    cwd: join(path, subdirectory),
    repoRoot: source.repoRoot,
    commonDir: source.commonDir,
    path,
    baseCommit: source.head,
    sourceRef: await gitRef(source.repoRoot),
    ...(options.mode === 'isolated' ? { branch: `pi/sdlc/${id}` } : {})
  };
}

function worktree(workspace: SdlcWorkspace, commit: string) {
  if (!workspace.repoRoot || !workspace.commonDir || !workspace.path || !workspace.branch)
    throw new Error('Incomplete SDLC worktree identity.');
  return {
    repoRoot: workspace.repoRoot,
    commonDir: workspace.commonDir,
    path: workspace.path,
    cwd: workspace.cwd,
    branch: workspace.branch,
    baseCommit: commit
  };
}

async function validateWorkspace(workspace: SdlcWorkspace, setup: Setup): Promise<void> {
  if (setup.version !== 1 || setup.identity !== identity(workspace))
    throw new Error('SDLC workspace recovery identity does not match the saved intent.');
  const directory = await lstat(workspace.cwd);
  if (setup.directoryIdentity && setup.directoryIdentity !== `${directory.dev}:${directory.ino}`)
    throw new Error(
      'SDLC target directory was replaced. Restore the owned checkout before continuing.'
    );
  if (workspace.mode === 'isolated')
    await validateWorktree(worktree(workspace, setup.commit as string));
  else if (workspace.repoRoot) {
    const [repoRoot, commonDir] = await Promise.all([
      git(workspace.cwd, ['rev-parse', '--show-toplevel']).then((path) => realpath(path)),
      git(workspace.cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']).then((path) =>
        realpath(path)
      )
    ]);
    if (repoRoot !== workspace.repoRoot || commonDir !== workspace.commonDir)
      throw new Error('SDLC target workspace was replaced or removed.');
    if (workspace.sourceRef && workspace.sourceRef !== (await gitRef(workspace.cwd)))
      throw new Error(
        'SDLC target branch changed outside the operation. Restore the recorded checkout before continuing.'
      );
  } else if ((await realpath(workspace.cwd)) !== workspace.sourceCwd)
    throw new Error('SDLC target directory was replaced.');
}

export async function ensureSdlcWorkspace(workspace: SdlcWorkspace): Promise<void> {
  let setup = await saved<Setup>(recordPath(workspace));
  if (!setup) {
    if (workspace.repoRoot) {
      if (workspace.sourceRef && workspace.sourceRef !== (await gitRef(workspace.repoRoot)))
        throw new Error('SDLC source branch changed before setup. No checkout was overwritten.');
      const state = await gitState(workspace.repoRoot, workspace.sourceTrackingTree);
      if (state.revision !== workspace.sourceRevision)
        throw new Error(
          'SDLC source drifted before setup. No checkout was overwritten. Start again from the current source.'
        );
      setup = {
        version: 1,
        identity: identity(workspace),
        tree: state.tree,
        trackingTree: state.tree,
        commit: await commitTree(workspace.repoRoot, state.tree, state.head)
      };
    } else {
      const state = await localState(workspace.cwd);
      if (state.revision !== workspace.sourceRevision)
        throw new Error('SDLC source drifted before setup.');
      setup = { version: 1, identity: identity(workspace), files: state.files };
    }
    await save(recordPath(workspace), setup);
  }
  if (setup.identity !== identity(workspace))
    throw new Error(
      'SDLC workspace identity changed. Restore its recorded intent instead of overwriting it.'
    );
  if (workspace.mode === 'isolated')
    await ensureWorktree(worktree(workspace, setup.commit as string));
  if (!setup.directoryIdentity) {
    const directory = await lstat(workspace.cwd);
    setup.directoryIdentity = `${directory.dev}:${directory.ino}`;
    await save(recordPath(workspace), setup);
  }
  await validateWorkspace(workspace, setup);
}

export async function validateSdlcWorkspace(workspace: SdlcWorkspace): Promise<void> {
  const setup = await saved<Setup>(recordPath(workspace));
  if (!setup)
    throw new Error(
      'SDLC workspace setup record is missing. Restore the recorded workspace before continuing.'
    );
  await validateWorkspace(workspace, setup);
}

export async function inspectSdlcWorkspace(
  workspace: SdlcWorkspace
): Promise<{ revision: string; changedFiles: string[] }> {
  const setup = await saved<Setup>(recordPath(workspace));
  if (!setup) throw new Error('SDLC workspace has not been set up.');
  await validateWorkspace(workspace, setup);
  if (!workspace.repoRoot) {
    const state = await localState(workspace.cwd);
    const paths = new Set([...Object.keys(setup.files ?? {}), ...Object.keys(state.files)]);
    return {
      revision: state.revision,
      changedFiles: [...paths].filter((path) => setup.files?.[path] !== state.files[path]).sort()
    };
  }
  const root = workspace.mode === 'isolated' ? (workspace.path as string) : workspace.repoRoot;
  const state = await gitState(root, setup.trackingTree);
  return workspaceSnapshot(workspace, setup, state);
}

async function workspaceSnapshot(workspace: SdlcWorkspace, setup: Setup, state: GitState) {
  const root =
    workspace.mode === 'isolated' ? (workspace.path as string) : (workspace.repoRoot as string);
  if (setup.trackingTree !== state.tree) {
    setup.trackingTree = state.tree;
    await save(recordPath(workspace), setup);
  }
  const changedFiles = (
    await git(root, ['diff', '--no-renames', '--name-only', '-z', setup.tree as string, state.tree])
  )
    .split('\0')
    .filter(Boolean)
    .map((path) => relative(workspace.cwd, join(root, path)).split(sep).join('/'));
  return { revision: state.revision, changedFiles };
}

/** Paths retained by the private candidate index, including integrated files that are now ignored. */
export async function sdlcWorkspaceTrackingPaths(workspace: SdlcWorkspace): Promise<string[]> {
  if (!workspace.repoRoot) return [];
  const setup = await saved<Setup>(recordPath(workspace));
  if (!setup?.trackingTree && !setup?.tree)
    throw new Error('SDLC workspace has no captured candidate tree.');
  const root = workspace.mode === 'isolated' ? (workspace.path as string) : workspace.repoRoot;
  return [...(await treePaths(root, (setup.trackingTree ?? setup.tree) as string))];
}

/** Stable task IDs recover the same fork, even when its writer has partially edited it. */
export async function forkSdlcWorkspace(
  target: SdlcWorkspace,
  taskId: string
): Promise<SdlcWorkspace> {
  const intentPath = join(
    target.storageDir,
    'workspaces',
    `fork-${hash(`${target.owner}:${taskId}`).slice(0, 24)}.json`
  );
  const known = await saved<SdlcWorkspace>(intentPath);
  if (known) {
    await ensureSdlcWorkspace(known);
    return known;
  }
  await validateSdlcWorkspace(target);
  const planned = await planSdlcWorkspace({
    operationId: `${target.operationId}:${taskId}`,
    sourceCwd: target.cwd,
    storageDir: target.storageDir,
    mode: 'isolated',
    sourceTrackingTree: (await saved<Setup>(recordPath(target)))?.trackingTree
  });
  await save(intentPath, planned);
  await ensureSdlcWorkspace(planned);
  return planned;
}

/** Process-lifetime lease. SQLite releases it on interruption or process death without stealing files. */
export function acquireSdlcWorkspaceLease(workspace: SdlcWorkspace): () => void {
  const destination =
    workspace.mode === 'existing'
      ? (workspace.repoRoot ?? workspace.cwd)
      : (workspace.path ?? workspace.cwd);
  const root = workspace.commonDir
    ? join(workspace.commonDir, 'pi-sdlc-ownership')
    : join(workflowRunsRoot(), 'workspace-leases');
  try {
    // Non-Git roots can overlap without a repository identity. Serialize them conservatively.
    return acquireRunLock(root, workspace.repoRoot ? hash(destination).slice(0, 32) : 'non-git');
  } catch (error) {
    if (!(error instanceof WorkflowRunLockedError)) throw error;
    throw new Error(
      `SDLC workspace ${destination} is owned by another active operation. Close it before continuing.`,
      { cause: error }
    );
  }
}

type Integration = {
  version: 1;
  childRevision: string;
  expectedRevision: string;
  beforeTree: string;
  afterTree: string;
  head: string;
  index: string;
};

/** Integrate through a private index. Never stage, reset, or commit the destination checkout. */
export async function integrateSdlcWorkspace(
  target: SdlcWorkspace,
  child: SdlcWorkspace,
  expectedTargetRevision: string
): Promise<{ revision: string; changedFiles: string[] }> {
  const targetSetup = await saved<Setup>(recordPath(target));
  const childSetup = await saved<Setup>(recordPath(child));
  if (
    !targetSetup ||
    !childSetup ||
    !target.repoRoot ||
    !child.repoRoot ||
    target.commonDir !== child.commonDir
  )
    throw new Error('SDLC branch integration requires compatible Git workspaces.');
  await validateWorkspace(target, targetSetup);
  await validateWorkspace(child, childSetup);
  const root = target.mode === 'isolated' ? (target.path as string) : target.repoRoot;
  const childRoot = child.mode === 'isolated' ? (child.path as string) : child.repoRoot;
  const childState = await gitState(childRoot, childSetup.trackingTree);
  const receiptPath = join(
    target.storageDir,
    'integrations',
    `${hash(child.owner).slice(0, 24)}.json`
  );
  let intent = await saved<Integration>(receiptPath);
  const current = await gitState(root, targetSetup.trackingTree);
  if (intent) {
    if (
      intent.version !== 1 ||
      intent.childRevision !== childState.revision ||
      intent.expectedRevision !== expectedTargetRevision
    )
      throw new Error(
        'SDLC integration inputs changed after its durable intent. Replan the affected task.'
      );
    if (current.head !== intent.head || current.index !== intent.index)
      throw new Error(
        'SDLC target HEAD or index drifted during integration. User changes were preserved.'
      );
    if (current.tree === intent.afterTree) return workspaceSnapshot(target, targetSetup, current);
    if (current.tree !== intent.beforeTree)
      throw new Error(
        'SDLC target changed during interrupted integration. Reconcile it manually without discarding user edits.'
      );
  } else {
    if (current.revision !== expectedTargetRevision)
      throw new Error(
        'SDLC target drift detected. User changes and index were preserved; inspect and continue from a compatible revision.'
      );
    const patch = await git(childRoot, [
      'diff',
      '--binary',
      '--full-index',
      childSetup.tree as string,
      childState.tree
    ]);
    if (!patch) return workspaceSnapshot(target, targetSetup, current);
    const privateIndex = join(
      await git(root, ['rev-parse', '--path-format=absolute', '--git-dir']),
      `pi-sdlc-merge-${randomUUID()}`
    );
    const patchPath = `${privateIndex}.patch`;
    try {
      const env = { GIT_INDEX_FILE: privateIndex };
      await git(root, ['read-tree', current.tree], env);
      await writeFile(patchPath, `${patch}\n`);
      try {
        await git(root, ['apply', '--cached', '--3way', '--whitespace=nowarn', patchPath], env);
      } catch {
        throw new Error(
          'SDLC integration conflict. The target and its index are unchanged; retain the worker checkout for conflict resolution.'
        );
      }
      intent = {
        version: 1,
        childRevision: childState.revision,
        expectedRevision: expectedTargetRevision,
        beforeTree: current.tree,
        afterTree: await git(root, ['write-tree'], env),
        head: current.head,
        index: current.index
      };
      await save(receiptPath, intent);
    } finally {
      await rm(privateIndex, { force: true });
      await rm(`${privateIndex}.lock`, { force: true });
      await rm(patchPath, { force: true });
    }
  }
  if ((await gitState(root, targetSetup.trackingTree)).revision !== current.revision)
    throw new Error('SDLC target drifted before applying integration. No changes were applied.');
  if (intent.beforeTree === intent.afterTree)
    return workspaceSnapshot(target, targetSetup, current);
  const patchPath = join(
    target.storageDir,
    'integrations',
    `${hash(child.owner).slice(0, 24)}.patch`
  );
  await writeFile(
    patchPath,
    `${await git(root, ['diff', '--binary', '--full-index', intent.beforeTree, intent.afterTree])}\n`
  );
  await git(root, ['apply', '--check', '--whitespace=nowarn', patchPath]);
  targetSetup.trackingTree = intent.afterTree;
  await save(recordPath(target), targetSetup);
  await git(root, ['apply', '--whitespace=nowarn', patchPath]);
  const after = await gitState(root, targetSetup.trackingTree);
  if (after.tree !== intent.afterTree || after.index !== intent.index || after.head !== intent.head)
    throw new Error(
      'SDLC integration result drifted. Inspect the retained workspaces before continuing.'
    );
  return workspaceSnapshot(target, targetSetup, after);
}
