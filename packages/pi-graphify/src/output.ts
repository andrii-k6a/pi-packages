import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  truncateTail
} from '@earendil-works/pi-coding-agent';
import type { GraphifyRun } from './runner.js';

export const MISSING_GRAPH_MESSAGE =
  'No graphify-out/graph.json found. Build it with `/graphify extract .` or `graphify extract .`.';
export const MISSING_CLI_MESSAGE =
  'Graphify CLI not found. Install with: `uv tool install graphifyy`.';
export const DISABLED_MESSAGE = 'pi-graphify is disabled in prime-settings.json.';

export function truncateOutput(stdout: string, stderr = '', fromTail = false): string {
  const combined = `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ''}`;
  const truncation = (fromTail ? truncateTail : truncateHead)(combined, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES
  });
  let text = truncation.content;
  if (truncation.truncated) {
    const direction = fromTail ? 'last' : 'first';
    text += `\n\n[Output truncated: showing ${direction} ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).]`;
  }
  return text;
}

export function formatRunResult(result: GraphifyRun): string {
  if (result.errorCode === 'ENOENT') return MISSING_CLI_MESSAGE;
  if (!result.ok) return truncateOutput(result.stderr || result.stdout, '', true);
  return truncateOutput(result.stdout, result.stderr);
}

export function formatExternalCommandResult(result: GraphifyRun, command: string): string {
  if (result.errorCode === 'ENOENT') {
    return `Unable to open graph HTML: '${command}' was not found.`;
  }
  return truncateOutput(result.stderr || result.stdout, '', true);
}
