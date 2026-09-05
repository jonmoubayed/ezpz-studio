import copy
import io
import json
import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from backend.confidence import mark_model_confidence, response_schema, strict_response_schema, valid_confidence
from backend.harness import _confidence, _merge_values
from backend.model import AnthropicModel, GeminiModel, OpenAICompatibleModel
from backend.pipeline import canonicalize, ExtractionService
from backend.server import create_runtime
from backend.tests.test_adapters import sample_ir

SCHEMA = {"type": "object", "properties": {
    "total": {"type": "number"}, "approved": {"type": "boolean"},
    "vendor": {"type": "object", "properties": {"name": {"type": "string"}}},
    "items": {"type": "array", "items": {"type": "object", "properties": {"price": {"type": "number"}}}},
}}
OUTPUT = {"total": {"value": 25, "confidence": .83}, "approved": {"value": False, "confidence": 0},
          "vendor": {"name": {"value": "Acme", "confidence": .94}},
          "items": {"value": [{"price": 25}], "confidence": .68}}


class ConfidenceTests(unittest.TestCase):
    def test_contract_preserves_nested_and_array_values_and_original_schema(self):
        original = copy.deepcopy(SCHEMA)
        wrapped = response_schema(SCHEMA)
        self.assertEqual(wrapped['properties']['items']['properties']['value']['anyOf'][0], SCHEMA['properties']['items'])
        self.assertIn('confidence', wrapped['properties']['vendor']['properties']['name']['properties'])
        strict = strict_response_schema(wrapped)
        array_item = strict['properties']['items']['properties']['value']['anyOf'][0]['items']
        self.assertFalse(array_item['additionalProperties'])
        self.assertEqual(array_item['required'], ['price'])
        self.assertEqual(SCHEMA, original)

    def test_invalid_or_missing_scores_remain_unknown(self):
        for value in [None, True, False, '0.8', '85%', -1, 1.1, float('nan'), float('inf')]:
            self.assertIsNone(valid_confidence(value))
        self.assertEqual(valid_confidence(0), 0)
        self.assertEqual(valid_confidence(1), 1)
        for raw in [25, {"value": 25}, {"value": 25, "confidence": 'high'}]:
            result = canonicalize({'total': raw}, SCHEMA, {'id': 'pv'}, sample_ir(), 'test').to_dict()
            self.assertIsNone(result['fields']['total']['confidence'])
            self.assertIsNone(result['fields']['total']['provenance']['confidence_source'])

    def test_adapters_request_and_parse_confidence_without_external_calls(self):
        text = json.dumps(OUTPUT)
        cases = [
            (OpenAICompatibleModel(api_key='test'), {'choices': [{'message': {'content': text}}]}, 'messages'),
            (OpenAICompatibleModel(provider='ollama', api_key='test', requires_api_key=False), {'choices': [{'message': {'content': text}}]}, 'messages'),
            (AnthropicModel(api_key='test'), {'content': [{'type': 'text', 'text': text}]}, 'messages'),
            (GeminiModel(api_key='test'), {'candidates': [{'content': {'parts': [{'text': text}]}}]}, 'contents'),
        ]
        for adapter, response, messages_key in cases:
            with self.subTest(provider=adapter.provider), patch('urllib.request.urlopen', return_value=io.BytesIO(json.dumps(response).encode())) as request:
                result = adapter.run(sample_ir(), SCHEMA, {})
                body = json.loads(request.call_args[0][0].data)
                self.assertIn('confidence', json.dumps(body[messages_key]))
                self.assertEqual(result.output['total']['confidence'], .83)
                self.assertEqual(result.output['total']['confidence_source'], 'model_reported')
                self.assertEqual(result.output['approved']['confidence'], 0)
                canonical = canonicalize(result.output, SCHEMA, {'id': 'pv'}, sample_ir(), adapter.name).to_dict()
                self.assertEqual(canonical['fields']['vendor.name']['confidence'], .94)
                self.assertEqual(canonical['fields']['items']['value'], [{'price': 25}])
        forged = mark_model_confidence({'total': {'value': 25, 'confidence': .83, 'confidence_source': 'heuristic'}}, SCHEMA)
        self.assertEqual(forged['total']['confidence_source'], 'model_reported')

    def test_confidence_persists_and_cache_reuses_verified_metadata(self):
        with TemporaryDirectory() as directory, patch.dict(os.environ, {'EZPZ_SEED_DEMO': 'false'}):
            runtime = create_runtime(Path(directory))
            db = runtime.database
            doc = runtime.ingestor.ingest('confidence.txt', b'Total: $25.00', 'text/plain')['document']
            db.upsert_processor_draft('invoice-extractor', {'schema': SCHEMA, 'parser': {'name': 'native'}, 'model': {'provider': 'openai', 'name': 'test-model'}})
            version = db.publish_processor_draft('invoice-extractor')
            adapter = OpenAICompatibleModel(api_key='test', model='test-model')
            response = {'choices': [{'message': {'content': json.dumps(OUTPUT)}}]}
            with patch.object(runtime.extractions, '_model', return_value=adapter), patch('urllib.request.urlopen', return_value=io.BytesIO(json.dumps(response).encode())) as request:
                extracted = runtime.extractions.extract_document(doc['id'])
                saved = db.get_extraction(extracted['id'])
                field = saved['result']['fields']['total']
                self.assertEqual(field['confidence'], .83)
                self.assertEqual(field['provenance']['confidence_source'], 'model_reported')
                self.assertEqual(saved['fields']['total']['confidence'], .83)
                self.assertEqual(saved['fields']['total']['provenance']['confidence_source'], 'model_reported')
                self.assertEqual(saved['raw_response'], response)
                cached = runtime.extractions.extract_document(doc['id'])
                self.assertTrue(cached['cache_hit'])
                self.assertEqual(cached['result']['fields']['total']['provenance']['confidence_source'], 'model_reported')
                self.assertEqual(request.call_count, 1)
            # A plain response no longer acquires a default 75%, including aggregate metrics.
            with patch.object(runtime.extractions, '_model', return_value=adapter), patch('urllib.request.urlopen', return_value=io.BytesIO(json.dumps({'choices': [{'message': {'content': '{"total":25}'}}]}).encode())):
                missing = runtime.extractions.extract_document(doc['id'], force_refresh=True)
                self.assertIsNone(missing['result']['fields']['total']['confidence'])
                self.assertIsNone(missing['run']['metrics']['average_confidence'])
            legacy_key = __import__('hashlib').sha256(json.dumps({'document_sha256':doc['sha256'], 'processor_version_id':version['id'], 'cache_schema':2}, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
            self.assertNotEqual(ExtractionService._cache_key(doc, version), legacy_key)

    def test_harness_preserves_unknown_and_zero_confidence(self):
        self.assertEqual(_confidence({'value': {'value': 'test', 'confidence': .6}}), .6)
        self.assertEqual(_confidence({'a': {'value': 1, 'confidence': 0}, 'b': {'value': 2, 'confidence': 1}}), .5)
        self.assertIsNone(_merge_values({'value': 1}, {'value': 2})['confidence'])
        merged = _merge_values({'value': 1, 'confidence': .2}, {'value': None, 'confidence': .9})
        self.assertEqual(merged['value'], 1)
        self.assertEqual(merged['confidence'], .2)


if __name__ == '__main__':
    unittest.main()
