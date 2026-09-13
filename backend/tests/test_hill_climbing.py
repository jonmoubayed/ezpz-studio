"""Autonomous loop regressions; all model responses and documents are synthetic."""
import json
import os
import threading
import time
import unittest
from copy import deepcopy
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from urllib.request import Request, urlopen

from backend.db import set_request_context, reset_request_context
from backend.hill_climbing import HillClimbing
from backend.model import DeterministicInvoiceModel
from backend.server import create_runtime, make_server


class HillClimbingTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {"EZPZ_SEED_DEMO": "true"}, clear=True)
        self.env.start()
        self.tmp = TemporaryDirectory()
        self.runtime = create_runtime(Path(self.tmp.name))
        self.db = self.runtime.database
        self.service = self.runtime.hill_climbing
        self.dataset = "ds_invoice_eval_2026"
        self.prompts = []
        self.planner = patch("backend.hill_climbing.plan_candidate", side_effect=self.proposal)
        self.planner.start()

    def proposal(self, config, diagnosis, history, model, on_usage, credential_resolver=None):
        on_usage({"input_tokens": 10, "output_tokens": 10}, 0)
        cluster = diagnosis["clusters"][0]
        field = cluster["field"]
        return {"summary": "Synthetic diagnosis", "concerns": [], "plans": [{
            "title": "Synthetic hypothesis " + str(len(history) + 1),
            "rationale": "The fixture tests causal loop behavior with controlled outputs.",
            "prediction": "The targeted field should improve without unrelated regressions.",
            "target_fields": [field], "evidence_document_ids": [cluster["patterns"][0]["document_ids"][0]],
            "changes": [{"section": "extraction", "before": "", "after": "Synthetic decision procedure for " + field + "; controlled variant " + str(len(history) + 1) + "."}],
        }]}

    def tearDown(self):
        self.planner.stop()
        self.tmp.cleanup()
        self.env.stop()

    def model(self, totals):
        model = DeterministicInvoiceModel()
        original = model.run
        values = iter(totals)
        def run(ir, schema, prompt):
            self.prompts.append(deepcopy(prompt))
            result = original(ir, schema, prompt)
            result.output["total"]["value"] = next(values)
            return result
        model.run = run
        return model

    def baseline(self):
        return self.runtime.extractions.run_dataset(self.dataset, force_refresh=True)["run"]

    def wait(self, job):
        until = time.monotonic() + 8
        while time.monotonic() < until:
            current = self.service.get(job["id"])
            if current["status"] not in ("running", "stopping") and job["id"] not in self.service.jobs:
                return current
            time.sleep(.01)
        self.fail("Loop did not finish")

    def start(self, baseline, **options):
        return self.service.start({"dataset_id": self.dataset, "baseline_run_id": baseline["id"], **options})

    def test_rejects_regressions_then_accepts_improvement_from_best_and_freezes_truth(self):
        with patch.object(self.runtime.extractions, "_model", return_value=self.model([999, 888, 1204.19, 999, 1204.19])):
            baseline = self.baseline()
            original = deepcopy(baseline["processor_version"])
            truth = self.db.get_ground_truth("doc_demo_invoice")
            self.db.save_ground_truth("doc_demo_invoice", {**truth["value"], "total": 999999})
            extra = self.runtime.ingestor.ingest("later.txt", b"Invoice # EXTRA\nTotal $55")["document"]
            self.db.add_document_to_dataset(self.dataset, extra["id"])
            # Two failed attempts would stall. The second candidate improves instead.
            job = self.wait(self.start(baseline, max_candidates=2))
        self.assertEqual([i["status"] for i in job["iterations"]], ["rejected", "accepted"])
        self.assertGreater(job["best_score"], job["baseline_score"])
        self.assertEqual(job["iterations"][1]["parent_run_id"], baseline["id"])
        self.assertNotIn(job["iterations"][0]["prompt"], self.prompts[2]["extraction"])
        self.assertEqual(self.db.get_processor_version(original["id"]), original)
        for entry in job["iterations"]:
            run = self.db.get_run(entry["run_id"])
            self.assertEqual(run["metadata"]["benchmark_snapshot"], baseline["metadata"]["benchmark_snapshot"])
            self.assertEqual(run["metrics"]["documents"], 1)
            self.assertEqual(run["evaluations"][0]["fields"]["total"]["expected"], truth["value"]["total"])
            self.assertEqual(run["eval_group"]["id"], baseline["eval_group"]["id"])
            for key in ("schema", "model", "parser", "harness", "normalization"):
                self.assertEqual(run["processor_version"][key], original[key])

    def test_patience_and_iteration_limits_and_no_duplicate_candidate_prompts(self):
        with patch.object(self.runtime.extractions, "_model", return_value=self.model([999] * 10)):
            baseline = self.baseline()
            job = self.wait(self.start(baseline, patience=2, max_candidates=5))
            limited = self.wait(self.start(baseline, patience=3, max_candidates=1))
        self.assertEqual(len(job["iterations"]), 2)
        self.assertIn("without improvement", job["reason"])
        self.assertEqual(job["best_run_id"], baseline["id"])
        self.assertEqual(len({i["prompt"] for i in job["iterations"]}), 2)
        self.assertEqual(len(limited["iterations"]), 1)
        self.assertEqual(limited["reason"], "Candidate limit reached.")

    def test_next_iteration_branches_from_the_accepted_best(self):
        truth = self.db.get_ground_truth("doc_demo_invoice")["value"]
        self.db.save_ground_truth("doc_demo_invoice", {**truth, "vendor": {"name": "Synthetic different vendor"}})
        with patch.object(self.runtime.extractions, "_model", return_value=self.model([999, 1204.19, 999, 1204.19, 999])):
            baseline = self.baseline()
            result = self.wait(self.start(baseline, max_candidates=2))
        first, second = result["iterations"]
        self.assertEqual(first["status"], "accepted", result)
        self.assertEqual(second["status"], "rejected")
        self.assertEqual(second["parent_run_id"], first["run_id"])
        self.assertEqual(result["best_run_id"], first["run_id"])
        self.assertIn(first["prompt"], self.prompts[-1]["extraction"])
        self.assertEqual(len(first["verification_runs"]), 2)
        self.assertEqual(result["evaluation_count"], 4)

    def test_stop_in_flight_is_idempotent_and_never_starts_another_candidate(self):
        with patch.object(self.runtime.extractions, "_model", return_value=self.model([999])):
            baseline = self.baseline()
        entered, release = threading.Event(), threading.Event()
        model = self.model([999])
        original = model.run
        def slow(*args):
            entered.set()
            release.wait(5)
            return original(*args)
        model.run = slow
        with patch.object(self.runtime.extractions, "_model", return_value=model):
            job = self.start(baseline, request_id="same-request")
            try:
                self.assertTrue(entered.wait(3))
                self.assertEqual(self.start(baseline, request_id="same-request")["id"], job["id"])
                with self.assertRaisesRegex(ValueError, "already active"):
                    self.start(baseline)
                self.assertEqual(self.service.stop(job["id"])["status"], "stopping")
            finally:
                release.set()
            result = self.wait(job)
        self.assertEqual(result["status"], "stopped")
        self.assertEqual(len(result["iterations"]), 1)
        self.assertEqual(result["iterations"][0]["status"], "cancelled")
        self.assertEqual(result["best_run_id"], baseline["id"])
        self.assertEqual(self.service.stop(job["id"])["status"], "stopped")

    def test_missing_documents_and_model_errors_stop_instead_of_accepting_partial_scores(self):
        with patch.object(self.runtime.extractions, "_model", return_value=self.model([999])):
            baseline = self.baseline()
        with patch.object(self.runtime.extractions, "_model", side_effect=RuntimeError("Synthetic provider outage")):
            result = self.wait(self.start(baseline))
        self.assertEqual(result["status"], "failed")
        self.assertEqual(len(result["iterations"]), 1)
        self.assertEqual(result["best_run_id"], baseline["id"])
        self.db.delete_document("doc_demo_invoice")
        with self.assertRaisesRegex(ValueError, "removed or changed"):
            self.start(baseline)

    def test_cost_limits_stop_before_next_run_and_unknown_cost_is_not_free(self):
        with patch.object(self.runtime.extractions, "_model", return_value=self.model([999] * 10)):
            baseline = self.baseline()
            execute = self.runtime.extractions.run_dataset
            def priced(*args, **kwargs):
                result = execute(*args, **kwargs)
                result["run"]["metrics"]["cost_usd"] = .5
                return result
            with patch.object(self.runtime.extractions, "run_dataset", side_effect=priced):
                result = self.wait(self.start(baseline, max_cost_usd=.1))
            self.assertEqual(len(result["iterations"]), 1)
            self.assertEqual(result["spent_usd"], .5)
            self.assertIn("Cost threshold", result["reason"])
            def unpriced(*args, **kwargs):
                result = execute(*args, **kwargs)
                result["run"]["metrics"]["cost_usd"] = None
                return result
            with patch.object(self.runtime.extractions, "run_dataset", side_effect=unpriced):
                result = self.wait(self.start(baseline, max_cost_usd=1))
            self.assertEqual(len(result["iterations"]), 1)
            self.assertFalse(result["cost_complete"])
            self.assertIn("unavailable", result["reason"])

    def test_initial_baseline_validation_recovery_and_scope(self):
        config = self.db.get_processor("invoice-extractor")["versions"][0]
        with patch.object(self.runtime.extractions, "_model", return_value=self.model([999, 999])):
            result = self.wait(self.service.start({"dataset_id": self.dataset, "config": config, "max_candidates": 1}))
        self.assertEqual(result["iterations"][0]["status"], "baseline")
        self.assertEqual(len(result["iterations"]), 2)
        # Recreate the manager as a reader, then simulate a process restart recovery.
        reader = HillClimbing(self.db, self.runtime.extractions)
        self.assertEqual(reader.get(result["id"])["best_run_id"], result["best_run_id"])
        self.db._execute("UPDATE hill_climbs SET status = 'running' WHERE id = ?", (result["id"],))
        reader.recover()
        self.assertEqual(reader.get(result["id"])["status"], "interrupted")
        tokens = set_request_context("other-workspace", "other-project")
        try:
            self.assertIsNone(reader.get(result["id"]))
            self.assertEqual(reader.list(), [])
        finally:
            reset_request_context(tokens)
        for options in ({"max_candidates": 0}, {"patience": True}, {"max_cost_usd": float("nan")}, {"dataset_id": "wrong"}):
            with self.assertRaises(ValueError):
                self.service.start({"dataset_id": self.dataset, "config": config, **options})

    def test_single_run_gain_and_baseline_variability_cannot_promote(self):
        for outputs in ([999, 1204.19, 999, 999], [999, 1204.19, 1204.19, 1204.19]):
            with self.subTest(outputs=outputs), patch.object(self.runtime.extractions, "_model", return_value=self.model(outputs)):
                baseline = self.baseline()
                result = self.wait(self.start(baseline, max_candidates=1))
            entry = result["iterations"][0]
            self.assertEqual(entry["status"], "rejected")
            self.assertEqual(result["best_run_id"], baseline["id"])
            self.assertEqual(len(entry["verification_runs"]), 2)
            self.assertIn("did not hold", entry["decision"])

    def test_minimum_gain_and_multiple_confirmation_rounds(self):
        with patch.object(self.runtime.extractions, "_model", return_value=self.model([999, 1204.19])):
            baseline = self.baseline()
            result = self.wait(self.start(baseline, max_candidates=1, min_gain=.9))
        self.assertEqual(result["iterations"][0]["status"], "rejected")
        self.assertEqual(result["evaluation_count"], 1)
        with patch.object(self.runtime.extractions, "_model", return_value=self.model([999, 1204.19, 999, 1204.19, 999, 1204.19])):
            baseline = self.baseline()
            result = self.wait(self.start(baseline, max_candidates=1, confirmation_pairs=2))
        self.assertEqual(result["iterations"][0]["status"], "accepted", result)
        self.assertEqual(result["evaluation_count"], 5)
        self.assertEqual(len(result["iterations"][0]["comparisons"]), 2)

    def test_budget_exhausted_during_confirmation_keeps_previous_best(self):
        with patch.object(self.runtime.extractions, "_model", return_value=self.model([999, 1204.19, 999])):
            baseline = self.baseline()
            execute = self.runtime.extractions.run_dataset
            def priced(*args, **kwargs):
                result = execute(*args, **kwargs)
                result["run"]["metrics"]["cost_usd"] = .1
                return result
            with patch.object(self.runtime.extractions, "run_dataset", side_effect=priced):
                result = self.wait(self.start(baseline, max_candidates=1, max_cost_usd=.15))
        self.assertEqual(result["iterations"][0]["status"], "unverified")
        self.assertEqual(result["best_run_id"], baseline["id"])
        self.assertEqual(result["evaluation_count"], 2)
        self.assertAlmostEqual(result["spent_usd"], .2)

    def test_stop_during_optimizer_accounts_cost_and_starts_no_evaluations(self):
        with patch.object(self.runtime.extractions, "_model", return_value=self.model([999])):
            baseline = self.baseline()
        entered, release = threading.Event(), threading.Event()
        def slow(config, diagnosis, history, model, on_usage, credential_resolver=None):
            entered.set(); release.wait(5)
            on_usage({"input_tokens": 10, "output_tokens": 20}, .25)
            return self.proposal(config, diagnosis, history, model, lambda *args: None)
        with patch("backend.hill_climbing.plan_candidate", side_effect=slow):
            job = self.start(baseline)
            try:
                self.assertTrue(entered.wait(3))
                self.service.stop(job["id"])
            finally:
                release.set()
            result = self.wait(job)
        self.assertEqual(result["status"], "stopped")
        self.assertEqual(result["iterations"], [])
        self.assertAlmostEqual(result["spent_usd"], .25)
        self.assertEqual(result["best_run_id"], baseline["id"])

    def test_stop_and_failure_during_confirmation_never_promote_screening_gain(self):
        for outcome in ("stop", "error"):
            with self.subTest(outcome=outcome), patch.object(self.runtime.extractions, "_model", return_value=self.model([999])):
                baseline = self.baseline()
            entered, release = threading.Event(), threading.Event()
            model = self.model([1204.19, 999])
            original = model.run
            calls = [0]
            def controlled(*args):
                calls[0] += 1
                if calls[0] == 2:
                    if outcome == "error":
                        raise RuntimeError("Synthetic confirmation outage")
                    entered.set(); release.wait(5)
                return original(*args)
            model.run = controlled
            with patch.object(self.runtime.extractions, "_model", return_value=model):
                job = self.start(baseline, max_candidates=1)
                try:
                    if outcome == "stop":
                        self.assertTrue(entered.wait(3))
                        self.service.stop(job["id"])
                finally:
                    release.set()
                result = self.wait(job)
            self.assertEqual(result["best_run_id"], baseline["id"])
            self.assertIn(result["iterations"][0]["status"], ("unverified", "failed"))
            self.assertEqual(result["status"], "stopped" if outcome == "stop" else "failed")
            self.assertEqual(len(result["iterations"][0]["verification_runs"]), 1)

    def test_optimizer_cost_and_invalid_edits_cannot_launch_evaluations(self):
        with patch.object(self.runtime.extractions, "_model", return_value=self.model([999])):
            baseline = self.baseline()
        def costly(config, diagnosis, history, model, on_usage, credential_resolver=None):
            on_usage({}, .5)
            return self.proposal(config, diagnosis, history, model, lambda *args: None)
        with patch("backend.hill_climbing.plan_candidate", side_effect=costly):
            result = self.wait(self.start(baseline, max_cost_usd=.1))
        self.assertEqual(result["iterations"], [])
        self.assertEqual(result["spent_usd"], .5)
        def invalid(*args, **kwargs):
            result = self.proposal(*args)
            result["plans"][0]["changes"][0]["section"] = "schema"
            return result
        with patch("backend.hill_climbing.plan_candidate", side_effect=invalid):
            result = self.wait(self.start(baseline))
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["iterations"], [])
        self.assertEqual(result["best_run_id"], baseline["id"])
        for options in ({"confirmation_pairs": 0}, {"min_gain": 0}, {"min_gain": True}, {"max_regressions": -1}, {"optimizer_model": {}}):
            with self.assertRaises(ValueError):
                self.start(baseline, **options)

    def test_worker_uses_selected_workspace_credentials_and_isolates_history(self):
        self.runtime.credentials.update("openai", "synthetic-default-key")
        workspace = self.db.save_workspace("Loop workspace")["id"]
        tokens = set_request_context(workspace)
        seen = []
        try:
            self.runtime.credentials.update("openai", "synthetic-loop-key")
            document = self.runtime.ingestor.ingest("loop.txt", b"Invoice # TEST\nTotal due $80.00")["document"]
            self.db.save_ground_truth(document["id"], {"total": 80})
            dataset = self.db.insert_dataset("Loop benchmark")
            self.db.add_document_to_dataset(dataset["id"], document["id"])
            config = {"schema": {"type": "object", "properties": {"total": {"type": "number"}}},
                      "parser": {"name": "native"}, "model": {"provider": "openai", "name": "synthetic"}}
            def planner(config, diagnosis, history, model, on_usage, credential_resolver=None):
                seen.append((self.db._workspace_id(), credential_resolver("OPENAI_API_KEY")))
                on_usage({}, 0)
                return {"summary": "Synthetic search finished", "concerns": [], "plans": []}
            with patch.object(self.runtime.extractions, "_model", return_value=self.model([999])), patch("backend.hill_climbing.plan_candidate", side_effect=planner):
                result = self.wait(self.service.start({"dataset_id": dataset["id"], "config": config}))
            self.assertEqual(result["status"], "completed", result)
            self.assertEqual(seen, [(workspace, "synthetic-loop-key")])
            self.assertEqual(len(self.service.list()), 1)
        finally:
            reset_request_context(tokens)
        self.assertIsNone(self.service.get(result["id"]))
        self.assertEqual(self.service.list(), [])
        self.assertEqual(self.runtime.resolve_credential("OPENAI_API_KEY"), "synthetic-default-key")

    def test_proposals_do_not_embed_answers_and_http_status_endpoints(self):
        server = make_server(Path(self.tmp.name), port=0)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        base = f"http://127.0.0.1:{server.server_address[1]}/v1"
        try:
            self.assertEqual(json.load(urlopen(base + "/hill-climbs")), {"hill_climbs": []})
            config = self.db.get_processor("invoice-extractor")["versions"][0]
            data = json.dumps({"dataset_id": self.dataset, "config": config, "max_candidates": 1}).encode()
            response = urlopen(Request(base + "/hill-climbs", data=data, headers={"Content-Type": "application/json"}))
            self.assertEqual(response.status, 202)
            job = json.load(response)["hill_climb"]
            handler_service = server.RequestHandlerClass.runtime.hill_climbing
            until = time.monotonic() + 8
            while job["id"] in handler_service.jobs and time.monotonic() < until:
                time.sleep(.01)
            saved = json.load(urlopen(base + "/hill-climbs/" + job["id"]))["hill_climb"]
            self.assertIn(saved["status"], ("completed", "failed"))
            response = urlopen(Request(base + "/hill-climbs/" + job["id"] + "/stop", data=b"{}", headers={"Content-Type": "application/json"}))
            self.assertEqual(response.status, 202)
        finally:
            server.shutdown(); server.server_close(); worker.join()


if __name__ == "__main__":
    unittest.main()
