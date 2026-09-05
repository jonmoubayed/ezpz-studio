"""Small, dependency-optional loader for the project configuration file."""

import json
import os
from pathlib import Path
from typing import Any, Dict


def _scalar(value: str) -> Any:
    value = value.strip()
    if not value:
        return ""
    if value.lower() in {"true", "yes", "on"}:
        return True
    if value.lower() in {"false", "no", "off"}:
        return False
    if value.lower() in {"null", "none", "~"}:
        return None
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return value.strip("\"'")


def _fallback_yaml(text: str) -> Dict[str, Any]:
    """Parse the simple key/value subset emitted by ``ezpz init``."""
    result: Dict[str, Any] = {}
    parents = [(0, result)]
    for raw_line in text.splitlines():
        if not raw_line.strip() or raw_line.lstrip().startswith("#"):
            continue
        indent = len(raw_line) - len(raw_line.lstrip(" "))
        if ":" not in raw_line:
            continue
        key, raw_value = raw_line.strip().split(":", 1)
        while len(parents) > 1 and indent <= parents[-1][0]:
            parents.pop()
        target = parents[-1][1]
        value = _scalar(raw_value)
        if value == "":
            value = {}
            parents.append((indent, value))
        target[key.strip()] = value
    return result


def load_project_config(root: Path) -> Dict[str, Any]:
    path = Path(os.environ.get("EZPZ_CONFIG_FILE", str(Path(root) / "ezpz.yaml")))
    if not path.exists():
        return {}
    text = path.read_text(encoding="utf-8")
    return load_yaml_text(text, str(path))


def load_yaml_text(text: str, source: str = "configuration") -> Dict[str, Any]:
    """Parse a YAML document using PyYAML when available, with a small fallback."""
    try:
        import yaml  # type: ignore

        value = yaml.safe_load(text)
    except ImportError:
        value = _fallback_yaml(text)
    except Exception as error:
        raise ValueError("could not parse {}: {}".format(source, error)) from error
    return value if isinstance(value, dict) else {}


def config_value(config: Dict[str, Any], *path: str, default: Any = None) -> Any:
    current: Any = config
    for part in path:
        if not isinstance(current, dict) or part not in current:
            return default
        current = current[part]
    return current


def dump_yaml(value: Dict[str, Any]) -> str:
    """Serialize configuration for humans and source control."""
    try:
        import yaml  # type: ignore

        return yaml.safe_dump(value, sort_keys=False, allow_unicode=True)
    except ImportError:
        lines = []

        def emit(mapping: Dict[str, Any], indent: int = 0) -> None:
            for key, item in mapping.items():
                prefix = " " * indent + "{}:".format(key)
                if isinstance(item, dict):
                    lines.append(prefix)
                    emit(item, indent + 2)
                elif isinstance(item, list):
                    lines.append(prefix)
                    lines.extend(" " * (indent + 2) + "- {}".format(json.dumps(entry, ensure_ascii=False)) for entry in item)
                else:
                    lines.append("{} {}".format(prefix, json.dumps(item, ensure_ascii=False)))

        emit(value)
        return "\n".join(lines) + "\n"


def write_project_config(root: Path, project_name: str = "ezpz project") -> Path:
    path = Path(root) / "ezpz.yaml"
    if not path.exists():
        path.write_text(
            "# ezpz project configuration. Environment variables override these values.\n"
            "project:\n"
            "  name: {}\n"
            "storage:\n"
            "  blob_root: .ezpz/blobs\n"
            "database:\n"
            "  url: sqlite://./.ezpz/ezpz.db\n".format(project_name),
            encoding="utf-8",
        )
    return path
