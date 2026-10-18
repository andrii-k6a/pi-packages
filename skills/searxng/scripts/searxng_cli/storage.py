"""Response persistence, independent of HTTP and terminal output."""

from pathlib import Path
import tempfile
from typing import Optional


def check_output(value: Optional[str]) -> Optional[Path]:
    """Reject unusable output paths before a search sends a request."""
    if value is None:
        return None
    path = Path(value).expanduser().absolute()
    if path.exists() or path.is_symlink():
        raise ValueError(f"output already exists: {path}; choose a distinct path")
    if not path.parent.is_dir():
        raise ValueError(f"output directory does not exist: {path.parent}")
    return path


def save_response(payload: bytes, path: Optional[Path] = None) -> Path:
    if path is not None:
        with path.open("xb") as output:
            output.write(payload)
        return path
    with tempfile.NamedTemporaryFile(prefix="searxng-", suffix=".json", delete=False) as output:
        output.write(payload)
        return Path(output.name).resolve()
