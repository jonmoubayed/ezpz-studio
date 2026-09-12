import os
import json
import subprocess
import sys
import time
import unittest
from copy import deepcopy
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from backend.harness_runtime import execute_harness, saved_latency_ms
from backend.harness_spec import validate_spec, vote, assess
from backend.models import ModelResult
from backend.server import create_runtime
from backend.resumable import EvaluationInterrupted


SCHEMA = {"type": "object", "properties": {"total": {"type": "number"}}, "required": ["total"]}
SOURCE = {"id": "document", "filename": "invoice.txt", "mime_type": "text/plain"}


def extractor(name, **extra):
    return {"id": name, "kind": "extract", "model": {"provider": "local", "name": name}, **extra}


def version(flow):
    return {"id": "pv-test", "schema": SCHEMA, "model": {"provider": "local", "name": "test"}, "prompt": {}, "parser": {"name": "native"},
            "harness": {"name": "workflow", "version": 1, "input": "parsed", "flow": flow}}


class HarnessRecoveryTests(unittest.TestCase):
    def test_saved_latency_keeps_prior_work_without_sleep_gap_or_parallel_overlap(self):
        steps = [{"kind": "extract", "latency_ms": duration, "attempts": [{"status": "completed", "started_at": start}]}
                 for start, duration in [(1, 2000), (2, 2000), (3600, 1000)]]
        self.assertEqual(saved_latency_ms(steps), 4000)

    def test_unresolved_scope_preserves_accepted_fields(self):
        schemas = []
        class Model:
            def __init__(self, config): self.name = config["name"]
            def run(self, ir, schema, prompt):
                schemas.append(schema)
                return ModelResult({"total": {"value": 100 if self.name == "cheap" else 999, "confidence": .99}, "vendor": {"value": "Acme", "confidence": .2 if self.name == "cheap" else .99}}, {})
        config = version({"id": "tiers", "kind": "cascade", "scope": "unresolved", "threshold": .9, "tiers": [extractor("cheap"), extractor("strong")]})
        config["schema"] = {"type": "object", "properties": {**SCHEMA["properties"], "vendor": {"type": "string"}}, "required": ["total", "vendor"]}
        with TemporaryDirectory() as root:
            _, result = execute_harness(SOURCE, b"Acme Total 100", config, Model, root, "scoped")
        self.assertEqual(set(schemas[1]["properties"]), {"vendor"})
        self.assertEqual(result.output["total"]["value"], 100)
        self.assertEqual(result.output["vendor"]["confidence"], .99)

    def test_repair_receives_candidate_source_and_keeps_acceptance_policy(self):
        prompts = []
        class Model:
            def __init__(self, config): pass
            def run(self, ir, schema, prompt):
                prompts.append(prompt)
                assert ir.pages[0].blocks[0].text
                return ModelResult({"total": {"value": 123, "confidence": .2}}, {})
        config = version({"id": "flow", "kind": "sequence", "steps": [extractor("first"),
            {"id": "repair", "kind": "repair", "threshold": .9, "attempts": 1, "body": extractor("fix")},
            {"id": "validate", "kind": "validate"}]})
        with TemporaryDirectory() as root:
            _, result = execute_harness(SOURCE, b"Total 123", config, Model, root, "repair")
        self.assertEqual(len(prompts), 2)
        self.assertIn('"value": 123', prompts[1]["extraction"])
        self.assertIn("Validation feedback", prompts[1]["extraction"])
        self.assertFalse(result.raw_response["acceptance"]["accepted"])

    def test_table_vote_aligns_rows_by_key_and_keeps_model_confidence(self):
        schema = {"type": "object", "properties": {"items": {"type": "array", "items": {"type": "object"}}}}
        rows = [{"sku": "a", "amount": 1}, {"sku": "b", "amount": 2}]
        candidates = [{"items": {"value": value, "confidence": .6}} for value in (rows, list(reversed(rows)), [])]
        policy = {"branches": [{}, {}, {}], "field_policies": {"items": {"row_key": "sku"}}}
        output, decisions = vote(candidates, schema, policy)
        self.assertTrue(decisions[0]["selected"])
        self.assertEqual(output["items"]["confidence"], .6)
        self.assertEqual(output["items"]["selection"]["agreement"], 2 / 3)
        output, _ = vote(candidates, schema, {"branches": [{}, {}, {}]})
        self.assertIsNone(output["items"]["value"])

    def test_model_call_budget_is_preserved_on_resume(self):
        calls = []
        class Model:
            def __init__(self, config): self.name = config["name"]
            def run(self, ir, schema, prompt):
                calls.append(self.name)
                return ModelResult({"total": {"value": 100, "confidence": .2}}, {})
        config = version({"id": "tiers", "kind": "cascade", "threshold": .9, "tiers": [extractor("cheap"), extractor("strong")]})
        config["harness"]["limits"] = {"max_calls": 1}
        with TemporaryDirectory() as root:
            for _ in range(2):
                with self.assertRaisesRegex(ValueError, "model-call limit"):
                    execute_harness(SOURCE, b"Total 100", config, Model, root, "budget")
        self.assertEqual(calls, ["cheap"])

    def test_process_kill_recovers_documents_and_inflight_cascade(self):
        with TemporaryDirectory() as root, patch.dict(os.environ, {"EZPZ_SEED_DEMO": "false"}):
            path = Path(root)
            process = subprocess.Popen([sys.executable, "-m", "backend.tests.harness_crash_worker", root], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            try:
                deadline = time.monotonic() + 15
                while not (path / "blocked").exists() and process.poll() is None and time.monotonic() < deadline:
                    time.sleep(.05)
                self.assertTrue((path / "blocked").exists(), "Worker did not reach the second document's in-flight model call")
                process.kill()
                process.wait(timeout=5)
                runtime = create_runtime(path)
                runtime.extractions.recovery.recover_abandoned()
                run = runtime.database.list_runs()[0]
                self.assertEqual(run["status"], "interrupted")
                self.assertEqual(run["metrics"]["completed"], 1)
                original_id = run["id"]
                class Model:
                    def __init__(self, config): self.name = config["name"]
                    def run(self, ir, schema, prompt):
                        with (path / "calls.jsonl").open("a") as file: file.write(json.dumps([ir.document_id, self.name]) + "\n")
                        return ModelResult({"total": {"value": 100, "confidence": .95}}, {}, {"input_tokens": 10})
                runtime.extractions._model_from_config = Model
                runtime.extractions.recovery.control(original_id, "resume")
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    run = runtime.database.get_run(original_id)
                    if run["status"] != "running": break
                    time.sleep(.03)
                self.assertEqual(run["status"], "completed", run.get("error_text"))
                self.assertEqual(run["metrics"]["completed"], 2)
                self.assertEqual(len(run["extractions"]), 2)
                self.assertEqual(len(run["evaluations"]), 2)
                calls = [json.loads(line) for line in (path / "calls.jsonl").read_text().splitlines()]
                self.assertEqual(len(calls), 5)  # Four logical calls + one lost in flight.
                self.assertEqual(sum(name == "cheap" for _, name in calls), 2)
                self.assertTrue(any("may have been charged" in warning for ex in run["extractions"] for warning in ex["warnings"]))
                self.assertEqual(len(runtime.database.list_runs()), 1)
            finally:
                if process.poll() is None: process.kill(); process.wait(timeout=5)
                if process.stderr: process.stderr.close()

    def test_exhausted_tier_stays_unresolved_after_validation(self):
        class Model:
            def __init__(self, config): pass
            def run(self, ir, schema, prompt): return ModelResult({"total": {"value": 100, "confidence": .4}}, {})
        flow = {"id": "flow", "kind": "sequence", "steps": [
            {"id": "tiers", "kind": "cascade", "threshold": .9, "tiers": [extractor("cheap"), extractor("strong")]},
            {"id": "validate", "kind": "validate"}]}
        with TemporaryDirectory() as root:
            _, result = execute_harness(SOURCE, b"Total 100", version(flow), Model, root, "tiers")
            self.assertFalse(result.raw_response["acceptance"]["accepted"])

    def test_direct_input_skips_parser_and_provider_payloads_keep_pdf(self):
        import base64
        from backend.model import OpenAICompatibleModel, AnthropicModel, GeminiModel
        from backend.models import DocumentIR
        ir = DocumentIR("pdf", {"name": "none"}, {"source_input": {"filename": "invoice.pdf", "mime_type": "application/pdf", "data": base64.b64encode(b"%PDF-test").decode()}}, [])
        self.assertEqual(OpenAICompatibleModel(api_key="test", model="gpt-4.1").request_payload(ir, SCHEMA, {})["messages"][1]["content"][0]["type"], "file")
        self.assertEqual(AnthropicModel(api_key="test").request_payload(ir, SCHEMA, {})["messages"][0]["content"][0]["type"], "document")
        self.assertEqual(GeminiModel(api_key="test").request_payload(ir, SCHEMA, {})["contents"][0]["parts"][0]["inlineData"]["mimeType"], "application/pdf")
        class Model:
            def __init__(self, config): pass
            def run(self, ir, schema, prompt):
                self_source = ir.metadata["source_input"]
                assert base64.b64decode(self_source["data"]) == b"Total 100"
                return ModelResult({"total": {"value": 100, "confidence": .9}}, {})
        config = version(extractor("direct")); config["harness"]["input"] = "document"
        with TemporaryDirectory() as root, patch("backend.harness_runtime.parse_document", side_effect=AssertionError("Parser must not run")):
            _, result = execute_harness(SOURCE, b"Total 100", config, Model, root, "direct")
            self.assertEqual(result.output["total"]["value"], 100)

    def test_cascade_resumes_saved_model_call_and_completed_graph(self):
        counts = {}
        failing = True
        class Model:
            def __init__(self, config): self.name = config["name"]
            def run(self, ir, schema, prompt):
                counts[self.name] = counts.get(self.name, 0) + 1
                if self.name == "strong" and failing:
                    raise RuntimeError("connection lost")
                return ModelResult({"total": {"value": 100, "confidence": 0.4 if self.name == "cheap" else 0.99}}, {"model": self.name}, {"input_tokens": 10})
        config = version({"id": "tiers", "kind": "cascade", "threshold": 0.9, "tiers": [extractor("cheap"), extractor("strong")]})
        with TemporaryDirectory() as root:
            with self.assertRaisesRegex(RuntimeError, "connection lost"):
                execute_harness(SOURCE, b"Total 100", config, Model, root, "same-execution")
            failing = False
            _, result = execute_harness(SOURCE, b"Total 100", config, Model, root, "same-execution")
            self.assertEqual(counts, {"cheap": 1, "strong": 2})
            self.assertEqual(result.usage["input_tokens"], 20)
            self.assertEqual(result.output["total"]["confidence"], 0.99)
            execute_harness(SOURCE, b"Total 100", config, Model, root, "same-execution")
            self.assertEqual(counts, {"cheap": 1, "strong": 2})

    def test_parallel_recovery_preserves_successful_voter_usage(self):
        counts = {}
        failing = True
        class Model:
            def __init__(self, config): self.name = config["name"]
            def run(self, ir, schema, prompt):
                counts[self.name] = counts.get(self.name, 0) + 1
                if self.name != "a" and failing: raise RuntimeError("network unavailable")
                return ModelResult({"total": {"value": 100, "confidence": 0.9}}, {}, {"input_tokens": 7})
        config = version({"id": "vote", "kind": "consensus", "branches": [extractor(n) for n in ("a", "b", "c")]})
        with TemporaryDirectory() as root:
            with self.assertRaises(RuntimeError):
                execute_harness(SOURCE, b"Total 100", config, Model, root, "vote")
            failing = False
            _, result = execute_harness(SOURCE, b"Total 100", config, Model, root, "vote")
            self.assertEqual(counts["a"], 1)
            self.assertEqual(result.usage["input_tokens"], 21)
            self.assertEqual(len(result.model_usage), 3)
            self.assertEqual(result.output["total"]["selection"]["agreement"], 1)

    def test_missing_confidence_and_critical_field_gate(self):
        self.assertFalse(assess({"total": {"value": 5, "confidence": None}}, SCHEMA, {"threshold": 0.8})["accepted"])
        self.assertTrue(assess({"total": {"value": 5, "confidence": None}}, SCHEMA, {"threshold": 0.8, "missing_confidence": "ignore"})["accepted"])

    def test_vote_does_not_treat_one_survivor_as_consensus(self):
        output, decisions = vote([{"total": {"value": 100}}, {}, {}], SCHEMA, {"branches": [{}, {}, {}]})
        self.assertIsNone(output["total"]["value"])
        self.assertFalse(decisions[0]["selected"])

    def test_validation_rejects_duplicate_ids_and_bad_threshold(self):
        with self.assertRaisesRegex(ValueError, "unique ID"):
            validate_spec(version({"id": "seq", "kind": "sequence", "steps": [extractor("a"), extractor("a")]})["harness"], SCHEMA)
        with self.assertRaisesRegex(ValueError, "threshold"):
            validate_spec(version({"id": "gate", "kind": "gate", "threshold": 2})["harness"], SCHEMA)

    def test_resume_eval_preserves_documents_and_frozen_truth(self):
        with TemporaryDirectory() as root, patch.dict(os.environ, {"EZPZ_SEED_DEMO": "true"}):
            runtime = create_runtime(Path(root))
            dataset = runtime.database.list_datasets()[0]
            original = runtime.extractions.extract_document
            def interrupted(*args, **kwargs): raise EvaluationInterrupted("sleep")
            with patch.object(runtime.extractions, "extract_document", interrupted):
                first = runtime.extractions.run_dataset(dataset["id"])["run"]
            self.assertEqual(first["status"], "interrupted")
            recovered = create_runtime(Path(root))
            run = recovered.extractions.recovery.control(first["id"], "resume")
            import time
            for _ in range(100):
                run = recovered.database.get_run(first["id"])
                if run["status"] not in ("running", "pausing"): break
                time.sleep(0.02)
            self.assertEqual(run["status"], "completed", run.get("error_text"))
            self.assertEqual(run["metadata"]["benchmark_snapshot"], first["metadata"]["benchmark_snapshot"])
            self.assertEqual(len(recovered.database.list_runs()), 1)


if __name__ == "__main__": unittest.main()
