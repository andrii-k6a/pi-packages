# Review Feedback: `@andrii-k6a/pi-graphify`

Review target:

```text
pi-packages/packages/pi-graphify/
```

Reference checked:

```text
../graphify/
```

Validation run from `pi-packages/`:

```bash
npm run check
npm run test -- packages/pi-graphify
graphify --version
graphify --help
```

Result:

```text
lint:       passed
typecheck:  passed
tests:      5 files passed, 47 tests passed
CLI:        graphify 0.8.26 available on PATH
```

## Overall assessment

The extension is **usable for the basic workflow**, but it is **not release-ready yet**.

It successfully wraps the installed Python Graphify CLI with Pi-native commands and tools while preserving the safer `execFile` argv-array execution model. The core status/query/explain/path/update/extract flow is in place and tested.

However, several advertised or partially implemented capabilities do not yet match the current Graphify CLI behavior or the extension README/config promises. The biggest gaps are:

- expanded tools exist, but the `/graphify` slash command still exposes only the older subset;
- `outputDir` is checked for status but not consistently used when invoking the CLI;
- `semanticBackend: "pi"` maps provider names but does not forward Pi credentials into Graphify;
- some runner flags appear unsupported or misleading for the current public Graphify CLI.

## What looks good

### Modular structure

The package is split into focused modules:

```text
src/args.ts
src/auto-context.ts
src/commands.ts
src/config.ts
src/graphify.ts
src/index.ts
src/output.ts
src/runner.ts
src/status.ts
src/tools.ts
```

This is much easier to maintain than a single large extension file.

### Manifest registration

Root `package.json` correctly registers:

```json
"./packages/pi-graphify/src/index.ts"
```

Package `package.json` correctly registers:

```json
"pi": {
  "extensions": ["./src/index.ts"]
}
```

### Safety posture

The implementation keeps the important safety properties:

- uses `execFile` with argv arrays;
- avoids shell-string interpolation of user input;
- does not auto-install Python packages;
- does not auto-build graphs for casual questions;
- graph build, upgrade, and watch operations require explicit user/model action.

### Config support

Config support is well structured:

- global/project `prime-settings.json` loading;
- `pi-graphify` config key;
- default config;
- validation with warnings and fallback;
- `enabled`, `outputDir`, `defaultQueryBudget`, `semanticBackend`, and `autoContext`.

The important caveat is that `outputDir` and `semanticBackend: "pi"` are not fully honored at execution time yet; see issues below.

### Runner design

`src/runner.ts` has good testable argv builders for:

- query;
- update;
- build plan;
- add plan;
- cluster;
- detailed extract;
- callflow export;
- watch;
- upgrade.

This is a good pattern because most behavior can be tested without requiring the real `graphify` binary.

### Tool coverage

The extension exposes a useful tool surface:

```text
graphify_status
graphify_query
graphify_explain
graphify_path
graphify_update
graphify_build
graphify_add
graphify_cluster
graphify_extract
graphify_export_callflow
graphify_upgrade
graphify_watch
```

This is close to the desired native-Pi experience, even though slash-command parity is still missing.

### Auto-context

Auto-context is conservative and bounded:

- no auto-query by default;
- hidden/session guidance only when graph exists;
- tool-result hints are limited and deduped;
- skips Graphify tool results;
- uses `checkCli: false` in hot paths.

### Tests

Current test coverage is meaningful and fast:

```text
__tests__/auto-context.test.ts
__tests__/config.test.ts
__tests__/graphify.test.ts
__tests__/runner.test.ts
__tests__/status.test.ts
```

The package-specific suite passes.

## Important issues to fix

### 1. `/graphify` command does not expose the expanded command surface

The tools were expanded, but the slash command parser and autocomplete still only support:

```text
status
query
explain
path
update
extract
report
open
```

Missing from `/graphify` command support:

```text
build
add
watch
cluster
callflow
upgrade
```

So these likely do not work today:

```text
/graphify build .
/graphify add https://example.com/article
/graphify cluster .
/graphify callflow
/graphify upgrade check
/graphify watch .
```

Files to update:

```text
packages/pi-graphify/src/args.ts
packages/pi-graphify/src/commands.ts
```

Recommended fix:

- Extend `GraphifyCommand`.
- Extend `parseGraphifyCommand()`.
- Extend `getArgumentCompletions()`.
- Add dispatch in `handleCommand()`.
- Add tests for all new command forms.

This is the largest remaining native-UX gap.

### 2. `outputDir` config is only partially honored

`graphStatus()` checks the configured `outputDir`, but CLI invocations still call plain commands like:

```text
graphify query ...
graphify extract ...
graphify update ...
```

The current Graphify CLI defaults to `graphify-out` unless `GRAPHIFY_OUT`, `--graph`, or `--out` is used depending on the subcommand. This means a custom `outputDir` can make status look in one location while Graphify reads/writes another.

Examples of current mismatch risk:

- `graphify_status` may report `custom-out/graph.json` present.
- `graphify_query` may still query `graphify-out/graph.json`.
- `graphify_extract` may write `<path>/graphify-out/` instead of the configured output location.

Recommended fix:

- Decide the contract for `outputDir`.
- If it means Graphify's artifact directory, pass it to the CLI consistently:
  - use `GRAPHIFY_OUT` for subcommands that honor it;
  - use `--graph <configured>/graph.json` for `query`, `path`, `explain`, exports, etc.;
  - use `--out` for `extract` if appropriate, accounting for Graphify's `<out>/graphify-out/` behavior.
- Add tests for argv/env construction with a non-default `outputDir`.

### 3. Missing graph/report/html messages hardcode `graphify-out`

Config supports custom `outputDir`, but several messages still hardcode `graphify-out`:

```text
No graphify-out/graph.json found.
No graphify-out/GRAPH_REPORT.md found...
No graphify-out/graph.html found...
```

Files:

```text
packages/pi-graphify/src/output.ts
packages/pi-graphify/src/commands.ts
packages/pi-graphify/src/tools.ts
```

Recommended fix:

Replace the constant:

```ts
export const MISSING_GRAPH_MESSAGE =
  'No graphify-out/graph.json found. Build it with `/graphify extract .` or `graphify extract .`.';
```

with a function:

```ts
export function missingGraphMessage(outputDir: string): string {
  return `No ${outputDir}/graph.json found. Build it with \`/graphify extract .\` or \`graphify extract .\`.`;
}
```

Then use the configured `config.outputDir` everywhere.

Also update report/html messages to rely on the configured paths returned by `graphStatus()`.

### 4. `semanticBackend: "pi"` does not actually use Pi credentials

The README says `pi` is the default semantic backend and maps the active Pi model/provider to the closest Graphify backend:

```text
google -> gemini
anthropic -> claude
openai -> openai
...
```

The code does perform provider-name mapping, but it does **not** forward Pi API credentials into the Graphify subprocess. The Graphify CLI still expects environment variables such as:

```text
GEMINI_API_KEY / GOOGLE_API_KEY
ANTHROPIC_API_KEY
OPENAI_API_KEY
DEEPSEEK_API_KEY
MOONSHOT_API_KEY
```

So if credentials exist only in Pi's model registry/config, extraction can fail even though `semanticBackend: "pi"` selected the right Graphify backend.

Recommended fix options:

1. **Clarify docs only:** rename/describe this as “Pi-provider backend selection” and explicitly state Graphify still needs its own environment variables.
2. **Implement credential forwarding:** use `ctx.modelRegistry.getApiKeyAndHeaders(ctx.model)` where safe/applicable, map the result to the corresponding Graphify env var, and pass an explicit `env` to `execFile`.

If option 2 is chosen, keep it conservative:

- only forward for known direct API providers;
- never log secrets;
- do not write secrets to disk;
- add tests for env construction without exposing values.

### 5. `graphify_watch` passes unsupported `--debounce` to the public CLI

Current runner builds:

```ts
['watch', path, '--debounce', debounce]
```

The inspected Graphify CLI entrypoint for `graphify watch` accepts only:

```text
graphify watch <path>
```

The `--debounce` option appears in lower-level `python -m graphify.watch`, not in the public `graphify watch` command.

Recommended fix options:

1. Remove debounce support from this wrapper for now:

```ts
export function buildWatchArgs(params: WatchArgsParams = {}): string[] {
  return ['watch', normalizeOptionalPath(params.path)];
}
```

and update README/tool schema.

2. Or implement watch via Python module invocation, but that requires reliable Python interpreter detection, which this package intentionally avoids.

Simplest recommendation: remove `debounce` until the public CLI supports it.

### 6. `graphify_build` passes export flags to `graphify extract`, but current CLI does not implement them there

`graphify_build` accepts flags such as:

```text
svg
graphml
neo4j
```

and `buildBuildPlan()` passes them to:

```text
graphify extract <path> --svg --graphml --neo4j
```

The current Graphify CLI help shows `svg`, `graphml`, and `neo4j` under `graphify export ...`, not under `graphify extract`. The `extract` parser appears to ignore unknown flags rather than producing those artifacts.

Recommended fix:

- Remove these flags from `graphify_build`, or
- Convert `graphify_build` into a multi-step plan:

```text
graphify extract <path> ...
graphify export svg ...        # if requested
graphify export graphml ...    # if requested
graphify export neo4j ...      # if requested
```

Add tests proving the expected command plan.

### 7. `graphify_build` may redundantly run clustering

`buildBuildPlan()` currently runs:

```text
graphify extract <path> --backend ...
graphify cluster-only <path>
```

Current Graphify `extract` already builds, clusters, writes `graph.json`, and writes analysis/report outputs unless `--no-cluster` is passed. Running `cluster-only` afterward is likely redundant and slow.

Recommendation:

- Simplify `graphify_build` to only run `graphify extract <path> ...`, unless there is a specific reason to force a second cluster pass.
- If the extra cluster pass is intentional, document why and add an option name that makes it explicit.

### 8. `/graphify query` command does not parse `--dfs` or `--budget`

The `graphify_query` tool supports `dfs` and `budget`, but slash command parsing does not.

This command probably treats flags as part of the question:

```text
/graphify query What calls extract? --dfs --budget 1500
```

Recommended fix:

Extend parser support to:

```text
/graphify query <question> [--dfs] [--budget N]
```

Then route those options into `buildQueryArgs()` and add parser tests.

### 9. README usage is incomplete/misleading

`README.md` lists the expanded tools, but the usage block only shows the older slash-command surface:

```text
/graphify status
/graphify query What are the main modules?
/graphify explain AuthModule
/graphify path AuthModule Database
/graphify update .
/graphify extract .
/graphify report
/graphify open
```

If the new operations are intentionally tool-only, say so explicitly.

Preferably, implement slash-command support and then update README with the full command surface:

```text
/graphify build [path] [flags]
/graphify add <url> [--author N] [--contributor N]
/graphify cluster [path] [--no-viz]
/graphify callflow [--graph P] [--output P]
/graphify upgrade <check|install|sync-skill>
/graphify watch [path]
```

Also document the current Graphify credential requirement unless credential forwarding is implemented.

### 10. `autoContext.autoQuery` is parsed but unused

Config exposes:

```ts
autoContext.autoQuery
```

but `auto-context.ts` does not implement auto-query behavior.

This is okay if reserved for future use, but README currently says:

```text
It does not auto-query or auto-build graphs by default.
```

That may imply auto-query can be enabled.

Recommendation:

Either:

- document `autoQuery` as reserved/future, or
- implement optional auto-query later with timeout and error swallowing.

### 11. Auto-context session hint could be system-prompt guidance instead of a hidden message

Current `before_agent_start` hook returns:

```ts
return {
  message: {
    customType: 'graphify-auto-context',
    content: buildSessionHintText(...),
    display: false
  }
};
```

Pi supports this, so it is valid. However, this is behavioral instruction and may be cleaner as system-prompt augmentation if the extension API supports that path for this hook.

Current approach is acceptable; consider changing only if it improves reliability.

## Minor suggestions

### Include planning docs in package files only if intentional

`package.json` currently includes:

```json
"files": [
  "src",
  "README.md",
  "LICENSE",
  "IMPLEMENTATION_PLAN.md"
]
```

`ADOPTION_PLAN_FROM_GAODES.md` and `REVIEW_FEEDBACK.md` are not included. That is fine if they are internal planning docs.

If they are intended to ship with the npm package, add them to `files`.

### Add command registration/dispatch tests

The missing command support escaped because tests mostly cover pure helpers and runner builders.

Add tests for:

- `/graphify` autocomplete includes all intended subcommands;
- `parseGraphifyCommand('build . --mode deep')`;
- `parseGraphifyCommand('add https://example.com --author Ada')`;
- `parseGraphifyCommand('upgrade check')`;
- `parseGraphifyCommand('query What calls extract? --dfs --budget 1500')`;
- `handleCommand()` dispatch for new command kinds using mocked runner functions or extracted dispatch builders.

### Add non-default `outputDir` tests

Add tests proving that custom `outputDir` is honored consistently by:

- status detection;
- missing-graph messages;
- query/path/explain graph path selection;
- extract/build output selection, if supported.

### Add status hot-path test

Add a test proving:

```ts
graphStatus(cwd, { checkCli: false })
```

does not call CLI availability probing.

### Add simple renderers later

Tool call/result rendering is functional but plain. Later, add `renderCall()` and `renderResult()` for scanability, using Pi built-ins only. Avoid adding an extra UI dependency unless needed.

## Recommended next patch

Priority order:

1. Implement full `/graphify` slash command support for:
   - `build`
   - `add`
   - `watch`
   - `cluster`
   - `callflow`
   - `upgrade`
2. Make `outputDir` semantically correct for both status and CLI execution.
3. Make missing graph/report/html messages respect `config.outputDir`.
4. Fix/remove `graphify_watch` `--debounce`.
5. Fix `svg`/`graphml`/`neo4j` build behavior.
6. Decide and document/implement what `semanticBackend: "pi"` really means for credentials.
7. Simplify or justify the extra `cluster-only` step in `graphify_build`.
8. Add `/graphify query --dfs --budget` parsing.
9. Update README command examples and credential caveats.
10. Add parser/dispatch/outputDir tests.

## Final verdict

**Ready for local/basic use:** yes, with default `graphify-out` and Graphify credentials available via environment variables.

**Ready to publish or recommend broadly:** not yet.

The implementation is good and passes checks, but the public surface and docs currently promise more than the extension reliably delivers. Fix command-surface parity, `outputDir` semantics, unsupported/misleading runner flags, and the `semanticBackend: "pi"` credential story before calling it release-ready.
