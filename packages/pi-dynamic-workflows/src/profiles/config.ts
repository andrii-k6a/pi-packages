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
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { terminalInput } from '../shared/terminal-text.js';
import {
  boundedProfileText,
  describeProfileText,
  type WorkflowProfile,
  type WorkflowProfileConfig
} from './contracts.js';

const CONFIG_FILE_NAME = 'pi-dynamic-workflows/profiles.json';
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
function profileConfigPath(path: string): string {
  return boundedProfileText(path);
}

function profileConfigError(path: string, message: string): Error {
  return new Error(
    `Invalid dynamic workflow profile configuration at ${profileConfigPath(path)}: ${message}`
  );
}

export function workflowProfilesPath(agentDir = getAgentDir()): string {
  return join(agentDir, CONFIG_FILE_NAME);
}

/**
 * Loads approved profiles; a missing or disabled configuration intentionally approves none, and
 * individually disabled profiles are skipped.
 */
export function loadWorkflowProfiles(agentDir = getAgentDir()): WorkflowProfile[] {
  const { enabled, profiles } = loadWorkflowProfileConfig(agentDir);
  return enabled ? profiles.filter((profile) => profile.enabled !== false) : [];
}

/** Loads the configuration as stored, including the profiles of a disabled configuration. */
export function loadWorkflowProfileConfig(agentDir = getAgentDir()): WorkflowProfileConfig {
  const path = workflowProfilesPath(agentDir);
  if (!existsSync(path)) return { enabled: true, profiles: [] };

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

  return parseWorkflowProfileConfig(config, path);
}

/**
 * Validates and atomically persists the user-owned workflow profile configuration.
 *
 * The parser is intentionally shared with loading so manager writes can never create a
 * configuration that the extension would reject on its subsequent runtime reload.
 */
export function saveWorkflowProfileConfig(
  config: WorkflowProfileConfig,
  agentDir = getAgentDir()
): WorkflowProfileConfig {
  const path = workflowProfilesPath(agentDir);
  const validated = parseWorkflowProfileConfig(config, path);
  const directory = dirname(path);
  const temporaryPath = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);

  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, {
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

export function parseWorkflowProfileConfig(config: unknown, path: string): WorkflowProfileConfig {
  if (!isRecord(config)) throw profileConfigError(path, 'expected an object');
  assertOnlyKeys(config, ['enabled', 'profiles'], 'configuration', path);
  const enabled = optionalBoolean(config.enabled, 'enabled', path);
  if (!Array.isArray(config.profiles)) {
    throw profileConfigError(path, 'profiles must be an array');
  }

  const names = new Set<string>();
  const profiles = config.profiles.map((item, index) => {
    const itemPath = `profiles[${index}]`;
    if (!isRecord(item)) invalidConfig(path, `${itemPath} must be an object`);
    assertOnlyKeys(
      item,
      ['name', 'description', 'provider', 'model', 'thinkingLevel', 'enabled'],
      itemPath,
      path
    );

    const profileEnabled = optionalBoolean(item.enabled, `${itemPath}.enabled`, path);
    const profile: WorkflowProfile = {
      name: requiredText(item.name, `${itemPath}.name`, path),
      description: requiredText(item.description, `${itemPath}.description`, path),
      provider: optionalText(item.provider, `${itemPath}.provider`, path),
      model: requiredText(item.model, `${itemPath}.model`, path),
      thinkingLevel: requiredThinkingLevel(item.thinkingLevel, `${itemPath}.thinkingLevel`, path),
      ...(profileEnabled === undefined ? {} : { enabled: profileEnabled })
    };
    if (names.has(profile.name))
      invalidConfig(path, `${itemPath}.name duplicates ${describeProfileText(profile.name)}`);
    names.add(profile.name);
    return profile;
  });
  return { enabled: enabled ?? true, profiles };
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
  if (terminalInput(value) !== value)
    invalidConfig(path, `${name} must not contain terminal control characters`);
  return value.trim();
}

function optionalText(value: unknown, name: string, path: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredText(value, name, path);
}

function optionalBoolean(value: unknown, name: string, path: string): boolean | undefined {
  if (value !== undefined && typeof value !== 'boolean')
    invalidConfig(path, `${name} must be a boolean`);
  return value;
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
