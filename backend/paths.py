"""Keep mutable workspaces independent of Python's installation/cache directory."""

import os
import sys
from pathlib import Path


def default_workspace_root() -> Path:
    override = os.environ.get("EZPZ_WORKSPACE")
    if override:
        return Path(override).expanduser().resolve()
    if sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    elif sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    else:
        configured = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")
        base = configured if configured.is_absolute() else Path.home() / ".local" / "share"
    return base / "ezpz"


def bundled_studio_root() -> Path:
    return Path(__file__).resolve().parent / "studio"


def default_runtime_root() -> Path:
    """Preserve source-checkout defaults; installed packages use persistent data."""
    source = Path(__file__).resolve().parents[1]
    if not os.environ.get("EZPZ_WORKSPACE") and (source / "package.json").is_file():
        return source
    return default_workspace_root()
