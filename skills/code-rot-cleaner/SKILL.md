---
name: code-rot-cleaner
description: Find code a software project may no longer need, distinguish credible dead-code evidence from framework and dynamic-loading false positives, prove eligible file removals in disposable copies, and create a Markdown cleanup report. Use when asked to find dead code, unused files, orphan modules, unused exports or dependencies, duplicate implementations, stale code, cleanup opportunities, removable LOC, repository bloat, or code rot. Default to report-only mode, never change real project source without explicit candidate-by-candidate approval, and verify approved cleanup with relevant tests and builds.
compatibility: Requires Python 3.11+ (python3). Uses only the Python standard library; approved verification commands require their project-specific tools.
license: MIT
---

# Code Rot Cleaner

Find removable code without confusing “not found by a regex” with “safe to delete.” Keep the real project unchanged during discovery and proof. Treat deletion as a claim that must survive static checks, dynamic-reference checks, and relevant project commands.

> Resolve every `scripts/...` and `references/...` path relative to this skill directory. The scripts are not on `$PATH`.

## Safety boundary

Invoking this skill authorizes inspection and report artifacts only. It never authorizes deletion, edits, renames, uninstalls, formatting, reorganization, or execution of repository-controlled commands.

- Start in `report-only` mode unless the user explicitly requests a later mode.
- During discovery, never alter source, manifests, lockfiles, tests, configuration, generated files, or dependencies.
- Write artifacts to `outputs/code-rot-cleaner/` within the inspected project unless the user selects another location. Those documented paths are valid only for a first run when every named artifact is absent. Every output destination must be a new, non-symlink path: existing destinations are always refused regardless of extension, contents, marker, artifact type, or location. Preserve existing artifacts; scripts never replace them or clean an old run directory. For a rerun, use a new empty directory such as `outputs/code-rot-cleaner-<run-id>/` or fresh unused explicit paths. Fresh custom locations, including outside the project, remain supported. Do not add artifacts to source control unless asked.
- Treat build, test, lint, typecheck, and package-manager commands as repository-controlled code. Before each proof run, display the exact commands, purpose, and disposable-copy scope; stop for approval.
- Perform removal experiments only in fresh disposable copies. Never present a temporary copy as the user’s working tree.
- Before touching the real project, require a second explicit approval that names the exact candidate IDs and files or manifest entries. Approval is limited to that displayed scope.
- Preserve a dirty worktree and unrelated user work. Never reset, clean, stash, rewrite history, or delete untracked files.

Before applying real cleanup, present this checkpoint and stop:

```markdown
## Proposed cleanup

| ID | File or dependency | Evidence | Proof | Risk |
|---|---|---|---|---|
| CRT-... | ... | ... | ... | low/medium/high |

- Exact files or manifest entries to change:
- Expected removable LOC / bytes:
- Commands to run afterward:
- Main residual risk:

The real project has not been changed. Do you approve applying only these candidate IDs?
```

Ask again if affected files, candidate IDs, verification commands, evidence, or residual risk changes.

## Modes

- `report-only` — Default. Inventory and rank leads; generate a report. No project commands or project edits.
- `prove` — After explicit command approval, prove eligible file removals in disposable copies and update the report. The real project remains unchanged.
- `apply-approved` — After approval at the cleanup checkpoint, change only named real files, execute approved checks, and report the final diff.

Never jump from invocation directly to `apply-approved`, including when the user says “clean everything,” “fix it,” or “do it.”

## Workflow

### 1. Map the project

- Inspect the Git state, language and source roots, manifests, entry points, framework conventions, generated directories, tests, and documented project commands.
- Exclude dependencies, build output, caches, vendored code, snapshots, coverage, minified bundles, and generated files unless the user explicitly includes them.
- Read [the detection playbook](references/detection-playbook.md) before reviewing candidates. It lists common dynamic and convention-driven false positives.

### 2. Generate static evidence

Run the scanner without executing project code:

```bash
python3 scripts/analyze-code-rot.py \
  /absolute/path/to/project \
  /absolute/path/to/project/outputs/code-rot-cleaner/analysis.json
```

Treat scanner results as leads, not conclusions. Symlinked files are excluded from static scanning. The default output path is for a first run only; for a rerun, select a fresh directory such as `outputs/code-rot-cleaner-<run-id>/analysis.json`. When existing project-native analyzers are already installed, you may use them as supplementary evidence; do not install an analyzer, a dependency, or a package manager tool without approval.

Manually inspect every leading candidate. Search routes, scripts, configuration, manifests, templates, string references, registries, plugin loading, glob imports, reflection, dependency injection, generated imports, CLI entry points, migrations, tests, deployment files, and public package surfaces. Git age alone is not evidence of dead code.

### 3. Classify conservatively

Use only these user-facing states:

- `SAFE TO REMOVE` — Strong static evidence, no dynamic or convention-based reference, approved relevant commands passed after the exact removal in a disposable copy, and residual risk is low.
- `REVIEW` — Plausibly removable but unproved, dynamically reachable, convention-sensitive, duplicated rather than dead, or covered by incomplete checks.
- `KEEP` — A reference was found, baseline or removal proof failed for a relevant reason, the file is an entry point, or evidence was rejected.

Static inspection alone cannot produce `SAFE TO REMOVE`; a passing build alone cannot either. Unused exports and dependencies stay `REVIEW` unless project-native tooling and focused proof support the precise change.

Record manual rejections and unresolved caveats in `outputs/code-rot-cleaner/review.json`:

```json
{
  "decisions": [
    {
      "candidate_id": "CRT-004",
      "status": "KEEP",
      "reason": "Loaded by the plugin registry in config/plugins.json."
    }
  ]
}
```

Manual review may downgrade a candidate to `KEEP` or leave it at `REVIEW`; it must never promote a candidate to `SAFE TO REMOVE`.

### 4. Request command approval for proof

Show the smallest credible command set, why each command is relevant, expected scope, and that it runs only in temporary copies. Stop for approval. After approval, run:

```bash
python3 scripts/prove-candidates.py \
  /absolute/path/to/project \
  /absolute/path/to/project/outputs/code-rot-cleaner/analysis.json \
  /absolute/path/to/project/outputs/code-rot-cleaner/proof.json \
  --confirm-run-project-code \
  --command "npm test" \
  --command "npm run build"
```

The script proves an untouched baseline first, then tests each eligible candidate in a fresh copy. It refuses proof if any file, directory, or dangling symlink exists in the copied project scope; static report-only analysis remains available. If the baseline fails, do not classify a deletion from that command set. Never weaken or skip checks merely to produce a green proof.

### 5. Generate the report

```bash
python3 scripts/generate-report.py \
  /absolute/path/to/project/outputs/code-rot-cleaner/analysis.json \
  /absolute/path/to/project/outputs/code-rot-cleaner/CODE-ROT-REPORT.md \
  /absolute/path/to/project/outputs/code-rot-cleaner/cleanup-plan.csv \
  --proof /absolute/path/to/project/outputs/code-rot-cleaner/proof.json \
  --review /absolute/path/to/project/outputs/code-rot-cleaner/review.json
```

In `report-only` mode, omit `--proof`. Omit `--review` when there are no manual decisions. For any rerun, pass fresh unused paths for every output, for example under `outputs/code-rot-cleaner-<run-id>/`; the scripts preserve and refuse existing artifacts. The report must lead with identified code by status, distinguish what was and was not proven, show candidate IDs, and keep limitations visible.

Read [the evidence schema](references/evidence-schema.md) only when consuming or extending the JSON artifacts.

### 6. Apply approved cleanup

After approval at the proposed-cleanup checkpoint:

1. Reconfirm candidate IDs and exact real paths.
2. Make one small causal batch, beginning with `SAFE TO REMOVE` candidates.
3. Use targeted edits rather than a blanket cleanup command.
4. Change manifests or lockfiles only when their exact entries received explicit approval.
5. Run the approved focused checks and broadest relevant suite.
6. Inspect the final diff for scope creep, public API changes, lost side effects, and unrelated formatting.
7. If a check fails, restore only edits made for this approved cleanup. Reclassify the candidate as `KEEP` or `REVIEW`; never discard unrelated user work.

## Report honestly

Lead the final response with exactly one outcome:

- `REPORT READY` — Candidates ranked; the real project is unchanged.
- `PROOF COMPLETE` — At least one disposable-copy removal experiment completed; the real project is unchanged.
- `CLEANUP VERIFIED` — Approved real changes applied and relevant checks passed.
- `INCONCLUSIVE` — Evidence or the baseline was insufficient.

Then state removable LOC and bytes by status, the strongest candidate, commands and results, limitations, and the report path. Never claim a project is clean merely because a scan found no candidates.
