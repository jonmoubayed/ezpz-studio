import json
import os
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from unittest.mock import patch

from backend.server import make_server, create_runtime
from backend.db import set_request_context, reset_request_context


class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.env = patch.dict(os.environ, {"EZPZ_SEED_DEMO": "true"})
        self.env.start()
        self.server = make_server(Path(self.directory.name), port=0)
        self.runtime = self.server.RequestHandlerClass.runtime
        self.base = f"http://127.0.0.1:{self.server.server_port}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.env.stop()
        self.directory.cleanup()

    def api(self, path, body=None, workspace=None, method=None):
        headers = {"Content-Type": "application/json", "Origin": self.base, "X-Ezpz-Settings": "1"}
        if workspace:
            headers["X-Ezpz-Workspace"] = workspace
        req = Request(self.base + "/v1" + path, data=json.dumps(body).encode() if body is not None else None,
                      headers=headers, method=method)
        with urlopen(req) as response:
            return json.load(response)

    def create(self, name="Finance"):
        return self.api("/workspaces", {"name": name})["workspace"]["id"]

    def test_create_rename_validate_and_preserve_after_restart(self):
        original = self.api("/documents")["documents"]
        ws = self.create()
        self.assertEqual(self.api("/workspaces")["workspaces"][0]["name"], "My workspace")
        for name in (" ", "x" * 81, "FINANCE", 42):
            with self.assertRaises(HTTPError) as error:
                self.api("/workspaces", {"name": name})
            self.assertEqual(error.exception.code, 400)
        renamed = self.api(f"/workspaces/{ws}", {"name": "Accounts"}, method="PATCH")
        self.assertEqual(renamed["workspace"]["name"], "Accounts")
        restarted = create_runtime(Path(self.directory.name))
        try:
            self.assertEqual(restarted.database.get_workspace(ws)["name"], "Accounts")
            self.assertEqual(restarted.database.list_documents(), original)
        finally:
            restarted.shutdown()

    def test_records_and_sources_are_scoped_and_concurrent_requests_stay_separate(self):
        ws = self.create()
        document = self.api("/documents")["documents"][0]
        processor = self.api("/processors")["processors"][0]
        for collection in ("documents", "datasets", "processors", "runs", "eval-groups"):
            self.assertEqual(self.api(f"/{collection}", workspace=ws)[collection.replace("-", "_")], [])
        for path in (f"/documents/{document['id']}", f"/documents/{document['id']}/source", f"/processors/{processor['id']}"):
            with self.assertRaises(HTTPError) as error:
                self.api(path, workspace=ws)
            self.assertEqual(error.exception.code, 404)
        ds = self.api("/datasets", {"name": "Workspace dataset"}, workspace=ws)["dataset"]
        self.assertNotIn(ds["id"], [d["id"] for d in self.api("/datasets")["datasets"]])
        def read(index):
            return len(self.api("/documents", workspace=ws if index % 2 else None)["documents"])
        with ThreadPoolExecutor(max_workers=6) as pool:
            self.assertEqual(list(pool.map(read, range(24))), [1, 0] * 12)
        self.assertEqual(self.api(f"/documents?workspace_id={ws}")["documents"], [])
        with self.assertRaises(HTTPError) as error:
            self.api("/documents?workspace_id=missing")
        self.assertEqual(error.exception.code, 404)
        self.assertEqual(len(self.api("/workspaces?workspace_id=missing")["workspaces"]), 2)

    def test_credentials_and_background_jobs_remain_in_their_workspace(self):
        ws = self.create()
        self.api("/settings/credentials/openai", {"api_key": "test-default-key"})
        self.api("/settings/credentials/openai", {"api_key": "test-finance-key"}, workspace=ws)
        tokens = set_request_context(ws)
        try:
            self.assertEqual(self.runtime.resolve_credential("OPENAI_API_KEY"), "test-finance-key")
            doc = self.runtime.ingestor.ingest("example.txt", b"Invoice total 25")['document']
            ds = self.runtime.database.insert_dataset("Test")
            self.runtime.database.add_document_to_dataset(ds['id'], doc['id'])
            processor = self.runtime.database.insert_processor("Test processor")
            version = self.runtime.database.insert_processor_version({
                "id": "test-workspace-version", "processor_id": processor['id'], "version": 1,
                "status": "published", "schema": {"type": "object", "properties": {}},
                "prompt": {}, "parser": {"name": "native"},
                "model": {"provider": "local", "name": "deterministic-local"}, "harness": {}, "normalization": {},
            })
            job = self.runtime.agent_jobs.start({"request_key": "workspace-test", "dataset_id": ds['id'], "processor": processor['id'], "version": 1})
        finally:
            reset_request_context(tokens)
        self.runtime.agent_jobs.shutdown()
        self.assertEqual(self.runtime.resolve_credential("OPENAI_API_KEY"), "test-default-key")
        with self.assertRaises(ValueError):
            self.runtime.agent_jobs.get(job['id'])
        tokens = set_request_context(ws)
        try:
            result = self.runtime.agent_jobs.get(job['id'])
            self.assertEqual(result['status'], 'completed', result)
            self.assertEqual(len(self.runtime.database.list_runs()), 1)
        finally:
            reset_request_context(tokens)
        self.assertEqual(self.runtime.database.list_runs(), [])
