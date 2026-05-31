import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

export const CONFIG_KEY = 'pi-graphify';

export const SEMANTIC_BACKENDS = [
  'pi',
  'auto',
  'deepseek',
  'openai',
  'claude',
  'kimi',
  'gemini',
  'ollama',
  'bedrock',
  'claude-cli'
] as const;

export type SemanticBackend = (typeof SEMANTIC_BACKENDS)[number];

export type AutoContextConfig = {
  enabled: boolean;
  sessionHint: boolean;
  toolResultHints: boolean;
  autoQuery: boolean;
  maxSessionHints: number;
  maxHintChars: number;
  minToolResultLines: number;
  triggerTools: string[];
  triggerPatterns: string[];
};

export type RawGraphifyConfig = {
  enabled?: boolean;
  outputDir?: string;
  defaultQueryBudget?: number;
  semanticBackend?: SemanticBackend;
  autoContext?: Partial<AutoContextConfig>;
};

export type GraphifyConfig = {
  enabled: boolean;
  outputDir: string;
  defaultQueryBudget: number;
  semanticBackend: SemanticBackend;
  autoContext: AutoContextConfig;
};

export const DEFAULT_CONFIG: GraphifyConfig = {
  enabled: true,
  outputDir: 'graphify-out',
  defaultQueryBudget: 2000,
  semanticBackend: 'pi',
  autoContext: {
    enabled: true,
    sessionHint: true,
    toolResultHints: true,
    autoQuery: false,
    maxSessionHints: 8,
    maxHintChars: 1200,
    minToolResultLines: 8,
    triggerTools: ['read', 'grep', 'rg', 'find', 'bash'],
    triggerPatterns: [
      'architecture',
      'module',
      'component',
      'pipeline',
      'dependency',
      'depends',
      'connect',
      'relationship',
      'call flow',
      'graphify',
      'graph',
      'GRAPH_REPORT',
      'graphify-out'
    ]
  }
};

export type LoadGraphifyConfigOptions = {
  cwd?: string;
  globalConfigPath?: string;
  projectConfigPath?: string;
  readTextFile?: (file: string) => string | undefined;
  warn?: (message: string) => void;
};

const warningPrefix = '[pi-graphify]';

export function getGlobalPrimeSettingsPath(): string {
  try {
    return path.join(getAgentDir(), 'prime-settings.json');
  } catch {
    return path.join(os.homedir(), '.pi', 'agent', 'prime-settings.json');
  }
}

export function getProjectPrimeSettingsPath(cwd = process.cwd()): string {
  return path.join(cwd, '.pi', 'prime-settings.json');
}

export function resolveOutputDir(cwd: string, outputDir: string): string {
  return path.resolve(cwd, outputDir);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isSemanticBackend(value: unknown): value is SemanticBackend {
  return typeof value === 'string' && SEMANTIC_BACKENDS.includes(value as SemanticBackend);
}

function warnInvalid(warn: ((message: string) => void) | undefined, message: string): void {
  warn?.(`${warningPrefix} ${message}`);
}

function validPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined;
}

function validStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter(
    (item): item is string => typeof item === 'string' && item.trim().length > 0
  );
  return strings.length === value.length ? strings.map((item) => item.trim()) : undefined;
}

function parseAutoContext(
  value: unknown,
  warn?: (message: string) => void
): Partial<AutoContextConfig> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    warnInvalid(warn, 'Invalid autoContext config; using defaults');
    return undefined;
  }

  const config: Partial<AutoContextConfig> = {};
  for (const key of ['enabled', 'sessionHint', 'toolResultHints', 'autoQuery'] as const) {
    if (value[key] === undefined) continue;
    if (typeof value[key] === 'boolean') config[key] = value[key];
    else warnInvalid(warn, `Invalid autoContext.${key}; using default`);
  }

  for (const key of ['maxSessionHints', 'maxHintChars', 'minToolResultLines'] as const) {
    if (value[key] === undefined) continue;
    const parsed = validPositiveInteger(value[key]);
    if (parsed !== undefined) config[key] = parsed;
    else warnInvalid(warn, `Invalid autoContext.${key}; using default`);
  }

  for (const key of ['triggerTools', 'triggerPatterns'] as const) {
    if (value[key] === undefined) continue;
    const parsed = validStringArray(value[key]);
    if (parsed) config[key] = parsed;
    else warnInvalid(warn, `Invalid autoContext.${key}; using default`);
  }

  return config;
}

export function parseGraphifyConfig(
  input: unknown,
  warn?: (message: string) => void
): Partial<GraphifyConfig> {
  if (input === undefined) return {};
  if (!isRecord(input)) {
    warnInvalid(warn, 'Invalid config; using defaults');
    return {};
  }

  const config: Partial<GraphifyConfig> = {};

  if (input.enabled !== undefined) {
    if (typeof input.enabled === 'boolean') config.enabled = input.enabled;
    else warnInvalid(warn, 'Invalid enabled value; using default');
  }

  if (input.outputDir !== undefined) {
    if (typeof input.outputDir === 'string' && input.outputDir.trim()) {
      config.outputDir = input.outputDir.trim();
    } else {
      warnInvalid(warn, 'Invalid outputDir value; using default');
    }
  }

  if (input.defaultQueryBudget !== undefined) {
    const parsed = validPositiveInteger(input.defaultQueryBudget);
    if (parsed !== undefined) config.defaultQueryBudget = parsed;
    else warnInvalid(warn, 'Invalid defaultQueryBudget value; using default');
  }

  if (input.semanticBackend !== undefined) {
    if (isSemanticBackend(input.semanticBackend)) config.semanticBackend = input.semanticBackend;
    else warnInvalid(warn, 'Invalid semanticBackend value; using default');
  }

  const autoContext = parseAutoContext(input.autoContext, warn);
  if (autoContext) config.autoContext = { ...DEFAULT_CONFIG.autoContext, ...autoContext };

  return config;
}

function mergeConfig(base: GraphifyConfig, override: Partial<GraphifyConfig>): GraphifyConfig {
  return {
    ...base,
    ...override,
    autoContext: { ...base.autoContext, ...override.autoContext }
  };
}

function defaultReadTextFile(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  return readFileSync(file, 'utf8');
}

function readConfigFile(
  file: string,
  readTextFile: (file: string) => string | undefined,
  warn?: (message: string) => void
): Partial<GraphifyConfig> {
  const text = readTextFile(file);
  if (text === undefined) return {};

  try {
    const root = JSON.parse(text) as unknown;
    if (!isRecord(root)) {
      warnInvalid(warn, `Invalid settings file ${file}; expected object`);
      return {};
    }
    const packageConfig = root[CONFIG_KEY];
    if (packageConfig === undefined) return {};
    if (!isRecord(packageConfig)) {
      warnInvalid(warn, `Invalid ${CONFIG_KEY} config in ${file}; expected object`);
      return {};
    }
    return parseGraphifyConfig(packageConfig, warn);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnInvalid(warn, `Failed to read ${file}: ${message}`);
    return {};
  }
}

export function loadGraphifyConfig(options: LoadGraphifyConfigOptions = {}): GraphifyConfig {
  const cwd = options.cwd ?? process.cwd();
  const readTextFile = options.readTextFile ?? defaultReadTextFile;
  const warn = options.warn ?? console.warn;
  const globalConfig = readConfigFile(
    options.globalConfigPath ?? getGlobalPrimeSettingsPath(),
    readTextFile,
    warn
  );
  const projectConfig = readConfigFile(
    options.projectConfigPath ?? getProjectPrimeSettingsPath(cwd),
    readTextFile,
    warn
  );

  return mergeConfig(mergeConfig(DEFAULT_CONFIG, globalConfig), projectConfig);
}
