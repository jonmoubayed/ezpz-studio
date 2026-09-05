"""Release regressions: use synthetic data and no hosted model requests."""
import io
import json
import os
import threading
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from backend.model import AnthropicModel, GeminiModel, OpenAICompatibleModel, DeterministicInvoiceModel
from backend.server import create_runtime, make_server
from backend.tests.test_adapters import sample_ir


class BetaTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {"EZPZ_SEED_DEMO": "true"}, clear=True)
        self.env.start()
        self.directory = TemporaryDirectory()
        self.root = Path(self.directory.name)

    def tearDown(self):
        self.directory.cleanup()
        self.env.stop()

    def test_static_files_origins_and_multipart(self):
        (self.root / '.env').write_text('SYNTHETIC_MARKER=not-a-secret\n')
        (self.root / 'private.txt').write_text('private marker')
        dist = self.root / 'dist'
        dist.mkdir()
        (dist / 'index.html').write_text('<h1>Public studio</h1>')
        (dist / 'escape.txt').symlink_to(self.root / 'private.txt')
        (dist / '.hidden').write_text('hidden')
        server = make_server(self.root, port=0)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        base = 'http://127.0.0.1:{}'.format(server.server_address[1])
        try:
            self.assertIn(b'Public studio', urlopen(base).read())
            for path in ['/.env', '/%2eenv', '/.hidden', '/escape.txt', '/private.txt', '/backend/server.py']:
                with self.assertRaises(HTTPError) as denied:
                    urlopen(base + path)
                self.assertIn(denied.exception.code, (403, 404))
            for headers in [{'Host': 'attacker.invalid'}, {'Origin': 'https://attacker.invalid'}, {'Origin': 'null'}]:
                with self.assertRaises(HTTPError) as denied:
                    urlopen(Request(base + '/v1/documents', headers=headers))
                self.assertEqual(denied.exception.code, 403)
            allowed = urlopen(Request(base + '/v1/ready', headers={'Origin': 'http://localhost:5180'}))
            self.assertEqual(allowed.headers['Access-Control-Allow-Origin'], 'http://localhost:5180')
            body = b'--test-boundary\r\nContent-Disposition: form-data; name="file"; filename="synthetic.txt"\r\nContent-Type: text/plain\r\n\r\nInvoice # TEST\r\n--test-boundary--\r\n'
            response = urlopen(Request(base + '/v1/documents', data=body, headers={'Content-Type': 'multipart/form-data; boundary=test-boundary'}))
            self.assertEqual(json.loads(response.read())['document']['filename'], 'synthetic.txt')
            (dist / 'index.html').unlink()
            with self.assertRaises(HTTPError) as no_build:
                urlopen(base + '/private.txt')
            self.assertEqual(no_build.exception.code, 404)
        finally:
            server.shutdown()
            server.server_close()
            worker.join()

    def test_provider_errors_never_become_successful_local_extractions(self):
        for factory in (AnthropicModel, GeminiModel, OpenAICompatibleModel):
            with self.subTest(provider=factory.__name__):
                with self.assertRaisesRegex(RuntimeError, 'no fallback model'):
                    factory().run(sample_ir(), {'type':'object','properties':{}}, {})
                with patch('urllib.request.urlopen', side_effect=URLError('synthetic outage')):
                    with self.assertRaisesRegex(RuntimeError, 'no fallback model'):
                        factory(api_key='synthetic').run(sample_ir(), {'type':'object','properties':{}}, {})

    def test_benchmark_is_frozen_before_extraction_and_fresh_is_default(self):
        runtime = create_runtime(self.root)
        db = runtime.database
        previous = db.get_ground_truth('doc_demo_invoice')
        model = DeterministicInvoiceModel()
        extract = model.run
        def modify_during_extraction(*args):
            db.save_ground_truth('doc_demo_invoice', {**previous['value'], 'total': 999999})
            return extract(*args)
        with patch.object(model, 'run', side_effect=modify_during_extraction), patch.object(runtime.extractions, '_model', return_value=model):
            first = runtime.extractions.run_dataset('ds_invoice_eval_2026')
        self.assertEqual(first['run']['evaluations'][0]['fields']['total']['expected'], previous['value']['total'])
        snapshot = first['run']['metadata']['benchmark_snapshot']
        self.assertEqual(snapshot['documents'][0]['ground_truth']['revision'], previous['revision'])
        second = runtime.extractions.run_dataset('ds_invoice_eval_2026')
        self.assertNotEqual(second['run']['metadata']['benchmark_snapshot']['fingerprint'], snapshot['fingerprint'])
        self.assertEqual(second['run']['metrics']['cache_hits'], 0)
        cached = runtime.extractions.run_dataset('ds_invoice_eval_2026', force_refresh=False)
        self.assertEqual(cached['run']['metrics']['cache_hits'], 1)
        self.assertEqual(cached['run']['metrics']['cost_usd'], 0)
        self.assertEqual(cached['run']['metadata']['benchmark_snapshot']['fingerprint'], second['run']['metadata']['benchmark_snapshot']['fingerprint'])

    def test_background_run_can_be_cancelled_and_reports_progress(self):
        runtime = create_runtime(self.root)
        second = runtime.ingestor.ingest('second.txt', b'Invoice # INV-SECOND\nTotal $50')['document']
        runtime.database.add_document_to_dataset('ds_invoice_eval_2026', second['id'])
        entered, finish = threading.Event(), threading.Event()
        model = DeterministicInvoiceModel()
        original = model.run
        def slow(*args):
            entered.set()
            finish.wait(5)
            return original(*args)
        with patch.object(model, 'run', side_effect=slow), patch.object(runtime.extractions, '_model', return_value=model):
            run = runtime.extractions.run_dataset('ds_invoice_eval_2026', background=True)['run']
            try:
                self.assertTrue(entered.wait(3))
                with self.assertRaisesRegex(ValueError, 'already running'):
                    runtime.extractions.run_dataset('ds_invoice_eval_2026', background=True)
                self.assertEqual(runtime.database.cancel_run(run['id'])['status'], 'cancelling')
            finally:
                finish.set()
            for _ in range(100):
                saved = runtime.database.get_run(run['id'])
                if saved['status'] == 'cancelled':
                    break
                time.sleep(.02)
            self.assertEqual(saved['status'], 'cancelled')
            self.assertEqual(saved['metrics']['completed'], 1)
            self.assertEqual(saved['metrics']['documents'], 2)

    def test_restart_marks_unfinished_runs_and_preserves_completed_records(self):
        runtime = create_runtime(self.root)
        complete = runtime.extractions.run_dataset('ds_invoice_eval_2026')['run']
        pending = runtime.database.create_run(complete['processor_version_id'], 'dataset', dataset_id='ds_invoice_eval_2026')
        reopened = create_runtime(self.root)
        self.assertEqual(reopened.database.get_run(pending['id'])['status'], 'interrupted')
        saved = reopened.database.get_run(complete['id'])
        self.assertEqual(saved['status'], 'completed')
        self.assertEqual(saved['evaluations'], complete['evaluations'])
        self.assertEqual(saved['metadata'], complete['metadata'])

    def test_empty_benchmark_is_rejected(self):
        runtime = create_runtime(self.root)
        empty = runtime.database.insert_dataset('Empty')
        with self.assertRaisesRegex(ValueError, 'Add documents'):
            runtime.extractions.run_dataset(empty['id'])

    def test_hundred_document_benchmark_and_provider_failures_are_reported(self):
        runtime = create_runtime(self.root)
        dataset = runtime.database.insert_dataset('Larger beta benchmark')
        for index in range(100):
            document = runtime.ingestor.ingest('invoice-{}.txt'.format(index), 'Invoice # INV-{}\nTotal $75'.format(index).encode())['document']
            runtime.database.add_document_to_dataset(dataset['id'], document['id'])
            runtime.database.save_ground_truth(document['id'], {'total':75})
        run = runtime.extractions.run_dataset(dataset['id'])['run']
        self.assertEqual(run['status'], 'completed')
        self.assertEqual(run['metrics']['completed'], 100)
        self.assertEqual(run['metrics']['cache_hits'], 0)
        self.assertEqual(len(run['metadata']['benchmark_snapshot']['documents']), 100)
        with patch.object(runtime.extractions, '_model', side_effect=RuntimeError('Synthetic provider failure')):
            failed = runtime.extractions.run_dataset('ds_invoice_eval_2026')['run']
        self.assertEqual(failed['status'], 'failed')
        self.assertEqual(failed['metrics']['failed'], 1)
        self.assertEqual(failed['metrics']['failures'][0]['error'], 'Synthetic provider failure')

    def test_submitted_processor_version_is_pinned_and_failed_submission_releases_slot(self):
        runtime = create_runtime(self.root)
        resolve = runtime.database.resolve_processor_version
        with patch.object(runtime.database, 'resolve_processor_version', wraps=resolve) as calls:
            run = runtime.extractions.run_dataset('ds_invoice_eval_2026')['run']
        expected = runtime.database.get_processor_version(run['processor_version_id'])
        for call in calls.call_args_list[1:]:
            self.assertEqual(call.args, (expected['processor_id'], expected['version']))
        with patch.object(runtime.database, 'create_run', side_effect=RuntimeError('write unavailable')):
            with self.assertRaisesRegex(RuntimeError, 'write unavailable'):
                runtime.extractions.run_dataset('ds_invoice_eval_2026', background=True)
        self.assertTrue(runtime.extractions.background_slots.acquire(blocking=False))
        runtime.extractions.background_slots.release()
