"""Temporary-fixture regressions for the code-rot-cleaner bundled scripts."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import shlex
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SKILL_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = SKILL_ROOT / "scripts"
ANALYZE = SCRIPTS / "analyze-code-rot.py"
PROVE = SCRIPTS / "prove-candidates.py"
REPORT = SCRIPTS / "generate-report.py"
CLEANUP_PLAN_HEADER = (
    "id,final_status,category,subject,path,line,confidence,risk,proof_eligible,loc,bytes,status_reason\r\n"
).encode()


def write_json(path: Path, data: dict) -> bytes:
    raw = (json.dumps(data, indent=2) + "\n").encode()
    path.write_bytes(raw)
    return raw


def candidate(path: str = "orphan.py") -> dict:
    return {
        "id": "CRT-001",
        "category": "orphan-file",
        "subject": path,
        "path": path,
        "confidence": "high",
        "initial_status": "REVIEW",
        "risk": "low",
        "proof_eligible": True,
        "loc": 1,
        "bytes": 10,
        "evidence": ["test evidence"],
        "caveats": ["test caveat"],
    }


def analysis_artifact(root: Path, candidates: list[dict] | None = None) -> dict:
    candidates = [candidate()] if candidates is None else candidates
    return {
        "artifact_type": "code-rot-analysis",
        "schema_version": "1.0",
        "project_root": str(root.resolve()),
        "generated_at": "2025-01-01T00:00:00Z",
        "scope": {"source_files": 1, "source_loc": 1, "source_bytes": 10},
        "summary": {},
        "candidates": candidates,
        "limitations": [],
    }


def proof_artifact(
    root: Path,
    analysis_path: Path,
    analysis_bytes: bytes,
    *,
    baseline_passed: bool = True,
    results: list[dict] | None = None,
) -> dict:
    return {
        "artifact_type": "code-rot-proof",
        "schema_version": "1.1",
        "project_root": str(root.resolve()),
        "analysis_file": str(analysis_path.resolve()),
        "analysis_sha256": hashlib.sha256(analysis_bytes).hexdigest(),
        "generated_at": "2025-01-01T00:00:00Z",
        "commands": ["test command"],
        "baseline": {
            "passed": baseline_passed,
            "commands": [{"command": "test command", "passed": baseline_passed, "duration_seconds": 0}],
        },
        "results": [] if results is None else results,
        "limitations": [],
    }


class CodeRotScriptTests(unittest.TestCase):
    maxDiff = None

    def run_script(
        self, script: Path, *arguments: Path | str, expected: int | None = 0
    ) -> subprocess.CompletedProcess[str]:
        result = subprocess.run(
            [sys.executable, str(script), *(str(argument) for argument in arguments)],
            text=True,
            capture_output=True,
            check=False,
        )
        if expected is not None:
            self.assertEqual(
                result.returncode,
                expected,
                f"{script.name} stdout:\n{result.stdout}\nstderr:\n{result.stderr}",
            )
        return result

    def make_project(self, temporary: Path, *, source: bool = True) -> Path:
        root = temporary / "project"
        root.mkdir()
        if source:
            (root / "orphan.py").write_text("value = 1\n", encoding="utf-8")
        return root

    def prove_command(self, code: str = "pass") -> str:
        return f"{shlex.quote(sys.executable)} -c {shlex.quote(code)}"

    def generate_analysis(self, root: Path, output: Path | None = None) -> Path:
        output = output or root / "outputs" / "code-rot-cleaner" / "analysis.json"
        self.run_script(ANALYZE, root, output)
        return output

    def generate_report(
        self, analysis: Path, markdown: Path, csv: Path, proof: Path | None = None
    ) -> subprocess.CompletedProcess[str]:
        arguments: list[Path | str] = [analysis, markdown, csv]
        if proof is not None:
            arguments.extend(["--proof", proof])
        return self.run_script(REPORT, *arguments)

    def assert_symlink(self, link: Path, target: Path) -> None:
        try:
            link.symlink_to(target)
        except (NotImplementedError, OSError) as error:
            self.skipTest(f"symlinks unavailable: {error}")

    def write_existing_output(self, root: Path, category: str, name: str, contents: bytes) -> Path:
        path = root / category / name
        path.parent.mkdir(parents=True)
        path.write_bytes(contents)
        return path

    def assert_existing_output_refused(
        self, script: Path, output: Path, contents: bytes, *arguments: Path | str
    ) -> None:
        result = self.run_script(script, *arguments, expected=2)
        self.assertIn("refusing", result.stderr.lower())
        self.assertEqual(output.read_bytes(), contents)

    def test_marker_shaped_env_and_readme_outputs_are_immutable(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            temporary = Path(directory)
            root = self.make_project(temporary)
            analysis_marker = b'{"artifact_type":"code-rot-analysis"}\n'
            proof_marker = b'{"artifact_type":"code-rot-proof","schema_version":"1.1"}\n'
            report_marker = b"<!-- code-rot-cleaner: report -->\n"

            for name in (".env", "README"):
                output = self.write_existing_output(root, f"analysis-{name}", name, analysis_marker)
                self.assert_existing_output_refused(ANALYZE, output, analysis_marker, root, output)

            analysis = self.generate_analysis(root)
            sentinel = temporary / "approved-command-ran"
            command = self.prove_command(
                f"from pathlib import Path; Path({str(sentinel)!r}).write_text('ran')"
            )
            for name in (".env", "README"):
                output = self.write_existing_output(root, f"proof-{name}", name, proof_marker)
                self.assert_existing_output_refused(
                    PROVE,
                    output,
                    proof_marker,
                    root,
                    analysis,
                    output,
                    "--confirm-run-project-code",
                    "--command",
                    command,
                )
            self.assertFalse(sentinel.exists(), "rejected proof output must stop before project commands")

            for name in (".env", "README"):
                markdown = self.write_existing_output(root, f"markdown-{name}", name, report_marker)
                csv = root / "outputs" / f"fresh-plan-{name}.csv"
                self.assert_existing_output_refused(REPORT, markdown, report_marker, analysis, markdown, csv)
                self.assertFalse(csv.exists(), "invalid Markdown output must not create a CSV")

                csv = self.write_existing_output(root, f"csv-{name}", name, CLEANUP_PLAN_HEADER)
                markdown = root / "outputs" / f"fresh-report-{name}.md"
                self.assert_existing_output_refused(REPORT, csv, CLEANUP_PLAN_HEADER, analysis, markdown, csv)
                self.assertFalse(markdown.exists(), "invalid CSV output must not create Markdown")

    def test_default_outputs_refuse_reruns_and_fresh_run_succeeds(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = self.make_project(Path(directory))
            outputs = root / "outputs" / "code-rot-cleaner"
            analysis = self.generate_analysis(root)
            proof = outputs / "proof.json"
            command = self.prove_command()
            proof_arguments = [
                root,
                analysis,
                proof,
                "--confirm-run-project-code",
                "--command",
                command,
            ]
            self.run_script(PROVE, *proof_arguments)
            markdown = outputs / "CODE-ROT-REPORT.md"
            csv = outputs / "cleanup-plan.csv"
            self.generate_report(analysis, markdown, csv, proof)
            originals = {path: path.read_bytes() for path in (analysis, proof, markdown, csv)}

            self.assert_existing_output_refused(ANALYZE, analysis, originals[analysis], root, analysis)
            self.assert_existing_output_refused(PROVE, proof, originals[proof], *proof_arguments)
            self.assert_existing_output_refused(REPORT, markdown, originals[markdown], analysis, markdown, csv, "--proof", proof)
            self.assert_existing_output_refused(REPORT, csv, originals[csv], analysis, markdown, csv, "--proof", proof)
            self.assertEqual({path: path.read_bytes() for path in originals}, originals)

            second = root / "outputs" / "code-rot-cleaner-second-run"
            second_analysis = self.generate_analysis(root, second / "analysis.json")
            second_proof = second / "proof.json"
            self.run_script(
                PROVE,
                root,
                second_analysis,
                second_proof,
                "--confirm-run-project-code",
                "--command",
                command,
            )
            self.generate_report(
                second_analysis,
                second / "CODE-ROT-REPORT.md",
                second / "cleanup-plan.csv",
                second_proof,
            )

    def test_fresh_custom_artifact_paths_outside_project_succeed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            temporary = Path(directory)
            root = self.make_project(temporary)
            custom = temporary / "custom-artifacts"
            analysis = self.generate_analysis(root, custom / "analysis.json")
            proof = custom / "proof.json"
            self.run_script(
                PROVE,
                root,
                analysis,
                proof,
                "--confirm-run-project-code",
                "--command",
                self.prove_command(),
            )
            markdown = custom / "report.md"
            csv = custom / "cleanup.csv"
            self.generate_report(analysis, markdown, csv, proof)
            self.assertTrue(all(path.is_file() for path in (analysis, proof, markdown, csv)))

    def test_output_symlinks_collisions_escaped_parents_and_topology_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            temporary = Path(directory)
            root = self.make_project(temporary)
            analysis = self.generate_analysis(root)
            outside = temporary / "outside"
            outside.mkdir()
            final_link = root / "final-link.json"
            self.assert_symlink(final_link, outside / "target.json")
            self.run_script(ANALYZE, root, final_link, expected=2)

            escaped_parent = root / "escaped"
            self.assert_symlink(escaped_parent, outside)
            self.run_script(ANALYZE, root, escaped_parent / "analysis.json", expected=2)
            self.assertFalse((outside / "analysis.json").exists())
            not_a_directory = root / "not-a-directory"
            not_a_directory.write_text("sentinel", encoding="utf-8")
            self.run_script(ANALYZE, root, not_a_directory / "analysis.json", expected=2)
            self.assertEqual(not_a_directory.read_text(encoding="utf-8"), "sentinel")

            self.run_script(
                PROVE,
                root,
                analysis,
                analysis,
                "--confirm-run-project-code",
                "--command",
                self.prove_command(),
                expected=2,
            )
            self.run_script(REPORT, analysis, analysis, root / "plan.csv", expected=2)
            same = root / "same-output"
            self.run_script(REPORT, analysis, same, same, expected=2)
            self.assertFalse(same.exists())

            report = root / "outputs" / "report"
            plan = report / "cleanup.csv"
            self.run_script(REPORT, analysis, report, plan, expected=2)
            self.assertFalse(report.exists(), "parent/child output paths must fail before report creation")
            self.assertFalse(plan.exists())

    def test_scanner_excludes_symlinked_source_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            temporary = Path(directory)
            root = self.make_project(temporary, source=False)
            external = temporary / "external.py"
            external.write_text("external_value = 1\n", encoding="utf-8")
            self.assert_symlink(root / "linked.py", external)
            analysis_path = root / "analysis.json"
            self.run_script(ANALYZE, root, analysis_path)
            analysis = json.loads(analysis_path.read_text(encoding="utf-8"))
            self.assertEqual(analysis["scope"]["source_files"], 0)
            self.assertEqual(analysis["summary"]["candidates"], 0)
            self.assertNotIn(str(external.resolve()), analysis_path.read_text(encoding="utf-8"))
            self.assertIn(
                "Symlinked files are excluded from static scanning.", analysis["limitations"]
            )

            (root / "ordinary.py").write_text("ordinary_value = 1\n", encoding="utf-8")
            second_analysis_path = root / "analysis-second.json"
            self.run_script(ANALYZE, root, second_analysis_path)
            self.assertEqual(
                json.loads(second_analysis_path.read_text(encoding="utf-8"))["scope"]["source_files"], 1
            )

    def test_proof_refuses_source_symlink_before_command_and_copy_helper_materializes_links(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            temporary = Path(directory)
            root = self.make_project(temporary)
            analysis = self.generate_analysis(root)
            sentinel = temporary / "external-sentinel"
            sentinel.write_text("unchanged", encoding="utf-8")
            self.assert_symlink(root / "linked", sentinel)
            proof = root / "proof.json"
            command = self.prove_command("from pathlib import Path; Path('linked').write_text('changed')")
            result = self.run_script(
                PROVE,
                root,
                analysis,
                proof,
                "--confirm-run-project-code",
                "--command",
                command,
                expected=2,
            )
            self.assertIn("symlink", result.stderr.lower())
            self.assertEqual(sentinel.read_text(encoding="utf-8"), "unchanged")
            self.assertFalse(proof.exists())

            module_path = SCRIPTS / "prove-candidates.py"
            spec = importlib.util.spec_from_file_location("code_rot_prove", module_path)
            self.assertIsNotNone(spec)
            module = importlib.util.module_from_spec(spec)
            sys.path.insert(0, str(SCRIPTS))
            try:
                assert spec.loader is not None
                spec.loader.exec_module(module)
            finally:
                sys.path.remove(str(SCRIPTS))
            source = temporary / "copy-source"
            destination = temporary / "copy-destination"
            source.mkdir()
            linked_target = temporary / "link-target.txt"
            linked_target.write_text("materialized", encoding="utf-8")
            self.assert_symlink(source / "linked.txt", linked_target)
            module.copy_project(source, destination, include_dependencies=False)
            self.assertFalse((destination / "linked.txt").is_symlink())
            self.assertEqual((destination / "linked.txt").read_text(encoding="utf-8"), "materialized")
            for path in destination.rglob("*"):
                self.assertFalse(path.is_symlink())

    def test_report_rejects_cross_run_digest_path_and_duplicate_proof_results(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            temporary = Path(directory)
            root = self.make_project(temporary)
            analysis_a = temporary / "analysis-a.json"
            analysis_b = temporary / "analysis-b.json"
            bytes_a = write_json(analysis_a, analysis_artifact(root, [candidate("a.py")]))
            bytes_b = write_json(analysis_b, analysis_artifact(root, [candidate("b.py")]))
            proof_a = temporary / "proof-a.json"
            write_json(
                proof_a,
                proof_artifact(
                    root,
                    analysis_a,
                    bytes_a,
                    results=[
                        {
                            "candidate_id": "CRT-001",
                            "path": "a.py",
                            "outcome": "PASSED_IN_DISPOSABLE_COPY",
                        }
                    ],
                ),
            )
            cross_report = temporary / "cross.md"
            self.run_script(
                REPORT,
                analysis_b,
                cross_report,
                temporary / "cross.csv",
                "--proof",
                proof_a,
                expected=2,
            )
            self.assertFalse(cross_report.exists())

            analysis_same = temporary / "analysis-same.json"
            original = write_json(analysis_same, analysis_artifact(root))
            stale_proof = temporary / "stale-proof.json"
            write_json(stale_proof, proof_artifact(root, analysis_same, original))
            changed = analysis_artifact(root)
            changed["generated_at"] = "2025-01-02T00:00:00Z"
            write_json(analysis_same, changed)
            self.run_script(
                REPORT,
                analysis_same,
                temporary / "stale.md",
                temporary / "stale.csv",
                "--proof",
                stale_proof,
                expected=2,
            )

            analysis = temporary / "analysis.json"
            analysis_bytes = write_json(analysis, analysis_artifact(root))
            for name, results in {
                "wrong-path": [
                    {
                        "candidate_id": "CRT-001",
                        "path": "other.py",
                        "outcome": "PASSED_IN_DISPOSABLE_COPY",
                    }
                ],
                "duplicate": [
                    {"candidate_id": "CRT-001", "path": "orphan.py", "outcome": "SKIPPED"},
                    {"candidate_id": "CRT-001", "path": "orphan.py", "outcome": "SKIPPED"},
                ],
            }.items():
                proof = temporary / f"{name}.json"
                write_json(proof, proof_artifact(root, analysis, analysis_bytes, results=results))
                markdown = temporary / f"{name}.md"
                self.run_script(
                    REPORT,
                    analysis,
                    markdown,
                    temporary / f"{name}.csv",
                    "--proof",
                    proof,
                    expected=2,
                )
                self.assertFalse(markdown.exists())

    def test_report_headings_distinguish_baseline_and_removal_evaluation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            temporary = Path(directory)
            root = self.make_project(temporary)
            analysis = temporary / "analysis.json"
            analysis_bytes = write_json(analysis, analysis_artifact(root))

            cases: list[tuple[str, dict | None, str, str | None]] = [
                ("no-proof", None, "REPORT READY", None),
                (
                    "failed-baseline",
                    proof_artifact(root, analysis, analysis_bytes, baseline_passed=False),
                    "INCONCLUSIVE",
                    "0",
                ),
                ("empty", proof_artifact(root, analysis, analysis_bytes), "REPORT READY", "0"),
                (
                    "skipped",
                    proof_artifact(
                        root,
                        analysis,
                        analysis_bytes,
                        results=[{"candidate_id": "CRT-001", "path": "orphan.py", "outcome": "SKIPPED"}],
                    ),
                    "REPORT READY",
                    "0",
                ),
                (
                    "passed-removal",
                    proof_artifact(
                        root,
                        analysis,
                        analysis_bytes,
                        results=[
                            {
                                "candidate_id": "CRT-001",
                                "path": "orphan.py",
                                "outcome": "PASSED_IN_DISPOSABLE_COPY",
                            }
                        ],
                    ),
                    "PROOF COMPLETE",
                    "1",
                ),
                (
                    "failed-removal",
                    proof_artifact(
                        root,
                        analysis,
                        analysis_bytes,
                        results=[
                            {
                                "candidate_id": "CRT-001",
                                "path": "orphan.py",
                                "outcome": "FAILED_AFTER_REMOVAL",
                            }
                        ],
                    ),
                    "PROOF COMPLETE",
                    "1",
                ),
            ]
            for name, proof_data, heading, count in cases:
                markdown = temporary / f"{name}.md"
                csv = temporary / f"{name}.csv"
                if proof_data is None:
                    self.generate_report(analysis, markdown, csv)
                else:
                    proof = temporary / f"{name}.json"
                    write_json(proof, proof_data)
                    self.generate_report(analysis, markdown, csv, proof)
                report = markdown.read_text(encoding="utf-8")
                self.assertIn(f"**{heading}**", report)
                if count is not None:
                    self.assertIn(f"Removal experiments evaluated: {count}", report)
                if count == "0":
                    self.assertIn("No candidate deletion was evaluated or proven", report)

    def test_runtime_declaration_requires_python_311(self) -> None:
        skill = (SKILL_ROOT / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn("Python 3.11+", skill)


if __name__ == "__main__":
    unittest.main()
