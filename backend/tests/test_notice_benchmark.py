import copy
import hashlib
import json
import os
import threading
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

from backend.cuad import digest, file_hash
from backend.cuad_import import LocalStudio
from backend.evaluation import score_extraction
from backend.notice_benchmark import explicit_date, notice_period
from backend.notice_fixtures import fixtures
from backend.notice_harness import run
from backend.notice_import import import_notice
from backend.server import make_server

KEYS = ['vendor','startDate','endDate','renewalDate','autoRenew','noticePeriod','noticeUnit','timezone','amount','currency','billing','months','seats','uplift','method','recipient','conditions']
SCHEMA = {'type':'object','properties':{k:{'type':'object','properties':{'value':{'type':'string'},'status':{'type':'string'},'excerpt':{'type':'string'},'location':{'type':'string'}}} for k in KEYS}}


class NoticeBenchmarkTests(unittest.TestCase):
    def test_dates_require_direct_evidence_and_days_are_not_assumed_calendar(self):
        self.assertIsNone(explicit_date('1/1/2027', [{'text':'one year after the Effective Date'}]))
        self.assertEqual(explicit_date('1/1/2027', [{'text':'January 1, 2027'}]), '2027-01-01')
        self.assertIsNone(explicit_date('[]/[]/2027', [{'text':'during 2027'}]))
        self.assertEqual(notice_period('30 days', [{'text':'thirty (30) days before renewal'}]), ('30', 'unclear'))
        self.assertEqual(notice_period('10 days', [{'text':'ten business days before renewal'}]), ('10', 'business days'))
        self.assertIsNone(notice_period('60 / 180 days', [{'text':'depending on rate schedule'}]))
        self.assertIsNone(notice_period('5 days', [{'text':'within 5 days of the conclusion'}]))

    def test_fixtures_cover_all_notice_fields_and_score_absence_and_conflicts(self):
        with TemporaryDirectory() as directory:
            docs = fixtures(directory, KEYS)
            self.assertEqual(len(docs), 10)
            for d in docs:
                self.assertEqual(set(d['value']), set(KEYS))
                self.assertIn('FICTIONAL TEST CONTRACT', Path(d['path']).read_text())
                fields = {f'{k}.{leaf}': {'value': value} for k, term in d['value'].items() for leaf, value in term.items()}
                score = score_extraction({'fields': fields}, {'value':d['value']}, SCHEMA)
                self.assertEqual(score['metrics']['field_accuracy'], 1)
            wrong = next(d for d in docs if d['title'].endswith('amended-notice'))
            score = score_extraction({'fields': {'noticePeriod.value': {'value':'30'}}}, {'value': wrong['value']}, SCHEMA)
            self.assertEqual(score['fields']['noticePeriod.value']['status'], 'incorrect')
            missing = next(d for d in docs if d['title'].endswith('per-seat-without-total'))
            score = score_extraction({'fields': {'amount.value': {'value':'12000'}}}, {'value': missing['value']}, SCHEMA)
            self.assertEqual(score['fields']['amount.value']['status'], 'hallucinated')

    def test_harness_passes_original_pdf_and_saved_prompt_without_labels(self):
        with TemporaryDirectory() as directory:
            root = Path(directory); (root/'source.ts').write_text('version one')
            config = {'notice_root':directory,'schema_hash':'schema','source_hashes':{'source.ts':file_hash(root/'source.ts')}}
            response = SimpleNamespace(returncode=0, stdout=json.dumps({'terms':{'vendor':{'value':'Supplier'}},'usage':{'input_tokens':12}}))
            with patch('backend.notice_harness.subprocess.run', return_value=response) as invoke:
                result = run(None, SCHEMA, {'system':'saved prompt'}, None, config, model_config={'provider':'openai','name':'gpt-4.1-mini'}, source_document={'id':'doc','filename':'contract.pdf','mime_type':'application/pdf'},source_bytes=b'%PDF-test-source')
            payload = json.loads(invoke.call_args.kwargs['input'])
            self.assertEqual(payload['instructions'], 'saved prompt')
            self.assertNotIn('ground_truth', payload)
            self.assertNotIn('text', payload)
            import base64
            self.assertEqual(base64.b64decode(payload['base64']), b'%PDF-test-source')
            self.assertEqual(result.output['vendor']['value'], 'Supplier')
            (root/'source.ts').write_text('changed')
            with self.assertRaisesRegex(ValueError, 'code changed'):
                run(None, SCHEMA, {}, None, config, model_config={'provider':'openai'},source_document={},source_bytes=b'pdf')

    def test_api_import_keeps_cohorts_separate_and_is_idempotent(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            docs = fixtures(root/'fixtures', KEYS)[:3]
            docs[0].update(cohort='real',split='dev')
            docs[1].update(cohort='real',split='test')
            for d in docs: d['sha256'] = file_hash(d['path'])
            config = {'schema':SCHEMA,'prompt':{'system':'Notice test'},'model':{'provider':'openai','name':'gpt-4.1-mini'},'parser':{'name':'native','version':'1'},'harness':{'name':'direct'},'normalization':{}}
            bundle = {'fingerprint':digest(docs),'documents':docs,'processor':config}
            with patch.dict(os.environ,{'EZPZ_DATABASE_URL':'sqlite:///'+str(root/'test.db'),'EZPZ_BLOB_ROOT':str(root/'blobs'),'EZPZ_SEED_DEMO':'false'}):
                server = make_server(root,port=0)
            thread = threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            try:
                api = LocalStudio('http://127.0.0.1:'+str(server.server_address[1]))
                first = import_notice(api,bundle,root,progress=lambda _:None)
                second = import_notice(api,bundle,root,progress=lambda _:None)
                self.assertEqual(second['uploaded'],0)
                self.assertEqual(second['new_ground_truth_revisions'],0)
                db = server.RequestHandlerClass.runtime.database
                self.assertEqual(len(db.list_runs()),0)
                for key in ('dev','holdout','regression'):
                    self.assertEqual(len(db.list_dataset_documents(first['datasets'][key])),1)
                for d in first['documents']:
                    self.assertEqual(db.get_document(d['id'])['mime_type'],'text/plain')
                doc_id=first['documents'][0]['id'];db.save_ground_truth(doc_id,{'vendor':{'value':'User edit'}})
                with self.assertRaisesRegex(ValueError,'was edited'):
                    import_notice(api,bundle,root,progress=lambda _:None)
                self.assertEqual(db.get_ground_truth(doc_id)['value']['vendor']['value'],'User edit')
            finally:
                server.shutdown();server.server_close();thread.join()


if __name__ == '__main__':
    unittest.main()
