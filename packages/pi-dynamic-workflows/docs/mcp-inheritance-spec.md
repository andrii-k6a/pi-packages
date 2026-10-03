# Parent-owned MCP access for workflow subagents

Status: implementation specification; not implemented.

Target: `@andrii-k6a/pi-dynamic-workflows` on Pi 1.0.0. Recheck the SDK contracts below before implementing against a later version.

## 1. Decision

Workflow subagents should inherit access to the parent session's available native MCP tools, using the parent's existing connections and tool-execution pipeline.

**Separate conversations, shared approved capabilities, parent-owned connections.**

Do not instantiate `createMcpExtension()` in every subagent as the default solution. Do not copy raw MCP clients into child sessions. Register child tool adapters that delegate calls through the parent workflow invocation's `ctx.executeTool()`.

This specification describes the target behavior and the SDK feasibility checks needed to implement it. It does not assert that Pi currently exposes every necessary discovery/readiness hook.

## 2. Reference behavior: Claude Code

Anthropic's documentation establishes the following model:

- [Dynamic workflows](https://code.claude.com/docs/en/workflows) orchestrate subagents, and their tool calls remain subject to session permission checks.
- [Subagent tool access](https://code.claude.com/docs/en/sub-agents#available-tools) inherits built-in and MCP tools, subject to restrictions. Background subagents retain MCP tools. `Workflow` is excluded from the subagent tool pool.
- [Subagent-scoped MCP servers](https://code.claude.com/docs/en/sub-agents#scope-mcp-servers-to-a-subagent) distinguish shared named references from new inline definitions: “String references share the parent session’s connection.” Inline definitions connect when the subagent starts and disconnect when it finishes.

Use this as a behavioral reference, not as a claim about undocumented Claude Code internals. This change implements shared parent access only; independently configured subagent servers are deferred.

## 3. Current implementation

Relevant files, relative to this package:

| File | Current responsibility |
| --- | --- |
| `src/dynamic-workflows.ts` | Registers `workflow`; supplies the parent's active-tool callback |
| `src/workflow-tool.ts` | Owns the parent tool invocation, starts `runWorkflow()`, streams progress, returns usage |
| `src/workflow.ts` | Runs the script, limits concurrent agents, tracks budget and pending runs |
| `src/agent.ts` | Creates and disposes a fresh in-memory Pi session for each agent |
| `src/structured-output.ts` | Registers model-only terminating `structured_output` |
| `src/usage.ts` | Aggregates full session history, including compacted messages and summary usage |

Today, children can inherit codemode availability, but they do not inherit the parent's native MCP tools or connections. Native MCP and `tool_search` are not automatically installed by `createAgentSession()`.

Preserve the existing fixes for `session.cwd`/`session.agentDir` overrides and full-history usage accounting. Preserve model/profile routing, standalone library use, and exclusion of nested workflows.

## 4. Scope

### Included

- Default MCP inheritance for subagents launched by the registered `workflow` tool when a live parent tool context is available.
- Parent-owned tool calls over existing native MCP connections, including native MCP resource tools.
- Correct direct, codemode, deferred, hidden, and disabled-tool behavior.
- Metadata, structured results, permissions, cancellation, progress, and usage handling.
- Tools that appear or disappear while a workflow runs.
- Offline integration tests using real Pi sessions and a local mock MCP server.

### Excluded

- New MCP connections, inline server configurations, login flows, or credential management in children.
- Generic inheritance of every parent extension tool.
- Forwarding parent coding tools: children retain their own local tools and effective working directory.
- New workflow-script syntax, arbitrary server configuration in `agent()` options, or a new settings file.
- New per-agent tool-policy language. User/host restrictions can be added separately.
- Automatic isolation of stateful servers, automatic retries of mutating calls, or a new per-server scheduler.
- Workflow persistence/resumption and unrelated rendering changes.

### Default and opt-out

For the registered workflow tool, inherit eligible parent MCP access by default. A trusted host-level `WorkflowToolOptions.inheritMcp?: boolean` may disable it; default it to `true`. This is a library/host option, not an LLM-controlled permission bypass.

Standalone `WorkflowAgent`/`runWorkflow()` use without an explicitly supplied parent bridge remains unchanged: no implicit MCP discovery or new connections.

## 5. Architecture and ownership

```text
Parent Pi session
  native MCP extension -> authenticated server connections
  workflow.execute(..., parentCtx)
    per-invocation MCP bridge
      child A: own conversation, local tools, MCP adapters
      child B: own conversation, local tools, MCP adapters

Child MCP call
  -> child adapter
  -> parentCtx.executeTool(originalName, originalArgs, options)
  -> parent validation / tool_call hooks / permission checks
  -> native MCP tool and existing connection
  -> parent tool_result hooks
  -> child-visible result
```

The parent owns transports, authentication, reconnect policy, MCP configuration, and server shutdown. Children own only their adapters, local discovery state, and individual calls.

Create the bridge inside `workflow.execute()`, not in the extension factory or a process-global singleton. Its authority and lifetime belong to that specific workflow tool call. Concurrent workflows must not share a captured tool context or mix their usage/progress records.

Pass the bridge through host-side run options into `WorkflowAgent`. Do not expose it, `ExtensionAPI`, the parent context, credentials, or raw client objects as workflow VM globals or model-visible tool arguments.

## 6. Pi 1.0.0 API contracts and feasibility gate

Read the installed SDK declarations and the [Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md), [extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md), and [MCP](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md) documentation. The installed 1.0.0 declarations are the version-specific authority; online `main` can change.

Verified contracts:

- `ExtensionToolContext.tools` describes tools callable through that parent context. Do not invoke their `execute` functions directly.
- `ctx.executeTool()` performs nested execution through Pi's validation and hook pipeline. It returns `AgentToolCallOutcome`, with `result` and an authoritative `isError`; ordinary tool failures do not reject the promise.
- `pi.getAllTools()` provides exposure, namespace, annotations, source metadata, parameters, and descriptions. It does not provide `outputSchema`; join metadata with the matching callable `AgentTool` when constructing an adapter.
- `pi.getActiveTools()` alone is insufficient: inactive codemode/deferred tools can still be callable.
- Native codemode and `tool_search` are model-only tools. Do not attempt to invoke the parent's discovery tools through `ctx.executeTool()`.
- Parent nested-tool usage is automatically added to the enclosing workflow tool result by Pi.
- Native MCP starts connections on `session_start`; registering its factory alone does not connect servers. Its shutdown handler closes connections. `session.dispose()` is not a substitute for emitting that shutdown lifecycle in Pi 1.0.0.

Before implementing the complete bridge, prove these integration points with a small executable test:

1. Read current eligible tool descriptors using public APIs, including output schemas and namespace instructions.
2. Execute a child adapter through a real parent workflow call, with parent hooks observing the call exactly once.
3. Refresh a child's registry through supported registration APIs after a parent tool appears or is withdrawn.
4. Establish a bounded, abortable strategy for parent MCP startup/readiness and subsequent discovery.
5. Support local child discovery without invoking model-only parent discovery tools or changing the parent's active tool set.

**Known readiness gap to resolve:** Pi's native MCP extension waits for pending servers in its own parent-side codemode/tool-search hooks. A codemode call executed locally in a child does not automatically trigger those parent hooks. Registered-server changes also must not be assumed to report every connection or tool-list change.

A one-time snapshot of `ctx.tools` is not a complete implementation. If the required readiness/refresh behavior cannot be implemented reliably through public APIs, record the limitation and propose a narrowly scoped upstream SDK capability before claiming full support. Do not silently fall back to duplicate connections, fabricated tool calls, or private MCP runtime fields.

## 7. Eligible tools and permissions

At discovery and again immediately before execution, intersect:

1. Tools recognized as native parent MCP tools/resources.
2. Tools currently callable through the parent context.
3. Any applicable host exclusions, including `session.excludeTools` in the child.

Use source/namespace metadata alongside native naming conventions. A name beginning with `mcp__` is not, by itself, proof that an arbitrary extension tool should be inherited.

Include native resource tools when eligible:

- `list_mcp_resources`
- `list_mcp_resource_templates`
- `read_mcp_resource`

These names do not have an `mcp__` prefix. Preserve the parent's resource-access behavior rather than implementing a second resource client.

| Parent state | Child behavior |
| --- | --- |
| Active, callable `direct` MCP tool | Available as a direct child adapter |
| Callable `codemode` MCP tool | Available through child codemode/discovery; do not declare every tool directly |
| Callable `deferred` MCP tool | Discoverable and activatable in the child; also callable from child codemode when available |
| Hidden tool or disabled server | Not exposed or executable |
| Inactive, non-callable `direct` tool | Not inherited as callable |
| Model-only parent tool | Never forwarded |
| Tool removed after discovery | Hide/remove the adapter and fail stale calls without invoking a cached implementation |

Preserve the parent's relevant declarations where supported, without promoting hidden tools or eagerly declaring all deferred tools. Child discovery can activate adapters locally but must not mutate parent activation state.

Always exclude `workflow` from children, and keep `structured_output` local and model-only. Do not bridge parent `codemode`, `tool_search`, commands, UI tools, or arbitrary local tools.

Every forwarded call must pass through the parent pipeline, including calls made by child codemode scripts. Parent permission denial must remain a denial; do not reconnect independently or retry via another route. MCP annotations are hints, not permission grants.

Do not manually replay parent hooks in the child. Check interactions with extensions already discovered by the child's resource loader so additional child hooks do not accidentally introduce duplicated parent authorization or misleading attribution. Child hooks must not replace or bypass the parent's final checks.

## 8. Discovery and adapter registration

Maintain a per-run bridge and per-child adapter registry. Prefer a small dedicated module such as `src/mcp-bridge.ts`; do not scatter MCP-specific logic through the workflow parser.

Each adapter preserves, where present:

- Original name and parameter schema.
- Description, label, and relevant prompt guidance.
- Output schema.
- Effective exposure, namespace description/instructions, and annotations.

Treat parent metadata as immutable. Do not mutate an existing `AgentTool` or share child-specific capture/activation state between agents. Do not replace concrete schemas with an untyped catch-all schema.

Use child-local native codemode/tool-search facilities over the adapter registry where feasible:

- Preserve current codemode inheritance behavior.
- Inherit active native `tool_search` availability for deferred-tool discovery.
- Do not override caller-supplied discovery replacements or a caller-supplied resource loader silently.
- If an indirect tool has no usable discovery route, report that limitation rather than silently changing its exposure.
- Preserve enough namespace/server guidance that children know which available MCP capabilities they can discover; avoid copying full tool catalogs into every prompt.

Refresh at child startup and supported request/discovery boundaries. Revalidate on every forwarded execution. Add newly available adapters, update changed metadata, and withdraw unavailable ones. Use supported re-registration/hiding behavior when unregistering tools is unavailable.

Readiness waits must be bounded and abortable. Distinguish “currently unavailable or still connecting” from a definitive absence of configured capabilities. A connection becoming ready after startup must be discoverable without restarting the entire workflow.

A name collision with a child-local tool must produce an explicit diagnostic or a documented safe exclusion, not silently replace an unrelated tool or route around parent permissions.

## 9. Execution, results, and progress

An adapter delegates the original name and arguments to `parentCtx.executeTool()` with the appropriate signal and update callback.

Preserve the finalized parent outcome:

- `content`, including images and truncated-output references.
- `details` and `structuredContent`, after parent result hooks have applied redaction/transformation.
- Error state from `outcome.isError`, even when `result.isError` is absent.
- Native MCP output semantics: codemode callers receive the structured MCP result, not a lossy JSON string or just its text blocks.

Do not turn all failures into thrown exceptions: that can discard structured MCP error data. Do not retry mutating tools automatically; the server may already have performed the operation.

Forward partial updates to the child tool callback and retain parent nested-tool events. Attribute any bridge diagnostics to the workflow/agent label. Avoid forwarding raw MCP updates as if they were workflow snapshot objects, and do not log credentials or connection headers.

Child direct calls and child codemode calls must produce equivalent parent-side authorization and server behavior.

## 10. Cancellation and lifecycle

- Combine the parent workflow signal and the child tool-call signal; do not replace parent cancellation with a narrower signal.
- Cancel an individual call without closing the shared MCP connection or aborting sibling agents.
- Propagate workflow cancellation to all child work and outstanding forwarded calls.
- When the workflow script throws or rejects early, cancel/drain pending child runs and bridge calls before the parent tool invocation settles. Inspect `runWorkflow()`'s existing pending-run handling: draining only on the successful script path is insufficient for a captured parent context.
- Dispose child adapters/listeners in `finally` on success, failure, and cancellation.
- Never use a captured parent context after the workflow completes, session replacement, or reload invalidation.
- Do not allow an in-flight startup/discovery operation to register tools into an already disposed child.
- Child cleanup must not call parent session shutdown, MCP disconnect, or credential operations.

Keeping transports open does not mean cancelled remote work is rolled back. Preserve Pi/MCP cancellation semantics and do not promise rollback of side effects.

## 11. Usage and budget accounting

There are two distinct accounting owners:

| Work | Accounting owner |
| --- | --- |
| Child model calls, child-local model tools, and child compaction/summaries | Workflow's existing full-session aggregation |
| Tools delegated through parent `ctx.executeTool()` | Pi's parent nested-tool accounting |

**Do not count delegated usage twice.** If a delegated outcome carries `usage`, blindly returning it to the child records it in child history; the workflow then reports it again while Pi also attaches the parent's nested usage.

Required handling:

1. Track finalized delegated usage separately in the bridge, once per completed call, including failed calls that report usage.
2. Omit parent-owned usage from the child adapter result/update that would otherwise be accumulated into child session history. Preserve the rest of the result unchanged.
3. Continue aggregating child-owned usage from complete session entries, including compacted history and summaries.
4. Return only workflow-owned usage in the workflow tool's explicit `usage` field. Let Pi add delegated usage automatically.
5. Include both categories once in `budget.spent()`/`remaining()`. Do not add partial-update usage repeatedly.
6. If details expose owned, delegated, or combined totals, label them explicitly; do not present an owned-only number as the combined total.

For example, with 100 child-owned tokens and 7 delegated tokens, the workflow reports 100 explicitly, Pi's final parent result totals 107, and the workflow budget spends 107—not 114.

Do not “fix” double counting by removing all tool-result usage from `sumSessionUsage()`: child-local nested model work still belongs there.

The existing limitation that workflow-owned usage is not returned when the entire workflow throws is separate. Preserve/document that behavior unless intentionally addressed as a separate change; do not claim cancellation makes all accounting lossless.

## 12. Shared-state and concurrency policy

The existing agent concurrency limit remains in force. Do not add a second scheduler merely because calls use MCP, but respect any sequencing imposed by Pi's parent tool pipeline.

A shared MCP server can have mutable session state: a browser tab, a selected database, or a workspace. Independent conversations do not isolate those states, and separate connections would not necessarily isolate remote data either.

Document that workflows must serialize conflicting operations or use explicitly distinct resources. Isolated server instances and configurable per-server scheduling are future work. Read-only annotations alone do not prove that concurrent calls are independent.

## 13. Implementation sequence

1. **Prove SDK feasibility.** Add a minimal real-session test for parent delegation, metadata, readiness, and dynamic registration. Resolve any public-API gap before building a larger abstraction.
2. **Implement the bridge.** Add live eligibility checks, immutable descriptors, outcome adaptation, and a per-invocation usage ledger.
3. **Wire child sessions.** Pass the bridge through `workflow-tool.ts`/`workflow.ts`/`agent.ts`; register adapters and child-local discovery without starting MCP clients.
4. **Complete lifecycle handling.** Join cancellation signals and ensure early script failures do not leave children using a settled parent invocation.
5. **Integrate accounting.** Separate delegated usage from full child-session usage while keeping budgets accurate.
6. **Document behavior.** Replace the README's current “built-in MCP and tool_search are not loaded” limitation with the implemented inheritance behavior, opt-out, readiness limitations if any, and state-sharing warning. Update exported host types if changed.

Keep changes focused. Do not revert existing staged work, redesign profile routing, add nested workflows, or introduce unrelated cleanup.

## 14. Regression and integration tests

Use temporary agent/workspace directories, in-memory settings/sessions, a deterministic model driver, and a local mock MCP server. Do not read personal MCP configuration, use real credentials, contact production servers, or make paid model calls. Import test dependencies explicitly rather than relying on accidental transitive packages.

Unit coverage:

- Eligibility matrix for every exposure, active/inactive state, native resource tools, and non-MCP lookalikes.
- Correct metadata/output-schema preservation and no mutation of parent definitions.
- Structured success, structured error, validation error, permission denial, and thrown implementation errors.
- Signal composition, listener cleanup, and no execution after bridge disposal.
- Owned/delegated usage separation, failed-call usage, and no accumulation of progress updates.
- Opt-out and standalone/no-parent behavior.

Real Pi/native-MCP integration coverage:

| Scenario | Required assertion |
| --- | --- |
| Multiple children call a stdio MCP tool | One parent server process/connection; no per-child launches |
| Direct and child-codemode invocation | Both reach the same parent server through parent hooks |
| Deferred discovery | Child search finds and activates its adapter without modifying parent activation |
| Delayed server startup | Capability becomes discoverable through a bounded, abortable readiness path |
| Tool list changes | Added tools appear; removed/hidden tools cannot be called through stale adapters |
| Disabled server or parent restriction | Neither discovery nor execution bypasses the restriction |
| Parent permission hook blocks a call | Server sees zero invocations |
| Parent result hook redacts output | Both child model content and structured script output use the redacted result |
| MCP resources and images | Resource tools and structured/image content survive the bridge |
| One child call is cancelled | Parent connection and unrelated sibling calls remain usable |
| Workflow abort or script exception after launching agents | No child bridge calls continue after parent execution settles |
| Child completes normally | Parent can still call the same server afterward |
| Parent reload/replacement | Old bridge cannot continue using stale context |
| Delegated result reports synthetic usage | Parent total and workflow budget count it once, alongside compacted child history |
| Native MCP absent/disabled | Existing local-tool/codemode workflows still work without creating a connection |

Exercise `ctx.executeTool()` from a real model-issued parent workflow tool call. Calling a descriptor's `execute()` directly with an invented context does not test Pi's nested-call lifecycle or accounting.

Retain tests for model-only `structured_output`, excluded `workflow`, resource-path overrides, profile routing, custom resource loaders, and compacted-history usage.

Run from the repository root:

```bash
npm run test -- packages/pi-dynamic-workflows
npm run check
npm run test
git diff --check
```

## 15. Definition of done

- [ ] Real workflow children can use parent native MCP capabilities through direct calls and available indirect discovery routes.
- [ ] No additional MCP transports/processes are created per child.
- [ ] Hidden/disabled/revoked tools remain inaccessible, including after discovery races.
- [ ] Parent permissions and finalized result transformations remain authoritative.
- [ ] Startup readiness and dynamic tool-list behavior are tested, not just mocked as already available.
- [ ] Child completion/cancellation does not disconnect the parent or leak per-run resources.
- [ ] No calls outlive the parent workflow invocation, including early script failures.
- [ ] Usage and budgets count child-owned and delegated work once each.
- [ ] Standalone/no-MCP workflows and existing regressions remain green.
- [ ] README and public host types describe the behavior actually delivered.
- [ ] Any unresolved SDK blocker is explicit; no silent private-API dependency or duplicate-connection fallback is presented as complete inheritance.
