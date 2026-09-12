"""Real MCP transport and HTTP integration using disposable workspaces only."""

import asyncio
import json
import os
import sys
import threading
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from backend.server import make_server
from backend.collaboration import RevisionConflict, save_candidate
from backend.db import Database

try:
    from mcp import Client
    from mcp.client.stdio import StdioServerParameters
    HAS_MCP = True
except ImportError:
    HAS_MCP = False

if HAS_MCP:
    from backend.mcp_server import StudioClient, create_mcp


@unittest.skipUnless(HAS_MCP, "Install requirements-mcp.txt to run MCP integration tests")
class MCPTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.env = patch.dict(os.environ, {"EZPZ_SEED_DEMO": "false", "EZPZ_DATABASE_URL": f"sqlite:///{self.root}/test.db", "EZPZ_BLOB_ROOT": str(self.root / "blobs")})
        self.env.start()
        self.server = make_server(self.root, port=0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.api = StudioClient(f"http://127.0.0.1:{self.server.server_address[1]}", self.root, "http://127.0.0.1:5180", "test-agent")
        self.runtime = self.server.RequestHandlerClass.runtime
        (self.root / "invoice.txt").write_text("INVOICE\nInvoice Number: INV-101\nVendor: Example Co\nTotal: $12.50\n", encoding="utf-8")
        (self.root / "labels.csv").write_text('filename,Invoice,Total,Flag,Empty,Nested\ninvoice.txt,INV-101,12.5,false,null,0\n')

    def tearDown(self):
        self.api.http.close()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.env.stop()
        self.temp.cleanup()

    async def call(self, client, tool_name, **arguments):
        result = await client.call_tool(tool_name, arguments)
        self.assertFalse(result.is_error, result.content)
        return result.structured_content

    async def completed(self, client, job_id):
        for _ in range(100):
            data = await self.call(client, "get_job", job_id=job_id)
            if data["job"]["status"] not in {"queued", "running"}:
                self.assertEqual(data["job"]["status"], "completed", data)
                return data["job"]["result"]["run_id"]
            await asyncio.sleep(0.05)
        self.fail("Evaluation job never completed")

    async def test_stdio_import_evaluate_compare_and_reconnect(self):
        launcher = os.environ.get("EZPZ_TEST_MCP_EXECUTABLE")
        params = StdioServerParameters(command=launcher or sys.executable, args=(["-m", "backend.mcp_server"] if not launcher else []) + ["--api-url", self.api.api_url, "--import-root", str(self.root), "--author", "test-agent"], cwd=self.root if launcher else Path(__file__).resolve().parents[2])
        async with Client(params) as client:
            tools = await client.list_tools()
            by_name = {t.name: t for t in tools.tools}
            self.assertTrue(by_name["get_document"].annotations.read_only_hint)
            self.assertFalse(by_name["save_expected_values"].annotations.read_only_hint)
            status = await self.call(client, "workspace_status")
            before = status["revision"]
            arguments = {"paths": ["invoice.txt"], "dataset_name": "Invoices", "annotations_file": "labels.csv", "column_mapping": {"Invoice": "invoice_number", "Total": "total", "Flag": "approved", "Empty": "empty", "Nested": "detail.count"}}
            preview = await self.call(client, "import_documents", **arguments)
            self.assertTrue(preview["dry_run"])
            self.assertEqual(self.runtime.database.list_documents(), [])
            self.assertEqual(self.runtime.database.list_datasets(), [])
            imported = await self.call(client, "import_documents", **arguments, dry_run=False)
            self.assertEqual(imported["errors"], 0, imported)
            dataset_id = imported["dataset"]["id"]
            document_id = imported["files"][0]["document_id"]
            doc = await self.call(client, "get_document", document_id=document_id)
            self.assertEqual(doc["ground_truth"]["annotation_status"], "unverified")
            self.assertEqual(doc["ground_truth"]["author"], "mcp:test-agent")
            truth = doc["ground_truth"]["value"]
            self.assertIs(truth["approved"], False)
            self.assertIsNone(truth["empty"])
            self.assertEqual(truth["detail"], {"count": 0})
            duplicate = await self.call(client, "import_documents", **arguments, dry_run=False)
            self.assertTrue(duplicate["files"][0]["duplicate"])
            self.assertEqual(duplicate["files"][0]["annotation_action"], "preserve_existing")
            self.assertEqual(len(self.runtime.database.list_ground_truth_revisions(document_id)), 1)
            self.assertEqual(len(self.runtime.database.list_dataset_documents(dataset_id)), 1)
            self.assertGreater((await self.call(client, "workspace_status"))["revision"], before)
            proc = await self.call(client, "create_processor", name="Invoice MCP", config={"schema": {"type": "object", "properties": {"invoice_number": {"type": "string"}, "total": {"type": "number"}}}, "parser": {"name": "native"}, "model": {"provider": "local", "name": "deterministic-local"}})
            processor = proc["processor"]["id"]
            unverified_job = await self.call(client, "start_evaluation", dataset_id=dataset_id, processor=processor, version=1, request_key="unverified")
            unverified_run = await self.completed(client, unverified_job["job"]["id"])
            unscored = await self.call(client, "get_run", run_id=unverified_run, failures_only=False)
            self.assertEqual(unscored["run"]["metrics"]["scored_documents"], 0)
            self.assertEqual(unscored["results"]["items"][0]["status"], "unscored")
            await self.call(client, "save_expected_values", document_id=document_id, value=truth, expected_revision=1, verified=True)
            conflict = await client.call_tool("save_expected_values", {"document_id": document_id, "value": {"total": 999}, "expected_revision": 1})
            self.assertTrue(conflict.is_error)
            self.assertEqual(self.runtime.database.get_ground_truth(document_id)["value"], truth)
            baseline = await self.call(client, "start_evaluation", dataset_id=dataset_id, processor=processor, version=1, request_key="baseline")
            again = await self.call(client, "start_evaluation", dataset_id=dataset_id, processor=processor, version=1, request_key="baseline")
            self.assertEqual(again["job"]["id"], baseline["job"]["id"])
            baseline_id = await self.completed(client, baseline["job"]["id"])
            await self.call(client, "save_processor_candidate", processor=processor, expected_version=1, config={"prompt": {"extraction": "Extract the invoice fields carefully."}})
            stale = await client.call_tool("save_processor_candidate", {"processor": processor, "expected_version": 1, "config": {}})
            self.assertTrue(stale.is_error)
            candidate = await self.call(client, "start_evaluation", dataset_id=dataset_id, processor=processor, version=2, request_key="candidate")
            candidate_id = await self.completed(client, candidate["job"]["id"])
            comparison = await self.call(client, "compare_runs", baseline_run_id=baseline_id, candidate_run_id=candidate_id)
            self.assertEqual(comparison["baseline_run_id"], baseline_id)
            report = await self.call(client, "get_run", run_id=candidate_id)
            self.assertEqual(report["run"]["metrics"]["scored_documents"], 1)
            self.assertIn(candidate_id, (await self.call(client, "studio_link", run_id=candidate_id))["url"])
            mismatch = await client.call_tool("compare_runs", {"baseline_run_id": unverified_run, "candidate_run_id": candidate_id})
            self.assertTrue(mismatch.is_error)
        async with Client(params, mode="legacy") as reconnected:
            job = await self.call(reconnected, "get_job", job_id=candidate["job"]["id"])
            self.assertEqual(job["job"]["result"]["run_id"], candidate_id)

    async def test_import_validation_paths_json_and_partial_results(self):
        with TemporaryDirectory() as outside:
            secret = Path(outside) / "outside.txt"
            secret.write_text("outside")
            (self.root / "escape.txt").symlink_to(secret)
            for path in [str(secret), "escape.txt", "../outside.txt"]:
                with self.assertRaises((ValueError, FileNotFoundError)):
                    self.api.import_documents([path], "invalid", dry_run=False)
        self.assertEqual(self.runtime.database.list_datasets(), [])
        (self.root / "bad.json").write_text('{"missing.txt": {"total": 1}}')
        with self.assertRaisesRegex(ValueError, "do not match"):
            self.api.import_documents(["invoice.txt"], "invalid", annotations_file="bad.json", dry_run=False)
        self.assertEqual(self.runtime.database.list_documents(), [])
        (self.root / "truth.json").write_text('{"invoice.txt": {"total": 0, "ok": false, "empty": null}}')
        imported = self.api.import_documents(["invoice.txt"], "JSON", annotations_file="truth.json", verified=True, dry_run=False)
        doc_id = imported["files"][0]["document_id"]
        self.assertEqual(self.runtime.database.get_ground_truth(doc_id)["annotation_status"], "complete")
        # A failed file is explicit, while successful files remain safely retryable.
        with patch.object(self.api, "request", wraps=self.api.request) as request:
            original = self.api.request
            def fail_upload(path, method="GET", **kwargs):
                if method == "POST" and path == "documents":
                    raise ValueError("test upload failure")
                return request._mock_wraps(path, method, **kwargs)
            request.side_effect = fail_upload
            result = self.api.import_documents(["invoice.txt"], None, dataset_id=imported["dataset"]["id"], dry_run=False)
        self.assertEqual(result["errors"], 1)
        self.assertEqual(result["imported"], 0)

    async def test_folder_import_and_tool_discovery(self):
        folder = self.root / "batch"
        folder.mkdir()
        (folder / "a.txt").write_text("same document")
        (folder / "b.txt").write_text("same document")
        (folder / "labels.csv").write_text("ignored,sidecar")
        preview = self.api.import_documents(["batch"], "Folder")
        self.assertEqual(preview["count"], 2)
        self.assertEqual([f["duplicate"] for f in preview["files"]], [False, True])
        result = self.api.import_documents(["batch"], "Folder", dry_run=False)
        self.assertEqual(result["errors"], 0)
        self.assertEqual(len(self.runtime.database.list_dataset_documents(result["dataset"]["id"])), 1)
        async with Client(create_mcp(self.api)) as client:
            listing = await self.call(client, "list_items", kind="documents", limit=1)
            self.assertEqual(listing["total"], 1)
            dataset = await self.call(client, "get_dataset", dataset_id=result["dataset"]["id"], limit=1)
            self.assertEqual(dataset["documents"]["total"], 1)
            invalid = await client.call_tool("list_items", {"kind": "documents", "limit": 0})
            self.assertTrue(invalid.is_error)
            with patch("backend.mcp_server.webbrowser.open", return_value=True) as opened:
                link = await self.call(client, "open_in_studio", document_id=listing["items"][0]["id"])
                self.assertTrue(link["opened"])
                opened.assert_called_once_with(link["url"])

    async def test_atomic_revision_checks_across_database_connections(self):
        doc = self.runtime.ingestor.ingest("race.txt", b"race")["document"]
        second = Database(self.runtime.database.path)
        barrier = threading.Barrier(2)
        def write(db):
            barrier.wait()
            try:
                db.save_ground_truth(doc["id"], {"value": 1}, expected_revision=0)
                return "saved"
            except RevisionConflict:
                return "conflict"
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(2) as pool:
            a, b = pool.submit(write, self.runtime.database), pool.submit(write, second)
            self.assertEqual(sorted([a.result(), b.result()]), ["conflict", "saved"])
        processor = self.runtime.database.get_processor("invoice-extractor")
        draft = self.runtime.database.upsert_processor_draft(processor["id"], {"prompt": {"extraction": "User draft"}})
        version = save_candidate(self.runtime.database, processor["id"], {"prompt": {"extraction": "Agent candidate"}}, 1, "mcp:test")
        self.assertEqual(version["author"], "mcp:test")
        self.assertEqual(self.runtime.database.get_processor_draft(processor["id"]), draft | {"next_version": 3})
        with self.assertRaises(RevisionConflict):
            save_candidate(second, processor["id"], {}, 1)

    async def test_jobs_failed_conflicting_keys_and_restart_recovery(self):
        dataset = self.runtime.database.insert_dataset("Failures")
        payload = {"dataset_id": dataset["id"], "processor": "invoice-extractor", "version": 1, "request_key": "failure"}
        with patch.object(self.runtime.extractions, "run_dataset", side_effect=RuntimeError("test failure")):
            job = self.runtime.agent_jobs.start(payload)
            for _ in range(100):
                state = self.runtime.agent_jobs.get(job["id"])
                if state["status"] == "failed":
                    break
                await asyncio.sleep(0.01)
            self.assertEqual(state["status"], "failed")
            self.assertIn("test failure", state["error"])
        with self.assertRaises(RevisionConflict):
            self.runtime.agent_jobs.start({**payload, "version": 2})
        self.runtime.database._execute("UPDATE agent_jobs SET status = 'running' WHERE id = ?", (job["id"],))
        self.runtime.agent_jobs.recover()
        self.assertEqual(self.runtime.agent_jobs.get(job["id"])["status"], "interrupted")


if __name__ == "__main__":
    unittest.main()
