import { createRequire } from 'node:module';
import { StringEnum } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import type { Opener } from './glimpse-window.js';
import { AVAILABLE_MODULES, getGuidelines, type Module } from './guidelines.js';
import { WidgetSession } from './session.js';

const require = createRequire(import.meta.url);
const GLIMPSE_PATH = require.resolve('glimpseui');

// ── Tool schemas ───────────────────────────────────────────────────────
const ReadMeParams = Type.Object({
  modules: Type.Array(StringEnum(AVAILABLE_MODULES), {
    description: 'Which module(s) to load. Pick all that fit.'
  })
});

const ShowWidgetParams = Type.Object({
  i_have_seen_read_me: Type.Boolean({
    description: 'Confirm you have already called visualize_read_me in this conversation.'
  }),
  title: Type.String({
    description: 'Short snake_case identifier for this widget (used as window title).'
  }),
  widget_code: Type.String({
    description:
      'HTML or SVG code to render. For SVG: raw SVG starting with <svg>. ' +
      'For HTML: raw content fragment, no DOCTYPE/<html>/<head>/<body>.'
  }),
  width: Type.Optional(Type.Number({ description: 'Window width in pixels. Default: 800.' })),
  height: Type.Optional(Type.Number({ description: 'Window height in pixels. Default: 600.' })),
  floating: Type.Optional(
    Type.Boolean({ description: 'Keep window always on top. Default: false.' })
  )
});

interface ReadMeDetails {
  modules: readonly Module[];
}
interface ShowWidgetDetails {
  title: string;
  width: number;
  height: number;
  isSVG: boolean;
}

type ToolCallBlock = {
  type: string;
  name?: string;
  id?: string;
  arguments?: Record<string, unknown>;
};

type AssistantToolCallEvent = {
  type: string;
  contentIndex: number;
  partial?: { content?: ToolCallBlock[] };
  toolCall?: { id?: string; arguments?: Record<string, unknown> };
};

export default function (pi: ExtensionAPI) {
  const activeSessions = new Set<WidgetSession>();
  let openCache: Opener | null = null;

  async function getOpen(): Promise<Opener> {
    if (!openCache) {
      const mod = (await import(GLIMPSE_PATH)) as { open: Opener };
      openCache = mod.open;
    }
    return openCache;
  }

  // ── Streaming bridge ───────────────────────────────────────────────────
  //
  // While show_widget streams, we want the user to see partial content
  // before the tool call finishes. The session is created on toolcall_start
  // and `execute()` later picks it up by content index.

  const pendingSessions = new Map<string, WidgetSession>();
  const completedSessions: WidgetSession[] = [];

  function indexKey(contentIndex: number): string {
    return `index:${contentIndex}`;
  }

  function toolKey(raw: AssistantToolCallEvent, block?: ToolCallBlock): string {
    return raw.toolCall?.id ?? block?.id ?? indexKey(raw.contentIndex);
  }

  function getPendingSession(
    raw: AssistantToolCallEvent,
    block?: ToolCallBlock
  ): WidgetSession | undefined {
    return (
      pendingSessions.get(toolKey(raw, block)) ?? pendingSessions.get(indexKey(raw.contentIndex))
    );
  }

  function deletePendingSession(raw: AssistantToolCallEvent, block?: ToolCallBlock): void {
    pendingSessions.delete(toolKey(raw, block));
    pendingSessions.delete(indexKey(raw.contentIndex));
  }

  function deleteSessionAliases(session: WidgetSession): void {
    for (const [key, value] of pendingSessions) {
      if (value === session) pendingSessions.delete(key);
    }
  }

  function trackSession(session: WidgetSession): void {
    activeSessions.add(session);
    session.onClosed(() => activeSessions.delete(session));
  }

  function closePendingSessions(): void {
    for (const session of new Set(pendingSessions.values())) session.close();
    for (const session of completedSessions) session.close();
    pendingSessions.clear();
    completedSessions.length = 0;
  }

  pi.on('message_update', async (event) => {
    const raw = (event as { assistantMessageEvent?: AssistantToolCallEvent }).assistantMessageEvent;
    if (!raw) return;

    if (raw.type === 'toolcall_start') {
      const block = raw.partial?.content?.[raw.contentIndex];
      if (block?.type !== 'toolCall' || block.name !== 'show_widget') return;

      const args = block.arguments ?? {};
      const title = String(args.title ?? 'Widget').replace(/_/g, ' ');
      const width = typeof args.width === 'number' ? args.width : 800;
      const height = typeof args.height === 'number' ? args.height : 600;

      try {
        const open = await getOpen();
        const session = new WidgetSession(open, { title, width, height });
        trackSession(session);
        pendingSessions.set(toolKey(raw, block), session);
        pendingSessions.set(indexKey(raw.contentIndex), session);
      } catch (err) {
        console.error('[generative-ui] failed to open streaming window:', err);
      }
      return;
    }

    if (raw.type === 'toolcall_delta') {
      const block = raw.partial?.content?.[raw.contentIndex];
      const session = getPendingSession(raw, block);
      const html = block?.arguments?.widget_code;
      if (session && typeof html === 'string') session.onChunk(html);
      return;
    }

    if (raw.type === 'toolcall_end') {
      const session = getPendingSession(raw);
      const html = raw.toolCall?.arguments?.widget_code;
      if (!session) return;
      if (typeof html === 'string') await session.onComplete(html);
      deletePendingSession(raw);
      if (!completedSessions.includes(session)) completedSessions.push(session);
      return;
    }
  });

  // ── read_me tool ───────────────────────────────────────────────────────

  pi.registerTool<typeof ReadMeParams, ReadMeDetails>({
    name: 'visualize_read_me',
    label: 'Read Guidelines',
    description:
      'Returns design guidelines for show_widget (CSS patterns, colors, typography, layout rules, examples). ' +
      'Call once before your first show_widget call. Do NOT mention this call to the user — it is an internal setup step.',
    promptSnippet:
      'Load design guidelines before creating widgets. Call silently before first show_widget use.',
    promptGuidelines: [
      'Call visualize_read_me once before your first show_widget call to load design guidelines.',
      'Do NOT mention the read_me call to the user — call it silently, then proceed directly to building the widget.',
      'Pick the modules that match your use case: interactive, chart, mockup, art, diagram.'
    ],
    parameters: ReadMeParams,

    async execute(_id, params) {
      const modules = params.modules as readonly Module[];
      return {
        content: [{ type: 'text' as const, text: getGuidelines(modules) }],
        details: { modules }
      };
    },

    renderCall(args, theme) {
      const mods = (args.modules ?? []).join(', ');
      return new Text(
        theme.fg('toolTitle', theme.bold('read_me ')) + theme.fg('muted', mods),
        0,
        0
      );
    },

    renderResult(_result, { isPartial }, theme) {
      if (isPartial) return new Text(theme.fg('warning', 'Loading guidelines...'), 0, 0);
      return new Text(theme.fg('dim', 'Guidelines loaded'), 0, 0);
    }
  });

  // ── show_widget tool ───────────────────────────────────────────────────

  pi.registerTool<typeof ShowWidgetParams, ShowWidgetDetails>({
    name: 'show_widget',
    label: 'Show Widget',
    description:
      'Show visual content — SVG graphics, diagrams, charts, or interactive HTML/JS widgets — in a native window. ' +
      'Supports macOS, Linux, and Windows. ' +
      'The HTML is rendered in a native WebView with full CSS/JS support including Canvas, animations, and CDN libraries. ' +
      "Widgets are display-only from the agent's perspective: there is no return channel for clicks/input. " +
      'In-widget interactivity (sliders that update charts, hover states, animations, click handlers driving local state) all works — ' +
      'but the agent does not receive callbacks. Do NOT write `glimpse.send(...)` or `sendPrompt(...)` patterns; they are no-ops here. ' +
      'IMPORTANT: Call visualize_read_me once before your first show_widget call.',
    promptSnippet:
      'Render interactive HTML/SVG widgets in a native window. Full CSS, JS, Canvas, Chart.js. Display-only — no callbacks to the agent.',
    promptGuidelines: [
      'Use show_widget when the user asks for visual content: charts, diagrams, interactive explainers, UI mockups, art.',
      'Always call visualize_read_me first to load design guidelines, then set i_have_seen_read_me: true.',
      'The widget opens in a native window with full browser capabilities (Canvas, JS, CDN libraries).',
      'Structure HTML as fragments: no DOCTYPE/<html>/<head>/<body>. Style first, then HTML, then scripts.',
      'Widgets are display-only. The agent does not receive widget interactions — do not emit `glimpse.send(...)` or `sendPrompt(...)`. ' +
        "In-widget interactivity (sliders, hovers, controls that mutate the widget's own DOM) is fully supported and encouraged.",
      'Keep widgets focused and appropriately sized. Default is 800x600 but adjust to fit content.',
      'For SVG: start code with <svg> tag.'
    ],
    parameters: ShowWidgetParams,

    async execute(id, params, signal) {
      if (!params.i_have_seen_read_me) {
        throw new Error(
          'You must call visualize_read_me before show_widget. Set i_have_seen_read_me: true after doing so.'
        );
      }
      if (signal?.aborted) {
        throw new Error('show_widget aborted before execution');
      }

      const code = params.widget_code;
      const isSVG = code.trimStart().startsWith('<svg');
      const title = params.title.replace(/_/g, ' ');
      const width = params.width ?? 800;
      const height = params.height ?? 600;

      // Reuse the streaming session if present; otherwise open one now.
      let session = pendingSessions.get(id);
      if (session) {
        deleteSessionAliases(session);
      } else {
        session = completedSessions.shift();
      }
      if (!session) {
        const open = await getOpen();
        session = new WidgetSession(open, { title, width, height, floating: params.floating });
        trackSession(session);
      }

      // Wire abort BEFORE the async onComplete await — abort during
      // streaming flush must close the window. The listener also stays
      // attached for after we return, so an abort that arrives after the
      // tool resolves still cleans up the still-open window.
      if (signal) {
        if (signal.aborted) {
          session.close();
          throw new Error('show_widget aborted before execution');
        }
        signal.addEventListener('abort', () => session.close(), { once: true });
      }

      await session.onComplete(code);

      return {
        content: [
          {
            type: 'text' as const,
            text: `Widget "${title}" rendered (${width}×${height}).`
          }
        ],
        details: { title: params.title, width, height, isSVG }
      };
    },

    renderCall(args, theme) {
      const title = (args.title ?? 'widget').replace(/_/g, ' ');
      const size = args.width && args.height ? ` ${args.width}×${args.height}` : '';
      let text = theme.fg('toolTitle', theme.bold('show_widget ')) + theme.fg('accent', title);
      if (size) text += theme.fg('dim', size);
      return new Text(text, 0, 0);
    },

    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text(theme.fg('warning', '⟳ Widget rendering...'), 0, 0);
      const d = result.details;
      const title = (d?.title ?? 'widget').replace(/_/g, ' ');
      let text = theme.fg('success', '✓ ') + theme.fg('accent', title);
      text += theme.fg('dim', ` ${d?.width ?? 800}×${d?.height ?? 600}`);
      if (d?.isSVG) text += theme.fg('dim', ' (SVG)');
      return new Text(text, 0, 0);
    }
  });

  // ── shutdown ───────────────────────────────────────────────────────────

  pi.on('session_shutdown', async () => {
    closePendingSessions();
    for (const s of activeSessions) s.close();
    activeSessions.clear();
  });
}
