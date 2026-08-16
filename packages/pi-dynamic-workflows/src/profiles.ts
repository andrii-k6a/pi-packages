import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import { type Api, getSupportedThinkingLevels, type Model } from '@earendil-works/pi-ai';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

const CONFIG_FILE_NAME = 'pi-dynamic-workflows/profiles.json';
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

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
}

export type WorkflowProfileResolver = (name: string) => ResolvedWorkflowProfile;

export class WorkflowProfileRoutingError extends Error {
  constructor(profileName: string, reason: string) {
    super(`Cannot route workflow profile ${JSON.stringify(profileName)}: ${reason}`);
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
    const detail = error instanceof Error ? `: ${error.message}` : '';
    throw new Error(`Invalid dynamic workflow profile configuration at ${path}${detail}`);
  }

  return parseWorkflowProfiles(config, path);
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

    if (!getSupportedThinkingLevels(model).includes(profile.thinkingLevel)) {
      throw new WorkflowProfileRoutingError(
        name,
        'the configured thinking level is unsupported by the selected model'
      );
    }

    return { model, thinkingLevel: profile.thinkingLevel };
  };
}

function parseWorkflowProfiles(config: unknown, path: string): WorkflowProfile[] {
  if (!isRecord(config))
    throw new Error(
      `Invalid dynamic workflow profile configuration at ${path}: expected an object`
    );
  assertOnlyKeys(config, ['profiles'], 'configuration', path);
  if (!Array.isArray(config.profiles)) {
    throw new Error(
      `Invalid dynamic workflow profile configuration at ${path}: profiles must be an array`
    );
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
    if (names.has(profile.name)) invalidConfig(path, `${itemPath}.name duplicates ${profile.name}`);
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
    if (!allowed.includes(key)) invalidConfig(path, `${name} has unknown key ${key}`);
  }
}

function requiredText(value: unknown, name: string, path: string): string {
  if (typeof value !== 'string' || !value.trim())
    invalidConfig(path, `${name} must be a non-empty string`);
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
  throw new Error(`Invalid dynamic workflow profile configuration at ${path}: ${message}`);
}
