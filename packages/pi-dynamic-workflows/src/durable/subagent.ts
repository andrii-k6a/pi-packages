import { createHash } from 'node:crypto';
import type { Context, JsonValue } from '@earendil-works/chord';
import {
  DefaultResourceLoader,
  formatSkillsForPrompt,
  getAgentDir,
  loadProjectContextFiles,
  SettingsManager
} from '@earendil-works/pi-coding-agent';
import {
  defineExtension,
  defineTool,
  type Extension,
  type PromptInput,
  section,
  type ToolRegistration,
  wrapTool
} from '@earendil-works/pi-durable';
import { createReadTool } from '@earendil-works/pi-durable/tools';
import type { TSchema } from 'typebox';
import {
  WorkflowOutputDoc,
  WorkflowPromptContextDoc,
  type WorkflowPromptContextState
} from './docs.js';

export const SUBAGENT_EXTENSION_NAME = 'workflow.subagent';
export const STRUCTURED_OUTPUT_TOOL_NAME = 'structured_output';
const OUTPUT_EXTENSION_PREFIX = 'workflow.output.';

const PREAMBLE =
  'You are an expert coding assistant operating inside pi, a coding agent harness, as a subagent of a dynamic workflow. ' +
  'Your conversation context is separate, but filesystem access and the working directory are shared with the workflow. ' +
  'You received one self-contained task from a workflow script. You cannot see the parent conversation and cannot ask follow-up questions, ' +
  'so work autonomously with the tools available, and end with a final answer that the workflow can use directly.';

const RULES = [
  'Use bash for file operations like ls, rg, find',
  'Use read to examine files instead of cat or sed',
  'Use edit for precise changes and write only for new files or complete rewrites',
  'Stay within the task you were given; do not start unrelated work',
  'Be concise in your responses',
  'Show file paths clearly when working with files'
];

/** Pi-style system prompt for workflow subagents, rendered from the run's captured context. */
export function createSubagentExtension(): Extension {
  const context = (input: PromptInput, ctx: Context) =>
    input.read.snapshot(WorkflowPromptContextDoc, ctx);
  return defineExtension({
    name: SUBAGENT_EXTENSION_NAME,
    sections: [
      section('preamble', () => PREAMBLE, { tag: false }),
      section('rules', () => RULES.map((rule) => `- ${rule}`).join('\n')),
      section('addendum', async (input, ctx) => (await context(input, ctx))?.append || undefined),
      section('project_context', async (input, ctx) => {
        const files = (await context(input, ctx))?.contextFiles ?? [];
        if (files.length === 0) return undefined;
        return [
          'Project-specific instructions and guidelines:',
          ...files.map(
            ({ path, content }) =>
              `<project_instructions path="${path}">\n${content}\n</project_instructions>`
          )
        ].join('\n\n');
      }),
      section('skills', async (input, ctx) => (await context(input, ctx))?.skills || undefined),
      section('cwd', (input) => input.agent.cwd?.replace(/\\/g, '/'))
    ],
    // Reading is idempotent, so a call interrupted by a crash reruns instead of reaching the model
    // as an `interrupted` error. write, edit, and bash keep Pi Durable's default (not replayed).
    wraps: [
      wrapTool(createReadTool() as ToolRegistration, (tool) => ({
        ...tool,
        replay: 'safe' as const
      }))
    ]
  });
}

/** Stable short hash of a JSON Schema; equal schemas share one output extension. */
export function schemaHash(schema: unknown): string {
  return createHash('sha256').update(canonicalJson(schema)).digest('hex').slice(0, 16);
}

export function outputExtensionName(schema: unknown): string {
  return `${OUTPUT_EXTENSION_PREFIX}${schemaHash(schema)}`;
}

/**
 * A model-facing `structured_output` tool with the agent's concrete schema. Pi Durable validates
 * arguments against it before `execute()`, so invalid output goes back to the model as an error
 * result. The value is committed to the conversation's `workflow.output` document, and the tool
 * ends the run without another model request.
 */
export function createOutputExtension(schema: TSchema): Extension {
  return defineExtension({
    name: outputExtensionName(schema),
    tools: [
      defineTool({
        name: STRUCTURED_OUTPUT_TOOL_NAME,
        description:
          'Return the final structured output of this subagent. Call exactly once, as your final action, with arguments matching the schema.',
        parameters: schema,
        // Nested calls ignore control.terminate; only the model can end the subagent this way.
        callers: ['model'],
        // Idempotent: a rerun after a crash writes the same value again.
        replay: 'safe',
        execute: async (args, api, context) => {
          await api.commit(async (tx) => {
            const output = await tx.doc(WorkflowOutputDoc, api.conversationId);
            output.set = true;
            output.value = structuredClone(args) as JsonValue;
          }, context);
          return {
            output: [{ type: 'text', text: 'Structured output recorded.' }],
            control: { terminate: true }
          };
        }
      })
    ]
  });
}

export const STRUCTURED_OUTPUT_CONTRACT = [
  'Final output contract:',
  '- Your final action MUST be a structured_output tool call.',
  '- The structured_output arguments are the return value of this subagent.',
  '- Do not emit a prose final answer instead of structured_output.',
  '- If you need to inspect files or run commands first, do so, then call structured_output exactly once.'
].join('\n');

export const STRUCTURED_OUTPUT_NUDGE =
  'You finished without calling structured_output. Call structured_output now, exactly once, with arguments that match its schema. Do not answer in prose.';

/**
 * Capture project instructions (AGENTS.md and friends), skills, and appended system prompt the
 * way Pi discovers them for `cwd`, without loading extensions. Failures degrade to context files
 * only, so prompt discovery never prevents a workflow from running.
 */
export async function capturePromptContext(options: {
  cwd: string;
  agentDir?: string;
  projectTrusted?: boolean;
}): Promise<WorkflowPromptContextState> {
  const agentDir = options.agentDir ?? getAgentDir();
  try {
    const settingsManager = SettingsManager.create(options.cwd, agentDir);
    settingsManager.setProjectTrusted(options.projectTrusted ?? false);
    const loader = new DefaultResourceLoader({
      cwd: options.cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true
    });
    await loader.reload();
    const skills = loader.getSkills().skills;
    return {
      contextFiles: loader.getAgentsFiles().agentsFiles.map(({ path, content }) => ({
        path,
        content
      })),
      skills: skills.length ? formatSkillsForPrompt(skills, 'read').trim() : '',
      append: loader.getAppendSystemPrompt().join('\n\n')
    };
  } catch {
    return {
      contextFiles: loadProjectContextFiles({ cwd: options.cwd, agentDir }),
      skills: '',
      append: ''
    };
  }
}

/** JSON with sorted object keys, so equal values hash equally regardless of key order. */
export function canonicalJson(value: unknown): string {
  return (
    JSON.stringify(value, (_key, item: unknown) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0
        )
      );
    }) ?? 'null'
  );
}
