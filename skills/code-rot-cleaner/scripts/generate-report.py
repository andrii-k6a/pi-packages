#!/usr/bin/env python3
"""Generate a Markdown code-rot report and CSV cleanup plan from evidence files."""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any

from artifact_safety import (
    CLEANUP_PLAN_FIELDS,
    REPORT_MARKER,
    ArtifactSafetyError,
    canonical_path,
    publish_new_artifacts,
    validate_artifact_outputs,
)

VALID_MANUAL_STATUSES = {"KEEP", "REVIEW"}
COMPLETED_REMOVAL_OUTCOMES = {"PASSED_IN_DISPOSABLE_COPY", "FAILED_AFTER_REMOVAL"}


def escape_markdown(value: Any) -> str:
    return str(value).replace("|", "\\|").replace("\n", " ")


def format_bytes(value: int) -> str:
    if value < 1_024:
        return f"{value} B"
    if value < 1_024 * 1_024:
        return f"{value / 1_024:.1f} KB"
    return f"{value / (1_024 * 1_024):.1f} MB"


def read_json_bytes(path: Path, label: str) -> tuple[dict[str, Any], bytes]:
    try:
        raw = path.read_bytes()
        data = json.loads(raw)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError(f"Unable to read {label}: {error}") from error
    if not isinstance(data, dict):
        raise ValueError(f"{label} must contain a JSON object")
    return data, raw


def read_json(path: Path, label: str) -> dict[str, Any]:
    return read_json_bytes(path, label)[0]


def analysis_candidate_map(analysis: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    candidates = analysis.get("candidates")
    if not isinstance(candidates, list) or not all(isinstance(candidate, dict) for candidate in candidates):
        raise ValueError("Analysis candidates must be a list of objects")
    candidates_by_id: dict[str, dict[str, Any]] = {}
    for candidate in candidates:
        candidate_id = candidate.get("id")
        if not isinstance(candidate_id, str) or not candidate_id:
            raise ValueError("Analysis candidates must have non-empty string IDs")
        if candidate_id in candidates_by_id:
            raise ValueError("Analysis candidates must have unique IDs")
        candidates_by_id[candidate_id] = candidate
    return candidates, candidates_by_id


def manual_decisions(review: dict[str, Any], candidate_ids: set[str]) -> dict[str, dict[str, str]]:
    decisions: dict[str, dict[str, str]] = {}
    raw_decisions = review.get("decisions", [])
    if not isinstance(raw_decisions, list):
        raise ValueError("Review decisions must be a list")
    for item in raw_decisions:
        if not isinstance(item, dict):
            raise ValueError("Each review decision must be an object")
        candidate_id = item.get("candidate_id")
        status = item.get("status")
        reason = str(item.get("reason", "")).strip()
        if not isinstance(candidate_id, str) or candidate_id not in candidate_ids:
            raise ValueError(f"Review references unknown candidate ID: {candidate_id}")
        if status not in VALID_MANUAL_STATUSES:
            raise ValueError(f"Review for {candidate_id} must use KEEP or REVIEW")
        if not reason:
            raise ValueError(f"Review for {candidate_id} requires a reason")
        if candidate_id in decisions:
            raise ValueError(f"Review contains duplicate decision for {candidate_id}")
        decisions[candidate_id] = {"status": status, "reason": reason}
    return decisions


def validate_proof(
    proof: dict[str, Any], analysis: dict[str, Any], analysis_path: Path, analysis_bytes: bytes
) -> None:
    if proof.get("artifact_type") != "code-rot-proof" or proof.get("schema_version") != "1.1":
        raise ValueError("Proof must be a code-rot-proof artifact with schema_version 1.1; regenerate it")
    analysis_root = analysis.get("project_root")
    proof_root = proof.get("project_root")
    analysis_file = proof.get("analysis_file")
    if not isinstance(analysis_root, str) or not isinstance(proof_root, str):
        raise ValueError("Analysis and proof project_root values must be strings")
    if not isinstance(analysis_file, str):
        raise ValueError("Proof analysis_file must be a string")
    if canonical_path(Path(proof_root)) != canonical_path(Path(analysis_root)):
        raise ValueError("Proof project root does not match analysis project root")
    if canonical_path(Path(analysis_file)) != analysis_path:
        raise ValueError("Proof analysis_file does not match the selected analysis file")
    if proof.get("analysis_sha256") != hashlib.sha256(analysis_bytes).hexdigest():
        raise ValueError("Proof analysis_sha256 does not match the selected analysis bytes")

    _, candidates_by_id = analysis_candidate_map(analysis)
    baseline = proof.get("baseline")
    if not isinstance(baseline, dict) or not isinstance(baseline.get("passed"), bool):
        raise ValueError("Proof baseline must contain a boolean passed value")
    results = proof.get("results")
    if not isinstance(results, list):
        raise ValueError("Proof results must be a list")
    seen_ids: set[str] = set()
    for result in results:
        if not isinstance(result, dict):
            raise ValueError("Each proof result must be an object")
        candidate_id = result.get("candidate_id")
        if not isinstance(candidate_id, str):
            raise ValueError("Each proof result candidate_id must be a string")
        if candidate_id in seen_ids:
            raise ValueError(f"Proof contains duplicate result for {candidate_id}")
        seen_ids.add(candidate_id)
        candidate = candidates_by_id.get(candidate_id)
        if candidate is None:
            raise ValueError(f"Proof references unknown candidate ID: {candidate_id}")
        if not isinstance(candidate.get("path"), str) or not isinstance(result.get("path"), str):
            raise ValueError(f"Proof result path for {candidate_id} must be a string")
        if result["path"] != candidate["path"]:
            raise ValueError(f"Proof result path does not match analysis candidate {candidate_id}")


def final_status(
    candidate: dict[str, Any], proof: dict[str, Any] | None, decisions: dict[str, dict[str, str]]
) -> tuple[str, str]:
    decision = decisions.get(candidate["id"])
    if decision:
        return decision["status"], decision["reason"]
    if proof is None or not proof.get("baseline", {}).get("passed"):
        return "REVIEW", "Not proven in a disposable copy."
    outcome = next(
        (
            result
            for result in proof.get("results", [])
            if result.get("candidate_id") == candidate["id"]
        ),
        None,
    )
    if outcome is None:
        return "REVIEW", "Not selected or not eligible for disposable-copy proof."
    if outcome.get("outcome") == "FAILED_AFTER_REMOVAL":
        return "KEEP", "An approved verification command failed after removal."
    if (
        outcome.get("outcome") == "PASSED_IN_DISPOSABLE_COPY"
        and candidate.get("proof_eligible")
        and candidate.get("confidence") == "high"
        and candidate.get("risk") == "low"
    ):
        return (
            "SAFE TO REMOVE",
            "Strong static evidence and all approved commands passed after removal in a disposable copy.",
        )
    return "REVIEW", "Proof passed, but static confidence or residual risk is insufficient."


def unique_size(rows: list[dict[str, Any]], excluded_paths: set[str] | None = None) -> tuple[int, int, set[str]]:
    excluded_paths = excluded_paths or set()
    by_path: dict[str, dict[str, Any]] = {}
    for row in rows:
        path = row.get("path")
        if not path or path in excluded_paths:
            continue
        current = by_path.get(path)
        if current is None or row.get("loc", 0) > current.get("loc", 0):
            by_path[path] = row
    return (
        sum(row.get("loc", 0) for row in by_path.values()),
        sum(row.get("bytes", 0) for row in by_path.values()),
        set(by_path),
    )


def completed_removal_count(proof: dict[str, Any] | None) -> int:
    if proof is None:
        return 0
    return sum(result.get("outcome") in COMPLETED_REMOVAL_OUTCOMES for result in proof.get("results", []))


def report_heading(proof: dict[str, Any] | None) -> str:
    if proof is None:
        return "REPORT READY"
    if not proof.get("baseline", {}).get("passed"):
        return "INCONCLUSIVE"
    return "PROOF COMPLETE" if completed_removal_count(proof) else "REPORT READY"


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("analysis", type=Path, help="Analysis JSON")
    parser.add_argument("markdown", type=Path, help="Markdown report output path")
    parser.add_argument("csv", type=Path, help="CSV cleanup-plan output path")
    parser.add_argument("--proof", type=Path, help="Optional disposable-copy proof JSON")
    parser.add_argument("--review", type=Path, help="Optional manual KEEP/REVIEW decisions JSON")
    return parser.parse_args()


def main() -> int:
    args = parse_arguments()
    analysis_path = canonical_path(args.analysis)
    proof_path = canonical_path(args.proof) if args.proof else None
    review_path = canonical_path(args.review) if args.review else None
    try:
        analysis, analysis_bytes = read_json_bytes(analysis_path, "analysis JSON")
        proof = read_json(proof_path, "proof JSON") if proof_path else None
        review = read_json(review_path, "review JSON") if review_path else {"decisions": []}
        candidates, candidates_by_id = analysis_candidate_map(analysis)
        if proof is not None:
            validate_proof(proof, analysis, analysis_path, analysis_bytes)
        decisions = manual_decisions(review, set(candidates_by_id))
        project_root = analysis.get("project_root")
        if not isinstance(project_root, str):
            raise ValueError("Analysis project_root must be a string")
        markdown_path, csv_path = validate_artifact_outputs(
            [args.markdown, args.csv],
            input_paths=[path for path in [analysis_path, proof_path, review_path] if path is not None],
            project_root=project_root,
        )
    except (ArtifactSafetyError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2

    rows = []
    for candidate in candidates:
        status, reason = final_status(candidate, proof, decisions)
        rows.append({**candidate, "final_status": status, "status_reason": reason})

    counts = Counter(row["final_status"] for row in rows)
    safe_rows = [row for row in rows if row["final_status"] == "SAFE TO REMOVE"]
    review_rows = [row for row in rows if row["final_status"] == "REVIEW"]
    keep_rows = [row for row in rows if row["final_status"] == "KEEP"]
    safe_loc, safe_bytes, safe_paths = unique_size(safe_rows)
    review_loc, review_bytes, review_paths = unique_size(review_rows, safe_paths)
    keep_loc, keep_bytes, _ = unique_size(keep_rows, safe_paths | review_paths)

    lines = [
        "# Code Rot Report",
        REPORT_MARKER,
        "",
        f"> **{report_heading(proof)}** — The real project was not changed.",
        "",
        f"Project: `{analysis['project_root']}`  ",
        f"Generated: `{analysis['generated_at']}`",
        "",
        "## Executive summary",
        "",
        "| Result | Candidates | LOC | Size |",
        "|---|---:|---:|---:|",
        f"| SAFE TO REMOVE | {counts['SAFE TO REMOVE']} | {safe_loc:,} | {format_bytes(safe_bytes)} |",
        f"| REVIEW | {counts['REVIEW']} | {review_loc:,} | {format_bytes(review_bytes)} |",
        f"| KEEP | {counts['KEEP']} | {keep_loc:,} | {format_bytes(keep_bytes)} |",
        "",
    ]

    if proof is not None:
        baseline = proof.get("baseline", {})
        removal_count = completed_removal_count(proof)
        lines.extend(
            [
                "## Proof status",
                "",
                f"Baseline in disposable copy: **{'PASSED' if baseline.get('passed') else 'FAILED'}**  ",
                f"Removal experiments evaluated: {removal_count}",
            ]
        )
        if removal_count == 0:
            lines.append("No candidate deletion was evaluated or proven by this proof run.")
        lines.extend(
            [
                "",
                "| Command | Result | Duration |",
                "|---|---|---:|",
            ]
        )
        for command in baseline.get("commands", []):
            result = "PASS" if command.get("passed") else "FAIL"
            lines.append(
                f"| `{escape_markdown(command.get('command', ''))}` | {result} | {command.get('duration_seconds', 0):.3f}s |"
            )
        lines.append("")

    lines.extend(
        [
            "## Ranked candidates",
            "",
            "| ID | Status | Category | Subject | Confidence | Risk | LOC | Proof |",
            "|---|---|---|---|---|---|---:|---|",
        ]
    )
    for row in rows:
        lines.append(
            f"| {row['id']} | **{row['final_status']}** | {escape_markdown(row['category'])} | "
            f"`{escape_markdown(row['subject'])}` | {row['confidence']} | {row['risk']} | "
            f"{row.get('loc', 0)} | {escape_markdown(row['status_reason'])} |"
        )

    lines.extend(["", "## Evidence by candidate", ""])
    for row in rows:
        location = row.get("path") or row["subject"]
        if row.get("line"):
            location = f"{location}:{row['line']}"
        lines.extend(
            [
                f"### {row['id']} — {row['final_status']}",
                "",
                f"- Location: `{location}`",
                f"- Category: `{row['category']}`",
                f"- Potential size: {row.get('loc', 0):,} LOC / {format_bytes(row.get('bytes', 0))}",
                f"- Status reason: {row['status_reason']}",
                f"- Evidence: {' '.join(row.get('evidence', []))}",
                f"- Caveats: {' '.join(row.get('caveats', []))}",
                "",
            ]
        )

    lines.extend(
        [
            "## Cleanup approval checkpoint",
            "",
            "No cleanup has been applied. To continue, approve exact candidate IDs only after reviewing their paths, evidence, proof, and residual risk. Manifest or lockfile changes require separate explicit approval.",
            "",
            "```text",
            "Approved candidate IDs: ____________________",
            "Approved files / manifest entries: __________",
            "Approved verification commands: _____________",
            "```",
            "",
            "## Scope and limitations",
            "",
            f"- Scanned {analysis['scope']['source_files']:,} source files, {analysis['scope']['source_loc']:,} LOC, {format_bytes(analysis['scope']['source_bytes'])}.",
        ]
    )
    lines.extend(f"- {limitation}" for limitation in analysis.get("limitations", []))
    if proof is not None:
        lines.extend(f"- {limitation}" for limitation in proof.get("limitations", []))

    csv_contents = io.StringIO(newline="")
    writer = csv.DictWriter(csv_contents, fieldnames=CLEANUP_PLAN_FIELDS, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(rows)
    try:
        publish_new_artifacts(
            [
                (markdown_path, ("\n".join(lines).rstrip() + "\n").encode("utf-8")),
                (csv_path, csv_contents.getvalue().encode("utf-8")),
            ],
            project_root=Path(project_root),
        )
    except ArtifactSafetyError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2

    print(f"Report: {markdown_path}")
    print(f"Cleanup plan: {csv_path}")
    print(f"SAFE TO REMOVE: {len(safe_rows)}; REVIEW: {len(review_rows)}; KEEP: {len(keep_rows)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
