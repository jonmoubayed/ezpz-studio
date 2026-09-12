import base64
import copy
import io
import json
import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from backend.confidence import response_schema
from backend.grounding import model_output, original_document_ir
from backend.model import AnthropicModel, GeminiModel, OpenAICompatibleModel
from backend.models import DocumentIR
from backend.pipeline import canonicalize
from backend.server import create_runtime

SCHEMA = {"type": "object", "properties": {
    "total": {"type": "number"},
    "vendor": {"type": "object", "properties": {"name": {"type": "string"}}},
    "items": {"type": "array", "items": {"type": "string"}},
}}
BOX = {"page": 1, "bbox": [.1, .2, .4, .3], "text": "$25.00"}
OUTPUT = {"total": {"value": 25, "confidence": .8, "evidence": [BOX]},
          "vendor": {"name": {"value": "Acme", "confidence": .9, "evidence": [BOX]}},
          "items": {"value": ["Widget"], "confidence": .7, "evidence": [BOX, {**BOX, "page": 2}]}}
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=')


def source_ir(mime="application/pdf"):
    return DocumentIR("doc", {"name": "none", "status": "unavailable"}, {
        "page_count": 2,
        "source_input": {"mime_type": mime, "data": base64.b64encode(PNG).decode(), "filename": "source"},
    }, [])


class DirectGroundingTests(unittest.TestCase):
    def test_visual_contract_covers_nested_fields_and_arrays_without_mutating_schema(self):
        original = copy.deepcopy(SCHEMA)
        wrapped = response_schema(SCHEMA, include_evidence=True)
        self.assertIn("evidence", wrapped["properties"]["vendor"]["properties"]["name"]["required"])
        self.assertIn("evidence", wrapped["properties"]["items"]["required"])
        self.assertEqual(original, SCHEMA)
        self.assertNotIn("evidence", response_schema(SCHEMA)["properties"]["total"]["properties"])

    def test_all_providers_attach_source_request_boxes_and_preserve_direct_evidence(self):
        text = json.dumps(OUTPUT)
        cases = [
            (OpenAICompatibleModel(api_key="test"), {"choices": [{"message": {"content": text}}]}),
            (AnthropicModel(api_key="test"), {"content": [{"type": "text", "text": text}]}),
            (GeminiModel(api_key="test"), {"candidates": [{"content": {"parts": [{"text": text}]}}]}),
        ]
        for adapter, response in cases:
            with self.subTest(provider=adapter.provider), patch("urllib.request.urlopen", return_value=io.BytesIO(json.dumps(response).encode())) as request:
                ir = source_ir()
                result = adapter.run(ir, SCHEMA, {"structured_outputs": True})
                payload = json.loads(request.call_args.args[0].data)
                self.assertIn(ir.metadata["source_input"]["data"], json.dumps(payload))
                self.assertIn("normalized to [0,1]", json.dumps(payload))
                if adapter.provider == "openai":
                    contract = payload["response_format"]["json_schema"]["schema"]
                    self.assertIn("evidence", contract["properties"]["total"]["required"])
                elif adapter.provider == "gemini":
                    self.assertIn("evidence", payload["generationConfig"]["responseJsonSchema"]["properties"]["total"]["required"])
                canonical = canonicalize(result.output, SCHEMA, {"id": "pv"}, ir, adapter.name)
                self.assertEqual(canonical.fields["total"].evidence[0].bbox, BOX["bbox"])
                self.assertEqual(canonical.fields["total"].evidence[0].metadata["bbox_source"], "model")
                self.assertEqual(len(canonical.fields["items"].evidence), 2)
                self.assertEqual(result.raw_response, response)
    def test_text_input_does_not_request_visual_boxes(self):
        ir = source_ir("text/plain")
        ir.metadata["source_input"]["data"] = base64.b64encode(b"Total $25").decode()
        payload = GeminiModel(api_key="test").request_payload(ir, SCHEMA, {"structured_outputs": True})
        self.assertNotIn("evidence", payload["generationConfig"]["responseJsonSchema"]["properties"]["total"]["properties"])
        self.assertNotIn("bbox", json.dumps(payload))

    def test_bad_geometry_cannot_crash_or_become_a_citation(self):
        invalid = [None, "box", {}, {**BOX, "page": "1"}, {**BOX, "page": True}, {**BOX, "page": 0}, {**BOX, "page": 3},
                   *[{**BOX, "bbox": bbox} for bbox in ([0, 0, 1], [0, 0, 1, 1, 1], [False, 0, 1, 1],
                      [0, 0, float('nan'), 1], [0, 0, float('inf'), 1], [-.1, 0, 1, 1], [0, 0, 100, 100], [0, 0, 10**400, 1],
                      [.5, 0, .1, 1], [0, .5, 1, .5], ['0', 0, 1, 1])]]
        for evidence in (invalid, {}, "bad", 2):
            output = {"total": {"value": 25, "evidence": evidence}}
            direct = model_output(output, SCHEMA, source_ir())
            self.assertEqual(direct["total"]["evidence"], [])
            result = canonicalize(output, SCHEMA, {"id": "pv"}, source_ir(), "test")
            self.assertEqual(result.fields["total"].evidence, [])
        spoof = {**BOX, "metadata": {"bbox_source": "parser"}, "block_id": "fake"}
        direct = model_output({"total": {"value": 25, "evidence": [spoof, BOX]}}, SCHEMA, source_ir())
        self.assertEqual(len(direct["total"]["evidence"]), 1)
        self.assertEqual(direct["total"]["evidence"][0]["metadata"]["bbox_source"], "model")
        self.assertNotIn("block_id", direct["total"]["evidence"][0])
        direct = model_output({"total": {"value": None, "evidence": [BOX]}}, SCHEMA, source_ir())
        self.assertEqual(direct["total"]["evidence"], [])
        image = model_output(OUTPUT, SCHEMA, source_ir("image/png"))
        self.assertEqual(len(image["items"]["evidence"]), 1)

    def test_original_input_preparation_and_unsupported_adapter(self):
        document = {"id": "doc", "filename": "source.png", "mime_type": "image/png"}
        ir = original_document_ir(document, PNG)
        self.assertEqual(ir.metadata["page_count"], 1)
        self.assertEqual(base64.b64decode(ir.metadata["source_input"]["data"]), PNG)
        with patch("urllib.request.urlopen") as request:
            with self.assertRaisesRegex(ValueError, "does not support direct"):
                OpenAICompatibleModel(provider="ollama", requires_api_key=False).run(ir, SCHEMA, {})
            request.assert_not_called()

    def test_no_parser_execution_persists_boxes_and_reuses_cache(self):
        with TemporaryDirectory() as directory, patch.dict(os.environ, {"EZPZ_SEED_DEMO": "false", "OPENAI_API_KEY": "test"}):
            runtime = create_runtime(Path(directory))
            db = runtime.database
            doc = runtime.ingestor.ingest("source.png", PNG, "image/png")["document"]
            db.upsert_processor_draft("invoice-extractor", {
                "schema": SCHEMA, "parser": {"name": "none"},
                "model": {"provider": "openai", "name": "gpt-4.1"},
                "harness": {"name": "direct"},
            })
            db.publish_processor_draft("invoice-extractor")
            response = {"choices": [{"message": {"content": json.dumps(OUTPUT)}}]}
            with patch("backend.pipeline.parse_document", side_effect=AssertionError("Parser must not run")), patch("urllib.request.urlopen", return_value=io.BytesIO(json.dumps(response).encode())) as request:
                extracted = runtime.extractions.extract_document(doc["id"])
                saved = db.get_extraction(extracted["id"])
                self.assertEqual(saved["parser_ir"]["parser"]["name"], "none")
                self.assertEqual(saved["parser_ir"]["pages"], [])
                self.assertNotIn("source_input", saved["parser_ir"]["metadata"])
                self.assertEqual(saved["result"]["fields"]["total"]["evidence"][0]["bbox"], BOX["bbox"])
                self.assertEqual(saved["fields"]["total"]["evidence"][0]["metadata"]["bbox_source"], "model")
                cached = runtime.extractions.extract_document(doc["id"])
                self.assertTrue(cached["cache_hit"])
                self.assertEqual(cached["result"]["fields"]["total"]["evidence"], saved["fields"]["total"]["evidence"])
                self.assertEqual(request.call_count, 1)
                with self.assertRaisesRegex(ValueError, "requires parsed pages"):
                    runtime.extractions.extract_document(doc["id"], persist=False, processor_version_override={
                        "id": "preview", "parser": {"name": "none"}, "harness": {"name": "PAGE_EXTRACT"}, "schema": SCHEMA,
                    })
                self.assertEqual(request.call_count, 1)


if __name__ == "__main__":
    unittest.main()
