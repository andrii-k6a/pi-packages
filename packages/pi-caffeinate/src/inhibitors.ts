import { existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import type { CaffeinateMode } from './settings.js';

export interface InhibitorCommand {
  executable: string;
  args: string[];
  label: string;
  releaseOnStdinClose?: boolean;
  custom?: boolean;
  needsScreenSaverInhibit?: boolean;
}

export interface PlatformDetails {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  commandExists?: (command: string) => boolean;
  isWsl?: boolean;
}

export function selectInhibitor(
  mode: CaffeinateMode,
  {
    platform = process.platform,
    environment = process.env,
    commandExists = commandOnPath,
    isWsl = runningInWsl()
  }: PlatformDetails = {}
): InhibitorCommand | undefined {
  const custom = environment.PI_CAFFEINATE_COMMAND;
  if (custom?.trim()) {
    const [executable, ...args] = splitCommand(custom);
    if (executable)
      return { executable, args, label: `custom command (${executable})`, custom: true };
  }

  if (platform === 'darwin') return macInhibitor(mode);
  if (platform === 'win32') return windowsInhibitor('powershell.exe', mode);
  if (platform !== 'linux') return undefined;

  if (isWsl && commandExists('powershell.exe')) return windowsInhibitor('powershell.exe', mode);
  if (commandExists('systemd-inhibit')) {
    return {
      executable: 'systemd-inhibit',
      args: [
        `--what=${mode === 'display' ? 'idle:sleep' : 'sleep'}`,
        '--who=pi-caffeinate',
        '--why=Pi agent is active',
        '--mode=block',
        'sleep',
        'infinity'
      ],
      label: `systemd-inhibit (${formatMode(mode)})`,
      ...(mode === 'display' ? { needsScreenSaverInhibit: true } : {})
    };
  }
  if (commandExists('caffeinate')) {
    return {
      ...macInhibitor(mode),
      ...(mode === 'display' ? { needsScreenSaverInhibit: true } : {})
    };
  }
  return undefined;
}

function macInhibitor(mode: CaffeinateMode): InhibitorCommand {
  return {
    executable: 'caffeinate',
    args: mode === 'sleep' ? ['-ims'] : ['-dimsu'],
    label: `caffeinate (${formatMode(mode)})`
  };
}

function windowsInhibitor(executable: string, mode: CaffeinateMode): InhibitorCommand {
  return {
    executable,
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', windowsInhibitorScript(mode)],
    label: `PowerShell (${formatMode(mode)})`,
    releaseOnStdinClose: true
  };
}

export function splitCommand(value: string): string[] {
  const result: string[] = [];
  let current = '';
  let argumentStarted = false;
  let quote: '"' | "'" | undefined;

  const finishArgument = (): void => {
    if (argumentStarted) result.push(current);
    current = '';
    argumentStarted = false;
  };

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] as string;

    if (quote === "'") {
      if (character === "'") quote = undefined;
      else current += character;
      continue;
    }

    if (quote === '"') {
      if (character === '"') {
        quote = undefined;
        continue;
      }
      if (character === '\\') {
        const next = value[index + 1];
        if (next === undefined) throw invalidCommand('dangling escape in double quotes');
        if (next === '"' || next === '\\') {
          current += next;
          index += 1;
        } else {
          current += `\\${next}`;
          index += 1;
        }
        continue;
      }
      current += character;
      continue;
    }

    if (/\s/.test(character)) {
      finishArgument();
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      argumentStarted = true;
      continue;
    }
    if (character === '\\') {
      const next = value[index + 1];
      if (next === undefined) throw invalidCommand('dangling escape');
      if (/\s/.test(next) || next === '"' || next === "'" || next === '\\') {
        current += next;
        index += 1;
      } else {
        current += '\\';
      }
      argumentStarted = true;
      continue;
    }
    current += character;
    argumentStarted = true;
  }

  if (quote) throw invalidCommand(`unclosed ${quote === '"' ? 'double' : 'single'} quote`);
  finishArgument();
  return result;
}

function invalidCommand(reason: string): Error {
  return new Error(`Invalid PI_CAFFEINATE_COMMAND: ${reason}`);
}

export function windowsInhibitorScript(mode: CaffeinateMode): string {
  const flags = mode === 'sleep' ? '0x80000001' : '0x80000003';
  return [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -Namespace PiCaffeinate -Name Power -MemberDefinition \'[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);\'',
    `$keepAwake = [uint32]'${flags}'`,
    "$release = [uint32]'0x80000000'",
    '$input = [Console]::OpenStandardInput()',
    '$buffer = New-Object byte[] 1',
    '$read = $input.ReadAsync($buffer, 0, 1)',
    'try { while ($true) { [PiCaffeinate.Power]::SetThreadExecutionState($keepAwake) | Out-Null; if ($read.Wait(30000)) { break } } }',
    'finally { [PiCaffeinate.Power]::SetThreadExecutionState($release) | Out-Null }'
  ].join('; ');
}

export function formatMode(mode: CaffeinateMode): string {
  return mode === 'sleep' ? 'system-awake' : 'display-awake';
}

export function commandOnPath(
  command: string,
  environment = process.env,
  platform = process.platform
): boolean {
  const separator = platform === 'win32' ? ';' : ':';
  const suffixes = platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const directory of (environment.PATH ?? '').split(separator)) {
    if (!directory) continue;
    for (const suffix of suffixes) {
      if (existsSync(join(directory, `${command}${suffix}`))) return true;
    }
  }
  return false;
}

function runningInWsl(): boolean {
  return existsSync('/proc/sys/fs/binfmt_misc/WSLInterop');
}
