import type { AssistantMessage, TextContent, Usage } from '@earendil-works/pi-ai';
import {
  type CreateAgentSessionOptions,
  createAgentSession,
  createCodemodeExtension,
  createCodingTools,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type ToolDefinition
} from '@earendil-works/pi-coding-agent';
import type { Static, TSchema } from 'typebox';
import { createStructuredOutputTool, type StructuredOutputCapture } from './structured-output.js';
import { sumSessionUsage } from './usage.js';

export interface WorkflowAgentOptions {
  cwd?: string;
  /** Extra tools available to the subagent in addition to the structured output tool. */
  tools?: ToolDefinition[];
  /** Override any createAgentSession option (model, modelRuntime, resourceLoader, etc.). */
  session?: Partial<CreateAgentSessionOptions>;
  /** Inherit the parent session's active codemode tool (default: false). */
  codemode?: boolean;
  /** Extra system guidance prepended to every subagent task. */
  instructions?: string;
}

export interface AgentRunOptions<TSchemaDef extends TSchema | undefined = undefined> {
  label?: string;
  schema?: TSchemaDef;
  tools?: ToolDefinition[];
  instructions?: string;
  signal?: AbortSignal;
  onUsage?: (usage: Usage) => void;
}

interface InternalAgentRunOptions {
  sessionOverride?: Pick<CreateAgentSessionOptions, 'model' | 'thinkingLevel'>;
}

export type AgentRunResult<TSchemaDef extends TSchema | undefined> = TSchemaDef extends TSchema
  ? Static<TSchemaDef>
  : string;

export class WorkflowAgent {
  private readonly cwd: string;
  private readonly baseTools: ToolDefinition[];
  private readonly sessionOptions: Partial<CreateAgentSessionOptions>;
  private readonly codemode: boolean;
  private readonly instructions?: string;

  constructor(options: WorkflowAgentOptions = {}) {
    this.cwd = options.session?.cwd ?? options.cwd ?? process.cwd();
    this.baseTools = options.tools ?? createCodingTools(this.cwd);
    this.sessionOptions = options.session ?? {};
    this.codemode = options.codemode ?? false;
    this.instructions = options.instructions;
  }

  async run<TSchemaDef extends TSchema | undefined = undefined>(
    prompt: string,
    options: AgentRunOptions<TSchemaDef> & InternalAgentRunOptions = {}
  ): Promise<AgentRunResult<TSchemaDef>> {
    // createStructuredOutputTool keeps the schema/capture pair type-safe internally; this
    // outer capture is read back through AgentRunResult<TSchemaDef> after Pi validates params.
    // biome-ignore lint/suspicious/noExplicitAny: required to bridge conditional schema typing.
    const capture: StructuredOutputCapture<any> = { called: false, value: undefined };
    const customTools: ToolDefinition[] = [...this.baseTools, ...(options.tools ?? [])];

    if (options.schema) {
      customTools.push(
        createStructuredOutputTool({ schema: options.schema, capture }) as unknown as ToolDefinition
      );
    }

    const agentDir = this.sessionOptions.agentDir ?? getAgentDir();
    const settingsManager =
      this.sessionOptions.settingsManager ?? SettingsManager.create(this.cwd, agentDir);
    let resourceLoader = this.sessionOptions.resourceLoader;
    if (this.codemode && !resourceLoader) {
      resourceLoader = new DefaultResourceLoader({
        cwd: this.cwd,
        agentDir,
        settingsManager,
        extensionFactories: [
          { name: 'codemode', factory: createCodemodeExtension(), replaceable: true }
        ]
      });
      await resourceLoader.reload();
    }
    const { session } = await createAgentSession({
      cwd: this.cwd,
      agentDir,
      sessionManager: SessionManager.inMemory(this.cwd),
      settingsManager,
      customTools,
      ...this.sessionOptions,
      ...options.sessionOverride,
      ...(resourceLoader ? { resourceLoader } : {}),
      excludeTools: [...new Set(['workflow', ...(this.sessionOptions.excludeTools ?? [])])]
    });
    const usageStartIndex = session.sessionManager.getEntries().length;

    let removeAbortListener: (() => void) | undefined;
    try {
      if (this.codemode) {
        const active = session.getActiveToolNames();
        if (
          session.getAllTools().some((tool) => tool.name === 'codemode') &&
          !active.includes('codemode')
        ) {
          session.setActiveToolsByName([...active, 'codemode']);
        }
      }
      if (options.signal?.aborted) throw new Error('Subagent was aborted');
      if (options.signal) {
        const onAbort = () => void session.abort();
        options.signal.addEventListener('abort', onAbort, { once: true });
        removeAbortListener = () => options.signal?.removeEventListener('abort', onAbort);
      }

      await session.prompt(this.buildPrompt(prompt, options, Boolean(options.schema)));
      if (options.signal?.aborted) throw new Error('Subagent was aborted');

      if (options.schema) {
        if (!capture.called) {
          throw new Error('Subagent finished without calling structured_output');
        }
        return capture.value as AgentRunResult<TSchemaDef>;
      }

      return this.lastAssistantText(session.messages) as AgentRunResult<TSchemaDef>;
    } finally {
      try {
        // Use complete entries because live context can omit billed work after compaction or
        // context edits, but exclude history that predates this run when sessions are reused.
        options.onUsage?.(
          sumSessionUsage(session.sessionManager.getEntries().slice(usageStartIndex))
        );
      } finally {
        removeAbortListener?.();
        session.dispose();
      }
    }
  }

  private buildPrompt(
    prompt: string,
    options: Pick<AgentRunOptions, 'instructions' | 'label'>,
    structured: boolean
  ): string {
    const parts = [
      this.instructions,
      options.instructions,
      options.label ? `Task label: ${options.label}` : undefined,
      prompt
    ].filter(Boolean);

    if (structured) {
      parts.push(
        [
          'Final output contract:',
          '- Your final action MUST be a structured_output tool call.',
          '- The structured_output arguments are the return value of this subagent.',
          '- Do not emit a prose final answer instead of structured_output.',
          '- If you need to inspect files or run commands first, do so, then call structured_output exactly once.'
        ].join('\n')
      );
    }

    return parts.join('\n\n');
  }

  private lastAssistantText(messages: unknown[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i] as Partial<AssistantMessage> | undefined;
      if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue;
      const text = message.content
        .filter((part): part is TextContent => part.type === 'text')
        .map((part) => part.text)
        .join('');
      if (text.trim()) return text;
    }
    return '';
  }
}
