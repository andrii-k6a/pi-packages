# Implementation Plan: `@andrii-k6a/pi-graphify`

Self-contained plan for implementing a native [Pi coding agent](https://pi.dev) extension for the existing `graphify` CLI.

The user already has:

- `graphify` CLI installed.
- The Graphify skill installed for Pi.

The extension must live in this monorepo as a first-class package:

```text
pi-packages/
└── packages/
    └── pi-graphify/
        ├── src/
        │   └── graphify.ts
        ├── __tests__/
        │   └── graphify.test.ts
        ├── package.json
        ├── README.md
        ├── IMPLEMENTATION_PLAN.md
        └── LICENSE
```

## Repository conventions to follow

This repo is an npm workspace with packages in `packages/*`.

Package conventions:

- Package directory: `packages/pi-graphify`
- npm package name: `@andrii-k6a/pi-graphify`
- Extension source: `packages/pi-graphify/src/graphify.ts`
- Tests: `packages/pi-graphify/__tests__/graphify.test.ts`
- Per-package files: `README.md`, `package.json`, `LICENSE`
- TypeScript module style: ESM, strict TypeScript
- Formatting: Biome, 2-space indentation, single quotes are used in existing source
- Tests: Vitest
- Root package registration: add the extension path to root `package.json` under `pi.extensions`

Relevant root commands from `pi-packages/`:

```bash
npm install
npm run lint
npm run typecheck
npm run test
npm run check
npm run check:ci
```

Local manual test command:

```bash
cd packages/pi-graphify
pi -e .
```

## Goal

Implement a Pi extension that makes Graphify feel native inside Pi by providing:

1. A `/graphify` slash command.
2. LLM-callable tools:
   - `graphify_status`
   - `graphify_query`
   - `graphify_explain`
   - `graphify_path`
   - `graphify_update`
3. Safe execution of the existing `graphify` CLI.
4. Query-first behavior when `graphify-out/graph.json` exists.
5. Helpful output truncation and clear error messages.

Do **not** reimplement Graphify in TypeScript. This package is only a native Pi wrapper around the installed Python CLI.

## Package metadata

Create `packages/pi-graphify/package.json`:

```json
{
  "name": "@andrii-k6a/pi-graphify",
  "version": "0.1.0",
  "description": "Pi extension that wraps the Graphify knowledge-graph CLI with native commands and tools.",
  "type": "module",
  "keywords": [
    "pi-package",
    "pi-extension",
    "pi",
    "graphify",
    "knowledge-graph",
    "graphrag"
  ],
  "files": [
    "src",
    "README.md",
    "LICENSE",
    "IMPLEMENTATION_PLAN.md"
  ],
  "pi": {
    "extensions": [
      "./src/graphify.ts"
    ]
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": ">=0.75.0",
    "typebox": ">=1.1.0"
  }
}
```

Create `packages/pi-graphify/LICENSE` by copying the root `LICENSE`.

Create `packages/pi-graphify/README.md` with install, usage, tools, and troubleshooting sections.

Update root `package.json` and append:

```json
"./packages/pi-graphify/src/graphify.ts"
```

to `pi.extensions`.

Update root `README.md` package table with:

```md
| [@andrii-k6a/pi-graphify](./packages/pi-graphify/) | Extension | Native Pi commands and tools for Graphify knowledge graphs (`/graphify`, `graphify_query`) |
```

## Functional requirements

### Graph status detection

The extension must detect Graphify artifacts relative to Pi's current working directory (`ctx.cwd`):

```text
graphify-out/graph.json
graphify-out/GRAPH_REPORT.md
graphify-out/wiki/index.md
graphify-out/graph.html
```

Status should include:

- whether `graphify-out/graph.json` exists
- graph file size
- whether `GRAPH_REPORT.md` exists
- whether `wiki/index.md` exists
- whether `graph.html` exists
- absolute paths for these artifacts

Also check whether the `graphify` CLI is available on `PATH`. Do this lazily via `graphify --help` or by handling `ENOENT` from `execFile`.

### Slash command: `/graphify`

Register command:

```ts
pi.registerCommand('graphify', { ... })
```

Supported forms:

```text
/graphify
/graphify status
/graphify query <question>
/graphify explain <node-or-concept>
/graphify path <from> <to>
/graphify update [path]
/graphify extract [path]
/graphify report
/graphify open
```

#### `/graphify`

If `graphify-out/graph.json` exists:

- show status
- suggest example next commands:
  - `/graphify query What are the main modules?`
  - `/graphify explain <concept>`
  - `/graphify update .`

If no graph exists:

- show status
- ask for confirmation before running full extraction:

```ts
const ok = await ctx.ui.confirm(
  'Build Graphify graph?',
  'No graphify-out/graph.json found. Run `graphify extract .` now?'
);
```

If confirmed, run:

```bash
graphify extract .
```

Full extraction can be expensive. Never run it implicitly without explicit user action or confirmation.

#### `/graphify status`

Only inspect local files and CLI availability. Do not run extraction.

Example output:

```text
Graphify status
- CLI: available
- graph.json: present (1.2 MiB)
- GRAPH_REPORT.md: present
- wiki/index.md: missing
- graph.html: present
- graph path: /abs/path/graphify-out/graph.json
```

#### `/graphify query <question>`

If graph exists, run:

```bash
graphify query <question>
```

If no graph exists, tell the user to build one first:

```text
No graphify-out/graph.json found. Build it with `/graphify extract .` or `graphify extract .`.
```

#### `/graphify explain <concept>`

Run:

```bash
graphify explain <concept>
```

#### `/graphify path <from> <to>`

Run:

```bash
graphify path <from> <to>
```

Initial parser may split on whitespace. Better parser should support quoted values.

#### `/graphify update [path]`

Run:

```bash
graphify update <path-or-dot>
```

Default path is `.`.

#### `/graphify extract [path]`

Run:

```bash
graphify extract <path-or-dot>
```

Default path is `.`. Because the user explicitly typed `extract`, no extra confirmation is required.

#### `/graphify report`

If `graphify-out/GRAPH_REPORT.md` exists, show its path and a short preview. Do not dump a huge report into the notification. A preview of the first ~80 lines or first ~8 KiB is enough.

#### `/graphify open`

If `graphify-out/graph.html` exists, open it with the OS default opener:

- macOS: `open graphify-out/graph.html`
- Linux: `xdg-open graphify-out/graph.html`
- Windows: `cmd /c start graphify-out/graph.html`

This can be implemented after core tools.

### LLM-callable tools

Register tools so the model can use Graphify without shell-quoting mistakes.

All tools should return Pi tool results:

```ts
return {
  content: [{ type: 'text', text }],
  details
};
```

#### `graphify_status`

Parameters:

```ts
Type.Object({})
```

Returns current status. Use prompt guidance:

```text
Use graphify_status when deciding whether Graphify graph context is available for a codebase question.
```

#### `graphify_query`

Parameters:

```ts
Type.Object({
  question: Type.String({ description: 'Natural-language codebase or project question' }),
  budget: Type.Optional(Type.Number({ description: 'Token budget for Graphify output' })),
  dfs: Type.Optional(Type.Boolean({ description: 'Use DFS traversal instead of BFS' }))
})
```

CLI mapping:

```bash
graphify query <question> [--budget N] [--dfs]
```

Prompt guidance:

```text
Use graphify_query before broad raw source search when graphify-out/graph.json exists and the user asks about architecture, dependencies, call flow, relationships, or codebase concepts.
```

#### `graphify_explain`

Parameters:

```ts
Type.Object({
  concept: Type.String({ description: 'Node label, symbol, file, module, or concept' })
})
```

CLI mapping:

```bash
graphify explain <concept>
```

#### `graphify_path`

Parameters:

```ts
Type.Object({
  from: Type.String(),
  to: Type.String()
})
```

CLI mapping:

```bash
graphify path <from> <to>
```

#### `graphify_update`

Parameters:

```ts
Type.Object({
  path: Type.Optional(Type.String({ description: 'Path to update; defaults to .' })),
  force: Type.Optional(Type.Boolean()),
  noCluster: Type.Optional(Type.Boolean())
})
```

CLI mapping:

```bash
graphify update <path> [--force] [--no-cluster]
```

Use after code edits to keep `graphify-out/graph.json` current.

## Implementation details

### Use `execFile`, not shell interpolation

Use Node `child_process.execFile` with an argv array. Do not build shell strings with user input.

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type GraphifyRun = {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
  errorCode?: string;
};

export async function runGraphify(cwd: string, args: string[]): Promise<GraphifyRun> {
  try {
    const result = await execFileAsync('graphify', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024
    });
    return { ok: true, stdout: result.stdout ?? '', stderr: result.stderr ?? '', code: 0 };
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: string | number;
    };
    return {
      ok: false,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? err.message ?? String(error),
      code: typeof err.code === 'number' ? err.code : 1,
      errorCode: typeof err.code === 'string' ? err.code : undefined
    };
  }
}
```

If `errorCode === 'ENOENT'`, report:

```text
Graphify CLI not found. Install with: uv tool install graphifyy
```

### File helpers

Export helpers for tests:

```ts
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';

export async function exists(file: string): Promise<boolean> {
  try {
    await access(file, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function graphStatus(cwd: string) {
  const outDir = path.join(cwd, 'graphify-out');
  const graphJson = path.join(outDir, 'graph.json');
  const report = path.join(outDir, 'GRAPH_REPORT.md');
  const wikiIndex = path.join(outDir, 'wiki', 'index.md');
  const html = path.join(outDir, 'graph.html');

  const hasGraph = await exists(graphJson);
  const graphSize = hasGraph ? (await stat(graphJson)).size : 0;

  return {
    outDir,
    graphJson,
    report,
    wikiIndex,
    html,
    hasGraph,
    graphSize,
    hasReport: await exists(report),
    hasWiki: await exists(wikiIndex),
    hasHtml: await exists(html)
  };
}
```

### Output truncation

Use Pi truncation utilities:

```ts
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead
} from '@earendil-works/pi-coding-agent';
```

Implement and export:

```ts
export function truncateOutput(stdout: string, stderr = ''): string {
  const combined = `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ''}`;
  const truncation = truncateHead(combined, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES
  });
  let text = truncation.content;
  if (truncation.truncated) {
    text += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).]`;
  }
  return text;
}
```

### Command parser

Initial parser can be simple but should be isolated and tested.

Export:

```ts
export type GraphifyCommand =
  | { kind: 'status' }
  | { kind: 'query'; question: string }
  | { kind: 'explain'; concept: string }
  | { kind: 'path'; from: string; to: string }
  | { kind: 'update'; path: string }
  | { kind: 'extract'; path: string }
  | { kind: 'report' }
  | { kind: 'open' }
  | { kind: 'unknown'; subcommand: string };

export function parseGraphifyCommand(input: string): GraphifyCommand {
  const trimmed = input.trim();
  if (!trimmed || trimmed === 'status') return { kind: 'status' };

  const [subcommand, ...rest] = trimmed.split(/\s+/);
  const tail = rest.join(' ').trim();

  if (subcommand === 'query') return { kind: 'query', question: tail };
  if (subcommand === 'explain') return { kind: 'explain', concept: tail };
  if (subcommand === 'path') {
    // MVP: split remaining text into first token and rest. Future: quoted parser.
    return { kind: 'path', from: rest[0] ?? '', to: rest.slice(1).join(' ').trim() };
  }
  if (subcommand === 'update') return { kind: 'update', path: rest[0] || '.' };
  if (subcommand === 'extract') return { kind: 'extract', path: rest[0] || '.' };
  if (subcommand === 'report') return { kind: 'report' };
  if (subcommand === 'open') return { kind: 'open' };
  return { kind: 'unknown', subcommand };
}
```

### Extension registration skeleton

`packages/pi-graphify/src/graphify.ts` should contain exported helpers plus default extension registration.

Core shape:

```ts
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

export default function graphifyExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'graphify_status',
    label: 'Graphify Status',
    description: 'Check whether the current project has Graphify graph artifacts.',
    promptSnippet: 'Check Graphify graph availability and artifact status',
    promptGuidelines: [
      'Use graphify_status when deciding whether Graphify graph context is available for a codebase question.'
    ],
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const status = await graphStatus(ctx.cwd);
      return { content: [{ type: 'text', text: statusText(status) }], details: status };
    }
  });

  pi.registerTool({
    name: 'graphify_query',
    label: 'Graphify Query',
    description: 'Query graphify-out/graph.json for focused codebase context.',
    promptSnippet: 'Query the Graphify knowledge graph for focused codebase context',
    promptGuidelines: [
      'Use graphify_query before broad raw source search when graphify-out/graph.json exists and the user asks about architecture, dependencies, call flow, relationships, or codebase concepts.'
    ],
    parameters: Type.Object({
      question: Type.String({ description: 'Natural-language codebase or project question' }),
      budget: Type.Optional(Type.Number({ description: 'Token budget for output' })),
      dfs: Type.Optional(Type.Boolean({ description: 'Use depth-first traversal instead of breadth-first' }))
    }),
    async execute(_id, params, _signal, onUpdate, ctx) {
      const status = await graphStatus(ctx.cwd);
      if (!status.hasGraph) {
        return {
          content: [
            {
              type: 'text',
              text: 'No graphify-out/graph.json found. Build it with `/graphify extract .` or `graphify extract .`.'
            }
          ],
          details: status
        };
      }
      onUpdate?.({ content: [{ type: 'text', text: 'Querying Graphify graph...' }] });
      const cliArgs = ['query', params.question];
      if (params.dfs) cliArgs.push('--dfs');
      if (typeof params.budget === 'number') cliArgs.push('--budget', String(params.budget));
      const result = await runGraphify(ctx.cwd, cliArgs);
      return {
        content: [{ type: 'text', text: formatRunResult(result) }],
        details: { ...result, args: cliArgs }
      };
    }
  });

  // Add graphify_explain, graphify_path, graphify_update similarly.

  pi.registerCommand('graphify', {
    description: 'Build, update, query, or inspect the Graphify knowledge graph',
    getArgumentCompletions: (prefix) => {
      const commands = ['status', 'query', 'explain', 'path', 'update', 'extract', 'report', 'open'];
      const filtered = commands.filter((command) => command.startsWith(prefix));
      return filtered.length ? filtered.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const parsed = parseGraphifyCommand(args);
      // Dispatch parsed command to helpers.
    }
  });
}
```

### Format CLI run result

Use this helper so missing CLI errors are consistent:

```ts
export function formatRunResult(result: GraphifyRun): string {
  if (result.errorCode === 'ENOENT') {
    return 'Graphify CLI not found. Install with: `uv tool install graphifyy`.';
  }
  return truncateOutput(result.stdout, result.stderr);
}
```

### Optional event-based graph guidance

After the core command/tools are stable, optionally add a soft reminder before broad source search when a graph exists.

Do **not** block built-in tools. A hard block will annoy users.

```ts
pi.on('tool_call', async (event, ctx) => {
  if (event.toolName !== 'bash') return;
  const command = String(event.input?.command || '');
  if (!/\b(rg|grep|find)\b/.test(command)) return;

  const status = await graphStatus(ctx.cwd);
  if (!status.hasGraph) return;

  ctx.ui.notify(
    'Graphify graph exists. For codebase relationship questions, prefer graphify_query before broad raw search.',
    'info'
  );
});
```

Make this optional and conservative. If implemented, ensure it only notifies; it must not mutate or block tool calls.

## Tests

Create `packages/pi-graphify/__tests__/graphify.test.ts`.

Recommended fast unit tests:

1. `parseGraphifyCommand('')` returns status.
2. `parseGraphifyCommand('status')` returns status.
3. `parseGraphifyCommand('query What are the main modules?')` returns query with full question.
4. `parseGraphifyCommand('explain extract')` returns explain.
5. `parseGraphifyCommand('path detect build')` returns path `{ from: 'detect', to: 'build' }`.
6. `parseGraphifyCommand('update')` defaults path to `.`.
7. `parseGraphifyCommand('extract src')` returns extract path `src`.
8. `parseGraphifyCommand('nonsense')` returns unknown.
9. `truncateOutput()` truncates long output and includes an output-truncated notice.
10. `statusText()` renders present/missing artifacts.

Avoid tests that require the real `graphify` binary. Keep integration tests manual unless adding a mocked executable.

Example test imports should use `.js` extension because repo uses Node16 module resolution:

```ts
import { describe, expect, it } from 'vitest';
import { parseGraphifyCommand, statusText, truncateOutput } from '../src/graphify.js';
```

## README contents

`packages/pi-graphify/README.md` should include:

```md
# pi-graphify

Native Pi extension for Graphify knowledge graphs.

## Prerequisites

Install Graphify first:

```bash
uv tool install graphifyy
# or: pipx install graphifyy
```

Build a graph in a project:

```bash
graphify extract .
```

## Install

```bash
pi install npm:@andrii-k6a/pi-graphify
```

Try locally from this repo:

```bash
pi -e ./packages/pi-graphify
```

## Usage

```text
/graphify status
/graphify query What are the main modules?
/graphify explain AuthModule
/graphify path AuthModule Database
/graphify update .
/graphify extract .
```

## Tools

- `graphify_status`
- `graphify_query`
- `graphify_explain`
- `graphify_path`
- `graphify_update`

## Safety

The extension uses `execFile` and argv arrays. It does not pass user input through a shell. Full extraction is only run when explicitly requested or confirmed.
```

## Manual acceptance tests

From `pi-packages/`:

```bash
npm run lint
npm run typecheck
npm run test
npm run check
```

Manual Pi test:

```bash
cd packages/pi-graphify
pi -e .
```

Inside Pi:

```text
/graphify status
/graphify query What are the main modules?
/graphify explain extract
/graphify path detect build
/graphify update .
```

Ask the model:

```text
Use Graphify to explain this project's architecture.
```

Expected:

- Model can call `graphify_status` and `graphify_query`.
- If `graphify-out/graph.json` exists, the model should prefer graph queries before broad raw source search.
- Missing graph produces a clear message and does not silently run extraction.
- Missing CLI produces: `Graphify CLI not found. Install with: uv tool install graphifyy`.

## Acceptance criteria

Implementation is complete when:

- `packages/pi-graphify/package.json` exists and declares the extension.
- `packages/pi-graphify/src/graphify.ts` exists.
- Root `package.json` registers `./packages/pi-graphify/src/graphify.ts` under `pi.extensions`.
- Root `README.md` lists `@andrii-k6a/pi-graphify`.
- `/graphify status` works in Pi.
- `/graphify query <question>` invokes `graphify query` safely.
- `graphify_query`, `graphify_explain`, `graphify_path`, and `graphify_update` tools are visible to the LLM.
- Tool outputs are truncated safely.
- No user input is passed through shell interpolation.
- Missing graph and missing CLI cases produce clear messages.
- Full extraction is never run automatically without explicit user intent or confirmation.
- `npm run lint`, `npm run typecheck`, and `npm run test` pass from repo root.

## Future enhancements

- Rich custom TUI rendering for graph query results.
- `/graphify open` for `graph.html`.
- `/graphify watch` with user confirmation.
- Configurable graph output directory, including `GRAPHIFY_OUT` support.
- Configurable default query budget.
- Optional soft `tool_call` reminder for broad `rg`/`grep`/`find` usage.
- A mocked executable fixture for integration-style tests.
- Optional prompt template for users who want `/graphify` behavior without loading the extension.
