"""Small environment-backed configuration for the local workbench."""

import os
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

from .project_config import config_value, load_project_config


_DOTENV_KEY = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _load_dotenv(root: Path) -> None:
    """Load a project-local ``.env`` file without replacing process settings.

    The workbench intentionally keeps its runtime dependency-free, so this is a
    small dotenv reader rather than an additional package. Values supplied by
    the shell (or another process manager) always win over values in the file.
    """

    env_path = Path(root) / ".env"
    try:
        lines = env_path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return

    for raw_line in lines:
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        if not _DOTENV_KEY.fullmatch(key):
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        os.environ.setdefault(key, value)


@dataclass(frozen=True)
class Settings:
    root: Path
    host: str
    port: int
    database_url: str
    blob_root: Path
    max_body_bytes: int
    cors_origin: str
    seed_demo: bool

    @classmethod
    def from_env(cls, root: Path) -> "Settings":
        root = Path(root).resolve()
        _load_dotenv(root)
        project_config = load_project_config(root)
        database_url = os.environ.get("EZPZ_DATABASE_URL") or os.environ.get("DATABASE_URL") or config_value(project_config, "database", "url") or "sqlite:///{}".format(root / ".ezpz" / "ezpz.db")
        try:
            port = int(os.environ.get("EZPZ_PORT", str(config_value(project_config, "server", "port", default=4173))))
        except (TypeError, ValueError):
            port = 4173
        try:
            max_body_bytes = max(1024, int(os.environ.get("EZPZ_MAX_BODY_BYTES", str(25 * 1024 * 1024))))
        except (TypeError, ValueError):
            max_body_bytes = 25 * 1024 * 1024
        configured_blob_root = config_value(project_config, "storage", "blob_root") or ".ezpz/blobs"
        blob_root = Path(os.environ.get("EZPZ_BLOB_ROOT", str(root / configured_blob_root)))
        if not blob_root.is_absolute():
            blob_root = root / blob_root
        return cls(
            root=root,
            host=os.environ.get("EZPZ_HOST", "127.0.0.1"),
            port=port,
            database_url=database_url,
            blob_root=blob_root,
            max_body_bytes=max_body_bytes,
            cors_origin=os.environ.get("EZPZ_CORS_ORIGIN", str(config_value(project_config, "server", "cors_origin", default=""))),
            seed_demo=os.environ.get("EZPZ_SEED_DEMO", "false").lower() in {"1", "true", "yes"},
        )

    @property
    def sqlite_path(self) -> Path:
        if self.database_url.startswith("sqlite:///"):
            # ``sqlite:///./relative.db`` is a project-relative URL. Using
            # urlparse().path directly turns its leading slash into an
            # absolute filesystem path (``/./relative.db``).
            path = Path(self.database_url[len("sqlite:///"):])
            return path if path.is_absolute() else self.root / path
        if self.database_url.startswith("sqlite://"):
            path = Path(self.database_url[len("sqlite://"):])
            return path if path.is_absolute() else self.root / path
        raise ValueError("Only SQLite is supported by the local workbench; use sqlite:///... for EZPZ_DATABASE_URL")
