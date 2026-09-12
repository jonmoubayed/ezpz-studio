"""Disposable subprocess used to test abrupt termination of an evaluation."""
import json
import sys
import time
from pathlib import Path
from backend.server import create_runtime
from backend.models import ModelResult
from backend.tests.test_resumable_harness import version, extractor

root = Path(sys.argv[1])
runtime = create_runtime(root)
dataset = runtime.database.insert_dataset("Recovery fixture")
for index in range(2):
    doc = runtime.ingestor.ingest(f"invoice-{index}.txt", f"Invoice {index}. Total 100".encode(), "text/plain")["document"]
    runtime.database.add_document_to_dataset(dataset["id"], doc["id"])
last = runtime.database.snapshot_dataset(dataset["id"])[-1]["id"]
processor = runtime.database.insert_processor("Recovery processor")
saved = {**version({"id": "tiers", "kind": "cascade", "threshold": .8, "tiers": [extractor("cheap"), extractor("strong")]}), "processor_id": processor["id"], "version": 1, "status": "published"}
runtime.database.insert_processor_version(saved)

class Model:
    def __init__(self, config): self.name = config["name"]
    def run(self, ir, schema, prompt):
        with (root / "calls.jsonl").open("a") as file:
            file.write(json.dumps([ir.document_id, self.name]) + "\n")
        if ir.document_id == last and self.name == "strong":
            (root / "blocked").write_text(last)
            while True: time.sleep(.05)
        return ModelResult({"total": {"value": 100, "confidence": .4 if self.name == "cheap" else .95}}, {}, {"input_tokens": 10})

runtime.extractions._model_from_config = Model
runtime.extractions.run_dataset(dataset["id"], processor["id"])
