import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config.js';
import {
  buildAddPlan,
  buildBuildPlan,
  buildClusterArgs,
  buildDetailedExtractArgs,
  buildExportCallflowArgs,
  buildQueryArgs,
  buildUpgradePlan,
  buildWatchArgs,
  graphifyBackendFromPiModel,
  resolveGraphifyBackend
} from '../src/runner.js';

describe('runner argv builders', () => {
  it('builds query args with budget and dfs', () => {
    expect(buildQueryArgs({ question: 'main modules', dfs: true, budget: 2000 })).toEqual([
      'query',
      'main modules',
      '--dfs',
      '--budget',
      '2000'
    ]);
  });

  it('builds build plan with explicit backend', () => {
    expect(
      buildBuildPlan(
        { path: 'src', mode: 'deep', backend: 'claude', noViz: true },
        DEFAULT_CONFIG
      ).map((step) => step.args)
    ).toEqual([
      ['extract', 'src', '--backend', 'claude', '--mode', 'deep'],
      ['cluster-only', 'src', '--no-viz']
    ]);
  });

  it('uses the active Pi model backend by default', () => {
    expect(
      buildBuildPlan({ path: 'src' }, DEFAULT_CONFIG, {
        provider: 'anthropic',
        id: 'claude-sonnet-4-6'
      }).map((step) => step.args)
    ).toEqual([
      ['extract', 'src', '--backend', 'claude'],
      ['cluster-only', 'src']
    ]);
  });

  it('omits backend when Pi model cannot be mapped so Graphify can auto-detect', () => {
    expect(
      buildBuildPlan({ path: 'src' }, DEFAULT_CONFIG, {
        provider: 'custom-provider',
        id: 'custom-model'
      }).map((step) => step.args)
    ).toEqual([
      ['extract', 'src'],
      ['cluster-only', 'src']
    ]);
  });

  it('builds add plan and preserves URL as one arg', () => {
    expect(
      buildAddPlan({
        url: 'https://example.com/a?x=1&y=2',
        author: 'Ada',
        contributor: 'Grace'
      }).map((step) => step.args)
    ).toEqual([
      ['add', 'https://example.com/a?x=1&y=2', '--author', 'Ada', '--contributor', 'Grace'],
      ['update', './raw']
    ]);
  });

  it('rejects empty add URLs', () => {
    expect(() => buildAddPlan({ url: ' ' })).toThrow('url is required');
  });

  it('builds cluster args', () => {
    expect(buildClusterArgs({ noViz: true })).toEqual(['cluster-only', '.', '--no-viz']);
  });

  it('builds detailed extract args', () => {
    expect(
      buildDetailedExtractArgs({
        inputPath: 'docs',
        backend: 'openai',
        maxWorkers: 2,
        tokenBudget: 1000,
        maxConcurrency: 3,
        apiTimeout: 60,
        resolution: 1.5,
        excludeHubs: 2,
        exclude: ['node_modules', 'dist']
      })
    ).toEqual([
      'extract',
      'docs',
      '--backend',
      'openai',
      '--max-workers',
      '2',
      '--token-budget',
      '1000',
      '--max-concurrency',
      '3',
      '--api-timeout',
      '60',
      '--resolution',
      '1.5',
      '--exclude-hubs',
      '2',
      '--exclude',
      'node_modules',
      '--exclude',
      'dist'
    ]);
  });

  it('rejects invalid detailed extract numbers', () => {
    expect(() => buildDetailedExtractArgs({ maxWorkers: 0 })).toThrow(
      'maxWorkers must be a positive integer'
    );
  });

  it('maps Pi providers to Graphify backends', () => {
    expect(graphifyBackendFromPiModel({ provider: 'google', id: 'gemini-2.5-pro' })).toBe('gemini');
    expect(graphifyBackendFromPiModel({ provider: 'anthropic', id: 'claude-sonnet-4-6' })).toBe(
      'claude'
    );
    expect(graphifyBackendFromPiModel({ provider: 'openai', id: 'gpt-5.4' })).toBe('openai');
    expect(graphifyBackendFromPiModel({ provider: 'openrouter', id: 'moonshotai/kimi-k2.6' })).toBe(
      'kimi'
    );
  });

  it('respects auto config by leaving backend unset', () => {
    expect(
      resolveGraphifyBackend(
        undefined,
        { ...DEFAULT_CONFIG, semanticBackend: 'auto' },
        {
          provider: 'anthropic',
          id: 'claude-sonnet-4-6'
        }
      )
    ).toEqual({ source: 'graphify-auto' });
  });

  it('builds callflow export args with configured output dir', () => {
    expect(buildExportCallflowArgs({}, 'custom-out')).toEqual([
      'export',
      'callflow-html',
      '--graph',
      'custom-out/graph.json',
      '--output',
      'custom-out/callflow.html'
    ]);
  });

  it('builds upgrade plans', () => {
    expect(buildUpgradePlan('check').map((step) => [step.command, step.args])).toEqual([
      ['graphify', ['--version']]
    ]);
    expect(buildUpgradePlan('sync-skill').map((step) => [step.command, step.args])).toEqual([
      ['graphify', ['install', '--platform', 'pi']]
    ]);
    expect(buildUpgradePlan('install').map((step) => [step.command, step.args])).toEqual([
      ['uv', ['tool', 'upgrade', 'graphifyy']],
      ['graphify', ['install', '--platform', 'pi']]
    ]);
  });

  it('builds watch args', () => {
    expect(buildWatchArgs({ debounce: 5 })).toEqual(['watch', '.', '--debounce', '5']);
  });
});
