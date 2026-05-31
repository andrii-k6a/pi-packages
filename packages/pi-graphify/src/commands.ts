import { readFile } from 'node:fs/promises';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { truncateHead } from '@earendil-works/pi-coding-agent';
import { type GraphifyCommand, parseGraphifyCommand } from './args.js';
import type { GraphifyConfig } from './config.js';
import {
  DISABLED_MESSAGE,
  formatExternalCommandResult,
  formatRunResult,
  MISSING_GRAPH_MESSAGE
} from './output.js';
import {
  buildExplainArgs,
  buildExtractArgs,
  buildPathArgs,
  buildQueryArgs,
  buildUpdateArgs,
  runExecFile,
  runGraphify
} from './runner.js';
import { graphStatus, statusText } from './status.js';

export type GetGraphifyConfig = (cwd: string) => GraphifyConfig;

export function registerGraphifyCommand(pi: ExtensionAPI, getConfig: GetGraphifyConfig): void {
  pi.registerCommand('graphify', {
    description: 'Build, update, query, or inspect the Graphify knowledge graph',
    getArgumentCompletions: (prefix) => {
      const commands = [
        'status',
        'query',
        'explain',
        'path',
        'update',
        'extract',
        'report',
        'open'
      ];
      const filtered = commands.filter((command) => command.startsWith(prefix));
      return filtered.length ? filtered.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const config = getConfig(ctx.cwd);
      if (!config.enabled) {
        ctx.ui.notify(DISABLED_MESSAGE, 'warning');
        return;
      }

      const parsed = parseGraphifyCommand(args);
      if (args.trim() === '') {
        const status = await graphStatus(ctx.cwd, { outputDir: config.outputDir });
        const text = `${statusText(status)}${status.hasGraph ? `\n\nTry next:\n- /graphify query What are the main modules?\n- /graphify explain <concept>\n- /graphify update .` : ''}`;
        ctx.ui.notify(text, status.hasGraph ? 'info' : 'warning');
        if (!status.hasGraph && ctx.hasUI) {
          const ok = await ctx.ui.confirm(
            'Build Graphify graph?',
            'No graphify-out/graph.json found. Run `graphify extract .` now?'
          );
          if (ok) {
            await runCommand(ctx.cwd, buildExtractArgs('.'), ctx.signal, (message, type) =>
              ctx.ui.notify(message, type)
            );
          }
        }
        return;
      }

      if (parsed.kind === 'status') {
        ctx.ui.notify(
          statusText(await graphStatus(ctx.cwd, { outputDir: config.outputDir })),
          'info'
        );
        return;
      }

      const message = await handleCommand(ctx.cwd, parsed, config, ctx.signal);
      ctx.ui.notify(message, message.startsWith('Graphify CLI not found') ? 'error' : 'info');
    }
  });
}

export async function handleCommand(
  cwd: string,
  command: Exclude<GraphifyCommand, { kind: 'status' }>,
  config: GraphifyConfig,
  signal?: AbortSignal
): Promise<string> {
  if (command.kind === 'unknown') return `Unknown /graphify subcommand: ${command.subcommand}`;
  if (command.kind === 'open') return openHtml(cwd, config, signal);
  if (command.kind === 'report') return reportPreview(cwd, config);

  if (command.kind === 'query' && !command.question) return 'Usage: /graphify query <question>';
  if (command.kind === 'explain' && !command.concept) {
    return 'Usage: /graphify explain <node-or-concept>';
  }
  if (command.kind === 'path' && (!command.from || !command.to)) {
    return 'Usage: /graphify path <from> <to>';
  }

  if (
    (command.kind === 'query' || command.kind === 'explain' || command.kind === 'path') &&
    !(await graphStatus(cwd, { outputDir: config.outputDir })).hasGraph
  ) {
    return MISSING_GRAPH_MESSAGE;
  }

  if (command.kind === 'query') {
    return formatRunResult(
      await runGraphify(
        cwd,
        buildQueryArgs({ question: command.question, budget: config.defaultQueryBudget }),
        signal
      )
    );
  }
  if (command.kind === 'explain') {
    return formatRunResult(await runGraphify(cwd, buildExplainArgs(command.concept), signal));
  }
  if (command.kind === 'path') {
    return formatRunResult(await runGraphify(cwd, buildPathArgs(command.from, command.to), signal));
  }
  if (command.kind === 'update') {
    return formatRunResult(await runGraphify(cwd, buildUpdateArgs({ path: command.path }), signal));
  }
  return formatRunResult(await runGraphify(cwd, buildExtractArgs(command.path), signal));
}

async function reportPreview(cwd: string, config: GraphifyConfig): Promise<string> {
  const status = await graphStatus(cwd, { outputDir: config.outputDir });
  if (!status.hasReport) return `No graphify-out/GRAPH_REPORT.md found at ${status.report}.`;
  const text = await readFile(status.report, 'utf8');
  const preview = truncateHead(text, { maxLines: 80, maxBytes: 8 * 1024 });
  return `Graphify report: ${status.report}\n\n${preview.content}${preview.truncated ? '\n\n[Report preview truncated.]' : ''}`;
}

async function openHtml(
  cwd: string,
  config: GraphifyConfig,
  signal?: AbortSignal
): Promise<string> {
  const status = await graphStatus(cwd, { outputDir: config.outputDir });
  if (!status.hasHtml) return `No graphify-out/graph.html found at ${status.html}.`;

  const opener =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', status.html] : [status.html];
  const result = await runExecFile(opener, args, cwd, signal);
  return result.ok ? `Opened ${status.html}` : formatExternalCommandResult(result, opener);
}

async function runCommand(
  cwd: string,
  args: string[],
  signal: AbortSignal | undefined,
  notify: (message: string, type?: 'info' | 'warning' | 'error') => void
): Promise<void> {
  notify(`Running graphify ${args.join(' ')}...`, 'info');
  const result = await runGraphify(cwd, args, signal);
  notify(formatRunResult(result), result.ok ? 'info' : 'error');
}
