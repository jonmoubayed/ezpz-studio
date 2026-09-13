"""Exercise features that previously lived in different Studio builds."""
import json
import os
import threading
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

from backend.db import set_request_context, reset_request_context
from backend.server import create_runtime


class ConsolidatedBuildTests(unittest.TestCase):
    def test_notice_bridge_uses_workspace_key_through_saved_harness(self):
        with TemporaryDirectory() as directory, patch.dict(os.environ, {"EZPZ_SEED_DEMO": "false"}):
            root = Path(directory)
            runtime = create_runtime(root)
            self.addCleanup(runtime.shutdown)
            workspace = runtime.database.save_workspace("Notice")
            tokens = set_request_context(workspace["id"])
            try:
                runtime.credentials.update("openai", "mock-notice-workspace-key")
                doc = runtime.ingestor.ingest("contract.txt", b"Supplier: Acme")['document']
                processor = runtime.database.insert_processor("Notice integration")
                runtime.database.insert_processor_version({
                    "id": "pv_notice_integration", "processor_id": processor['id'], "version": 1,
                    "status": "published", "schema": {"type": "object", "properties": {"vendor": {"type": "string"}}},
                    "prompt": {"system": "Extract supplier"}, "parser": {"name": "native"},
                    "model": {"provider": "openai", "name": "gpt-4.1-mini"},
                    "harness": {"name": "custom", "plugin": "backend.notice_harness:run", "notice_root": str(root), "source_hashes": {}, "schema_hash": "test-schema"},
                    "normalization": {},
                })
                seen = []
                def bridge(*args, **kwargs):
                    seen.append(kwargs)
                    return SimpleNamespace(returncode=0, stdout=json.dumps({"terms": {"vendor": "Acme"}, "usage": {"input_tokens": 5, "output_tokens": 2}}))
                with patch("backend.notice_harness.shutil.which", return_value="node"), patch("backend.notice_harness.subprocess.run", side_effect=bridge):
                    extraction = runtime.extractions.extract_document(doc['id'], processor['id'], 1)
                self.assertEqual(extraction['status'], 'completed')
                self.assertEqual(seen[0]['env']['OPENAI_API_KEY'], 'mock-notice-workspace-key')
                self.assertEqual(json.loads(seen[0]['input'])['text'], 'Supplier: Acme')
                self.assertNotIn('mock-notice-workspace-key', json.dumps(extraction))
            finally:
                reset_request_context(tokens)

    def test_sync_and_background_evaluations_share_one_slot(self):
        with TemporaryDirectory() as directory, patch.dict(os.environ, {"EZPZ_SEED_DEMO": "true"}):
            runtime = create_runtime(Path(directory))
            self.addCleanup(runtime.shutdown)
            entered, release = threading.Event(), threading.Event()
            original = runtime.extractions._execute_dataset_run
            def wait(*args):
                entered.set()
                release.wait(5)
                return original(*args)
            with patch.object(runtime.extractions, '_execute_dataset_run', side_effect=wait):
                runtime.extractions.run_dataset('ds_invoice_eval_2026', background=True)
                self.assertTrue(entered.wait(2))
                try:
                    with self.assertRaisesRegex(ValueError, 'already running'):
                        runtime.extractions.run_dataset('ds_invoice_eval_2026')
                finally:
                    release.set()
                self.assertTrue(runtime.extractions.background_slots.acquire(timeout=10))
                runtime.extractions.background_slots.release()
            self.assertEqual(runtime.extractions.run_dataset('ds_invoice_eval_2026')['run']['status'], 'completed')
