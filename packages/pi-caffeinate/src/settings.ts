import { randomUUID } from 'node:crypto';
import { access, constants, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

const SETTINGS_FILE = 'pi-caffeinate.json';
const LEGACY_SETTINGS_FILE = 'pi-caffeinate-settings.json';

export type CaffeinateMode = 'sleep' | 'display';

export interface CaffeinateSettings {
  mode: CaffeinateMode;
  quiet: boolean;
  updatedAt: number;
}

export type SettingsLoadResult =
  | { kind: 'missing'; notice?: string }
  | { kind: 'invalid'; reason: string; notice?: string }
  | { kind: 'loaded'; settings: CaffeinateSettings; notice?: string };

export interface SettingsFileOperations {
  write(path: string, content: string): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
}

const defaultOperations: SettingsFileOperations = {
  write: async (path, content) => writeFile(path, content, 'utf8'),
  rename
};

let saves: Promise<void> = Promise.resolve();

export function normalizeCaffeinateSettings(value: unknown): CaffeinateSettings | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as { mode?: unknown; quiet?: unknown; updatedAt?: unknown };
  if (candidate.mode !== 'sleep' && candidate.mode !== 'display') return undefined;
  if (candidate.quiet !== undefined && typeof candidate.quiet !== 'boolean') return undefined;
  if (candidate.updatedAt !== undefined && typeof candidate.updatedAt !== 'number')
    return undefined;
  return {
    mode: candidate.mode,
    quiet: candidate.quiet ?? false,
    updatedAt: candidate.updatedAt ?? 0
  };
}

export async function loadSettings(): Promise<SettingsLoadResult> {
  await saves;
  const canonical = await readDocument(settingsFilePath());
  if (canonical.result.kind !== 'missing') {
    return withLegacyNotice(canonical.result);
  }

  const legacy = await readDocument(legacySettingsFilePath());
  const canonicalAfterLegacyRead = await readDocument(settingsFilePath());
  if (canonicalAfterLegacyRead.result.kind !== 'missing') {
    return withLegacyNotice(canonicalAfterLegacyRead.result);
  }
  if (legacy.result.kind === 'loaded') {
    return {
      ...legacy.result,
      notice: `Using legacy ${LEGACY_SETTINGS_FILE}; future changes are saved to ${SETTINGS_FILE}.`
    };
  }
  return legacy.result;
}

export function saveSettings(
  settings: Omit<CaffeinateSettings, 'quiet'> & { quiet?: boolean },
  operations: Partial<SettingsFileOperations> = {}
): Promise<CaffeinateSettings> {
  const next = saves.then(async () => saveSettingsNow(settings, operations));
  saves = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

export function settingsFilePath(): string {
  return join(getAgentDir(), SETTINGS_FILE);
}

function legacySettingsFilePath(): string {
  return join(getAgentDir(), LEGACY_SETTINGS_FILE);
}

async function saveSettingsNow(
  requested: Omit<CaffeinateSettings, 'quiet'> & { quiet?: boolean },
  operations: Partial<SettingsFileOperations>
): Promise<CaffeinateSettings> {
  const filePath = settingsFilePath();
  let existing = await readDocument(filePath);
  const canonicalExisted = existing.result.kind !== 'missing';
  if (!canonicalExisted) existing = await readDocument(legacySettingsFilePath());
  if (existing.result.kind === 'invalid') {
    throw new Error(
      `Cannot save settings until the invalid file is repaired: ${existing.result.reason}`
    );
  }

  const previous = existing.result.kind === 'loaded' ? existing.result.settings : undefined;
  const next: CaffeinateSettings = {
    mode: requested.mode,
    quiet: requested.quiet ?? previous?.quiet ?? false,
    updatedAt: requested.updatedAt
  };
  const document = { ...(existing.document ?? {}), ...next };
  await mkdir(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await (operations.write ?? defaultOperations.write)(
      temporary,
      `${JSON.stringify(document, null, 2)}\n`
    );
    if (!canonicalExisted && (await exists(filePath))) {
      throw new Error(`${SETTINGS_FILE} appeared while saving; retry the requested change.`);
    }
    await (operations.rename ?? defaultOperations.rename)(temporary, filePath);
    return next;
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function withLegacyNotice(result: SettingsLoadResult): Promise<SettingsLoadResult> {
  if (!(await exists(legacySettingsFilePath()))) return result;
  return {
    ...result,
    notice: `Ignoring ${LEGACY_SETTINGS_FILE} because ${SETTINGS_FILE} takes precedence.`
  };
}

type ReadDocument = { result: SettingsLoadResult; document?: Record<string, unknown> };

async function readDocument(filePath: string): Promise<ReadDocument> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch (error) {
    if (isMissing(error)) return { result: { kind: 'missing' } };
    return { result: { kind: 'invalid', reason: `${filePath}: ${messageOf(error)}` } };
  }

  try {
    const value = JSON.parse(content) as unknown;
    const settings = normalizeCaffeinateSettings(value);
    if (!settings) {
      return {
        result: {
          kind: 'invalid',
          reason: `${filePath}: expected mode "sleep" or "display", with optional boolean quiet`
        }
      };
    }
    return {
      result: { kind: 'loaded', settings },
      document: { ...(value as Record<string, unknown>) }
    };
  } catch (error) {
    return { result: { kind: 'invalid', reason: `${filePath}: ${messageOf(error)}` } };
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
