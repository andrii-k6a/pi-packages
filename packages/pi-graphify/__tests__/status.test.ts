import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { graphStatus, resolveGraphifyPaths } from '../src/status.js';

const temps: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-graphify-'));
  temps.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('graphStatus', () => {
  it('respects custom outputDir without checking CLI', async () => {
    const cwd = await tempDir();
    await mkdir(path.join(cwd, 'custom-out', 'wiki'), { recursive: true });
    await writeFile(path.join(cwd, 'custom-out', 'graph.json'), '{}');
    await writeFile(path.join(cwd, 'custom-out', 'GRAPH_REPORT.md'), '# Report');
    await writeFile(path.join(cwd, 'custom-out', 'wiki', 'index.md'), '# Wiki');

    const status = await graphStatus(cwd, { outputDir: 'custom-out', checkCli: false });

    expect(status.graphJson).toBe(path.join(cwd, 'custom-out', 'graph.json'));
    expect(status.hasGraph).toBe(true);
    expect(status.graphSize).toBe(2);
    expect(status.hasReport).toBe(true);
    expect(status.hasWiki).toBe(true);
    expect(status.cliAvailable).toBe(false);
  });

  it('supports injected CLI availability check', async () => {
    const cwd = await tempDir();
    const status = await graphStatus(cwd, {
      checkCli: true,
      cliAvailable: async () => true
    });

    expect(status.cliAvailable).toBe(true);
  });
});

describe('resolveGraphifyPaths', () => {
  it('returns all artifact paths', () => {
    expect(resolveGraphifyPaths('/repo', 'out')).toEqual({
      outDir: '/repo/out',
      graphJson: '/repo/out/graph.json',
      report: '/repo/out/GRAPH_REPORT.md',
      wikiIndex: '/repo/out/wiki/index.md',
      html: '/repo/out/graph.html'
    });
  });
});
