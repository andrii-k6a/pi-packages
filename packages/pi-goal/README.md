# @andrii-k6a/pi-goal

A personal Pi extension for one branch-local goal loop with verifier-gated completion.

`pi-goal` lets you set one objective for the current Pi session branch. Pi keeps making bounded follow-up progress while the goal is active. The executor cannot mark the goal complete directly: it can only submit a `pi_goal_claim_done` completion claim, which is reviewed by a separate one-shot Pi verifier process.

## Install

```bash
pi install npm:@andrii-k6a/pi-goal
```

Try locally from this repository:

```bash
pi -e ./packages/pi-goal
```

## Commands

```text
/goal <objective>  Start or replace a goal
/goal              Show status
/goal status       Show status
/goal pause        Pause active/verifying goal work
/goal resume       Resume a paused or blocked goal
/goal clear        Clear the current non-closed goal
```

Exact subcommands only are treated as commands. For example, `/goal pause the flaky migration` starts a goal with that objective.

A non-closed goal is never silently replaced. In TUI/RPC modes, Pi asks for confirmation. In print/json modes, replacement is refused; clear or finish the current goal first.

## Executor tools

The extension registers two model-facing tools:

- `pi_goal_claim_done` — submit a completion claim with summary and evidence. This transitions the goal to `verifying`; it does **not** complete the goal.
- `pi_goal_blocked` — stop the loop with a blocker that needs user input, credentials, approval, or other intervention.

Both tools require the current `goal_id` and `generation`. Stale calls are rejected. Terminal goal tool calls are guarded so they are exclusive within a single assistant tool-call batch.

## Verification flow

1. User starts a goal.
2. The normal in-session Pi assistant works on the goal through bounded follow-ups.
3. The assistant calls `pi_goal_claim_done` with evidence.
4. After the parent session settles, the extension launches a fresh Pi subprocess in JSON mode.
5. The verifier receives only bounded goal/claim context, uses read-only built-in tools by default (`read`, `grep`, `find`, `ls`), and returns one strict JSON report.
6. Only a current verifier `pass` marks the goal complete.

Verifier `fail` returns the goal to `active` with bounded feedback. `uncertain`, invalid JSON, child failure, model mismatch, or schema failure blocks safely instead of completing.

A verifier pass is evidence-backed acceptance, not proof of correctness.

## Budgets and safety limits

Defaults:

- Token budget: `100,000` observed goal-related model tokens.
- Active-time budget: `1 hour` while the extension runtime is alive and the goal is active/verifying.

Budget exhaustion transitions to `budget_limited`. Budget-limited goals cannot be resumed; start a new goal or clear the old one.

The extension does not auto-resume after reload/session restore. Restored active or verifying goals are paused and require `/goal resume`.

## Security posture

Pi is not a sandbox. Extensions and tools run with the permissions of the Pi process. The verifier is separated by context and restricted to read-only Pi tools by default, but this is not OS-level containment.

For untrusted repositories or unattended risky work, run Pi itself inside a container, VM, micro-VM, or other real sandbox.

## Development

From the repository root:

```bash
npm run test -- packages/pi-goal
npm run typecheck
npm run lint
```

Manual smoke test:

```bash
pi -e ./packages/pi-goal
```

## License

MIT
