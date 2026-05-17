import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ExtensionAPI, getAgentDir } from '@earendil-works/pi-coding-agent';

export type ShortcutKey = Parameters<ExtensionAPI['registerShortcut']>[0];

export const directions = ['right', 'left', 'down', 'up'] as const;
export type Direction = (typeof directions)[number];
export type ShortcutConfig = Partial<Record<Direction, ShortcutKey>>;

export type DirectionConfig = {
  description: string;
  splitFlag: '-h' | '-v';
  before: boolean;
  shortcut: ShortcutKey;
};

export const directionConfig: Record<Direction, DirectionConfig> = {
  right: { description: 'on the right', splitFlag: '-h', before: false, shortcut: 'ctrl+shift+l' },
  left: { description: 'on the left', splitFlag: '-h', before: true, shortcut: 'ctrl+shift+h' },
  down: { description: 'below', splitFlag: '-v', before: false, shortcut: 'ctrl+shift+j' },
  up: { description: 'above', splitFlag: '-v', before: true, shortcut: 'ctrl+shift+k' }
};

export type Config = {
  shortcuts: ShortcutConfig;
};

const packageName = 'pi-tmux-branch';
const settingsFileName = 'settings.json';
const warningPrefix = `[${packageName}]`;

const DEFAULT_SHORTCUTS = Object.fromEntries(
  directions.map((direction) => [direction, directionConfig[direction].shortcut])
) as Record<Direction, ShortcutKey>;

function getGlobalSettingsPath(): string {
  return join(getAgentDir(), packageName, settingsFileName);
}

function getProjectSettingsPath(cwd = process.cwd()): string {
  return join(cwd, '.pi', packageName, settingsFileName);
}

function readSettings(path: string): unknown {
  if (!existsSync(path)) {
    return undefined;
  }

  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`${warningPrefix} Failed to read ${path}: ${message}`);
    return undefined;
  }
}

function loadSettings(cwd = process.cwd()): unknown {
  const projectSettingsPath = getProjectSettingsPath(cwd);
  if (existsSync(projectSettingsPath)) {
    return readSettings(projectSettingsPath);
  }

  return readSettings(getGlobalSettingsPath());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function defaultConfig(): Config {
  return { shortcuts: { ...DEFAULT_SHORTCUTS } };
}

export function parseConfig(settings: unknown): Config {
  const config = defaultConfig();

  if (settings === undefined) {
    return config;
  }

  if (!isRecord(settings)) {
    console.warn(`${warningPrefix} Invalid settings; using default Vim-style shortcuts`);
    return config;
  }

  if (settings.shortcutsEnabled === false) {
    return { shortcuts: {} };
  }

  if (settings.shortcutsEnabled !== undefined && typeof settings.shortcutsEnabled !== 'boolean') {
    console.warn(
      `${warningPrefix} Invalid shortcutsEnabled value; using default Vim-style shortcuts`
    );
    return config;
  }

  if (settings.shortcuts === undefined) {
    return config;
  }

  if (!isRecord(settings.shortcuts)) {
    console.warn(
      `${warningPrefix} Invalid shortcuts configuration; using default Vim-style shortcuts`
    );
    return config;
  }

  for (const direction of directions) {
    if (!(direction in settings.shortcuts)) {
      continue;
    }

    const shortcut = settings.shortcuts[direction];
    if (shortcut === null || shortcut === false) {
      delete config.shortcuts[direction];
    } else if (typeof shortcut === 'string' && shortcut.trim()) {
      config.shortcuts[direction] = shortcut.trim() as ShortcutKey;
    } else {
      console.warn(
        `${warningPrefix} Invalid shortcut for ${direction}; keeping the default binding`
      );
    }
  }

  return config;
}

export function loadConfig(cwd = process.cwd()): Config {
  return parseConfig(loadSettings(cwd));
}
