import json
import os
import unittest
from unittest.mock import patch

from backend.models import DocumentBlock, DocumentIR, DocumentPage
from backend.parser import _llama_pages_from_result, parse_document
from backend.pipeline import _evidence_for_value


class _Response:
    def __init__(self, value):
        self.value = value

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self):
        return self.value.encode("utf-8")


class LlamaParserTests(unittest.TestCase):
    def test_missing_table_boxes_get_inferred_layout_extents_without_becoming_citations(self):
        def table(section):
            return "| {} | FY26 | FY25 |\n| --- | --- | --- |\n| Revenue | $215,938 | $130,497 |\n| Net income | $120,067 | $72,880 |".format(section)

        q4_gaap = table("Q4 GAAP")
        q4_non_gaap = table("Q4 Non-GAAP")
        fy_gaap = table("FY GAAP")
        fy_non_gaap = table("FY Non-GAAP")
        items = [
            {"type": "heading", "md": "Q4 Fiscal 2026 Summary"},
            {"type": "table", "md": q4_gaap, "bbox": [{"x": 35, "y": 100, "w": 930, "h": 135}]},
            # LlamaParse sometimes returns only a header-cell bbox for the
            # table. Its top edge is still useful as a placement hint.
            {"type": "table", "md": q4_non_gaap, "bbox": [{"x": 452, "y": 256, "w": 96, "h": 14}]},
            {"type": "heading", "md": "Fiscal 2026 Summary"},
            {"type": "table", "md": fy_gaap},
            {"type": "table", "md": fy_non_gaap},
        ]
        grounded = {
            "page_number": 2,
            "page_width": 1000,
            "page_height": 1000,
            "items": [
                {"type": "heading", "md": "Q4 Fiscal 2026 Summary", "grounding": {"lines": [{"span": [0, 22], "bbox": {"x": 35, "y": 60, "w": 220, "h": 18}}]}},
                {},
                {},
                {"type": "heading", "md": "Fiscal 2026 Summary", "grounding": {"lines": [{"span": [0, 20], "bbox": {"x": 35, "y": 410, "w": 190, "h": 18}}]}},
                {},
                {},
            ],
        }
        pages, has_layout = _llama_pages_from_result(
            {"items": {"pages": [{"page_number": 2, "page_width": 1000, "page_height": 1000, "items": items}]}},
            {"id": "doc-1", "filename": "report.pdf"},
            [grounded],
        )

        table_blocks = [block for block in pages[0].blocks if block.block_type == "table"]
        self.assertEqual(len(table_blocks), 4)
        self.assertTrue(has_layout)
        self.assertTrue(all(block.bbox for block in table_blocks))
        self.assertEqual(table_blocks[1].metadata["bbox_source"], "inferred")
        self.assertAlmostEqual(table_blocks[1].bbox[1], 0.256, places=3)
        self.assertEqual(table_blocks[2].metadata["bbox_source"], "inferred")
        self.assertEqual(table_blocks[3].metadata["bbox_source"], "inferred")
        self.assertLess(table_blocks[1].bbox[3], table_blocks[2].bbox[1])
        self.assertLess(table_blocks[2].bbox[3], table_blocks[3].bbox[1])

    def test_v2_result_and_grounding_sidecar_are_converted_to_document_ir(self):
        result = {
            "job": {"id": "job-123", "status": "COMPLETED"},
            "markdown": {"pages": [{"page_number": 1, "markdown": "Invoice #: INV-42"}]},
            "items": {
                "pages": [{
                    "page_number": 1,
                    "page_width": 612,
                    "page_height": 792,
                    "items": [
                        {"type": "text", "md": "Invoice #: INV-42", "bbox": [{"x": 72, "y": 100, "w": 180, "h": 14}]},
                        {"type": "table", "md": "| Item | Amount |\\n| --- | --- |\\n| Widget | $12.00 |", "bbox": [{"x": 72, "y": 140, "w": 300, "h": 80}]},
                        {"type": "list_item", "md": "First item", "bbox": [{"x": 72, "y": 240, "w": 120, "h": 14}]},
                    ],
                }],
            },
            "result_content_metadata": {
                "grounded_items": {"presigned_url": "https://signed.example/grounded.jsonl"},
            },
        }
        grounded = {
            "page_number": 1,
            "page_width": 612,
            "page_height": 792,
            "success": True,
            "items": [{
                "type": "text",
                "md": "Invoice #: INV-42",
                "grounding": {"lines": [{"span": [0, 17], "bbox": {"x": 72, "y": 100, "w": 180, "h": 14}}]},
            }, {
                "type": "table",
                "md": "| Item | Amount |\\n| --- | --- |\\n| Widget | $12.00 |",
                "bbox": [{"x": 72, "y": 140, "w": 300, "h": 80}],
                "grounding": {"rows": [[{"span": [38, 44], "bbox": [{"x": 72, "y": 160, "w": 100, "h": 14}]}]]},
            }, {
                "type": "list_item",
                "md": "First item",
                "grounding": {"lines": [{"span": [0, 10], "bbox": {"x": 72, "y": 240, "w": 120, "h": 14}}]},
            }],
        }
        upload_body = {}

        def fake_urlopen(request, timeout=60):
            url = request if isinstance(request, str) else request.full_url
            if url.endswith("/parse/upload"):
                upload_body["value"] = request.data.decode("utf-8")
                return _Response(json.dumps({"id": "job-123", "status": "COMPLETED"}))
            if url.startswith("https://signed.example"):
                return _Response(json.dumps(grounded) + "\n")
            return _Response(json.dumps(result))

        with patch.dict(os.environ, {"LLAMA_CLOUD_API_KEY": "test-key"}, clear=False):
            with patch("backend.parser.urllib.request.urlopen", side_effect=fake_urlopen):
                parsed = parse_document(
                    {"id": "doc-1", "filename": "invoice.pdf", "mime_type": "application/pdf", "page_count": 1, "metadata": {"ocr_text": "Invoice #: INV-42"}},
                    b"document bytes",
                    {"name": "llama-parse", "version": "2"},
                )

        self.assertEqual(parsed.parser["status"], "available")
        self.assertEqual(parsed.parser["job_id"], "job-123")
        self.assertTrue(parsed.parser["grounded_bboxes"])
        self.assertEqual(parsed.pages[0].blocks[0].text, "Invoice #: INV-42")
        self.assertEqual(parsed.pages[0].blocks[0].metadata["grounding"], "line")
        self.assertAlmostEqual(parsed.pages[0].blocks[0].bbox[0], 72 / 612, places=4)
        table_blocks = [block for block in parsed.pages[0].blocks if block.block_type == "table"]
        self.assertEqual(len(table_blocks), 1)
        self.assertIn("Widget", table_blocks[0].text)
        self.assertEqual(table_blocks[0].metadata["grounding"], "cell")
        self.assertAlmostEqual(table_blocks[0].bbox[1], 160 / 792, places=4)
        list_blocks = [block for block in parsed.pages[0].blocks if block.block_type == "list"]
        self.assertEqual(len(list_blocks), 1)
        self.assertEqual(list_blocks[0].text, "• First item")
        self.assertEqual(list_blocks[0].metadata["layoutClass"], "List Item")
        self.assertIn('"spatial_text":{}', upload_body["value"])
        self.assertNotIn('"spatial_text":true', upload_body["value"])

    def test_missing_key_keeps_local_text_but_does_not_create_evidence(self):
        with patch.dict(os.environ, {}, clear=True):
            parsed = parse_document(
                {"id": "doc-1", "filename": "invoice.txt", "mime_type": "text/plain", "page_count": 1, "metadata": {"ocr_text": "Invoice #: INV-42"}},
                b"Invoice #: INV-42",
                {"name": "llama-parse", "version": "2"},
            )

        self.assertEqual(parsed.parser["status"], "compatibility")
        self.assertIn("LLAMA_CLOUD_API_KEY is not set", parsed.parser["warnings"][0])

    def test_numeric_values_get_source_boxes_when_table_uses_formatting(self):
        parser_ir = DocumentIR(
            document_id="doc-1",
            parser={"status": "available"},
            metadata={},
            pages=[DocumentPage(
                page=2,
                width=1000,
                height=1000,
                blocks=[DocumentBlock(
                    block_id="p2-t5",
                    block_type="table",
                    text="| Revenue | $215,938 |\n| Net income | $120,067 |",
                    bbox=[0.035, 0.443, 0.965, 0.58],
                    metadata={"bbox_source": "inferred", "grounding": "table", "source_index": 4},
                )],
            )],
        )

        evidence = _evidence_for_value(parser_ir, 215938)

        self.assertEqual(len(evidence), 1)
        self.assertEqual(evidence[0].block_id, "p2-t5")
        self.assertEqual(evidence[0].bbox, [0.035, 0.443, 0.965, 0.58])
        self.assertEqual(evidence[0].metadata["bbox_source"], "inferred")


if __name__ == "__main__":
    unittest.main()
