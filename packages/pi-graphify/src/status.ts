import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import { formatSize } from '@earendil-works/pi-coding-agent';
import { resolveOutputDir } from './config.js';
import { runGraphify } from './runner.js';

export type GraphifyPaths = {
  outDir: string;
  graphJson: string;
  report: string;
  wikiIndex: string;
  html: string;
};

export type GraphifyStatus = GraphifyPaths & {
  hasGraph: boolean;
  graphSize: number;
  hasReport: boolean;
  hasWiki: boolean;
  hasHtml: boolean;
  cliAvailable: boolean;
};

export type GraphStatusOptions = {
  outputDir?: string;
  checkCli?: boolean;
  cliAvailable?: (cwd: string) => Promise<boolean>;
};

let cliAvailabilityCache: { checkedAt: number; cwd: string; available: boolean } | undefined;
const CLI_CACHE_MS = 30_000;

export function resolveGraphifyPaths(cwd: string, outputDir = 'graphify-out'): GraphifyPaths {
  const outDir = resolveOutputDir(cwd, outputDir);
  return {
    outDir,
    graphJson: path.join(outDir, 'graph.json'),
    report: path.join(outDir, 'GRAPH_REPORT.md'),
    wikiIndex: path.join(outDir, 'wiki', 'index.md'),
    html: path.join(outDir, 'graph.html')
  };
}

export async function exists(file: string): Promise<boolean> {
  try {
    await access(file, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function defaultCliAvailable(cwd: string): Promise<boolean> {
  const now = Date.now();
  if (
    cliAvailabilityCache &&
    cliAvailabilityCache.cwd === cwd &&
    now - cliAvailabilityCache.checkedAt < CLI_CACHE_MS
  ) {
    return cliAvailabilityCache.available;
  }

  const result = await runGraphify(cwd, ['--help']);
  cliAvailabilityCache = { checkedAt: now, cwd, available: result.ok };
  return result.ok;
}

export async function graphStatus(
  cwd: string,
  options: GraphStatusOptions = {}
): Promise<GraphifyStatus> {
  const paths = resolveGraphifyPaths(cwd, options.outputDir);
  const hasGraph = await exists(paths.graphJson);
  const graphSize = hasGraph ? (await stat(paths.graphJson)).size : 0;
  const checkCli = options.checkCli ?? true;
  const cliAvailable = checkCli ? await (options.cliAvailable ?? defaultCliAvailable)(cwd) : false;

  return {
    ...paths,
    hasGraph,
    graphSize,
    hasReport: await exists(paths.report),
    hasWiki: await exists(paths.wikiIndex),
    hasHtml: await exists(paths.html),
    cliAvailable
  };
}

export function statusText(status: GraphifyStatus): string {
  return [
    'Graphify status',
    `- CLI: ${status.cliAvailable ? 'available' : 'missing'}`,
    `- graph.json: ${status.hasGraph ? `present (${formatSize(status.graphSize)})` : 'missing'}`,
    `- GRAPH_REPORT.md: ${status.hasReport ? 'present' : 'missing'}`,
    `- wiki/index.md: ${status.hasWiki ? 'present' : 'missing'}`,
    `- graph.html: ${status.hasHtml ? 'present' : 'missing'}`,
    `- graph path: ${status.graphJson}`,
    `- report path: ${status.report}`,
    `- wiki path: ${status.wikiIndex}`,
    `- html path: ${status.html}`
  ].join('\n');
}
