#!/usr/bin/env python3
"""Shared validation and new-only publishing for code-rot-cleaner artifacts."""

from __future__ import annotations

import os
import stat
import tempfile
from pathlib import Path
from typing import Iterable

REPORT_MARKER = "<!-- code-rot-cleaner: report -->"
CLEANUP_PLAN_FIELDS = (
    "id",
    "final_status",
    "category",
    "subject",
    "path",
    "line",
    "confidence",
    "risk",
    "proof_eligible",
    "loc",
    "bytes",
    "status_reason",
)


class ArtifactSafetyError(ValueError):
    """An artifact path is unsafe to create or publish."""


def canonical_path(path: Path | str) -> Path:
    """Return an absolute, symlink-resolved path without requiring it to exist."""
    return Path(path).resolve(strict=False)


def lexical_path(path: Path | str) -> Path:
    """Return an absolute path without resolving symlinks in its components."""
    return Path(os.path.abspath(os.fspath(path)))


def _is_within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
    except ValueError:
        return False
    return True


def _validate_parent(path: Path) -> None:
    """Ensure an output parent can be created without traversing a non-directory."""
    parent = path.parent
    while not os.path.lexists(parent):
        if parent == parent.parent:
            return
        parent = parent.parent
    if not parent.is_dir():
        raise ArtifactSafetyError(f"output parent is not a directory: {parent}")


def _validate_new_output(path: Path) -> None:
    """Reject every pre-existing final destination, including dangling symlinks."""
    if os.path.lexists(path):
        raise ArtifactSafetyError(
            f"refusing existing output path; select a new artifact path: {path}"
        )


def _validate_output_topology(outputs: list[Path]) -> None:
    for index, output in enumerate(outputs):
        for other in outputs[index + 1 :]:
            if output == other:
                raise ArtifactSafetyError("artifact output paths must resolve to distinct paths")
            if output in other.parents or other in output.parents:
                raise ArtifactSafetyError(
                    "artifact output paths cannot be parents of one another: "
                    f"{output} and {other}"
                )


def validate_artifact_outputs(
    outputs: Iterable[Path],
    *,
    input_paths: Iterable[Path] = (),
    project_root: Path | None = None,
) -> list[Path]:
    """Validate new artifact destinations without changing the filesystem.

    Every final destination must be absent, including dangling symlinks. The caller may
    use fresh explicit paths outside the project, but a lexical path inside the project
    cannot escape through a symlinked parent directory.
    """
    requested_outputs = [lexical_path(path) for path in outputs]
    if not requested_outputs:
        return []

    lexical_root = lexical_path(project_root) if project_root is not None else None
    resolved_root = canonical_path(project_root) if project_root is not None else None
    resolved_inputs = {canonical_path(path) for path in input_paths}
    resolved_outputs: list[Path] = []

    for requested in requested_outputs:
        resolved = canonical_path(requested)
        if lexical_root is not None and _is_within(requested, lexical_root):
            if not _is_within(resolved, resolved_root):
                raise ArtifactSafetyError(
                    "refusing output path lexically inside the project that resolves outside it "
                    f"through a symlinked parent: {requested}"
                )
        if resolved in resolved_inputs:
            raise ArtifactSafetyError(f"output path collides with an input artifact: {requested}")
        _validate_parent(requested)
        _validate_new_output(requested)
        resolved_outputs.append(resolved)

    _validate_output_topology(resolved_outputs)
    return requested_outputs


def _same_inode(left: Path, right: Path) -> bool:
    try:
        left_status = left.lstat()
        right_status = right.stat()
    except OSError:
        return False
    return stat.S_ISREG(left_status.st_mode) and (
        left_status.st_dev,
        left_status.st_ino,
    ) == (right_status.st_dev, right_status.st_ino)


def _remove_private_file(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        pass
    except OSError:
        pass


def publish_new_artifacts(
    outputs: Iterable[tuple[Path, bytes]], *, project_root: Path | None = None
) -> list[Path]:
    """Publish fully rendered artifacts only to paths that are new at link time.

    All payloads are first staged privately in their destination directories. Each final
    name is then created with ``link``, which fails rather than replacing a path that
    appeared after validation. If one publication fails, only final links known to share
    an inode with this invocation's staging files are removed.
    """
    requested_items = list(outputs)
    paths = validate_artifact_outputs(
        (path for path, _ in requested_items), project_root=project_root
    )
    items = list(zip(paths, (contents for _, contents in requested_items), strict=True))
    staged: list[tuple[Path, Path]] = []
    published: list[tuple[Path, Path]] = []

    try:
        for destination, contents in items:
            try:
                destination.parent.mkdir(parents=True, exist_ok=True)
                descriptor, temporary_name = tempfile.mkstemp(
                    prefix=".pi-code-rot-", suffix=".tmp", dir=destination.parent
                )
                staging = Path(temporary_name)
                staged.append((destination, staging))
                with os.fdopen(descriptor, "wb") as handle:
                    handle.write(contents)
            except OSError as error:
                raise ArtifactSafetyError(
                    f"unable to stage new artifact for {destination}: {error}"
                ) from error

        for destination, staging in staged:
            try:
                os.link(staging, destination, follow_symlinks=False)
            except FileExistsError as error:
                raise ArtifactSafetyError(
                    f"refusing existing output path; select a new artifact path: {destination}"
                ) from error
            except OSError as error:
                raise ArtifactSafetyError(
                    f"unable to publish new artifact {destination}: {error}"
                ) from error
            published.append((destination, staging))
    except BaseException:
        for destination, staging in published:
            if _same_inode(destination, staging):
                _remove_private_file(destination)
        raise
    finally:
        for _, staging in staged:
            _remove_private_file(staging)

    return paths
