import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { AutoContextConfig, GraphifyConfig } from './config.js';
import { graphStatus } from './status.js';

export type GraphifyIntentKind =
  | 'none'
  | 'broad-search'
  | 'overview-file'
  | 'docs-or-plan'
  | 'architecture-question'
  | 'multi-file-result';

export type AutoContextState = {
  sessionHintInjected: boolean;
  hintCount: number;
  seenKeys: Set<string>;
};

export type ToolSignal = {
  toolName: string;
  target: string;
  haystack: string;
  lineCount: number;
};

export type GetGraphifyConfig = (cwd: string) => GraphifyConfig;

export function createAutoContextState(): AutoContextState {
  return { sessionHintInjected: false, hintCount: 0, seenKeys: new Set() };
}

export function classifyPromptIntent(
  prompt: string,
  triggerPatterns: string[]
): 'none' | 'architecture-question' {
  const lower = prompt.toLowerCase();
  return triggerPatterns.some((pattern) => lower.includes(pattern.toLowerCase()))
    ? 'architecture-question'
    : 'none';
}

export function summarizeToolSignal(event: {
  toolName: string;
  input: unknown;
  content: Array<{ type: string; text?: string }>;
}): ToolSignal {
  const input = isRecord(event.input) ? event.input : {};
  const text = event.content
    .filter((item) => item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n');
  const target = String(
    input.path ?? input.pattern ?? input.glob ?? input.command ?? input.query ?? 'result'
  );
  return {
    toolName: event.toolName,
    target,
    haystack: `${event.toolName} ${target} ${text}`,
    lineCount: text ? text.split('\n').length : 0
  };
}

export function classifyToolIntent(
  signal: ToolSignal,
  lastPromptIntent: GraphifyIntentKind,
  config: AutoContextConfig
): GraphifyIntentKind {
  const tool = signal.toolName;
  const lowerTarget = signal.target.toLowerCase();
  const lowerHaystack = signal.haystack.toLowerCase();

  if (lastPromptIntent === 'architecture-question') return 'architecture-question';
  if (config.triggerPatterns.some((pattern) => lowerHaystack.includes(pattern.toLowerCase()))) {
    return 'architecture-question';
  }

  const broadTool = ['grep', 'rg', 'find'].includes(tool);
  const broadBash = tool === 'bash' && /\b(rg|grep|find|fd|tree)\b/.test(lowerTarget);
  if (signal.lineCount >= config.minToolResultLines && (broadTool || broadBash)) {
    return 'broad-search';
  }

  if (signal.lineCount >= config.minToolResultLines && looksMultiFile(signal.haystack)) {
    return 'multi-file-result';
  }

  if (
    tool === 'read' &&
    /(^|\/)(readme|agents|package|changelog)\.(md|json)$/i.test(signal.target)
  ) {
    return 'overview-file';
  }

  if (tool === 'read' && (/\.(md|mdx)$/i.test(lowerTarget) || lowerTarget.includes('docs/'))) {
    return 'docs-or-plan';
  }

  return 'none';
}

export function buildSessionHintText(args: {
  outputDir: string;
  hasWiki: boolean;
  hasReport: boolean;
}): string {
  const lines = [
    '[Graphify active]',
    `This project has a Graphify knowledge graph at ${args.outputDir}/graph.json.`,
    'For architecture, dependency, call-flow, relationship, or cross-file questions, prefer graphify_query, graphify_path, or graphify_explain before broad raw source search.'
  ];
  if (args.hasWiki) lines.push(`Use ${args.outputDir}/wiki/index.md for broad navigation.`);
  if (args.hasReport) lines.push(`Use ${args.outputDir}/GRAPH_REPORT.md for architecture review.`);
  lines.push('After code edits, consider graphify_update.');
  return lines.join('\n');
}

export function buildToolResultHintText(args: {
  intent: GraphifyIntentKind;
  target: string;
  budget: number;
  maxChars: number;
}): string | undefined {
  if (args.intent === 'none') return undefined;
  const question =
    args.intent === 'overview-file'
      ? `What role does ${args.target} play in the architecture?`
      : args.intent === 'docs-or-plan'
        ? `How does ${args.target} connect to the current architecture?`
        : 'How do these files relate in the system?';
  const hint = `---\n[Graphify] This result may benefit from graph context. Consider:\ngraphify_query({ question: ${JSON.stringify(question)}, budget: ${args.budget} })\n---`;
  return hint.length > args.maxChars ? `${hint.slice(0, args.maxChars - 3)}...` : hint;
}

export function makeDedupeKey(intent: GraphifyIntentKind, signal: ToolSignal): string {
  return `${signal.toolName}|${intent}|${normalize(signal.target)}`;
}

export function appendTextHint<T extends { type: string; text?: string }>(
  content: T[],
  hint: string
): T[] {
  return [...content, { type: 'text', text: hint } as T];
}

export function registerAutoContextHooks(pi: ExtensionAPI, getConfig: GetGraphifyConfig): void {
  const state = createAutoContextState();
  let lastPromptIntent: GraphifyIntentKind = 'none';

  pi.on('session_shutdown', () => {
    state.sessionHintInjected = false;
    state.hintCount = 0;
    state.seenKeys.clear();
    lastPromptIntent = 'none';
  });

  pi.on('before_agent_start', async (event) => {
    const config = getConfig(event.systemPromptOptions.cwd);
    if (!config.enabled || !config.autoContext.enabled) return;
    lastPromptIntent = classifyPromptIntent(event.prompt, config.autoContext.triggerPatterns);
    if (!config.autoContext.sessionHint || state.sessionHintInjected) return;

    const status = await graphStatus(event.systemPromptOptions.cwd, {
      outputDir: config.outputDir,
      checkCli: false
    });
    if (!status.hasGraph) return;

    state.sessionHintInjected = true;
    return {
      message: {
        customType: 'graphify-auto-context',
        content: buildSessionHintText({
          outputDir: config.outputDir,
          hasWiki: status.hasWiki,
          hasReport: status.hasReport
        }),
        display: false
      }
    };
  });

  pi.on('tool_result', async (event, ctx) => {
    const config = getConfig(ctx.cwd);
    if (!config.enabled || !config.autoContext.enabled || !config.autoContext.toolResultHints)
      return;
    if (event.toolName.startsWith('graphify_')) return;
    if (!config.autoContext.triggerTools.includes(event.toolName)) return;
    if (state.hintCount >= config.autoContext.maxSessionHints) return;

    const signal = summarizeToolSignal({
      toolName: event.toolName,
      input: event.input,
      content: event.content
    });
    if (signal.lineCount < config.autoContext.minToolResultLines) return;

    const intent = classifyToolIntent(signal, lastPromptIntent, config.autoContext);
    if (intent === 'none') return;

    const key = makeDedupeKey(intent, signal);
    if (state.seenKeys.has(key)) return;

    const status = await graphStatus(ctx.cwd, { outputDir: config.outputDir, checkCli: false });
    if (!status.hasGraph) return;

    const hint = buildToolResultHintText({
      intent,
      target: signal.target,
      budget: Math.min(config.defaultQueryBudget, 1200),
      maxChars: config.autoContext.maxHintChars
    });
    if (!hint) return;

    state.seenKeys.add(key);
    state.hintCount += 1;
    return { content: appendTextHint(event.content, hint) };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 120);
}

function looksMultiFile(text: string): boolean {
  const matches = text.match(/[\w./-]+\.(ts|tsx|js|jsx|json|md|py|go|rs|java|css|html)/g);
  return new Set(matches ?? []).size >= 2;
}
