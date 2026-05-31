import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CONFIG,
  loadGraphifyConfig,
  parseGraphifyConfig,
  resolveOutputDir
} from '../src/config.js';

function reader(files: Record<string, string>) {
  return (file: string) => files[file];
}

describe('loadGraphifyConfig', () => {
  it('returns defaults when config files are missing', () => {
    expect(
      loadGraphifyConfig({
        globalConfigPath: '/missing/global.json',
        projectConfigPath: '/missing/project.json',
        readTextFile: reader({})
      })
    ).toEqual(DEFAULT_CONFIG);
  });

  it('loads global config under pi-graphify', () => {
    const config = loadGraphifyConfig({
      globalConfigPath: '/global.json',
      projectConfigPath: '/project.json',
      readTextFile: reader({
        '/global.json': JSON.stringify({
          'pi-graphify': { outputDir: 'custom-out', defaultQueryBudget: 500 }
        })
      })
    });

    expect(config.outputDir).toBe('custom-out');
    expect(config.defaultQueryBudget).toBe(500);
    expect(config.enabled).toBe(true);
  });

  it('merges project config over global config', () => {
    const config = loadGraphifyConfig({
      globalConfigPath: '/global.json',
      projectConfigPath: '/project.json',
      readTextFile: reader({
        '/global.json': JSON.stringify({
          'pi-graphify': { outputDir: 'global-out', defaultQueryBudget: 500 }
        }),
        '/project.json': JSON.stringify({ 'pi-graphify': { defaultQueryBudget: 900 } })
      })
    });

    expect(config.outputDir).toBe('global-out');
    expect(config.defaultQueryBudget).toBe(900);
  });

  it('ignores unrelated keys', () => {
    const config = loadGraphifyConfig({
      globalConfigPath: '/global.json',
      projectConfigPath: '/project.json',
      readTextFile: reader({ '/global.json': JSON.stringify({ other: { enabled: false } }) })
    });

    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it('warns but does not throw for invalid JSON', () => {
    const warn = vi.fn();
    const config = loadGraphifyConfig({
      globalConfigPath: '/global.json',
      projectConfigPath: '/project.json',
      readTextFile: reader({ '/global.json': '{' }),
      warn
    });

    expect(config).toEqual(DEFAULT_CONFIG);
    expect(warn).toHaveBeenCalled();
  });

  it('ignores invalid pi-graphify config values', () => {
    const warn = vi.fn();
    const config = loadGraphifyConfig({
      globalConfigPath: '/global.json',
      projectConfigPath: '/project.json',
      readTextFile: reader({ '/global.json': JSON.stringify({ 'pi-graphify': true }) }),
      warn
    });

    expect(config).toEqual(DEFAULT_CONFIG);
    expect(warn).toHaveBeenCalled();
  });

  it('falls back for invalid field values individually', () => {
    expect(
      parseGraphifyConfig({
        enabled: 'yes',
        outputDir: ' ',
        defaultQueryBudget: 0,
        semanticBackend: 'bad'
      })
    ).toEqual({});
  });

  it('supports enabled false and auto-context overrides', () => {
    const config = loadGraphifyConfig({
      globalConfigPath: '/global.json',
      projectConfigPath: '/project.json',
      readTextFile: reader({
        '/global.json': JSON.stringify({
          'pi-graphify': { enabled: false, autoContext: { enabled: false, maxHintChars: 100 } }
        })
      })
    });

    expect(config.enabled).toBe(false);
    expect(config.autoContext.enabled).toBe(false);
    expect(config.autoContext.maxHintChars).toBe(100);
    expect(config.autoContext.sessionHint).toBe(DEFAULT_CONFIG.autoContext.sessionHint);
  });
});

describe('resolveOutputDir', () => {
  it('resolves relative output dirs against cwd', () => {
    expect(resolveOutputDir('/repo', '.artifacts/graph')).toBe(
      path.resolve('/repo/.artifacts/graph')
    );
  });

  it('keeps absolute output dirs absolute', () => {
    expect(resolveOutputDir('/repo', '/tmp/graph')).toBe('/tmp/graph');
  });
});
