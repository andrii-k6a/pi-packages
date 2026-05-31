# Adoption Plan: Improvements to Borrow from `../pi-graphify`

This is a self-contained implementation plan for improving `@andrii-k6a/pi-graphify` in the `pi-packages` monorepo by adopting the best ideas from the separate `../pi-graphify` extension.

The target package is:

```text
pi-packages/packages/pi-graphify/
```

The source of inspiration is:

```text
../pi-graphify/
```

Do **not** blindly copy the other extension. Adopt the ideas that improve reliability, UX, tool coverage, and maintainability while preserving this monorepo's conventions and the current package's safety posture.

## Current target implementation summary

Current `@andrii-k6a/pi-graphify` is intentionally small:

```text
packages/pi-graphify/
├── src/graphify.ts
├── __tests__/graphify.test.ts
├── package.json
├── README.md
├── IMPLEMENTATION_PLAN.md
└── LICENSE
```

Current features:

- `/graphify` slash command
- tools:
  - `graphify_status`
  - `graphify_query`
  - `graphify_explain`
  - `graphify_path`
  - `graphify_update`
- safe `execFile('graphify', args)` argv execution
- quoted argument parsing via `splitArgs()`
- output truncation
- missing graph / missing CLI handling

Current validation command from repo root:

```bash
cd ../pi-packages
npm run check
npm run test
```

## High-value ideas found in `../pi-graphify`

The other implementation has several strong ideas worth adopting:

1. **Layered architecture**
   - `config.ts`
   - pure runner module
   - tool registration module
   - command registration module
   - auto-context module

2. **Config support**
   - enable/disable extension
   - configurable `outputDir`
   - configurable Python path / semantic backend
   - configurable auto-context behavior

3. **More complete Graphify tool coverage**
   - build
   - add URL
   - watch
   - cluster-only
   - extract
   - export callflow HTML
   - upgrade/sync skill

4. **Better slash command UX**
   - rich subcommand autocomplete
   - flag autocomplete
   - command handlers for add/watch/cluster/extract/upgrade

5. **Auto-context behavior**
   - injects a session-level Graphify hint when graph artifacts exist
   - augments relevant tool results with Graphify query suggestions
   - optionally auto-runs graph queries for high-confidence architecture intent

6. **Testability**
   - pure runner functions with injected exec
   - focused tests for runner/config/auto-context/tool behavior

7. **Better graph artifact detection**
   - configurable output directory
   - graph/report/wiki metadata
   - cheap file stats

8. **Upgrade/sync skill workflows**
   - check graphifyy version
   - upgrade graphifyy via `uv`
   - reinstall Pi skill via `graphify install --platform pi`

## Important constraint: keep our safety model

The other extension often builds shell command strings and runs them through a shell adapter. Our package currently uses `execFile` with argv arrays. Keep that where possible.

For this package:

- Prefer `execFile(command, args)` over shell command strings.
- Do not pass user input through a shell.
- Only use shell execution if unavoidable, isolated, reviewed, and tested.
- Do not auto-install Python packages unless explicitly requested by the user.
- Do not auto-run expensive graph builds without explicit request or confirmation.

## Desired final architecture

Refactor from one large file into this package-local structure:

```text
packages/pi-graphify/
├── src/
│   ├── index.ts              # extension entrypoint; loads config and registers tools/commands/hooks
│   ├── config.ts             # config loading and defaults
│   ├── runner.ts             # pure Graphify CLI runner helpers, no Pi imports
│   ├── status.ts             # graph artifact detection and status rendering
│   ├── args.ts               # command parser / quoted arg splitting
│   ├── output.ts             # truncation / error formatting helpers
│   ├── commands.ts           # /graphify command registration
│   ├── tools.ts              # tool registration
│   └── auto-context.ts       # optional Graphify prompt/tool-result augmentation
├── __tests__/
│   ├── args.test.ts
│   ├── status.test.ts
│   ├── output.test.ts
│   ├── runner.test.ts
│   ├── config.test.ts
│   └── auto-context.test.ts
```

Update `packages/pi-graphify/package.json`:

```json
"pi": {
  "extensions": [
    "./src/index.ts"
  ]
}
```

Update root `package.json` from:

```json
"./packages/pi-graphify/src/graphify.ts"
```

to:

```json
"./packages/pi-graphify/src/index.ts"
```

Keep temporary compatibility by leaving `src/graphify.ts` only if needed as a re-export:

```ts
export { default } from './index.js';
export * from './args.js';
export * from './status.js';
export * from './output.js';
export * from './runner.js';
```

If no external code imports `src/graphify.ts`, delete it after migration and update tests.

## Phase 1 — Refactor for maintainability

### Goal

Split the current single-file implementation into focused modules without changing behavior.

### Steps

1. Create `src/args.ts`
   - Move:
     - `GraphifyCommand`
     - `parseGraphifyCommand()`
     - `splitArgs()`
   - Export all three.

2. Create `src/status.ts`
   - Move:
     - `GraphifyStatus`
     - `exists()`
     - `graphStatus()`
     - `statusText()`
   - Adjust `graphStatus()` to accept optional output directory and CLI availability callback.

3. Create `src/output.ts`
   - Move:
     - missing graph / missing CLI message constants
     - `truncateOutput()`
     - `formatRunResult()`
     - `toolText()` if still shared

4. Create `src/runner.ts`
   - Move:
     - `GraphifyRun`
     - `runGraphify()`
     - `execFileCommand()` if needed
   - Add focused runner functions listed in Phase 3.

5. Create `src/tools.ts`
   - Move all `pi.registerTool()` calls.
   - Export `registerGraphifyTools(pi, config)`.

6. Create `src/commands.ts`
   - Move `/graphify` registration and command handlers.
   - Export `registerGraphifyCommand(pi, config)`.

7. Create `src/index.ts`
   - Load config.
   - If disabled, return.
   - Register tools.
   - Register command.
   - Register auto-context if enabled.

8. Update tests to import helpers from their new modules.

### Acceptance criteria

- No behavior changes.
- `npm run check` passes.
- `npm run test` passes.
- Existing command/tool manual tests still work.

## Phase 2 — Add configuration support

### Goal

Adopt the other extension's configurable behavior, but keep it simpler and aligned with `pi-packages`.

### Config file location

Use Pi project/user settings through `prime-settings.json`, matching the other extension pattern.

Global:

```text
~/.pi/agent/prime-settings.json
```

Project:

```text
.pi/prime-settings.json
```

Config key:

```json
"pi-graphify"
```

### Config schema

Create `src/config.ts`:

```ts
export type SemanticBackend =
  | 'deepseek'
  | 'openai'
  | 'claude'
  | 'kimi'
  | 'gemini'
  | 'ollama'
  | 'bedrock'
  | 'claude-cli';

export type RawGraphifyConfig = {
  enabled?: boolean;
  outputDir?: string;
  defaultQueryBudget?: number;
  semanticBackend?: SemanticBackend;
  autoContext?: Partial<AutoContextConfig>;
};

export type GraphifyConfig = {
  enabled: boolean;
  outputDir: string;
  defaultQueryBudget: number;
  semanticBackend: SemanticBackend;
  autoContext: AutoContextConfig;
};

export type AutoContextConfig = {
  enabled: boolean;
  sessionHint: boolean;
  toolResultHints: boolean;
  autoQuery: boolean;
  maxSessionHints: number;
  maxHintChars: number;
  minToolResultLines: number;
  triggerTools: string[];
  triggerPatterns: string[];
};
```

Recommended defaults:

```ts
export const DEFAULT_CONFIG: GraphifyConfig = {
  enabled: true,
  outputDir: 'graphify-out',
  defaultQueryBudget: 2000,
  semanticBackend: 'deepseek',
  autoContext: {
    enabled: true,
    sessionHint: true,
    toolResultHints: true,
    autoQuery: false,
    maxSessionHints: 8,
    maxHintChars: 1200,
    minToolResultLines: 8,
    triggerTools: ['read', 'grep', 'rg', 'find', 'bash'],
    triggerPatterns: [
      'architecture',
      'module',
      'component',
      'pipeline',
      'dependency',
      'depends',
      'connect',
      'relationship',
      'call flow',
      'graphify',
      'graph',
      'GRAPH_REPORT',
      'graphify-out'
    ]
  }
};
```

### Implementation notes

- Use `getAgentDir()` from `@earendil-works/pi-coding-agent` if available, like the other extension.
- If importing `getAgentDir()` causes type/runtime issues, fall back to:

```ts
path.join(os.homedir(), '.pi', 'agent')
```

- Merge order:
  1. defaults
  2. global config
  3. project config

- Validate all user values.
- Invalid config should fall back to defaults, not throw.

### Example config for README

```json
{
  "pi-graphify": {
    "enabled": true,
    "outputDir": "graphify-out",
    "defaultQueryBudget": 2000,
    "semanticBackend": "deepseek",
    "autoContext": {
      "enabled": true,
      "sessionHint": true,
      "toolResultHints": true,
      "autoQuery": false
    }
  }
}
```

### Acceptance criteria

- `graphStatus()` respects `config.outputDir`.
- Tools and commands use `config.defaultQueryBudget` when no budget is given.
- Extension returns early when `enabled: false`.
- Unit tests cover default config, global/project merge, invalid values, custom outputDir.

## Phase 3 — Expand Graphify tool coverage

### Goal

Adopt the other extension's useful Graphify CLI coverage while keeping each tool thin and safe.

Add these tools in priority order.

### 3.1 `graphify_build`

Purpose: full graph build from a directory.

Parameters:

```ts
Type.Object({
  path: Type.Optional(Type.String({ description: 'Directory path to build graph from; defaults to .' })),
  mode: Type.Optional(Type.Union([Type.Literal('standard'), Type.Literal('deep')])),
  backend: Type.Optional(Type.Union([
    Type.Literal('deepseek'),
    Type.Literal('openai'),
    Type.Literal('claude'),
    Type.Literal('kimi'),
    Type.Literal('gemini'),
    Type.Literal('ollama'),
    Type.Literal('bedrock'),
    Type.Literal('claude-cli')
  ])),
  noViz: Type.Optional(Type.Boolean()),
  svg: Type.Optional(Type.Boolean()),
  graphml: Type.Optional(Type.Boolean()),
  neo4j: Type.Optional(Type.Boolean())
})
```

Runner mapping:

```bash
graphify extract <path> [--backend B] [--mode deep]
graphify cluster-only <path> [--no-viz]
```

Optional export flags can initially be deferred unless the Graphify CLI supports them directly on `extract` in the installed version.

Important:

- Do not auto-run this tool for casual questions.
- The model may call it only when user asks to build/rebuild graph.
- `/graphify extract .` may map to this or to `graphify_extract`; be explicit in docs.

### 3.2 `graphify_add`

Purpose: fetch URL and update graph.

Parameters:

```ts
Type.Object({
  url: Type.String({ description: 'URL to fetch and add to the corpus' }),
  author: Type.Optional(Type.String()),
  contributor: Type.Optional(Type.String())
})
```

Runner mapping:

```bash
graphify add <url> [--author <name>] [--contributor <name>]
graphify update ./raw
```

Use `execFile('graphify', ['add', url, ...])`, not shell.

### 3.3 `graphify_cluster`

Purpose: rerun clustering and regenerate report without re-extraction.

Parameters:

```ts
Type.Object({
  path: Type.Optional(Type.String({ description: 'Project path; defaults to .' })),
  noViz: Type.Optional(Type.Boolean())
})
```

Runner mapping:

```bash
graphify cluster-only <path> [--no-viz]
```

### 3.4 `graphify_extract`

Purpose: expose headless extraction options for CI / explicit extraction.

Parameters:

```ts
Type.Object({
  inputPath: Type.Optional(Type.String({ description: 'Directory path to extract; defaults to .' })),
  backend: Type.Optional(BackendUnion),
  maxWorkers: Type.Optional(Type.Integer({ minimum: 1 })),
  tokenBudget: Type.Optional(Type.Integer({ minimum: 1 })),
  maxConcurrency: Type.Optional(Type.Integer({ minimum: 1 })),
  apiTimeout: Type.Optional(Type.Integer({ minimum: 1 })),
  resolution: Type.Optional(Type.Number()),
  excludeHubs: Type.Optional(Type.Number()),
  exclude: Type.Optional(Type.Array(Type.String()))
})
```

Runner mapping:

```bash
graphify extract <inputPath> [flags]
```

### 3.5 `graphify_export_callflow`

Purpose: generate architecture/call-flow HTML.

Parameters:

```ts
Type.Object({
  graphPath: Type.Optional(Type.String({ description: 'Path to graph.json' })),
  outputPath: Type.Optional(Type.String({ description: 'Output HTML path' }))
})
```

Runner mapping:

```bash
graphify export callflow-html --graph <graphPath> --output <outputPath>
```

Check current Graphify CLI syntax before implementation. If `graphify export callflow-html` does not accept these flags, use the installed CLI's actual syntax.

### 3.6 `graphify_watch`

Purpose: start watch mode.

Parameters:

```ts
Type.Object({
  path: Type.Optional(Type.String({ description: 'Directory path to watch; defaults to .' })),
  debounce: Type.Optional(Type.Integer({ minimum: 1 }))
})
```

Important:

- Watch can be long-running.
- The tool description must warn it runs until aborted.
- Prefer command flow that tells the model/user to run it in a background terminal if needed.
- Do not start it automatically.

Runner mapping options:

```bash
graphify watch <path>
```

or if required:

```bash
python -m graphify.watch <path> --debounce N
```

Prefer the public CLI if available.

### 3.7 `graphify_upgrade`

Purpose: check/update Graphify Python CLI and sync Pi skill.

Parameters:

```ts
Type.Object({
  action: Type.Optional(Type.Union([
    Type.Literal('check'),
    Type.Literal('install'),
    Type.Literal('sync-skill')
  ]))
})
```

Mappings:

- `check`
  - `graphify --version`
  - optionally query PyPI via `uv pip index versions graphifyy` or `pip index versions graphifyy`
- `install`
  - `uv tool upgrade graphifyy`
  - then `graphify install --platform pi`
- `sync-skill`
  - `graphify install --platform pi`

Safety:

- `install` modifies user tool installation. It should be explicit only.
- Slash command should ask confirmation before `upgrade install` if not directly requested.

### Acceptance criteria for Phase 3

- New tools are visible in Pi.
- Tool schemas avoid `Type.Unknown()`.
- Tools use argv arrays.
- Tests cover CLI argv construction via runner tests.
- README lists all new tools.

## Phase 4 — Improve `/graphify` command UX

### Goal

Adopt the other extension's richer command surface and autocomplete while keeping command actions understandable.

### Add subcommands

Current:

```text
status query explain path update extract report open
```

Add:

```text
build add watch cluster hook upgrade callflow
```

Recommended final command list:

```text
/graphify                         # status + suggestions, prompt to build if no graph
/graphify status                  # status only
/graphify build [path] [flags]    # full graph build
/graphify query <question> [--dfs] [--budget N]
/graphify explain <concept>
/graphify path <from> <to>
/graphify add <url> [--author N] [--contributor N]
/graphify update [path] [--force] [--no-cluster]
/graphify extract [path] [flags]
/graphify watch [path] [--debounce N]
/graphify cluster [path] [--no-viz]
/graphify callflow [--graph P] [--output P]
/graphify hook <install|uninstall|status>
/graphify upgrade <check|install|sync-skill>
/graphify report
/graphify open
```

### Add typed parsed command shape

Extend `GraphifyCommand` to include all subcommands and flags.

Example:

```ts
type GraphifyCommand =
  | { kind: 'status' }
  | { kind: 'build'; path: string; mode?: 'standard' | 'deep'; backend?: SemanticBackend; noViz?: boolean }
  | { kind: 'query'; question: string; dfs: boolean; budget?: number }
  | { kind: 'add'; url: string; author?: string; contributor?: string }
  | ...;
```

### Parser requirements

- Reuse `splitArgs()` for quoted values.
- Support `--flag value`.
- Support boolean flags like `--dfs`, `--no-viz`, `--force`.
- Do not silently accept malformed command forms if they could be destructive.
- Return usage messages for missing required arguments.

### Autocomplete

Adopt the idea of grouped autocomplete items from `../pi-graphify/src/commands/index.ts`, but implement in this package's style.

Include:

- subcommand autocomplete
- query flags: `--dfs`, `--budget N`
- build flags: `--mode deep`, `--backend <backend>`, `--no-viz`
- extract flags: `--backend <backend>`, `--max-workers N`, `--token-budget N`, `--api-timeout N`
- add flags: `--author`, `--contributor`
- hook actions: `install`, `uninstall`, `status`
- upgrade actions: `check`, `install`, `sync-skill`

### Command behavior guidance

For commands that produce useful graph context (`query`, `path`, `explain`), prefer either:

1. show direct CLI output in notification for quick use, or
2. send a user message to the agent with the graph output for synthesis.

Current package uses notifications. The other extension uses `pi.sendUserMessage()` for synthesis. Adopt this selectively:

- Keep `/graphify status`, `update`, `cluster`, `upgrade` as notifications.
- For `/graphify query`, `/graphify path`, `/graphify explain`, consider adding a config option:

```ts
commandResultMode: 'notify' | 'ask-agent'
```

Default should remain `'notify'` to avoid surprising extra model calls. Document `'ask-agent'` as an optional workflow.

### Acceptance criteria

- `/graphify` autocomplete is useful for all supported subcommands.
- Parser tests cover quoted args and flags.
- Command tests cover at least parse/dispatch helpers without needing real `graphify`.
- README usage examples are updated.

## Phase 5 — Add auto-context, but make it conservative

### Goal

Adopt the other extension's best UX idea: when a graph exists, Pi should naturally remember to use it.

Current package relies on tool prompt guidance and the installed skill. Add lightweight auto-context hooks to improve model behavior.

### Scope

Implement `src/auto-context.ts` with two optional hooks:

1. session-level system prompt hint
2. tool-result hint augmentation

Do **not** auto-query by default.

### Session hint hook

On `before_agent_start`:

- check config:
  - `config.autoContext.enabled`
  - `config.autoContext.sessionHint`
- detect graph artifacts using `config.outputDir`
- if graph exists, append a small system prompt section
- inject once per session

Suggested text:

```text
[Graphify active]
This project has a Graphify knowledge graph at graphify-out/graph.json.
For architecture, dependency, call-flow, relationship, or cross-file questions, prefer graphify_query, graphify_path, or graphify_explain before broad raw source search.
Use graphify-out/wiki/index.md for broad navigation when present and GRAPH_REPORT.md for broad architecture review.
After code edits, consider graphify_update.
```

Include custom `outputDir` in text.

### Tool-result hint hook

On `tool_result`:

- only if graph exists
- only for configured trigger tools
- only if result is large enough (`minToolResultLines`)
- classify rough intent from:
  - tool name
  - input path/pattern/command
  - output size
- append a small hint to the tool result:

```text
---
[Graphify] This result spans multiple files. For architecture context, use:
graphify_query({ question: "How do these files relate in the system?", budget: 1200 })
---
```

### Intent classification

Implement a simple, tested classifier inspired by the other extension.

Suggested intent kinds:

```ts
type GraphifyIntentKind =
  | 'none'
  | 'broad-search'
  | 'overview-file'
  | 'docs-or-plan'
  | 'architecture-question'
  | 'multi-file-result';
```

Triggers:

- broad search tools: `grep`, `rg`, `find`, `bash` with `rg|grep|find`
- high-value files: `README.md`, `AGENTS.md`, `package.json`, `CHANGELOG.md`
- docs/plans: `.md`, `.mdx`, `docs/`, `plans/`
- input contains trigger patterns: architecture, module, pipeline, dependency, graph, graphify
- output has many lines

### Deduplication and limits

Maintain per-session mutable state:

```ts
type AutoContextState = {
  sessionHintInjected: boolean;
  hintCount: number;
  seenKeys: Set<string>;
};
```

Limits:

- max `config.autoContext.maxSessionHints`
- max hint chars `config.autoContext.maxHintChars`
- dedupe by tool name + input path/pattern/command

Clear state on `session_shutdown`.

### Optional auto-query

Only implement after hints are stable.

If `config.autoContext.autoQuery === true` and confidence is high:

- run `graphify query <suggested question> --budget <budget>`
- hard timeout: 8 seconds
- swallow all errors
- truncate to max hint chars
- append result as context

Default must be `false`.

### Acceptance criteria

- Session prompt hint appears only when graph exists.
- Tool-result hints appear only for relevant/large results.
- Hints are bounded and deduplicated.
- Auto-query is off by default.
- Auto-context tests do not require real `graphify`.

## Phase 6 — Add better rendering without mandatory extra dependency

The other extension uses `@gaodes/pi-utils-ui` for rich `ToolCallHeader`, `ToolBody`, and `ToolFooter` rendering. This is nice, but adding that dependency may be unnecessary for this monorepo.

Recommended approach:

1. First improve `renderCall()` and `renderResult()` using Pi built-ins only:
   - `Text` from `@earendil-works/pi-tui`
   - possibly `Markdown` if already used elsewhere
2. Only add `@gaodes/pi-utils-ui` if the repo owner explicitly wants the extra dependency.

### Minimal rendering to add

For each tool:

- `renderCall()` should show compact action:
  - `Graphify query: <question>`
  - `Graphify path: A → B`
  - `Graphify update: .`
- `renderResult()` should show status and key details in collapsed view.

Example:

```ts
renderCall(args, theme) {
  return new Text(theme.fg('toolTitle', theme.bold('Graphify query ')) + theme.fg('accent', args.question), 0, 0);
}
```

### Acceptance criteria

- Tool calls are easy to scan in the TUI.
- No large output is rendered in collapsed mode.
- Expanded mode can show truncated output.
- No new dependency unless justified.

## Phase 7 — Improve runner behavior and tests

### Goal

Adopt the other extension's testability by making runner logic pure and injected.

### Runner design

Current `runGraphify()` directly calls `execFile`. Keep that for production, but add injectable helpers for tests.

Option A: dependency injection per function:

```ts
type ExecFileLike = (
  file: string,
  args: string[],
  options: ExecFileOptions
) => Promise<{ stdout?: string; stderr?: string }>;
```

Option B: expose argv builders separately:

```ts
export function buildQueryArgs(params): string[];
export function buildExtractArgs(params): string[];
export function buildAddArgs(params): string[];
```

Prefer Option B for simplicity.

### Add argv builder tests

Test that:

- query uses `['query', question, '--budget', '2000']`
- dfs adds `--dfs`
- add URL preserves URL as one arg
- author/contributor become separate args
- extract flags are correct
- cluster flags are correct
- upgrade sync-skill uses `['install', '--platform', 'pi']`

### Graph status optimization

Current `graphStatus()` runs `graphify --help` every time. This can be slow. Improve by caching CLI availability per process for a short time.

Implement:

```ts
let cliAvailabilityCache: { checkedAt: number; available: boolean } | undefined;
const CLI_CACHE_MS = 30_000;
```

Or make CLI availability optional:

```ts
graphStatus(cwd, config, { checkCli: false })
```

Use `checkCli: true` only for `/graphify status` and `graphify_status`; avoid it in hot hooks.

### Acceptance criteria

- Runner tests cover argv construction.
- Auto-context path never runs `graphify --help`.
- No tests require real `graphify` binary.

## Phase 8 — Gitignore management, optional and explicit

The other extension automatically normalizes `.gitignore` for graph artifacts. This is useful but can be surprising.

Adopt as explicit command/tool only:

```text
/graphify gitignore
```

or as an option:

```text
/graphify build . --update-gitignore
```

Function behavior:

- ensure `.gitignore` contains:

```text
graphify-out/
```

- remove legacy noisy entries only if they are Graphify-owned:

```text
graphify-out/cache/
graphify-out/.graphify_python
graphify-out/.graphify_root
graphify-out/cost.json
/graphify-out/
```

Do not modify `.gitignore` during ordinary query/status/explain/path.

### Acceptance criteria

- Explicit command updates `.gitignore` idempotently.
- Test covers empty file, existing entry, legacy entries.

## Phase 9 — Upgrade/sync skill documentation

The other extension's upgrade story is useful because Graphify skill and CLI can drift.

Document and implement:

```text
/graphify upgrade check
/graphify upgrade install
/graphify upgrade sync-skill
```

README should explain:

- `check` checks the installed Python CLI version.
- `install` runs `uv tool upgrade graphifyy` and then reinstalls Pi skill.
- `sync-skill` only runs `graphify install --platform pi`.
- These commands update the Graphify CLI/skill, not the graph data.

If `uv` is unavailable, return a clear message:

```text
uv not found. Upgrade manually with pipx or pip, then run graphify install --platform pi.
```

## Things not to adopt yet

Do not adopt these until there is a clear need:

1. **Auto-installing `graphifyy` on first use**
   - Current user already installed it.
   - Auto-installing packages can surprise users.

2. **Shell-string runner as default**
   - Our `execFile` argv style is safer.

3. **Extra UI dependency by default**
   - `@gaodes/pi-utils-ui` is nice but not necessary.

4. **Complex Neo4j / clone / merge / global graph tools**
   - Useful but not core for first improvement wave.
   - Add later if the user explicitly wants full CLI parity.

5. **Automatic graph build from natural-language question**
   - Too expensive and surprising.
   - Always require explicit command or confirmation.

## Recommended implementation order

1. Phase 1: module refactor only.
2. Phase 2: config and configurable outputDir.
3. Phase 7 partial: argv builder tests and avoid repeated `graphify --help`.
4. Phase 3 tools:
   1. `graphify_build`
   2. `graphify_add`
   3. `graphify_cluster`
   4. `graphify_extract`
   5. `graphify_export_callflow`
   6. `graphify_upgrade`
   7. `graphify_watch`
5. Phase 4: command autocomplete and new subcommands.
6. Phase 5: conservative auto-context hints.
7. Phase 6: simple renderers.
8. Phase 8: explicit gitignore helper.
9. README and tests after each phase.

## Final acceptance checklist

The improved package is complete when:

- Root and package manifests point to the correct extension entrypoint.
- The package has focused modules instead of one large file.
- Config supports `enabled`, `outputDir`, `defaultQueryBudget`, `semanticBackend`, and `autoContext`.
- Existing tools still work.
- New tools work:
  - `graphify_build`
  - `graphify_add`
  - `graphify_cluster`
  - `graphify_extract`
  - `graphify_export_callflow`
  - `graphify_upgrade`
  - optionally `graphify_watch`
- `/graphify` autocomplete covers common subcommands and flags.
- Auto-context hints are conservative, bounded, deduped, and disabled via config.
- No user-controlled string is passed through a shell.
- Full graph builds/upgrades/watch are never run implicitly.
- Tests cover config, parsing, output formatting, status detection, argv builders, and auto-context.
- README documents install, config, commands, tools, and safety.
- From `pi-packages` root:

```bash
npm run check
npm run test
```

passes.
