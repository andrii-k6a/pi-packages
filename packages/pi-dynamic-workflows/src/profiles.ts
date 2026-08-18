import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import { type Api, getSupportedThinkingLevels, type Model } from '@earendil-works/pi-ai';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

const CONFIG_FILE_NAME = 'pi-dynamic-workflows/profiles.json';
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const MAX_ERROR_TEXT_LENGTH = 160;
const TERMINAL_ESCAPE_INITIATORS = new Set([27, 144, 155, 157, 158, 159]);

/** Removes C0, C1, and DEL characters before profile text reaches the terminal. */
export function sanitizeWorkflowProfileText(value: string): string {
  return value.replace(/\p{Cc}/gu, '');
}

function boundedProfileText(value: string, maxLength = MAX_ERROR_TEXT_LENGTH): string {
  const characters = [...sanitizeWorkflowProfileText(value)].filter(
    (character) => !TERMINAL_ESCAPE_INITIATORS.has(character.codePointAt(0) ?? -1)
  );
  return characters.length > maxLength
    ? `${characters.slice(0, maxLength).join('')}…`
    : characters.join('');
}

function describeProfileText(value: string): string {
  return JSON.stringify(boundedProfileText(value));
}

function profileConfigPath(path: string): string {
  return boundedProfileText(path);
}

function profileConfigError(path: string, message: string): Error {
  return new Error(
    `Invalid dynamic workflow profile configuration at ${profileConfigPath(path)}: ${message}`
  );
}

export interface WorkflowProfile {
  name: string;
  description: string;
  /** Optional provider. When omitted, resolve the model on the active session provider. */
  provider?: string;
  model: string;
  thinkingLevel: ThinkingLevel;
}

export interface ResolvedWorkflowProfile {
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
}

export interface WorkflowProfileResolverContext {
  model: Model<Api> | undefined;
  modelRegistry: {
    find(provider: string, modelId: string): Model<Api> | undefined;
    getAvailable(): Model<Api>[];
  };
  /** Empty or absent when no session model scope is configured. */
  scopedModels?: readonly {
    model: Model<Api>;
    thinkingLevel?: ThinkingLevel;
  }[];
}

export type WorkflowProfileResolver = (name: string) => ResolvedWorkflowProfile;

export class WorkflowProfileRoutingError extends Error {
  constructor(profileName: string, reason: string) {
    super(`Cannot route workflow profile ${describeProfileText(profileName)}: ${reason}`);
    this.name = 'WorkflowProfileRoutingError';
  }
}

export function workflowProfilesPath(agentDir = getAgentDir()): string {
  return join(agentDir, CONFIG_FILE_NAME);
}

/** Loads approved profiles; a missing configuration file intentionally returns no profiles. */
export function loadWorkflowProfiles(agentDir = getAgentDir()): WorkflowProfile[] {
  const path = workflowProfilesPath(agentDir);
  if (!existsSync(path)) return [];

  let config: unknown;
  try {
    config = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw profileConfigError(
      path,
      `invalid JSON${message ? `: ${boundedProfileText(message)}` : ''}`
    );
  }

  return parseWorkflowProfiles(config, path);
}

/**
 * Validates and atomically persists user-owned workflow profiles.
 *
 * The parser is intentionally shared with loading so manager writes can never create a
 * configuration that the extension would reject on its subsequent runtime reload.
 */
export function saveWorkflowProfiles(
  profiles: unknown,
  agentDir = getAgentDir()
): WorkflowProfile[] {
  const path = workflowProfilesPath(agentDir);
  const validated = parseWorkflowProfiles({ profiles }, path);
  const directory = dirname(path);
  const temporaryPath = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);

  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(temporaryPath, `${JSON.stringify({ profiles: validated }, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx'
    });
    renameSync(temporaryPath, path);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The temporary file was never created or has already been moved into place.
    }
    throw error;
  }

  return validated;
}

export function createWorkflowProfileResolver(
  profiles: readonly WorkflowProfile[],
  context: WorkflowProfileResolverContext
): WorkflowProfileResolver {
  const profilesByName = new Map(profiles.map((profile) => [profile.name, profile]));

  return (name) => {
    const profile = profilesByName.get(name);
    if (!profile) throw new WorkflowProfileRoutingError(name, 'the profile is not approved');

    const provider = profile.provider ?? context.model?.provider;
    if (!provider) {
      throw new WorkflowProfileRoutingError(
        name,
        'there is no configured provider or active session model to anchor routing'
      );
    }
    const model = context.modelRegistry.find(provider, profile.model);
    if (!model || model.provider !== provider) {
      throw new WorkflowProfileRoutingError(
        name,
        'the configured provider does not expose the configured model'
      );
    }

    const isAvailable = context.modelRegistry
      .getAvailable()
      .some((available) => available.provider === provider && available.id === model.id);
    if (!isAvailable) {
      throw new WorkflowProfileRoutingError(
        name,
        'the configured model is unavailable from its configured provider'
      );
    }

    const scopedModels = context.scopedModels ?? [];
    const scopedModel = scopedModels.find(
      ({ model: scoped }) => scoped.provider === model.provider && scoped.id === model.id
    );
    if (scopedModels.length > 0 && !scopedModel) {
      throw new WorkflowProfileRoutingError(
        name,
        'the configured model is outside the session model scope'
      );
    }
    if (
      scopedModel?.thinkingLevel !== undefined &&
      profile.thinkingLevel !== scopedModel.thinkingLevel
    ) {
      throw new WorkflowProfileRoutingError(
        name,
        'the configured thinking level does not match the session-scoped model pin'
      );
    }

    if (!getSupportedThinkingLevels(model).includes(profile.thinkingLevel)) {
      throw new WorkflowProfileRoutingError(
        name,
        'the configured thinking level is unsupported by the selected model'
      );
    }

    return { model, thinkingLevel: profile.thinkingLevel };
  };
}

export function parseWorkflowProfiles(config: unknown, path: string): WorkflowProfile[] {
  if (!isRecord(config)) throw profileConfigError(path, 'expected an object');
  assertOnlyKeys(config, ['profiles'], 'configuration', path);
  if (!Array.isArray(config.profiles)) {
    throw profileConfigError(path, 'profiles must be an array');
  }

  const names = new Set<string>();
  return config.profiles.map((item, index) => {
    const itemPath = `profiles[${index}]`;
    if (!isRecord(item)) invalidConfig(path, `${itemPath} must be an object`);
    assertOnlyKeys(
      item,
      ['name', 'description', 'provider', 'model', 'thinkingLevel'],
      itemPath,
      path
    );

    const profile: WorkflowProfile = {
      name: requiredText(item.name, `${itemPath}.name`, path),
      description: requiredText(item.description, `${itemPath}.description`, path),
      provider: optionalText(item.provider, `${itemPath}.provider`, path),
      model: requiredText(item.model, `${itemPath}.model`, path),
      thinkingLevel: requiredThinkingLevel(item.thinkingLevel, `${itemPath}.thinkingLevel`, path)
    };
    if (names.has(profile.name))
      invalidConfig(path, `${itemPath}.name duplicates ${describeProfileText(profile.name)}`);
    names.add(profile.name);
    return profile;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: string[],
  name: string,
  path: string
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key))
      invalidConfig(path, `${name} has unknown key ${describeProfileText(key)}`);
  }
}

function requiredText(value: unknown, name: string, path: string): string {
  if (typeof value !== 'string' || !value.trim())
    invalidConfig(path, `${name} must be a non-empty string`);
  if (sanitizeWorkflowProfileText(value) !== value)
    invalidConfig(path, `${name} must not contain terminal control characters`);
  return value.trim();
}

function optionalText(value: unknown, name: string, path: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredText(value, name, path);
}

function requiredThinkingLevel(value: unknown, name: string, path: string): ThinkingLevel {
  if (typeof value !== 'string' || !THINKING_LEVELS.includes(value as ThinkingLevel)) {
    invalidConfig(path, `${name} must be a supported Pi thinking level`);
  }
  return value as ThinkingLevel;
}

function invalidConfig(path: string, message: string): never {
  throw profileConfigError(path, message);
}
