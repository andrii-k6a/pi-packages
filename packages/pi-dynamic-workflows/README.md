# pi-dynamic-workflows

> Claude-Code-style dynamic workflows for [Pi](https://github.com/earendil-works/pi).

A Pi extension that adds a `workflow` tool. Instead of one assistant doing everything sequentially, the model writes a small JavaScript script that fans out the work across many subagents with separate conversation contexts, then synthesizes the results. Subagents share filesystem access and the run's working directory; they are not OS- or filesystem-isolated.

Great for codebase audits, multi-perspective review, large refactors, and fan-out research.

Runs are **durable**: every workflow runs on [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable). Each subagent is a durable conversation, every `agent()` call is a durable task, and all progress is committed to a per-run SQLite session before it is shown. A crash, `/reload`, quit, or `Esc` no longer throws away finished (and paid-for) subagent work: resume the run and only unfinished work runs again.

Inspired by Anthropic's [dynamic workflows in Claude Code](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code).

## Install

```bash
pi install npm:@andrii-k6a/pi-dynamic-workflows
# or from a local checkout
pi install /path/to/pi-dynamic-workflows
```

Then in Pi:

```text
/reload
```

That's it. The extension registers an active `workflow` tool when it loads. Requires **Pi 1.3.0+** (any 1.x from 1.3.0) and **Node 22.19+**; this package pins the experimental Pi Durable API, and the Chord and MCP packages it ships with, to **1.3.0**. Runs created with Pi Durable 1.2.0 open and resume unchanged.

## Usage

Just ask Pi for a workflow in plain language:

```text
Run a workflow to inspect this repository and summarize the main modules.
```

The model will write a workflow script and call the `workflow` tool. Live progress shows up inline:

```text
◆ Workflow: inspect_project (3/3 done)
  ✓ Scan 1/1
    #1 ✓ repo inventory
  ✓ Analyze 2/2
    #2 ✓ source modules
    #3 ✓ final summary
```

Rows also show duration, tokens, the model/profile in use, and what each running subagent is doing right now (for example `bash: npm test`, `thinking`, or `retrying (attempt 2): 429`). Extensions that call other tools show the nested work, such as `codemode → bash: 3 passed`, rather than just the orchestrator. Unresolved compaction failures appear as warnings, including after the agent finishes. The footer shows the run id, attempt, elapsed time, and spend.

Press `Esc` to cancel a running workflow. Active subagents are aborted bottom-up and surfaced as skipped, **completed results are kept**, and the error names the run id so the model (or you) can resume it.

## Durable runs

Every run has an id such as `20261012-185628-inspect_project-3f9a` and lives in its own Pi Durable session at `~/.pi/agent/pi-dynamic-workflows/runs/<runId>/`:

| File | Purpose |
| --- | --- |
| `run.sqlite` | The authoritative session: run record, attempts, tasks, and every subagent's full transcript, live state, and usage. |
| `run.lock` | Diagnostic owner metadata (pid, host) only; it never decides ownership. |
| `index.json` | Listing cache (never authoritative), kept current as the run commits. If it is missing or damaged the run stays listed (marked as needing recovery) and is rebuilt from `run.sqlite` when you inspect it. |
| `reports.log` | Runtime reports, including fatal session/storage failures, as valid JSON lines capped at 4,000 UTF-8 bytes each (including the newline). Long fields carry `… [truncated]` and the record has `truncated: true`. |

Pi Durable has no cross-process locking, so each run is guarded by an exclusive lease: a SQLite lock in `runs/.locks/<runId>.sqlite`. The operating system releases it when the owning process exits, however it exits, so a crashed run is simply resumable and no lock file is ever deleted or "taken over". Contending processes get exactly one winner. Do not delete `runs/.locks/`.

### Resuming

Call the tool with `resume`:

```json
{ "resume": "20261012-185628-inspect_project-3f9a" }
```

| Run state | `resume` does |
| --- | --- |
| Interrupted by a crash, quit, `/reload`, or session switch | Continues the **same attempt** in place from its durable checkpoints. Finished subagents are not repeated; a subagent that was mid-turn resumes from its last committed model request or tool call. |
| Failed or aborted | Starts a **new attempt** that reuses every completed `agent()` call whose request is identical. The run keeps the model and thinking level it started with: they are part of each call's identity, so switching the session model first would discard every reusable result. To change models, start a new run. |
| Failed because of a script bug | Pass a fixed `script` as well: identical `agent()` calls (same prompt, label, schema, instructions, and route) reuse their results, so you fix a broken synthesis step without paying for 20 agents again. |
| Already completed | Returns the stored result at no cost. |

Interrupted runs are announced when a session starts in the same directory. Spend of an attempt that failed or was aborted is not lost: the attempt that completes the run returns it to the session.

Usage delivery is crash-safe rather than assumed. When a run completes, the unreported spend is committed as a *pending receipt* and the receipt id is included in the tool result's `details.usageReceipt`. The receipt is acknowledged only after Pi has persisted that tool result in the parent session file. The run stays locked until then, so a competing resume cannot offer the same spend twice. If the process dies before the result is persisted, the next resume offers the spend again; if it dies after, the next resume finds the receipt in the parent session's raw history and acknowledges it. If the parent session file is missing or unreadable, resume fails closed instead of guessing. In-memory Pi sessions have no file to check, so their usage is acknowledged immediately. Library callers read `unreportedUsage`/`usageReceipt` from the outcome and call `acknowledgeUsage(receiptId)` only after durably recording both.

A tool call cut off by a crash follows Pi Durable's replay rules: `read` and `structured_output` are idempotent and simply run again, while `bash`, `write`, and `edit` are **not** replayed (they may have partly run), so the model receives an `interrupted` error with the output committed so far and decides what to do next.

### Storage failures and upgrading

Pi Durable 1.2.0 and later treat storage errors (including reads) as fatal to the open session. It cancels active invocations and closes storage; this host then releases providers and the run lease, even when no caller is waiting. The workflow is reported as **interrupted**, not durably failed: its error includes the cause and run id, and its last observed snapshot is retained when storage can no longer be read. Fix the underlying storage problem, then resume to recover from committed state. The failed session is never retried in place.

A storage error can occur after a commit succeeded but before it was acknowledged. Such a run is never deleted as a failed start. Inspect it with `/workflows <runId>`; an initial failure before the run record was actually committed may leave only a recoverable listing entry, not a resumable workflow. A failure while offering usage likewise leaves the completed result and ledger available for reconciliation on resume.

Upgrading to Pi Durable 1.3.0 needs no run migration: its storage layout is unchanged, and runs created with 1.2.0 (completed, interrupted, and aborted) were verified to open, inspect, and resume. Existing workflow documents stay at their current versions. Pi Durable migrates live 1.1 `pi.tool` records on resume; the stored replay policy is preserved. Back up important run directories before upgrading, and do not reopen migrated runs with Pi Durable 1.1. Library extensions must update their tool results from `{ content: [...] }` to `{ output: [...] }`; the parent Pi `workflow` tool still returns `content` because that is a separate API.

### `/workflows`

An interactive inspector (`/workflows <runId>` jumps to one run):

- **List**: status (running, interrupted, completed, failed, aborted), agents done, attempts, age, run id. `Enter` inspects, `r` resumes (asks the model to call the tool), `a` aborts (also works for interrupted runs), `d` twice deletes.
- **Run**: attempts (`[`/`]`), phases, every agent with duration, tokens, cost, profile, model, reuse marks (`↺`), prompt, result preview, error, and the selected agent's unresolved compaction failure.
- **Transcript**: `Enter` on an agent shows its full conversation: prompt, thinking, text, tool calls, and tool results.
  Press `e` to read the whole transcript in your editor. It opens as a temporary Markdown file with one `## n. role` heading per item and untruncated tool results. Edits are discarded.

  The editor is chosen like Pi's `Ctrl+G`: the global `externalEditor` setting, then `$VISUAL`, then `$EDITOR`. The command is split on spaces, so `nvim -R` works but quoted arguments do not. A graphical editor must wait for the file to close, for example `code --wait`.

Non-interactive modes return the same text summary without calling the model:

- **Print** (`pi -p "/workflows"`): summaries go to stdout; errors go to stderr.
- **JSON** (`pi --mode json "/workflows"`): native `message_start`/`message_end` events carry a custom message with `customType: "workflow-runs"`. Its `content` is the summary and `details.isError` identifies errors; single-run queries also include `details.runId`. Stdout remains JSONL.
- **RPC**: summaries and errors use extension UI notifications.

Old runs are kept until you delete them with `/workflows` (or remove the directory). Deleting a run leaves its small guard file in `runs/.locks/` on purpose.

## Workflow script shape

A workflow is plain JavaScript. The first statement must export literal metadata. `name` and `description` are required; `phases` is optional documentation for an expected outline. The live progress view is driven by `phase(...)` calls at runtime:

```js
export const meta = {
  name: 'inspect_project',
  description: 'Inspect a repository and summarize the main modules',
  phases: [
    { title: 'Scan' },
    { title: 'Analyze' },
  ],
}

phase('Scan')
const inventory = await agent('Inspect the repository structure.', {
  label: 'repo inventory',
})

phase('Analyze')
const summary = await agent(
  'Summarize the main modules from this inventory:\n' + inventory,
  { label: 'module summary' },
)

return { inventory, summary }
```

Phases are discovered as the script runs, so conditional and loop-created phases work naturally. If a branch is skipped, its phase does not show up as an empty progress row.

Each `meta.phases` entry can also be a plain string as shorthand for `{ title: '...' }`, e.g. `phases: ['Scan', 'Analyze']`.

### Approved routing profiles

Subagents inherit the active session model and thinking level by default. To allow controlled routing, configure an approved set at `~/.pi/agent/pi-dynamic-workflows/profiles.json`:

```json
{
  "profiles": [
    {
      "name": "fast",
      "description": "Quick repository triage",
      "provider": "openai",
      "model": "configured-model-id",
      "thinkingLevel": "low"
    }
  ]
}
```

See `examples/profiles.json` for a complete configuration example. The file is user-owned and is loaded at extension startup or `/reload`. It is optional; without it, workflows retain normal session inheritance. Configuration is strict: malformed JSON, unknown keys, duplicate or blank fields, and invalid thinking levels stop the extension from loading rather than being ignored.

Manage profiles inside Pi with `/workflow-profiles`. The full-width manager supports `j`/`k` or arrow navigation, `Enter`/`e` to edit, `n` to create, `d` to delete with confirmation, `r` to reload, and `q`/`Esc` to close. Creation and editing use a consistent five-step wizard for name, description, provider, model, and thinking level; use `Shift+Tab` to revisit an earlier step (or left arrow while choosing from a list). It only offers currently available (and, when configured, session-scoped) provider/model/thinking combinations. Choosing the active session provider intentionally omits `provider` from the saved profile. The runtime reloads after each successful change so the `workflow` tool immediately uses the saved profiles.

Workflow authors can select **only profile names**, never raw model IDs:

```js
export const meta = {
  name: 'review_project',
  description: 'Review a project with controlled routing',
  profile: 'fast',
}

phase('Deep review', { profile: 'thorough' })
await agent('Inspect authentication boundaries.', { profile: 'fast' })
```

Selection precedence is agent > current runtime phase > workflow. Calling a later `phase('Name')` without a profile resets routing to the workflow profile (or inherited session settings), rather than preserving the previous phase's choice. Static `meta.phases` remains documentation only.

Each selected profile resolves to its configured `provider` when present; otherwise its model resolves on the active session provider. A selected profile may therefore route a child session to another provider, but the workflow author can select only user-approved profile names—not arbitrary provider/model pairs. Unknown profiles, missing or unavailable configured-provider models, and unsupported thinking levels fail the workflow loudly with no fallback. When no profile is selected, or the profile configuration file is absent, child sessions retain the active session model and thinking level. The retired `model` option on `agent()` and phase metadata is rejected; use an approved named profile instead.

### Editor IntelliSense

Reusable workflow files can opt into editor hints for workflow globals:

```js
/// <reference types="@andrii-k6a/pi-dynamic-workflows/workflow" />
```

This declares `agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `cwd`, and `budget` for TypeScript-aware editors (`console` already comes from your editor's DOM or Node typings). Prose `agent()` results are `string | null`; schema results are `unknown` unless you supply a generic, such as `agent<Finding>(prompt, { schema })`, which returns `Finding | null`. A result generic requires a schema that is guaranteed to be present; options with an optional schema return `unknown`. `parallel()` and `pipeline()` also include `null` for failed branches. Declaration-consumer tests run in the test suite, independently of the extension's TypeScript configuration.

### Available globals

| Global | Description |
| --- | --- |
| `agent(prompt, opts)` | Spawn a subagent with separate conversation context, shared filesystem access. Returns final text or, with `opts.schema`, a validated JSON value; ordinary executor failures return `null`. |
| `parallel(thunks)` | Run an array of `() => agent(...)` thunks concurrently. Results are returned in input order. |
| `pipeline(items, ...stages)` | Run each item through sequential stages while items fan out. Each stage receives `(prev, original, index)`. |
| `phase(title, { profile })` | Mark the current phase and optionally select an approved profile. Used for grouping in the live progress view. |
| `log(...values)`, `console.log/info/debug/warn/error` | Append a workflow-level log line. Every argument is recorded, space-separated; strings stay as they are and other values are inspected (`{ a: 1 }`, not `[object Object]`). A line is capped at 2,000 characters. `warn` and `error` lines are prefixed `[warn]`/`[error]`. |
| `args` | Optional JSON object passed in via the tool's `args` parameter. |
| `cwd`, `process.cwd()` | Current working directory for subagents. |
| `budget` | `{ total, spent(), remaining() }` tracker. `spent()` counts tokens reported by subagents (estimating successful runs only when no usage is reported). `total` is `null` and `remaining()` is `Infinity` unless the `workflow` call sets `tokenBudget` (library: `tokenBudget` on `start`/`resume`). The limit is soft: it is checked when `agent()` is called and counts only agents that have finished, so agents started together can overshoot it. Once it is spent, `agent()` rejects with `workflow token budget exhausted`. A resumed run keeps its budget unless you pass a new `tokenBudget`; a different one replaces a live attempt. |

### Failure and isolation contracts

Ordinary subagent failures return `null` and log the failure. `parallel()` and `pipeline()` also turn ordinary thrown branch/stage errors into `null`. Check for partial failures before synthesis. Cancellation and approved-profile routing failures reject instead of becoming `null`; invalid runtime options also reject before an executor is invoked. A subagent whose final message has no text answers with a failure (`null`), never with an empty string.

**Limits.** `agent()` rejects once a script has made more than **500** calls in one attempt (reused results count), as a guard against runaway loops. The cap is stored with each attempt, so a replay never depends on later configuration. Raise or remove it for the Pi extension with the environment variable `PI_WORKFLOW_MAX_AGENTS` (a positive integer, or `unlimited`; a malformed value stops the extension from loading), or with `maxAgents` on `WorkflowHost`. Spend limits are separate: see `budget` above.

`agent(prompt, { isolation: 'worktree' })` is a **non-enforced prompt hint**, retained for compatibility. It adds `Requested isolation: worktree` to the instructions; it does not create a Git worktree, change the subagent's directory, or restrict filesystem access. Other isolation values are rejected. Separate conversation context is not filesystem isolation.

### Replay determinism requirement

Workflow scripts are evaluated in a Node `vm` context. **Node `vm` is not a security boundary. Run only trusted scripts.** Host callbacks remain accessible; these restrictions are correctness guardrails, not protection against malicious JavaScript.

- The context uses its own built-ins, rather than injecting mutable host-owned `Math`, `JSON`, `Array`, etc.
- Runtime guards reject `Date.now()`, constructing/calling `Date`, and `Math.random()`, including ordinary aliases and computed accesses. `Date.parse()` and `Date.UTC()` remain available; `Math.random` cannot be replaced.
- String and WebAssembly code generation are disabled (`eval`, `Function`, and their realm-local constructor equivalents cannot compile code). `Atomics` and `SharedArrayBuffer` are not provided, so a script cannot block Pi's event loop with `Atomics.wait`.
- Scripts run on Pi's event loop, so a script that never yields freezes Pi and `Esc` cannot interrupt it. Two guards reduce the risk, neither is complete: loops with a constant-true test (`while (true)`, `for (;;)`, `do … while (1)`) that contain no `await`, `break`, `return`, or `throw` are rejected when the script is parsed, and the first synchronous stretch of a script (before its first `await`) is interrupted after 10 seconds. Node cannot interrupt later synchronous stretches, so a loop such as `while (x) {}` that never ends after an `await` still hangs Pi. Always `await` inside long loops.
- `require`, module loading, filesystem, and network APIs are not provided as workflow globals. Subagents do have coding tools and may perform side effects.
- Literal `meta` rejects spreads, computed keys, template interpolation, and function calls. AST checks diagnose common direct clock/random calls early; they **do not prove determinism**.

Determinism is the author's replay requirement, not a parser guarantee: a resumed attempt **re-runs the script from the top** and answers each `agent()` call from its durable record. The script must produce the same calls given the same recorded results.

Replay caveats:

- Each `agent()` call is identified by a hash of its prompt, label (as written, not the generated default), instructions (phase, `agentType`, `isolation`), `schema`, and resolved model route, plus an occurrence counter for identical calls. Changing any of these re-runs that agent.
- Avoid control flow that depends on *which* concurrent agent finishes first (for example `Promise.race` over agents): a replay resolves finished agents instantly, so the race may go differently.
- Use the script for orchestration, not external side effects. `log()`/`phase()` are rebuilt on replay. Do not depend on mutable host inputs or mutate objects returned by the executor.
- Terminal renderers sanitize model-written names, phases, activity, logs, previews, and transcripts without rewriting stored records. Single-line fields collapse whitespace; transcripts retain line breaks. Terminal sanitization does not redact credentials.

### Structured subagent output

Pass a JSON Schema via `opts.schema` and the subagent will return a validated object:

```js
const finding = await agent('Find security-sensitive files.', {
  label: 'security scan',
  schema: {
    type: 'object',
    properties: {
      paths: { type: 'array', items: { type: 'string' } },
      reason: { type: 'string' },
    },
    required: ['paths', 'reason'],
  },
})
```

The schema's root must be `type: "object"`, because it becomes the parameters of a tool and model providers accept only object parameters; any other root is rejected before a subagent starts. Wrap lists in a property, for example `{ type: 'object', properties: { items: { type: 'array', items: { type: 'string' } } }, required: ['items'] }`.

Under the hood each distinct schema gets a `structured_output` tool whose parameters *are* that schema, so Pi Durable validates the arguments and sends validation errors back to the model for correction. The value is committed to the subagent's conversation and the tool terminates the run without an extra turn. A subagent that answers in prose instead is asked (up to twice) to call `structured_output`.

## Tools and extensions for subagents

By default a subagent has Pi Durable's coding tools (`read`, `write`, `edit`, `bash`) and, when you ask for a schema, `structured_output`. Subagents run unattended, so nothing else is shared with them unless you approve it. There are two ways to add tools.

### MCP servers

Subagents can use tools from MCP servers you already configured for Pi, **only for servers you approve for workflows**.

1. Configure the server for Pi as usual (`pi mcp add …`, or `~/.pi/agent/mcp.json`; in trusted projects also `.pi/mcp.json`). That file says *how to reach* a server and is only read. Project trust applies to the run's own working directory: resuming a run from a different project never lends it that project's trust, nor does a trusted session extend trust to another directory.
2. Approve it for workflows in `~/.pi/agent/pi-dynamic-workflows/mcp.json` (see `examples/mcp.json`):

```json
{
  "servers": {
    "github": { "tools": ["search_*", "get_*"] },
    "docs": {}
  }
}
```

`tools` lists exact names or `*` patterns; leave it out to approve every tool of the server. The file is strict like `profiles.json`: unknown keys or malformed entries stop the extension from loading. It is loaded at startup or `/reload`.

How it behaves:

- Each approved tool becomes a Pi Durable tool named `mcp__<server>__<tool>` (the same names Pi uses), declared to the subagent like a built-in tool. Names are assigned from the server's complete tool list before your allowlist is applied, and every tool whose sanitized name collides (for example `get-item` and `get_item`) gets a hash suffix, so a tool keeps the same name when the server reorders its list or when a sibling is hidden or unapproved. Tools Pi hides stay hidden even if approved (`toolExposure: { "delete_*": "hidden" }`, or a `hidden` server apart from the tools its `toolExposure` lists), and `enabled: false` servers are skipped.
- The workflow process owns the connection. Runs in the same Pi process and working directory share one connection per server, which is released when the last run closes; after a crash, quit, or `/reload`, resuming a run reconnects. `${ENV}` and `!command` values in `env`/`headers` resolve as in Pi; commands run without blocking Pi and are stopped after 10 seconds. A server that failed to connect is tried again by the next run that opens it, even while another run still holds the failed connection. Connection/protocol exceptions and server stderr are not copied into provider notes or persisted tool-failure diagnostics; only locally authored failure messages are used. Inspect `/mcp` in Pi for raw diagnostics. Tool descriptions, results, and progress remain server-provided data and may contain sensitive content.
- MCP calls are **not** replayed after a crash (a call that was cut off may already have changed the server), so the subagent receives an `interrupted` result and decides what to do.
- What is available is stated in the run's log (`mcp github: 3 of 12 tool(s) available`, `mcp docs: unavailable (connecting … timed out)`). An unreachable server never fails the workflow. If a resumed run's agents expect an extension this process did not install, the log says so. Agents retain every pinned extension name even when created during that outage, so restoring the extension on a later resume restores its tools. An already-prepared model request keeps its original tool set; the next request uses the restored tools.

Not supported yet: servers that need OAuth sign-in or a `/login` provider token (skipped with a note; give the server an `Authorization` header instead), MCP resources, tool-list change notifications (the list is read when a run opens), and Pi's `codemode`/`deferred` exposure (every approved tool is declared directly, so approve small sets).

### Pi Durable extensions

Library users can give every subagent their own [Pi Durable extensions](https://www.npmjs.com/package/@earendil-works/pi-durable): tools, prompt sections, hooks (for example a permission check with `hook(ToolTask, { beforeTool })`), and wrappers.

```ts
import { WorkflowHost, createMcpProvider } from '@andrii-k6a/pi-dynamic-workflows';
import type { WorkflowExtensionProvider } from '@andrii-k6a/pi-dynamic-workflows';

const host = new WorkflowHost({
  extensions: [myExtension],           // static
  providers: [createMcpProvider(...)]  // opened per run, released on close
});
```

Static and provider-supplied extensions share one admission policy: names must not be blank, replace built-ins, or start with `workflow.`. The package-owned MCP bridge has an explicit internal allowance; naming a custom provider `mcp` does not grant it that allowance. Invalid static configuration throws; invalid provider extensions are skipped with a note, so the run can still use its core tools. When providers supply duplicate names, the first extension in declaration order wins (after static extensions), regardless of connection timing.

A run stores only extension *names*; the host installs the code again whenever it opens the run, so a restarted process needs the same configuration. Providers must return curated availability notes, without credentials or raw server diagnostics; notes are persisted, and terminal formatting is not secret redaction. An uncaught provider-opening exception produces a generic unavailable note, not a copy of its message.

Pi Durable **1.2.0** and later also ship durable codemode and deferred tool search. Library hosts can explicitly install them as curated extensions:

```ts
import { CodemodeSandbox } from '@earendil-works/pi-codemode';
import { createCodemodeExtension } from '@earendil-works/pi-durable/codemode';
import { createToolSearchExtension } from '@earendil-works/pi-durable/tool-search';

const sandbox = new CodemodeSandbox({ memoryLimitBytes: 256 * 1024 * 1024 });
const host = new WorkflowHost({
  extensions: [
    createCodemodeExtension({ sandbox, models: false }),
    createToolSearchExtension()
  ]
});
// Drive runs with host.start()/resume(), then on shutdown:
await host.closeAll();
await sandbox.close();
```

Declare `@earendil-works/pi-codemode` in the embedding project's dependencies. The embedding application owns the sandbox and must keep it alive until its runs close. `models: false` disables codemode's additional classifier/image-model access; it does not change the approved routes of workflow subagents. Tools supplied by curated extensions can declare `deferred: true` for discovery by `tool_search`. Nested tools follow their own replay policies and report usage to the ledger themselves—do not add their usage again to the calling tool's result. `structured_output` is model-only because nested tool calls cannot terminate the subagent's turn.

The Pi extension does **not** enable these capabilities automatically or inherit the parent's codemode settings. The MCP bridge still declares approved tools directly; configuring Pi's `codemode` or `deferred` MCP exposure does not yet change that.

### What does not carry over

Pi (coding-agent) extensions are not loaded into subagents: Pi Durable has its own extension model and no loader for them. Port the parts a subagent needs: a tool becomes `defineTool` (returning `output`, not `content`), prompt text a `section()`, `tool_call`/`tool_result` handlers `hook(ToolTask, …)`, state a `defineDoc`. Commands and UI have no equivalent because subagents are headless; model access comes from the parent's `ModelRuntime`. Durable codemode and tool search are available through explicit library configuration as shown above, not through Pi's extension loader.

**Parent safeguards do not apply to subagents.** Subagents run unattended with Pi Durable's `bash`, `write`, and `edit`. A permission gate, protected-path rule, or any other `tool_call` handler in a Pi extension sees the parent's `workflow` call, but not the commands and edits its subagents perform. Treat approving a workflow as approving everything its subagents may do in the working directory. Pi's own tool restrictions still apply to the `workflow` tool itself: `--no-tools`, `--tools`, and `--exclude-tools workflow` keep it off. Library hosts can enforce a policy on subagent tools with `hook(ToolTask, { beforeTool })` in a Pi Durable extension.

## How it works

```text
user prompt
  → Pi model writes a workflow script
  → workflow tool creates a run (its own Pi Durable session) and an attempt task
  → the attempt task replays the script in a vm sandbox
  → each agent() becomes a durable child task that owns a subagent conversation
  → the subagent runs durable generation and tool tasks (read, write, edit, bash)
  → every step is committed before it is shown; progress streams from committed state
  → final structured result returned to the parent assistant
```

- **Run → attempt → agent.** A run holds one or more attempts (`workflow.run` tasks). Each `agent()` call is a `workflow.agent` task owned by its attempt; the task owns the subagent's conversation. Aborting an attempt aborts the agents, which abort their conversations (Pi Durable's bottom-up abort protocol), so nothing keeps running or spending.
- **Effect sandwich.** An agent first commits its intent (the conversation and a checkpoint), then performs the work, then commits the outcome with usage. Prompts are submitted with idempotent request ids, so a restart reattaches to the same submission instead of asking twice.
- **Model access.** Subagents use Pi's own `ModelRuntime` (Pi Durable accepts it as pi-ai `Models`), so they share the session's providers, auth, and request transforms. A subagent runs on the session model and thinking level unless a profile routes it elsewhere; the route is recorded per agent.
- **Prompts.** Subagents get a Pi-style system prompt (rules, `AGENTS.md`/project context, skills, working directory) captured once when the run is created, so a resumed run keeps the same prompt and warm provider caches. Provider failures retry durably (3 retries with backoff) and long contexts compact automatically.
- **Tools.** Subagents use Pi Durable's `read`, `write`, `edit`, and `bash` (an interrupted `read` simply runs again), plus `structured_output` when a schema is requested, plus any [approved MCP tools and extensions](#tools-and-extensions-for-subagents). The `workflow` tool is not available to them, so they cannot start nested workflows.
- **Usage.** Subagent token usage and cost are summed from each conversation's durable usage ledger (failed and aborted attempts included) and returned to the parent session when the run completes, with a receipt that makes delivery crash-safe (see [Resuming](#resuming)). `budget.spent()` counts reported tokens, falling back to an estimate for successful agents that report none; reused results count toward `budget.spent()` in the script, but not toward the new attempt's reported spend.

### Differences from the previous in-memory backend

Subagents are no longer `createAgentSession()` sessions, so they do **not** load your Pi extensions, inherit `codemode`, or share your session's MCP connections, and they use Pi Durable's coding tools rather than Pi's. Project context (`AGENTS.md`) and skills are still provided, and MCP servers and Pi Durable extensions can be added explicitly (see above).

Pi Durable is experimental. This package pins `@earendil-works/pi-durable` to an exact version and keeps all of its use under `src/durable/`; it requires Node with `node:sqlite` (22.19+; Pi's managed runtime provides it).

## Embedding API

The package root is the supported ESM library entry point (built JavaScript and declarations):

```ts
import { WorkflowHost, createMcpProvider, runWorkflow } from '@andrii-k6a/pi-dynamic-workflows';
import type { WorkflowRunBinding, WorkflowExtensionProvider } from '@andrii-k6a/pi-dynamic-workflows';
```

`WorkflowHost.start(options, binding)` and `resume(runId, options, binding)` accept `tokenBudget` next to `script`, `args`, and `concurrency`; the host option `maxAgents` (default `DEFAULT_MAX_AGENTS`, 500) caps `agent()` calls per attempt. Both return a handle with `wait()`, `watch()`, `abort()`, `acknowledgeUsage()`, and `close()`. A binding supplies pi-ai `Models`, the default `route`, approved-profile resolution, and captured prompt context. Always close handles (or `host.closeAll()` on shutdown); closing releases resources without aborting durable work. If `wait()` returns a usage receipt, durably record it with the usage before acknowledging it. See [Resuming](#resuming) for crash-safe delivery.

`runWorkflow()` is the lower-level interpreter with an injected executor; it does not create durable storage on its own. The separate `./workflow` entry supplies only ambient editor globals. Deep `src/`/`dist/` imports are internal and not exported. In a local checkout, run `npm run build --workspace @andrii-k6a/pi-dynamic-workflows` before importing the library; `npm pack` builds it automatically. Loading the Pi extension itself still uses its TypeScript source entry, with no build required.

## Package structure

The package is organized by responsibility, with only its two entrypoints at the source root:

```text
pi-dynamic-workflows/
├── src/
│   ├── dynamic-workflows.ts  # Pi registration and extension lifecycle only
│   ├── library.ts            # Supported package-root embedding API
│   ├── workflow/             # Contracts, parser, VM, execution, and plain snapshots
│   ├── profiles/             # Profile contracts, file configuration, and routing
│   ├── durable/              # Run lifecycle, persistence, ownership, billing, reports
│   │   ├── tasks/            # Task contracts, factory, run/agent machines, outcomes
│   │   └── mcp/              # MCP configuration and connection/tool provider
│   ├── pi/                   # Pi tool, inspector, and terminal display adapters
│   │   └── profiles/         # Profile manager, list, wizard, and route choices
│   └── shared/               # Terminal text, JSON conversion, and usage arithmetic
├── __tests__/                # Mirrors workflow/, profiles/, durable/, pi/, shared/
│   ├── fixtures/             # Server/process fixtures and declaration consumers
│   ├── architecture.test.ts  # Dependency boundaries and cycle checks
│   └── library-consumer.test.ts
├── types/workflow.d.ts       # Workflow-author editor globals, separate from library types
├── examples/                 # Sample profile and MCP configurations
├── dist/                     # Generated JS/declarations; mirrors src/, never hand-edited
├── tsconfig.build.json
├── package.json
├── README.md
└── LICENSE
```

Internal module responsibilities (these are not public import paths):

| Area | Main modules and responsibilities |
| --- | --- |
| `src/workflow/` | `contracts.ts` holds metadata/executor/status contracts; `parser.ts` and `validation.ts` validate scripts; `sandbox.ts` constructs the VM; `runtime.ts` orchestrates injected executors; `snapshot.ts` holds renderer-independent projections and preview helpers. |
| `src/profiles/` | `contracts.ts` defines profiles and routing errors; `config.ts` validates and atomically saves user-owned files; `routing.ts` resolves approved routes without loading configuration or UI. |
| `src/durable/` | `host.ts` drives runs; `docs.ts` owns durable records; `store.ts` owns directories and leases; `open-run.ts` owns open resources; `billing.ts`/`usage-delivery.ts` reconcile receipts; `report.ts` maps records to snapshots/transcripts; `providers.ts`/`extension-admission.ts` define and validate host extensions; `subagent.ts` supplies prompt/output extensions. |
| `src/durable/tasks/` | `factory.ts` wires `run.ts` and `agent.ts` to a per-run schema cache. `contracts.ts` owns replay inputs/checkpoints/services; `outcome.ts` formats authoritative task outcomes. |
| `src/durable/mcp/` | `config.ts` reads allowlists and Pi's MCP settings; `provider.ts` owns shared connections and approved durable tools. |
| `src/pi/` | `workflow-tool.ts` adapts Pi calls to the host; `runs-command.ts` implements `/workflows`; `display.ts` renders plain snapshots and forwards a progress update only when its picture changed; `limits.ts` reads `PI_WORKFLOW_MAX_AGENTS`. |
| `src/pi/profiles/` | `manager.ts` orchestrates `/workflow-profiles`; `list.ts` and `wizard.ts` own interaction state; `choices.ts` filters models and thinking levels for the current Pi session. |
| `src/shared/` | Neutral `terminal-text.ts`, `json-values.ts`, and `usage.ts` helpers, without dependencies on workflow, durable, or UI modules. |

### Dependency rules

- `pi/` may depend on durable, workflow, profiles, and shared modules. **Neither durable nor workflow code imports Pi adapters.** Plain snapshot types and preview helpers therefore live in `workflow/snapshot.ts`, not in the renderer.
- `durable/` owns all imports of Pi Durable APIs. It can depend on workflow/profile contracts and shared helpers, but not on commands, wizards, or renderers.
- `workflow/` depends on its own modules, shared helpers, and **injected profile contracts only**—not profile file loading or Pi session APIs. Parsing does not import VM setup; both use common validation diagnostics.
- `profiles/` depends only on profile modules and shared helpers. Configuration I/O is separate from route resolution and the Pi profile manager.
- `shared/` is a leaf layer: do not put feature orchestration or configuration ownership there.
- Internal modules import concrete module paths, not `library.ts` or the extension entrypoint. Only `library.ts` is a public facade; avoid internal barrel files and circular imports.

`__tests__/architecture.test.ts` checks these boundaries, including type-only imports and re-exports, and rejects module cycles. The Pi entrypoint and the published `.`/`./workflow` import paths stay stable when internal files move. Builds clean `dist/` first so renamed/deleted source modules cannot leave stale files in the published package.

## Development

From the repository root:

```bash
npm install
npm run test
npm run check
```

To try the local extension:

```bash
cd packages/pi-dynamic-workflows && pi -e .
```

Vitest tests live in `packages/pi-dynamic-workflows/__tests__/`, grouped to mirror the source layers. Shared process/server fixtures and declaration consumers live in `__tests__/fixtures/`. The suite includes architecture boundary/cycle checks, isolated declaration-consumer compilation, and a plain Node ESM import smoke test of the cleanly built library.

## Status

The core workflow primitive (script, subagents, parallel/pipeline, phases, abort, structured output) is durable and resumable on Pi Durable 1.3.0, with a `/workflows` inspector. Durable codemode and tool search are opt-in for library hosts. Not implemented yet: automatic codemode inheritance and MCP deferred-exposure mapping, OAuth for MCP servers, loading Pi extensions into subagents (not a Pi Durable feature), automatic pruning of old runs, and background (detached) runs that outlive the Pi process.

## License

MIT
