import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { GraphifyConfig } from './config.js';
import { DISABLED_MESSAGE, formatRunResult, MISSING_GRAPH_MESSAGE } from './output.js';
import {
  buildAddPlan,
  buildBuildPlan,
  buildClusterArgs,
  buildDetailedExtractArgs,
  buildExplainArgs,
  buildExportCallflowArgs,
  buildPathArgs,
  buildQueryArgs,
  buildUpdateArgs,
  buildUpgradePlan,
  buildWatchArgs,
  runCommandStep,
  runGraphify,
  type UpgradeAction
} from './runner.js';
import { graphStatus, statusText } from './status.js';

export type GetGraphifyConfig = (cwd: string) => GraphifyConfig;

const BackendUnion = Type.Union([
  Type.Literal('deepseek'),
  Type.Literal('openai'),
  Type.Literal('claude'),
  Type.Literal('kimi'),
  Type.Literal('gemini'),
  Type.Literal('ollama'),
  Type.Literal('bedrock'),
  Type.Literal('claude-cli')
]);

function toolText(text: string, details?: unknown) {
  return { content: [{ type: 'text' as const, text }], details };
}

function planResult(results: { label?: string; text: string }[]): string {
  return results.map((result) => `## ${result.label ?? 'step'}\n${result.text}`).join('\n\n');
}

export function registerGraphifyTools(pi: ExtensionAPI, getConfig: GetGraphifyConfig): void {
  pi.registerTool({
    name: 'graphify_status',
    label: 'Graphify Status',
    description: 'Check whether the current project has Graphify graph artifacts.',
    promptSnippet: 'Check Graphify graph availability and artifact status.',
    promptGuidelines: [
      'Use graphify_status when deciding whether Graphify graph context is available for a codebase question.'
    ],
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const config = getConfig(ctx.cwd);
      if (!config.enabled) return toolText(DISABLED_MESSAGE, { enabled: false });
      const status = await graphStatus(ctx.cwd, { outputDir: config.outputDir });
      return { content: [{ type: 'text', text: statusText(status) }], details: status };
    }
  });

  pi.registerTool({
    name: 'graphify_query',
    label: 'Graphify Query',
    description: 'Query graphify-out/graph.json for focused codebase context.',
    promptSnippet: 'Query the Graphify knowledge graph for focused codebase context.',
    promptGuidelines: [
      'Use graphify_query before broad raw source search when graphify-out/graph.json exists and the user asks about architecture, dependencies, call flow, relationships, or codebase concepts.'
    ],
    parameters: Type.Object({
      question: Type.String({
        minLength: 1,
        description: 'Natural-language codebase or project question'
      }),
      budget: Type.Optional(Type.Integer({ minimum: 1, description: 'Token budget for output' })),
      dfs: Type.Optional(
        Type.Boolean({ description: 'Use depth-first traversal instead of breadth-first' })
      )
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const config = getConfig(ctx.cwd);
      if (!config.enabled) return toolText(DISABLED_MESSAGE, { enabled: false });
      const status = await graphStatus(ctx.cwd, { outputDir: config.outputDir });
      if (!status.hasGraph) return toolText(MISSING_GRAPH_MESSAGE, status);

      onUpdate?.({
        content: [{ type: 'text', text: 'Querying Graphify graph...' }],
        details: undefined
      });
      const cliArgs = buildQueryArgs({
        question: params.question,
        dfs: params.dfs,
        budget: params.budget ?? config.defaultQueryBudget
      });
      const result = await runGraphify(ctx.cwd, cliArgs, signal);
      return toolText(formatRunResult(result), { ...result, args: cliArgs });
    }
  });

  pi.registerTool({
    name: 'graphify_explain',
    label: 'Graphify Explain',
    description: 'Explain a Graphify node, symbol, file, module, or concept.',
    promptSnippet: 'Explain a Graphify graph node or codebase concept.',
    parameters: Type.Object({
      concept: Type.String({
        minLength: 1,
        description: 'Node label, symbol, file, module, or concept'
      })
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const config = getConfig(ctx.cwd);
      if (!config.enabled) return toolText(DISABLED_MESSAGE, { enabled: false });
      const status = await graphStatus(ctx.cwd, { outputDir: config.outputDir });
      if (!status.hasGraph) return toolText(MISSING_GRAPH_MESSAGE, status);

      onUpdate?.({
        content: [{ type: 'text', text: 'Explaining Graphify node...' }],
        details: undefined
      });
      const cliArgs = buildExplainArgs(params.concept);
      const result = await runGraphify(ctx.cwd, cliArgs, signal);
      return toolText(formatRunResult(result), { ...result, args: cliArgs });
    }
  });

  pi.registerTool({
    name: 'graphify_path',
    label: 'Graphify Path',
    description: 'Find a shortest path between two Graphify graph nodes.',
    promptSnippet: 'Find a shortest path between two Graphify graph nodes.',
    parameters: Type.Object({
      from: Type.String({ minLength: 1 }),
      to: Type.String({ minLength: 1 })
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const config = getConfig(ctx.cwd);
      if (!config.enabled) return toolText(DISABLED_MESSAGE, { enabled: false });
      const status = await graphStatus(ctx.cwd, { outputDir: config.outputDir });
      if (!status.hasGraph) return toolText(MISSING_GRAPH_MESSAGE, status);

      onUpdate?.({
        content: [{ type: 'text', text: 'Finding Graphify path...' }],
        details: undefined
      });
      const cliArgs = buildPathArgs(params.from, params.to);
      const result = await runGraphify(ctx.cwd, cliArgs, signal);
      return toolText(formatRunResult(result), { ...result, args: cliArgs });
    }
  });

  pi.registerTool({
    name: 'graphify_update',
    label: 'Graphify Update',
    description: 'Update graphify-out/graph.json after code edits.',
    promptSnippet: 'Update the Graphify graph after code edits.',
    promptGuidelines: [
      'Use graphify_update after code edits to keep graphify-out/graph.json current.'
    ],
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: 'Path to update; defaults to .' })),
      force: Type.Optional(Type.Boolean()),
      noCluster: Type.Optional(Type.Boolean())
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const config = getConfig(ctx.cwd);
      if (!config.enabled) return toolText(DISABLED_MESSAGE, { enabled: false });
      onUpdate?.({
        content: [{ type: 'text', text: 'Updating Graphify graph...' }],
        details: undefined
      });
      const cliArgs = buildUpdateArgs(params);
      const result = await runGraphify(ctx.cwd, cliArgs, signal);
      return toolText(formatRunResult(result), { ...result, args: cliArgs });
    }
  });

  pi.registerTool({
    name: 'graphify_build',
    label: 'Graphify Build',
    description: 'Explicitly build a Graphify graph from a directory, then cluster it.',
    promptSnippet: 'Build or rebuild the Graphify knowledge graph only when explicitly requested.',
    promptGuidelines: [
      'Use graphify_build only when the user explicitly asks to build or rebuild the Graphify graph.'
    ],
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({ description: 'Directory path to build graph from; defaults to .' })
      ),
      mode: Type.Optional(Type.Union([Type.Literal('standard'), Type.Literal('deep')])),
      backend: Type.Optional(BackendUnion),
      noViz: Type.Optional(Type.Boolean()),
      svg: Type.Optional(Type.Boolean()),
      graphml: Type.Optional(Type.Boolean()),
      neo4j: Type.Optional(Type.Boolean())
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const config = getConfig(ctx.cwd);
      if (!config.enabled) return toolText(DISABLED_MESSAGE, { enabled: false });
      const plan = buildBuildPlan(params, config, ctx.model);
      const results = [];
      for (const step of plan) {
        onUpdate?.({
          content: [{ type: 'text', text: `Running graphify ${step.args.join(' ')}...` }],
          details: undefined
        });
        const result = await runCommandStep(ctx.cwd, step, signal);
        results.push({ label: step.label, text: formatRunResult(result) });
        if (!result.ok) break;
      }
      return toolText(planResult(results), { steps: plan, results });
    }
  });

  pi.registerTool({
    name: 'graphify_add',
    label: 'Graphify Add URL',
    description: 'Fetch a URL into Graphify raw corpus and update the graph.',
    parameters: Type.Object({
      url: Type.String({ minLength: 1, description: 'URL to fetch and add to the corpus' }),
      author: Type.Optional(Type.String()),
      contributor: Type.Optional(Type.String())
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const config = getConfig(ctx.cwd);
      if (!config.enabled) return toolText(DISABLED_MESSAGE, { enabled: false });
      const plan = buildAddPlan(params);
      const results = [];
      for (const step of plan) {
        onUpdate?.({
          content: [{ type: 'text', text: `Running graphify ${step.args.join(' ')}...` }],
          details: undefined
        });
        const result = await runCommandStep(ctx.cwd, step, signal);
        results.push({ label: step.label, text: formatRunResult(result) });
        if (!result.ok) break;
      }
      return toolText(planResult(results), { steps: plan, results });
    }
  });

  pi.registerTool({
    name: 'graphify_cluster',
    label: 'Graphify Cluster',
    description: 'Rerun Graphify clustering and report generation without re-extraction.',
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: 'Project path; defaults to .' })),
      noViz: Type.Optional(Type.Boolean())
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const config = getConfig(ctx.cwd);
      if (!config.enabled) return toolText(DISABLED_MESSAGE, { enabled: false });
      onUpdate?.({
        content: [{ type: 'text', text: 'Running Graphify clustering...' }],
        details: undefined
      });
      const cliArgs = buildClusterArgs(params);
      const result = await runGraphify(ctx.cwd, cliArgs, signal);
      return toolText(formatRunResult(result), { ...result, args: cliArgs });
    }
  });

  pi.registerTool({
    name: 'graphify_extract',
    label: 'Graphify Extract',
    description: 'Run explicit Graphify extraction with headless/CI-oriented flags.',
    parameters: Type.Object({
      inputPath: Type.Optional(
        Type.String({ description: 'Directory path to extract; defaults to .' })
      ),
      backend: Type.Optional(BackendUnion),
      maxWorkers: Type.Optional(Type.Integer({ minimum: 1 })),
      tokenBudget: Type.Optional(Type.Integer({ minimum: 1 })),
      maxConcurrency: Type.Optional(Type.Integer({ minimum: 1 })),
      apiTimeout: Type.Optional(Type.Integer({ minimum: 1 })),
      resolution: Type.Optional(Type.Number()),
      excludeHubs: Type.Optional(Type.Number()),
      exclude: Type.Optional(Type.Array(Type.String()))
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const config = getConfig(ctx.cwd);
      if (!config.enabled) return toolText(DISABLED_MESSAGE, { enabled: false });
      onUpdate?.({
        content: [{ type: 'text', text: 'Running Graphify extraction...' }],
        details: undefined
      });
      const cliArgs = buildDetailedExtractArgs(params, config, ctx.model);
      const result = await runGraphify(ctx.cwd, cliArgs, signal);
      return toolText(formatRunResult(result), { ...result, args: cliArgs });
    }
  });

  pi.registerTool({
    name: 'graphify_export_callflow',
    label: 'Graphify Export Callflow',
    description: 'Generate architecture/call-flow HTML from a Graphify graph.',
    parameters: Type.Object({
      graphPath: Type.Optional(Type.String({ description: 'Path to graph.json' })),
      outputPath: Type.Optional(Type.String({ description: 'Output HTML path' }))
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const config = getConfig(ctx.cwd);
      if (!config.enabled) return toolText(DISABLED_MESSAGE, { enabled: false });
      onUpdate?.({
        content: [{ type: 'text', text: 'Exporting Graphify callflow HTML...' }],
        details: undefined
      });
      const cliArgs = buildExportCallflowArgs(params, config.outputDir);
      const result = await runGraphify(ctx.cwd, cliArgs, signal);
      return toolText(formatRunResult(result), { ...result, args: cliArgs });
    }
  });

  pi.registerTool({
    name: 'graphify_upgrade',
    label: 'Graphify Upgrade',
    description: 'Check or explicitly update the Graphify Python CLI and Pi skill.',
    parameters: Type.Object({
      action: Type.Optional(
        Type.Union([Type.Literal('check'), Type.Literal('install'), Type.Literal('sync-skill')])
      )
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const config = getConfig(ctx.cwd);
      if (!config.enabled) return toolText(DISABLED_MESSAGE, { enabled: false });
      const plan = buildUpgradePlan(params.action as UpgradeAction | undefined);
      const results = [];
      for (const step of plan) {
        onUpdate?.({
          content: [{ type: 'text', text: `Running ${step.command} ${step.args.join(' ')}...` }],
          details: undefined
        });
        const result = await runCommandStep(ctx.cwd, step, signal);
        results.push({ label: step.label, text: formatRunResult(result) });
        if (!result.ok) break;
      }
      return toolText(planResult(results), { steps: plan, results });
    }
  });

  pi.registerTool({
    name: 'graphify_watch',
    label: 'Graphify Watch',
    description:
      'Start Graphify watch mode. This can be long-running and continues until aborted; only use when explicitly requested.',
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: 'Directory path to watch; defaults to .' })),
      debounce: Type.Optional(Type.Integer({ minimum: 1 }))
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const config = getConfig(ctx.cwd);
      if (!config.enabled) return toolText(DISABLED_MESSAGE, { enabled: false });
      onUpdate?.({
        content: [{ type: 'text', text: 'Starting Graphify watch mode...' }],
        details: undefined
      });
      const cliArgs = buildWatchArgs(params);
      const result = await runGraphify(ctx.cwd, cliArgs, signal);
      return toolText(formatRunResult(result), { ...result, args: cliArgs, longRunning: true });
    }
  });
}
