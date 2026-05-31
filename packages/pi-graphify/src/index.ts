import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerAutoContextHooks } from './auto-context.js';
import { registerGraphifyCommand } from './commands.js';
import { loadGraphifyConfig } from './config.js';
import { registerGraphifyTools } from './tools.js';

export default function graphifyExtension(pi: ExtensionAPI): void {
  const getConfig = (cwd: string) => loadGraphifyConfig({ cwd });
  const startupConfig = getConfig(process.cwd());

  if (!startupConfig.enabled) return;

  registerGraphifyTools(pi, getConfig);
  registerGraphifyCommand(pi, getConfig);
  if (startupConfig.autoContext.enabled) registerAutoContextHooks(pi, getConfig);
}
