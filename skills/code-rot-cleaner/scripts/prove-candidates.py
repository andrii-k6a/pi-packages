#!/usr/bin/env python3
"""Run approved checks for eligible file removals in disposable project copies."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from artifact_safety import (
    ArtifactSafetyError,
    canonical_path,
    publish_new_artifacts,
    validate_artifact_outputs,
)

COPY_EXCLUDES = {
    ".git",
    ".hg",
    ".mypy_cache",
    ".next",
    ".nuxt",
    ".pytest_cache",
    ".ruff_cache",
    ".svn",
    ".svelte-kit",
    ".venv",
    "__pycache__",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "out",
    "outputs",
    "target",
    "vendor",
    "venv",
}


def timestamp() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def copy_excludes(include_dependencies: bool) -> set[str]:
    excludes = {".git", ".hg", ".svn", "outputs", "__pycache__", ".pytest_cache"}
    if not include_dependencies:
        excludes.update(COPY_EXCLUDES)
    return excludes


def copy_ignore(include_dependencies: bool):
    return shutil.ignore_patterns(*sorted(copy_excludes(include_dependencies)))


def scoped_symlinks(source: Path, include_dependencies: bool) -> list[Path]:
    """Find all links that copy_project would include, without following any link."""
    ignored = copy_ignore(include_dependencies)
    links: list[Path] = []
    for directory, directory_names, file_names in os.walk(source, followlinks=False):
        names = sorted(directory_names + file_names)
        ignored_names = set(ignored(directory, names))
        directory_names[:] = [name for name in sorted(directory_names) if name not in ignored_names]
        for name in names:
            if name in ignored_names:
                continue
            path = Path(directory) / name
            if path.is_symlink():
                links.append(path)
    return links


def assert_no_symlinks(root: Path) -> None:
    """Defence in depth: a disposable destination must contain no symlink."""
    for directory, directory_names, file_names in os.walk(root, followlinks=False):
        for name in directory_names + file_names:
            path = Path(directory) / name
            if path.is_symlink():
                raise ValueError(f"Disposable copy contains a symlink: {path}")


def copy_project(source: Path, destination: Path, include_dependencies: bool) -> None:
    shutil.copytree(source, destination, ignore=copy_ignore(include_dependencies), symlinks=False)
    assert_no_symlinks(destination)


def run_command(command: str, working_directory: Path, timeout: int) -> dict[str, Any]:
    started = time.monotonic()
    try:
        result = subprocess.run(
            command,
            cwd=working_directory,
            shell=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=timeout,
            env={**os.environ, "PI_CODE_ROT_DISPOSABLE_COPY": "1"},
        )
    except subprocess.TimeoutExpired as error:
        output = error.stdout or ""
        if isinstance(output, bytes):
            output = output.decode(errors="replace")
        return {
            "command": command,
            "exit_code": None,
            "duration_seconds": round(time.monotonic() - started, 3),
            "timed_out": True,
            "output": str(output)[-5_000:],
            "passed": False,
        }

    output = result.stdout or ""
    return {
        "command": command,
        "exit_code": result.returncode,
        "duration_seconds": round(time.monotonic() - started, 3),
        "timed_out": False,
        "output": output[-5_000:],
        "passed": result.returncode == 0,
    }


def run_all(commands: list[str], working_directory: Path, timeout: int) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for command in commands:
        result = run_command(command, working_directory, timeout)
        results.append(result)
        if not result["passed"]:
            break
    return results


def checked_candidate_path(root: Path, relative: str) -> Path:
    candidate = (root / relative).resolve()
    if candidate == root or root not in candidate.parents:
        raise ValueError(f"Candidate path escapes disposable project copy: {relative}")
    return candidate


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project", type=Path, help="Original project root; it is never modified")
    parser.add_argument("analysis", type=Path, help="Analysis JSON produced by analyze-code-rot.py")
    parser.add_argument("output", type=Path, help="Path for proof JSON")
    parser.add_argument(
        "--command",
        action="append",
        required=True,
        help="An explicitly approved project command; repeat for multiple checks",
    )
    parser.add_argument(
        "--confirm-run-project-code",
        action="store_true",
        help="Required acknowledgement after explicit user approval",
    )
    parser.add_argument("--candidate-id", action="append", help="Limit proof to selected candidate ID")
    parser.add_argument("--max-candidates", type=int, default=10)
    parser.add_argument("--timeout", type=int, default=300, help="Per-command timeout in seconds")
    parser.add_argument(
        "--include-dependencies",
        action="store_true",
        help="Copy dependency directories; potentially slow and large",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_arguments()
    if not args.confirm_run_project_code:
        print(
            "error: refusing to run repository-controlled commands without --confirm-run-project-code after explicit user approval",
            file=sys.stderr,
        )
        return 2
    if args.max_candidates < 1 or args.timeout < 1:
        print("error: --max-candidates and --timeout must be positive", file=sys.stderr)
        return 2

    project = canonical_path(args.project)
    if not project.is_dir():
        print(f"error: project root is not a directory: {project}", file=sys.stderr)
        return 2
    analysis_path = canonical_path(args.analysis)
    try:
        analysis_bytes = analysis_path.read_bytes()
        analysis = json.loads(analysis_bytes)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        print(f"error: unable to read analysis JSON: {error}", file=sys.stderr)
        return 2
    if not isinstance(analysis, dict):
        print("error: analysis JSON must contain an object", file=sys.stderr)
        return 2
    analysis_root = analysis.get("project_root")
    if not isinstance(analysis_root, str) or canonical_path(analysis_root) != project:
        print("error: analysis project root does not match the requested project", file=sys.stderr)
        return 2
    try:
        output = validate_artifact_outputs(
            [args.output], input_paths=[analysis_path], project_root=args.project
        )[0]
    except ArtifactSafetyError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2

    links = scoped_symlinks(project, args.include_dependencies)
    if links:
        displayed = ", ".join(str(path.relative_to(project)) for path in links[:5])
        suffix = "" if len(links) <= 5 else ", ..."
        print(
            "error: refusing disposable-copy proof because the copied project scope contains "
            f"symlink(s): {displayed}{suffix}. Static analysis remains available.",
            file=sys.stderr,
        )
        return 2

    selected_ids = set(args.candidate_id or [])
    all_candidates = analysis.get("candidates", [])
    if not isinstance(all_candidates, list) or not all(
        isinstance(candidate, dict) and isinstance(candidate.get("id"), str)
        for candidate in all_candidates
    ):
        print("error: analysis candidates must be objects with string IDs", file=sys.stderr)
        return 2
    known_ids = {candidate["id"] for candidate in all_candidates}
    if len(known_ids) != len(all_candidates):
        print("error: analysis candidates must have unique IDs", file=sys.stderr)
        return 2
    missing_ids = sorted(selected_ids - known_ids)
    if missing_ids:
        print(f"error: unknown candidate IDs: {', '.join(missing_ids)}", file=sys.stderr)
        return 2
    candidates = [
        candidate
        for candidate in all_candidates
        if candidate.get("proof_eligible")
        and isinstance(candidate.get("path"), str)
        and candidate["path"]
        and (not selected_ids or candidate["id"] in selected_ids)
    ][: args.max_candidates]

    proof: dict[str, Any] = {
        "artifact_type": "code-rot-proof",
        "schema_version": "1.1",
        "project_root": str(project),
        "analysis_file": str(analysis_path),
        "analysis_sha256": hashlib.sha256(analysis_bytes).hexdigest(),
        "generated_at": timestamp(),
        "commands": args.command,
        "copy_excluded_directories": sorted(copy_excludes(args.include_dependencies)),
        "baseline": {"passed": False, "commands": []},
        "results": [],
        "limitations": [
            "Commands ran in disposable copies, never the real project.",
            "A passing command set proves only the behavior it exercises.",
            "Proof is refused when the copied project scope contains a symlink.",
        ],
    }

    with tempfile.TemporaryDirectory(prefix="pi-code-rot-") as temporary:
        temporary_root = Path(temporary)
        baseline_directory = temporary_root / "baseline"
        copy_project(project, baseline_directory, args.include_dependencies)
        baseline_commands = run_all(args.command, baseline_directory, args.timeout)
        baseline_passed = bool(baseline_commands) and all(item["passed"] for item in baseline_commands)
        proof["baseline"] = {"passed": baseline_passed, "commands": baseline_commands}

        if not baseline_passed:
            proof["limitations"].append(
                "The untouched baseline failed, so no candidate was evaluated or classified from these commands."
            )
        else:
            for index, candidate in enumerate(candidates, start=1):
                started = time.monotonic()
                candidate_directory = temporary_root / f"candidate-{index:03d}"
                copy_project(project, candidate_directory, args.include_dependencies)
                try:
                    target = checked_candidate_path(candidate_directory.resolve(), candidate["path"])
                except ValueError as error:
                    proof["results"].append(
                        {
                            "candidate_id": candidate["id"],
                            "path": candidate["path"],
                            "outcome": "SKIPPED",
                            "reason": str(error),
                            "commands": [],
                        }
                    )
                    continue
                if not target.is_file():
                    proof["results"].append(
                        {
                            "candidate_id": candidate["id"],
                            "path": candidate["path"],
                            "outcome": "SKIPPED",
                            "reason": "Candidate file is absent from the disposable copy.",
                            "commands": [],
                        }
                    )
                    continue
                target.unlink()
                command_results = run_all(args.command, candidate_directory, args.timeout)
                passed = bool(command_results) and all(item["passed"] for item in command_results)
                proof["results"].append(
                    {
                        "candidate_id": candidate["id"],
                        "path": candidate["path"],
                        "outcome": "PASSED_IN_DISPOSABLE_COPY" if passed else "FAILED_AFTER_REMOVAL",
                        "duration_seconds": round(time.monotonic() - started, 3),
                        "commands": command_results,
                    }
                )

    try:
        publish_new_artifacts(
            [(output, (json.dumps(proof, indent=2) + "\n").encode("utf-8"))],
            project_root=args.project,
        )
    except ArtifactSafetyError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    print(f"Baseline: {'passed' if proof['baseline']['passed'] else 'failed'}")
    print(f"Evaluated {len(proof['results'])} candidate(s) in disposable copies.")
    print(f"Proof: {output}")
    return 0 if proof["baseline"]["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
