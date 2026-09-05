import json
import os
import threading
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.request import Request, urlopen
from unittest.mock import patch

from backend.db import create_database
from backend.ingest import DocumentIngestor
from backend.server import create_runtime, make_server
from backend.storage import create_blob_store
from backend.seed import blank_prompt, blank_schema


class WorkbenchTests(unittest.TestCase):
    def test_seed_creates_the_core_workbench_records(self):
        with patch.dict(os.environ, {"EZPZ_SEED_DEMO": "true"}):
            with TemporaryDirectory() as directory:
                runtime = create_runtime(Path(directory))
                self.assertEqual(len(runtime.database.list_documents()), 1)
                self.assertEqual(len(runtime.database.list_datasets()), 1)
                self.assertEqual(len(runtime.database.list_processors()), 1)
                self.assertEqual(runtime.database.list_processors()[0]["versions"][0]["status"], "published")

    def test_default_runtime_is_empty_but_has_a_blank_processor_shell(self):
        with patch.dict(os.environ, {"EZPZ_SEED_DEMO": "false"}):
            with TemporaryDirectory() as directory:
                runtime = create_runtime(Path(directory))
                self.assertEqual(runtime.database.list_documents(), [])
                self.assertEqual(runtime.database.list_datasets(), [])
                processor = runtime.database.get_processor("invoice-extractor")
                self.assertIsNotNone(processor)
                self.assertEqual(processor["versions"][0]["schema"], {"type": "object", "properties": {}})
                self.assertEqual(processor["versions"][0]["model"]["name"], "deterministic-local")
                self.assertEqual(processor["versions"][0]["parser"]["name"], "native")

    def test_new_processor_defaults_are_neutral_and_library_metadata_is_available(self):
        with patch.dict(os.environ, {"EZPZ_SEED_DEMO": "false"}):
            with TemporaryDirectory() as directory:
                runtime = create_runtime(Path(directory))
                processor = runtime.database.insert_processor("contract-extractor")
                version = runtime.database.insert_processor_version(
                    {
                        "id": "pv_contract_extractor_1",
                        "processor_id": processor["id"],
                        "version": 1,
                        "status": "draft",
                        "schema": blank_schema(),
                        "prompt": blank_prompt(),
                        "parser": {"name": "native", "version": "1"},
                        "model": {"provider": "local", "name": "deterministic-local"},
                        "harness": {"name": "direct", "version": "1"},
                        "normalization": {},
                    }
                )
                listed = runtime.database.get_processor(processor["id"])
                self.assertEqual(version["schema"], {"type": "object", "properties": {}})
                self.assertEqual(version["parser"]["name"], "native")
                self.assertEqual(version["model"]["name"], "deterministic-local")
                self.assertEqual(listed["latest_version"]["version"], 1)
                self.assertEqual(listed["latest_version"]["status"], "draft")

    def test_processor_metadata_can_be_updated_and_names_stay_unique(self):
        with patch.dict(os.environ, {"EZPZ_SEED_DEMO": "false"}):
            with TemporaryDirectory() as directory:
                runtime = create_runtime(Path(directory))
                first = runtime.database.insert_processor("first-processor")
                second = runtime.database.insert_processor("second-processor")
                updated = runtime.database.update_processor(first["id"], {"name": "renamed-processor", "description": "A revised processor"})
                self.assertEqual(updated["name"], "renamed-processor")
                self.assertEqual(updated["description"], "A revised processor")
                with self.assertRaisesRegex(ValueError, "processor already exists"):
                    runtime.database.update_processor(first["id"], {"name": second["name"]})
                with self.assertRaisesRegex(ValueError, "processor name is required"):
                    runtime.database.update_processor(first["id"], {"name": "   "})

    def test_latest_extraction_can_be_scoped_to_a_processor(self):
        with patch.dict(os.environ, {"EZPZ_SEED_DEMO": "true"}):
            with TemporaryDirectory() as directory:
                runtime = create_runtime(Path(directory))
                processor = runtime.database.insert_processor("contract-extractor")
                runtime.database.insert_processor_version(
                    {
                        "id": "pv_contract_extractor_1",
                        "processor_id": processor["id"],
                        "version": 1,
                        "status": "published",
                        "schema": blank_schema(),
                        "prompt": blank_prompt(),
                        "parser": {"name": "native", "version": "1"},
                        "model": {"provider": "local", "name": "deterministic-local"},
                        "harness": {"name": "direct", "version": "1"},
                        "normalization": {},
                    }
                )
                invoice_extraction = runtime.extractions.extract_document("doc_demo_invoice", "invoice-extractor")
                contract_extraction = runtime.extractions.extract_document("doc_demo_invoice", processor["id"])
                latest_invoice = runtime.database.latest_extraction("doc_demo_invoice", "invoice-extractor")
                latest_contract = runtime.database.latest_extraction("doc_demo_invoice", processor["id"])
                self.assertEqual(latest_invoice["id"], invoice_extraction["id"])
                self.assertEqual(latest_contract["id"], contract_extraction["id"])
                self.assertNotEqual(latest_invoice["processor_version_id"], latest_contract["processor_version_id"])

    def test_ingestion_is_content_addressed_and_deduplicated(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            database = create_database("sqlite:///{}".format(root / "db.sqlite"), root / "db.sqlite")
            database.initialize()
            ingestor = DocumentIngestor(database, create_blob_store(root / "blobs"))
            first = ingestor.ingest("sample.txt", b"hello")
            second = ingestor.ingest("renamed.txt", b"hello")
            self.assertFalse(first["duplicate"])
            self.assertTrue(second["duplicate"])
            self.assertEqual(first["document"]["id"], second["document"]["id"])

    def test_document_folders_persist_and_move_documents(self):
        with patch.dict(os.environ, {"EZPZ_SEED_DEMO": "false"}):
            with TemporaryDirectory() as directory:
                runtime = create_runtime(Path(directory))
                folder = runtime.database.create_document_folder("invoices/validation")
                document = runtime.ingestor.ingest("invoice.pdf", b"invoice bytes")["document"]

                moved = runtime.database.update_document_folder(document["id"], folder["path"])
                folders = runtime.database.list_document_folders()

                self.assertEqual(moved["metadata"]["folder_path"], "invoices/validation/")
                self.assertEqual([item["path"] for item in folders], ["invoices/", "invoices/validation/"])
                self.assertEqual(folders[-1]["document_count"], 1)

                root_document = runtime.database.update_document_folder(document["id"], "")
                self.assertNotIn("folder_path", root_document["metadata"])

    def test_ground_truth_revisions_and_dataset_membership(self):
        with patch.dict(os.environ, {"EZPZ_SEED_DEMO": "true"}):
            with TemporaryDirectory() as directory:
                runtime = create_runtime(Path(directory))
                dataset = runtime.database.insert_dataset("review-set")
                runtime.database.add_document_to_dataset(dataset["id"], "doc_demo_invoice", "test")
                runtime.database.save_ground_truth("doc_demo_invoice", {"total": 1204.19}, author="reviewer")
                runtime.database.save_ground_truth("doc_demo_invoice", {"currency": "USD"}, merge=True, author="reviewer")
                self.assertEqual(runtime.database.get_ground_truth("doc_demo_invoice")["revision"], 3)
                self.assertEqual(runtime.database.list_dataset_documents(dataset["id"])[0]["split"], "test")

    def test_preview_publish_and_dataset_run_are_separate_records(self):
        with patch.dict(os.environ, {"EZPZ_SEED_DEMO": "true"}):
            with TemporaryDirectory() as directory:
                runtime = create_runtime(Path(directory))
                preview = runtime.extractions.preview_document("doc_demo_invoice", "invoice-extractor", {"prompt": {"system": "Use the schema."}})
                self.assertTrue(preview["preview"])
                draft = runtime.database.upsert_processor_draft("invoice-extractor", {"prompt": {"system": "Use the schema."}})
                self.assertEqual(draft["prompt"]["system"], "Use the schema.")
                published = runtime.database.publish_processor_draft("invoice-extractor")
                self.assertGreater(published["version"], 17)
                result = runtime.extractions.run_dataset("ds_invoice_eval_2026", "invoice-extractor")
                self.assertEqual(result["run"]["status"], "completed")
                self.assertEqual(len(result["run"]["extractions"]), 1)
                self.assertEqual(runtime.database.latest_extraction("doc_demo_invoice")["run_id"], result["run"]["id"])

    def test_eval_group_owns_the_benchmark_and_experiment_owns_the_config(self):
        with patch.dict(os.environ, {"EZPZ_SEED_DEMO": "true"}):
            with TemporaryDirectory() as directory:
                runtime = create_runtime(Path(directory))
                group = runtime.database.get_eval_group("eval_group_ds_invoice_eval_2026")
                version = runtime.database.resolve_processor_version("invoice-extractor")

                self.assertEqual(group["dataset_id"], "ds_invoice_eval_2026")
                experiment = runtime.database.create_eval_experiment(
                    group["id"],
                    version["id"],
                    "Baseline extraction config",
                    "Original model, prompt, parser, and harness",
                )
                self.assertEqual(experiment["processor_version_id"], version["id"])
                self.assertEqual(experiment["dataset_id"], group["dataset_id"])

                result = runtime.extractions.run_dataset(
                    group["dataset_id"],
                    "invoice-extractor",
                    eval_experiment_id=experiment["id"],
                )
                self.assertEqual(result["run"]["eval_experiment_id"], experiment["id"])
                self.assertEqual(result["run"]["processor_version_id"], experiment["processor_version_id"])
                self.assertEqual(result["run"]["eval_group"]["id"], group["id"])

                other_version = runtime.database.insert_processor_version({
                    "id": "pv_incompatible_eval_config",
                    "processor_id": version["processor_id"],
                    "version": 999,
                    "status": "published",
                    **{key: version[key] for key in ("schema", "prompt", "parser", "model", "harness", "normalization")},
                })
                with self.assertRaisesRegex(ValueError, "configuration must match"):
                    runtime.database.create_run(
                        other_version["id"],
                        "dataset",
                        dataset_id=group["dataset_id"],
                        eval_experiment_id=experiment["id"],
                    )

    def test_fresh_dataset_run_bypasses_existing_extraction_cache(self):
        with patch.dict(os.environ, {"EZPZ_SEED_DEMO": "true"}):
            with TemporaryDirectory() as directory:
                runtime = create_runtime(Path(directory))
                runtime.extractions.run_dataset("ds_invoice_eval_2026", "invoice-extractor")
                cached = runtime.extractions.run_dataset("ds_invoice_eval_2026", "invoice-extractor", force_refresh=False)
                fresh = runtime.extractions.run_dataset("ds_invoice_eval_2026", "invoice-extractor", force_refresh=True)
                after_fresh = runtime.extractions.run_dataset("ds_invoice_eval_2026", "invoice-extractor", force_refresh=False)

                self.assertEqual(cached["run"]["metrics"]["cache_hits"], 1)
                self.assertEqual(fresh["run"]["metrics"]["cache_hits"], 0)
                self.assertEqual(fresh["run"]["metrics"]["cache_misses"], 1)
                self.assertFalse(fresh["results"][0]["cache_hit"])
                self.assertEqual(fresh["run"]["metadata"]["cache_mode"], "bypass")
                self.assertEqual(after_fresh["run"]["metrics"]["cache_hits"], 1)
                self.assertTrue(after_fresh["results"][0]["cache_hit"])

    def test_review_decisions_are_idempotent_overlays_on_run_results(self):
        with patch.dict(os.environ, {"EZPZ_SEED_DEMO": "true"}):
            with TemporaryDirectory() as directory:
                runtime = create_runtime(Path(directory))
                result = runtime.extractions.run_dataset("ds_invoice_eval_2026", "invoice-extractor")
                run = result["run"]
                evaluation = run["evaluations"][0]
                field_path, field = next(iter(evaluation["fields"].items()))
                original_actual = field["actual"]

                accepted = runtime.database.save_review_decision(
                    run["id"],
                    evaluation["document_id"],
                    field_path,
                    "accepted",
                    reason="model_error",
                    evaluation_id=evaluation["id"],
                )
                corrected = runtime.database.save_review_decision(
                    run["id"],
                    evaluation["document_id"],
                    field_path,
                    "corrected",
                    reason="model_error",
                    corrected_value={"reviewed": True},
                    note="Reviewer override",
                    evaluation_id=evaluation["id"],
                )

                self.assertEqual(accepted["status"], "accepted")
                self.assertEqual(corrected["status"], "corrected")
                self.assertEqual(corrected["corrected_value"], {"reviewed": True})
                refreshed = runtime.database.get_run(run["id"])
                self.assertEqual(len(refreshed["review_decisions"]), 1)
                self.assertEqual(refreshed["review_decisions"][0]["status"], "corrected")
                self.assertEqual(refreshed["evaluations"][0]["fields"][field_path]["actual"], original_actual)
                with self.assertRaisesRegex(ValueError, "Evaluation field not found"):
                    runtime.database.save_review_decision(
                        run["id"],
                        evaluation["document_id"],
                        "missing.field",
                        "accepted",
                        evaluation_id=evaluation["id"],
                    )

    def test_http_exposes_only_the_workbench_loop(self):
        with patch.dict(os.environ, {"EZPZ_SEED_DEMO": "true"}):
            with TemporaryDirectory() as directory:
                server = make_server(Path(directory), port=0)
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                base = "http://127.0.0.1:{}".format(server.server_port)
                try:
                    with urlopen(base + "/v1/health") as response:
                        self.assertTrue(json.loads(response.read().decode())["ok"])
                    with urlopen(base + "/v1/documents") as response:
                        self.assertEqual(len(json.loads(response.read().decode())["documents"]), 1)
                    with urlopen(base + "/v1/adapters") as response:
                        adapters = json.loads(response.read().decode())
                        self.assertIn("anthropic", {item["id"] for item in adapters["llm"]})
                        self.assertIn("llama-parse", {item["id"] for item in adapters["parsers"]})
                    with urlopen(base + "/v1/deployments") as response:
                        self.assertEqual(response.status, 404)
                except Exception as error:
                    if getattr(error, "code", None) != 404:
                        raise
                finally:
                    server.shutdown()
                    server.server_close()

    def test_http_upserts_run_review_decisions_without_mutating_evaluation(self):
        with patch.dict(os.environ, {"EZPZ_SEED_DEMO": "true"}):
            with TemporaryDirectory() as directory:
                server = make_server(Path(directory), port=0)
                runtime = server.RequestHandlerClass.runtime
                run = runtime.extractions.run_dataset("ds_invoice_eval_2026", "invoice-extractor")["run"]
                evaluation = run["evaluations"][0]
                field_path, field = next(iter(evaluation["fields"].items()))
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                base = "http://127.0.0.1:{}".format(server.server_port)
                try:
                    body = json.dumps({
                        "document_id": evaluation["document_id"],
                        "evaluation_id": evaluation["id"],
                        "field_path": field_path,
                        "status": "corrected",
                        "reason": "model_error",
                        "corrected_value": {"reviewed": True},
                        "note": "API review",
                    }).encode("utf-8")
                    request = Request(base + "/v1/runs/" + run["id"] + "/reviews", data=body, headers={"Content-Type": "application/json"}, method="POST")
                    with urlopen(request) as response:
                        payload = json.loads(response.read().decode())
                    self.assertEqual(payload["review_decision"]["status"], "corrected")
                    with urlopen(base + "/v1/runs/" + run["id"] + "/reviews") as response:
                        reviews = json.loads(response.read().decode())["review_decisions"]
                    self.assertEqual(len(reviews), 1)
                    self.assertEqual(reviews[0]["corrected_value"], {"reviewed": True})
                    self.assertEqual(runtime.database.get_evaluation(evaluation["id"])["fields"][field_path]["actual"], field["actual"])
                finally:
                    server.shutdown()
                    server.server_close()

    def test_http_creates_a_processor_with_neutral_defaults(self):
        with patch.dict(os.environ, {"EZPZ_SEED_DEMO": "false"}):
            with TemporaryDirectory() as directory:
                server = make_server(Path(directory), port=0)
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                base = "http://127.0.0.1:{}".format(server.server_port)
                try:
                    body = json.dumps({"name": "contract-extractor", "description": "Contracts"}).encode("utf-8")
                    request = Request(base + "/v1/processors", data=body, headers={"Content-Type": "application/json"}, method="POST")
                    with urlopen(request) as response:
                        payload = json.loads(response.read().decode())
                    processor = payload["processor"]
                    version = processor["versions"][0]
                    self.assertEqual(processor["name"], "contract-extractor")
                    self.assertEqual(version["schema"], {"type": "object", "properties": {}})
                    self.assertEqual(version["parser"]["name"], "native")
                    self.assertEqual(version["model"]["name"], "deterministic-local")
                    update_body = json.dumps({"name": "contract-fields", "description": "Updated description"}).encode("utf-8")
                    update_request = Request(base + "/v1/processors/" + processor["id"], data=update_body, headers={"Content-Type": "application/json"}, method="PATCH")
                    with urlopen(update_request) as response:
                        updated = json.loads(response.read().decode())["processor"]
                    self.assertEqual(updated["name"], "contract-fields")
                    self.assertEqual(updated["description"], "Updated description")
                finally:
                    server.shutdown()
                    server.server_close()


if __name__ == "__main__":
    unittest.main()
