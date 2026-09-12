"""Harness tools through MCP and the real API, with isolated storage/providers."""

import asyncio
import threading
import unittest
import sys
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch

from backend.tests import test_mcp as base_tests

HAS_MCP = base_tests.HAS_MCP
from backend.models import ModelResult

if HAS_MCP:
    from mcp import Client
    from mcp.client.stdio import StdioServerParameters
    from backend.mcp_server import create_mcp

SCHEMA = {"type": "object", "properties": {"total": {"type": "number"}}, "required": ["total"]}


@unittest.skipUnless(HAS_MCP, "Install the MCP extra")
class HarnessMCPTests(unittest.IsolatedAsyncioTestCase):
    setUp = base_tests.MCPTests.setUp
    tearDown = base_tests.MCPTests.tearDown
    call = base_tests.MCPTests.call
    completed = base_tests.MCPTests.completed

    async def prepare(self, client, recipe="verify"):
        catalog = await self.call(client, "list_harnesses")
        spec = next(item["harness"] for item in catalog["recipes"] if item["id"] == recipe)
        imported = await self.call(client, "import_documents", paths=["invoice.txt"], dataset_name="Harness test", dry_run=False)
        processor = (await self.call(client, "create_processor", name="Harness processor", config={
            "schema": SCHEMA, "parser": {"name": "native"}, "model": {"provider": "local", "name": "deterministic-local"}, "harness": spec}))["processor"]["id"]
        return processor, imported["dataset"]["id"], imported["files"][0]["document_id"], spec

    async def poll_job(self, client, job_id, statuses):
        for _ in range(150):
            job = (await self.call(client, "get_job", job_id=job_id))["job"]
            if job["status"] in statuses:
                return job
            await asyncio.sleep(.03)
        self.fail(f"Job did not reach {statuses}: {job}")

    async def test_stdio_recipes_validation_candidates_and_trace(self):
        params = StdioServerParameters(command=sys.executable, args=["-m", "backend.mcp_server", "--api-url", self.api.api_url,
            "--import-root", str(self.root), "--author", "harness-test"], cwd=Path(__file__).resolve().parents[2])
        async with Client(params) as client:
            tools = {t.name: t for t in (await client.list_tools()).tools}
            self.assertTrue(tools["validate_harness"].annotations.read_only_hint)
            self.assertFalse(tools["control_evaluation"].annotations.read_only_hint)
            self.assertIn("harnesses", (await self.call(client, "workspace_status"))["capabilities"])
            catalog = await self.call(client, "list_harnesses")
            self.assertEqual(len(catalog["recipes"]), 6)
            for item in catalog["recipes"]:
                self.assertTrue((await self.call(client, "validate_harness", harness=item["harness"], schema=SCHEMA))["valid"])
            processor, dataset, document, spec = await self.prepare(client)
            draft = self.runtime.database.upsert_processor_draft(processor, {"prompt": {"extraction": "User's unsaved work"}})
            bad = deepcopy(spec)
            bad["flow"]["steps"][0]["fields"] = ["missing"]
            for tool, args in [("validate_harness", {"harness": bad, "schema": SCHEMA}),
                               ("save_harness_candidate", {"processor": processor, "expected_version": 1, "harness": bad}),
                               ("save_processor_candidate", {"processor": processor, "expected_version": 1, "config": {"harness": bad}})]:
                self.assertTrue((await client.call_tool(tool, args)).is_error)
            bad = deepcopy(spec)
            bad["flow"]["routing"] = {"edges": [{"id": "bad", "source": "block:extract", "target": "block:extract"}]}
            self.assertTrue((await client.call_tool("validate_harness", {"harness": bad, "schema": SCHEMA})).is_error)
            saved = (await self.call(client, "save_harness_candidate", processor=processor, expected_version=1, harness=spec))["version"]
            self.assertEqual(saved["version"], 2)
            self.assertEqual(saved["author"], "mcp:harness-test")
            self.assertEqual(saved["schema"], SCHEMA)
            self.assertEqual(self.runtime.database.get_processor_draft(processor)["prompt"], draft["prompt"])
            self.assertTrue((await client.call_tool("save_harness_candidate", {"processor": processor, "expected_version": 1, "harness": spec})).is_error)
            job = (await self.call(client, "start_evaluation", dataset_id=dataset, processor=processor, version=2, request_key="workflow"))["job"]
            run_id = await self.completed(client, job["id"])
            trace = await self.call(client, "get_run_steps", run_id=run_id, document_id=document, limit=100)
            kinds = {entry["step"]["kind"] for entry in trace["steps"]["items"]}
            self.assertIn("extract", kinds)
            self.assertIn("validate", kinds)
            first = await self.call(client, "get_run_steps", run_id=run_id, limit=1)
            self.assertEqual(first["steps"]["next_offset"], 1)
            empty = await self.call(client, "get_run_steps", run_id=run_id, document_id="missing")
            self.assertEqual(empty["steps"]["total"], 0)
            self.assertTrue((await client.call_tool("get_run_steps", {"run_id": run_id, "limit": 0})).is_error)

    async def test_pause_reconnect_resume_reuses_calls_and_cancel(self):
        entered, release = threading.Event(), threading.Event()
        calls = []
        class Model:
            name = "controlled"
            def run(self, ir, schema, prompt):
                calls.append(prompt)
                if len(calls) == 1:
                    entered.set()
                    if not release.wait(10):
                        raise TimeoutError("Test did not release model")
                return ModelResult({"total": {"value": 12.5, "confidence": .99}}, {})
        try:
            with patch.object(type(self.runtime.extractions), "_model_from_config", staticmethod(lambda config: Model())):
                async with Client(create_mcp(self.api)) as client:
                    processor, dataset, document, _ = await self.prepare(client)
                    job = (await self.call(client, "start_evaluation", dataset_id=dataset, processor=processor, version=1, request_key="pause"))["job"]
                    self.assertTrue(await asyncio.to_thread(entered.wait, 5))
                    running = (await self.call(client, "get_job", job_id=job["id"]))["job"]
                    run_id = running["result"]["run_id"]
                    partial = await self.call(client, "get_run_steps", run_id=run_id, document_id=document)
                    self.assertTrue(any(e["step"].get("attempts", [{}])[-1].get("status") == "running" for e in partial["steps"]["items"]))
                    paused = await self.call(client, "control_evaluation", run_id=run_id, action="pause")
                    self.assertEqual(paused["run"]["status"], "pausing")
                    release.set()
                    await self.poll_job(client, job["id"], {"paused"})
                    self.assertEqual(len(calls), 1)
                async with Client(create_mcp(self.api)) as client:
                    await self.call(client, "control_evaluation", run_id=run_id, action="resume")
                    final = await self.poll_job(client, job["id"], {"completed"})
                    self.assertEqual(final["result"]["run_id"], run_id)
                    self.assertEqual(len(calls), 2)
                    await self.call(client, "compare_runs", baseline_run_id=run_id, candidate_run_id=run_id)
                    self.assertTrue((await client.call_tool("control_evaluation", {"run_id": run_id, "action": "resume"})).is_error)
                    # Cancel a second paused run; it preserves the completed call.
                    calls.clear(); entered.clear(); release.clear()
                    job2 = (await self.call(client, "start_evaluation", dataset_id=dataset, processor=processor, version=1, request_key="cancel"))["job"]
                    self.assertTrue(await asyncio.to_thread(entered.wait, 5))
                    run2 = (await self.call(client, "get_job", job_id=job2["id"]))["job"]["result"]["run_id"]
                    await self.call(client, "control_evaluation", run_id=run2, action="pause")
                    release.set()
                    await self.poll_job(client, job2["id"], {"paused"})
                    await self.call(client, "control_evaluation", run_id=run2, action="cancel")
                    await self.poll_job(client, job2["id"], {"cancelled"})
                    self.assertEqual(len(calls), 1)
        finally:
            release.set()
            self.runtime.agent_jobs.shutdown()

    async def test_interruption_and_resume_refreshes_job_status(self):
        calls = []
        class Model:
            name = "transient"
            def run(self, ir, schema, prompt):
                calls.append(1)
                if len(calls) == 1:
                    raise TimeoutError("Provider response lost")
                return ModelResult({"total": {"value": 12.5, "confidence": .99}}, {})
        with patch.object(type(self.runtime.extractions), "_model_from_config", staticmethod(lambda config: Model())):
            async with Client(create_mcp(self.api)) as client:
                processor, dataset, document, _ = await self.prepare(client, "parsed")
                job = (await self.call(client, "start_evaluation", dataset_id=dataset, processor=processor, version=1, request_key="interrupt"))["job"]
                interrupted = await self.poll_job(client, job["id"], {"interrupted"})
                run_id = interrupted["result"]["run_id"]
                self.runtime.agent_jobs.recover()
                await self.call(client, "control_evaluation", run_id=run_id, action="resume")
                await self.poll_job(client, job["id"], {"completed"})
                trace = await self.call(client, "get_run_steps", run_id=run_id, document_id=document, limit=100)
                self.assertTrue(any(len(e["step"].get("attempts", [])) == 2 for e in trace["steps"]["items"]))
                self.assertEqual(len(calls), 2)
