import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GraphifyConfig, SemanticBackend } from './config.js';

const execFileAsync = promisify(execFile);

export type GraphifyRun = {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
  errorCode?: string;
};

export type CommandStep = {
  command: string;
  args: string[];
  label?: string;
  longRunning?: boolean;
  mutatesInstallation?: boolean;
};

export type QueryArgsParams = {
  question: string;
  dfs?: boolean;
  budget?: number;
};

export type UpdateArgsParams = {
  path?: string;
  force?: boolean;
  noCluster?: boolean;
};

export type BuildArgsParams = {
  path?: string;
  mode?: 'standard' | 'deep';
  backend?: SemanticBackend;
  noViz?: boolean;
  svg?: boolean;
  graphml?: boolean;
  neo4j?: boolean;
};

export type AddArgsParams = {
  url: string;
  author?: string;
  contributor?: string;
};

export type ClusterArgsParams = {
  path?: string;
  noViz?: boolean;
};

export type ExtractArgsParams = {
  inputPath?: string;
  backend?: SemanticBackend;
  maxWorkers?: number;
  tokenBudget?: number;
  maxConcurrency?: number;
  apiTimeout?: number;
  resolution?: number;
  excludeHubs?: number;
  exclude?: string[];
};

export type ExportCallflowArgsParams = {
  graphPath?: string;
  outputPath?: string;
};

export type WatchArgsParams = {
  path?: string;
  debounce?: number;
};

export type UpgradeAction = 'check' | 'install' | 'sync-skill';

export async function runExecFile(
  command: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal
): Promise<GraphifyRun> {
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      signal
    });
    return { ok: true, stdout: result.stdout ?? '', stderr: result.stderr ?? '', code: 0 };
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: string | number;
    };
    return {
      ok: false,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? err.message ?? String(error),
      code: typeof err.code === 'number' ? err.code : 1,
      errorCode: typeof err.code === 'string' ? err.code : undefined
    };
  }
}

export function runGraphify(
  cwd: string,
  args: string[],
  signal?: AbortSignal
): Promise<GraphifyRun> {
  return runExecFile('graphify', args, cwd, signal);
}

export async function runCommandStep(
  cwd: string,
  step: CommandStep,
  signal?: AbortSignal
): Promise<GraphifyRun> {
  return runExecFile(step.command, step.args, cwd, signal);
}

function normalizeOptionalPath(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed || '.';
}

function requireNonEmpty(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${name} is required`);
  return trimmed;
}

function requirePositiveInteger(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function requirePositiveNumber(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

function pushOption(args: string[], flag: string, value: string | number | undefined): void {
  if (value !== undefined) args.push(flag, String(value));
}

export type PiModelIdentity = {
  provider: string;
  id: string;
};

export type GraphifyBackendResolution = {
  backend?: Exclude<SemanticBackend, 'auto' | 'pi'>;
  source: 'explicit' | 'config' | 'pi' | 'graphify-auto';
};

export function graphifyBackendFromPiModel(
  model: PiModelIdentity | undefined
): Exclude<SemanticBackend, 'auto' | 'pi'> | undefined {
  if (!model) return undefined;

  const provider = model.provider.toLowerCase();
  const id = model.id.toLowerCase();

  if (provider === 'google' || provider === 'google-ai-studio' || provider === 'google-vertex') {
    return 'gemini';
  }
  if (provider === 'anthropic') return 'claude';
  if (provider === 'openai' || provider.startsWith('azure-openai')) return 'openai';
  if (provider === 'deepseek') return 'deepseek';
  if (provider === 'amazon-bedrock') return 'bedrock';
  if (provider === 'ollama') return 'ollama';
  if (provider === 'moonshotai' || provider === 'moonshotai-cn' || provider === 'kimi-coding') {
    return 'kimi';
  }

  // OpenRouter and other OpenAI-compatible gateways expose the model family in the model id.
  if (id.includes('gemini')) return 'gemini';
  if (id.includes('claude')) return 'claude';
  if (id.includes('deepseek')) return 'deepseek';
  if (id.includes('kimi') || id.includes('moonshot')) return 'kimi';
  if (id.includes('gpt-') || id.includes('openai/')) return 'openai';

  return undefined;
}

export function resolveGraphifyBackend(
  requested: SemanticBackend | undefined,
  config: GraphifyConfig,
  model?: PiModelIdentity
): GraphifyBackendResolution {
  if (requested && requested !== 'auto' && requested !== 'pi') {
    return { backend: requested, source: 'explicit' };
  }

  const configured = requested ?? config.semanticBackend;
  if (configured !== 'auto' && configured !== 'pi') {
    return { backend: configured, source: 'config' };
  }

  if (configured === 'pi') {
    const backend = graphifyBackendFromPiModel(model);
    if (backend) return { backend, source: 'pi' };
  }

  return { source: 'graphify-auto' };
}

export function buildQueryArgs(params: QueryArgsParams): string[] {
  const args = ['query', requireNonEmpty(params.question, 'question')];
  if (params.dfs) args.push('--dfs');
  pushOption(args, '--budget', params.budget);
  return args;
}

export function buildExplainArgs(concept: string): string[] {
  return ['explain', requireNonEmpty(concept, 'concept')];
}

export function buildPathArgs(from: string, to: string): string[] {
  return ['path', requireNonEmpty(from, 'from'), requireNonEmpty(to, 'to')];
}

export function buildUpdateArgs(params: UpdateArgsParams = {}): string[] {
  const args = ['update', normalizeOptionalPath(params.path)];
  if (params.force) args.push('--force');
  if (params.noCluster) args.push('--no-cluster');
  return args;
}

export function buildExtractArgs(path = '.'): string[] {
  return ['extract', normalizeOptionalPath(path)];
}

export function buildBuildPlan(
  params: BuildArgsParams,
  config: GraphifyConfig,
  model?: PiModelIdentity
): CommandStep[] {
  const extractArgs = ['extract', normalizeOptionalPath(params.path)];
  const backend = resolveGraphifyBackend(params.backend, config, model).backend;
  pushOption(extractArgs, '--backend', backend);
  if (params.mode === 'deep') extractArgs.push('--mode', 'deep');
  if (params.svg) extractArgs.push('--svg');
  if (params.graphml) extractArgs.push('--graphml');
  if (params.neo4j) extractArgs.push('--neo4j');

  const clusterArgs = ['cluster-only', normalizeOptionalPath(params.path)];
  if (params.noViz) clusterArgs.push('--no-viz');

  return [
    { command: 'graphify', args: extractArgs, label: 'extract' },
    { command: 'graphify', args: clusterArgs, label: 'cluster' }
  ];
}

export function buildAddPlan(params: AddArgsParams): CommandStep[] {
  const args = ['add', requireNonEmpty(params.url, 'url')];
  pushOption(args, '--author', params.author?.trim() || undefined);
  pushOption(args, '--contributor', params.contributor?.trim() || undefined);
  return [
    { command: 'graphify', args, label: 'add' },
    { command: 'graphify', args: ['update', './raw'], label: 'update raw' }
  ];
}

export function buildClusterArgs(params: ClusterArgsParams = {}): string[] {
  const args = ['cluster-only', normalizeOptionalPath(params.path)];
  if (params.noViz) args.push('--no-viz');
  return args;
}

export function buildDetailedExtractArgs(
  params: ExtractArgsParams = {},
  config?: GraphifyConfig,
  model?: PiModelIdentity
): string[] {
  const args = ['extract', normalizeOptionalPath(params.inputPath)];
  const backend = config
    ? resolveGraphifyBackend(params.backend, config, model).backend
    : params.backend === 'auto' || params.backend === 'pi'
      ? undefined
      : params.backend;
  pushOption(args, '--backend', backend);
  pushOption(args, '--max-workers', requirePositiveInteger(params.maxWorkers, 'maxWorkers'));
  pushOption(args, '--token-budget', requirePositiveInteger(params.tokenBudget, 'tokenBudget'));
  pushOption(
    args,
    '--max-concurrency',
    requirePositiveInteger(params.maxConcurrency, 'maxConcurrency')
  );
  pushOption(args, '--api-timeout', requirePositiveInteger(params.apiTimeout, 'apiTimeout'));
  pushOption(args, '--resolution', requirePositiveNumber(params.resolution, 'resolution'));
  pushOption(args, '--exclude-hubs', requirePositiveNumber(params.excludeHubs, 'excludeHubs'));
  for (const exclude of params.exclude ?? []) {
    const trimmed = exclude.trim();
    if (trimmed) args.push('--exclude', trimmed);
  }
  return args;
}

export function buildExportCallflowArgs(
  params: ExportCallflowArgsParams = {},
  outputDir = 'graphify-out'
): string[] {
  return [
    'export',
    'callflow-html',
    '--graph',
    params.graphPath?.trim() || `${outputDir}/graph.json`,
    '--output',
    params.outputPath?.trim() || `${outputDir}/callflow.html`
  ];
}

export function buildWatchArgs(params: WatchArgsParams = {}): string[] {
  const args = ['watch', normalizeOptionalPath(params.path)];
  pushOption(args, '--debounce', requirePositiveInteger(params.debounce, 'debounce'));
  return args;
}

export function buildUpgradePlan(action: UpgradeAction = 'check'): CommandStep[] {
  if (action === 'check') return [{ command: 'graphify', args: ['--version'], label: 'version' }];
  if (action === 'sync-skill') {
    return [{ command: 'graphify', args: ['install', '--platform', 'pi'], label: 'sync skill' }];
  }
  return [
    {
      command: 'uv',
      args: ['tool', 'upgrade', 'graphifyy'],
      label: 'upgrade graphifyy',
      mutatesInstallation: true
    },
    { command: 'graphify', args: ['install', '--platform', 'pi'], label: 'sync skill' }
  ];
}
