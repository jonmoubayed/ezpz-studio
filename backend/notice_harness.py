"""Run Notice's production provider/validator, with Studio's saved prompt.

No ground truths, OCR overrides or dataset metadata enter the subprocess.
"""
import base64
import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path

from .harness import HarnessResult


def run(parser_ir, schema, prompt, model, config, model_config=None, source_document=None, source_bytes=None, credential_resolver=None, **kwargs):
    if source_document is None or source_bytes is None:
        raise ValueError("Notice harness requires the original source document")
    if (model_config or {}).get("provider") != "openai":
        raise ValueError("Notice's current production provider is OpenAI; choose an OpenAI model")
    root = Path(config["notice_root"]).expanduser().resolve()
    for relative, expected in config["source_hashes"].items():
        if hashlib.sha256((root / relative).read_bytes()).hexdigest() != expected:
            raise ValueError("Notice extraction code changed. Export a new processor version before comparing runs.")
    node = shutil.which("node")
    if not node:
        raise ValueError("Node.js is required to run Notice's extraction bridge")
    payload = {
        "name": source_document["filename"], "mime": source_document["mime_type"],
        "documentId": source_document["id"], "schemaHash": config["schema_hash"],
        "model": (model_config or {}).get("name"),
        "instructions": "\n\n".join(part for part in (prompt.get("system", ""), prompt.get("extraction", "")) if part),
    }
    if payload["mime"] == "application/pdf":
        payload["base64"] = base64.b64encode(source_bytes).decode("ascii")
    else:
        payload["text"] = source_bytes.decode("utf-8")
    environment = dict(os.environ)
    if credential_resolver is not None:
        key = credential_resolver("OPENAI_API_KEY")
        environment.pop("OPENAI_API_KEY", None)
        if key:
            environment["OPENAI_API_KEY"] = key
    result = subprocess.run([node, "--import", "tsx", "scripts/eval-bridge.ts"], cwd=root,
                            input=json.dumps(payload), capture_output=True, text=True, timeout=65, env=environment)
    if result.returncode:
        raise ValueError("Notice extraction failed: " + result.stderr[:1000])
    response = json.loads(result.stdout)
    usage = response.get("usage") or {}
    return HarnessResult(
        output=response["terms"], raw_response=response, usage=usage,
        steps=[{"name": "Notice production extraction", "schema_hash": config["schema_hash"], "source_hashes": config["source_hashes"]}],
        model_usage=[{"model": payload["model"], "usage": usage, "pricing": (model_config or {}).get("pricing", {})}],
    )
