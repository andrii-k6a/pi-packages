---
name: pi-simple-subagent
description: Delegate a self-contained task to an isolated background Pi sub-agent running fully detached, then pull back only its final result. Use when the user wants to offload work without polluting the current conversation's context. The sub-agent runs invisibly in the background; the parent checks status and pulls the result on demand. This is a minimal, dependency-free approach (a detached headless `pi -p` process); for richer multi-agent orchestration prefer Pi's built-in workflow/agent tooling.
---

# pi-simple-subagent

Run a task in a **separate, isolated Pi sub-agent** as a detached background process.
The sub-agent has a fresh context, so the current conversation stays clean.

> Resolve `spawn-subagent` relative to this skill directory. It is not on `$PATH`.

## When to use

- The user asks to offload or delegate work, run something "in the background", or
  do a long/large task without cluttering the current chat.
- Do **not** use for quick edits the current agent can just do inline.

## Delegate a task

1. Pick a short slug for the task (lowercase, hyphens), e.g. `research-modern-auth-best-practices`.
2. Create a workdir and write the prompt. End the prompt with the result contract,
   naming the exact output path so the sub-agent writes a clean deliverable:

   ```bash
   dir="${XDG_STATE_HOME:-$HOME/.local/state}/pi-simple-subagent/$(date +%s)-<slug>"
   mkdir -p "$dir"
   cat > "$dir/task.md" <<EOF
   <clear, self-contained task description here>

   When finished, write ONLY your final deliverable — no reasoning, no tool logs —
   to this exact path using your file-writing tool:

       $dir/result.md

   Keep it concise and self-contained. That file is the only thing handed back.
   EOF
   ```

   The task must be self-contained: the sub-agent does NOT see this conversation.
   Include all needed context, paths, and the definition of done in `task.md`.
   (Use an unquoted `EOF` above so `$dir` expands to the real path in the contract.)

3. Launch it (runs in the current project directory, detached, invisible):

   ```bash
   <skill-dir>/spawn-subagent "$dir" "$dir/task.md"
   ```

   > Headless (`pi -p`) shows no trust prompt, so project-local `.pi`
   > extensions/skills/tools load only if the project is already trusted (a
   > saved decision in `~/.pi/agent/trust.json`). Built-in tools
   > (read/bash/edit/write) and `AGENTS.md`/`CLAUDE.md` context always load, so
   > most tasks are unaffected. If the task needs project-local pi resources,
   > trust the project once interactively first.

4. Tell the user it's delegated and how to check status. Do not poll aggressively.

## Is it done? (cheap check)

```bash
cat "$dir/exit_status"    # absent = still running, 0 = success, non-zero = failed
```

## Pull the result back (only when the user asks)

```bash
cat "$dir/result.md" 2>/dev/null || tail -n 60 "$dir/transcript.log"
```

`result.md` is the clean deliverable the sub-agent wrote (no reasoning, no tool logs).
If it is missing (sub-agent didn't write it, e.g. it failed), fall back to the tail of
`transcript.log`, the raw headless output. Read it and surface only the relevant final
answer to the user — nothing else from the sub-agent enters this conversation.

## Dig in later

The sub-agent's Pi session is saved under the slug name. From the same project
directory you can resume or inspect it:

```bash
pi --resume    # pick the session named "<timestamp>-<slug>"
```

## Cleanup

- Remove saved workdirs (`task.md`, `result.md`, `transcript.log`, `exit_status`):
  `rm -rf "${XDG_STATE_HOME:-$HOME/.local/state}/pi-simple-subagent/"*`.
- Old Pi sessions are managed by Pi's normal session store; prune them as you would
  any other session.
