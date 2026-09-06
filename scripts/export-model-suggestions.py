"""Export the backend's offline model suggestions; never call a provider."""
import argparse
import json
from pathlib import Path
import sys

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root))
from backend.model_catalog import BUILTIN_CATALOG_UPDATED_AT, BUILTIN_MODEL_IDS

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--check", action="store_true", help="Fail if the bundled suggestions need updating")
args = parser.parse_args()
target = root / "src" / "model-catalog.json"
if (root / "src" / "studio-preview").is_dir():
    target = root / "src" / "studio-preview" / "model-catalog.json"
providers = {
    **BUILTIN_MODEL_IDS,
    "google": BUILTIN_MODEL_IDS["gemini"],
    "local": ["deterministic-local"],
    "ollama": ["qwen3:8b", "llama3.2", "deepseek-r1"],
    "openai-compatible": [],
}
text = json.dumps({"updated_at": BUILTIN_CATALOG_UPDATED_AT, "providers": providers}, indent=2) + "\n"
if args.check:
    if not target.exists() or target.read_text() != text:
        sys.exit("Model suggestions are stale. Run python3 scripts/export-model-suggestions.py")
else:
    target.write_text(text)
print("Model suggestions are up to date.")

from backend.model_settings import MODEL_SETTING_RULES
settings_target = target.with_name("model-settings-catalog.json")
settings_text = json.dumps(MODEL_SETTING_RULES, indent=2) + "\n"
if args.check:
    if not settings_target.exists() or settings_target.read_text() != settings_text:
        sys.exit("Model settings are stale. Run python3 scripts/export-model-suggestions.py")
else:
    settings_target.write_text(settings_text)
