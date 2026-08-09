# Evidence schema

The analysis artifact uses `schema_version: "1.0"`; the proof artifact uses `schema_version: "1.1"`.

## Analysis

- `artifact_type`: always `code-rot-analysis` for newly generated analysis artifacts.
- `project_root`: canonical absolute scanned root.
- `generated_at`: UTC timestamp.
- `scope`: source extensions, excluded directories, file count, LOC, and bytes.
- `summary`: candidate counts and potential removable size.
- `candidates[]`:
  - `id`: stable only within this analysis run, such as `CRT-001`.
  - `category`: `orphan-file`, `unused-export`, `unused-dependency`, `duplicate-file`, or `commented-code`.
  - `subject`: repository-relative file, symbol, dependency, or duplicate pair.
  - `path`: primary repository-relative path when applicable.
  - `line`: optional 1-based line.
  - `confidence`: `high`, `medium`, or `low`.
  - `initial_status`: always `REVIEW` from the static scanner.
  - `risk`: `low`, `medium`, or `high`.
  - `proof_eligible`: whether the disposable-copy script can test a complete file removal.
  - `loc` and `bytes`: potential removable size.
  - `evidence[]` and `caveats[]`: human-readable signals and limitations.
- `limitations[]`: scan-wide caveats. In particular, symlinked files are excluded from static scans.

## Proof

- `artifact_type`: `code-rot-proof`.
- `schema_version`: `1.1`.
- `project_root`: canonical absolute root and must canonically equal the selected analysis root.
- `analysis_file`: canonical absolute path of the exact selected analysis file.
- `analysis_sha256`: SHA-256 of the raw bytes read from `analysis_file`. The report accepts proof only when it exactly matches the current analysis bytes.
- `generated_at` and `commands`: identify the experiment.
- `baseline`: command results for the untouched disposable copy and `passed`.
- `results[]`: candidate ID, removed `path`, `outcome`, command results, and duration. Result candidate IDs must be unique, exist in the selected analysis, and each result `path` must exactly equal that analysis candidate’s `path`.
- `outcome` is `PASSED_IN_DISPOSABLE_COPY`, `FAILED_AFTER_REMOVAL`, or `SKIPPED`.
- Command results include command, exit code, duration, timeout status, truncated output, and `passed`.

Proof is refused before copying or executing an approved command when the copied project scope contains a file, directory, or dangling symlink. This prevents disposable-copy commands from following a link to the real project or an external target.

Legacy proof files may be inspected for diagnostics but cannot be used by the report generator to derive candidate status; regenerate proof using schema `1.1`.

## Manual review

An optional review JSON contains `decisions[]` with `candidate_id`, `status`, and `reason`.

```json
{
  "decisions": [
    {
      "candidate_id": "CRT-004",
      "status": "KEEP",
      "reason": "Loaded by the plugin registry."
    }
  ]
}
```

Manual decisions may use only `KEEP` or `REVIEW`; they cannot promote a candidate to `SAFE TO REMOVE`.

## Artifact output safety

Every artifact destination must be a new, non-symlink path. Existing analysis, proof, Markdown report, and CSV cleanup-plan destinations are always refused, regardless of extension, contents, marker, artifact type, or location. The scripts never replace, delete, or clean an existing artifact. Use a new empty run directory or fresh unused explicit paths for every rerun; fresh output locations outside the project remain supported.

All requested output paths are validated before parent directories are created, proof commands run, or any artifact is written. Input/output collisions, duplicate Markdown/CSV paths, and output paths that are parents of one another are rejected. Final publication uses exclusive creation so a path that appears after validation is not overwritten; report artifacts are staged and published together so an invalid or already-existing second destination does not leave a newly created first report. A path lexically under the project that resolves outside it through a symlinked parent is also rejected.

`artifact_type`, the report marker `<!-- code-rot-cleaner: report -->`, and the cleanup-plan column names are evidence and report-format metadata only. They never authorize replacement.

## Final status and heading derivation

The report generator derives `SAFE TO REMOVE` only when a high-confidence, low-risk, proof-eligible file candidate has `PASSED_IN_DISPOSABLE_COPY` and the baseline passed. A proof failure becomes `KEEP`. All other candidates remain `REVIEW`, unless a valid manual decision marks one `KEEP`.

The leading report heading is:

| Condition | Heading |
|---|---|
| No proof | `REPORT READY` |
| Proof baseline failed | `INCONCLUSIVE` |
| Baseline passed with no `PASSED_IN_DISPOSABLE_COPY` or `FAILED_AFTER_REMOVAL` result | `REPORT READY` |
| Baseline passed with at least one completed removal experiment | `PROOF COMPLETE` |

`SKIPPED` does not count as a completed deletion experiment. Reports show the count of removal experiments evaluated and explicitly state when zero candidate deletions were proven.
