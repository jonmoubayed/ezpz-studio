import unittest

from backend.confidence import response_schema, strict_response_schema
from backend.adapters import get_adapter_catalog, normalize_model_config, normalize_parser_name
from backend.model import AnthropicModel, GeminiModel, OpenAICompatibleModel, create_model_adapter
from backend.models import DocumentBlock, DocumentIR, DocumentPage


def sample_ir():
    return DocumentIR(
        document_id="doc-1",
        parser={"name": "native", "status": "compatibility"},
        metadata={"filename": "invoice.txt"},
        pages=[DocumentPage(page=1, width=1, height=1, blocks=[DocumentBlock("p1-b1", "text", "Invoice # INV-42", [0, 0, 1, 0.1])])],
    )


class AdapterTests(unittest.TestCase):
    def test_catalog_exposes_initial_llm_and_parser_adapters(self):
        catalog = get_adapter_catalog()
        self.assertEqual({item["id"] for item in catalog["llm"]}, {"local", "openai", "anthropic", "gemini", "ollama", "openai-compatible"})
        self.assertEqual({item["id"] for item in catalog["parsers"]}, {"none", "native", "docling", "llama-parse"})

    def test_legacy_model_names_are_normalized_without_changing_the_ui_contract(self):
        self.assertEqual(normalize_model_config({"name": "claude-3-5-sonnet"})["provider"], "anthropic")
        self.assertEqual(normalize_model_config({"name": "llama3.2"})["provider"], "openai-compatible")
        self.assertEqual(normalize_model_config({"provider": "openai-compatible"})["name"], "llama3.2")
        self.assertEqual(normalize_parser_name("llamaparse"), "llama-parse")
        self.assertEqual(normalize_parser_name("structured"), "native")

    def test_factory_selects_explicit_provider_adapters(self):
        self.assertIsInstance(create_model_adapter({"provider": "openai", "name": "gpt-4o"}), OpenAICompatibleModel)
        self.assertIsInstance(create_model_adapter({"provider": "anthropic", "name": "claude-sonnet-4"}), AnthropicModel)
        self.assertIsInstance(create_model_adapter({"provider": "gemini", "name": "gemini-2.5-flash"}), GeminiModel)
        ollama = create_model_adapter({"provider": "ollama", "name": "llama3.2"})
        self.assertIsInstance(ollama, OpenAICompatibleModel)
        self.assertEqual(ollama.base_url, "http://127.0.0.1:11434/v1")
        self.assertFalse(ollama.requires_api_key)

    def test_each_adapter_translates_the_same_extraction_contract(self):
        schema = {"type": "object", "properties": {"invoice_number": {"type": "string"}}}
        prompt = {"system": "Return JSON.", "extraction": "Find the invoice number.", "temperature": 0, "max_tokens": 128}
        ir = sample_ir()

        openai = OpenAICompatibleModel(api_key="test", model="gpt-4o", provider="openai")
        openai_payload = openai.request_payload(ir, schema, prompt)
        self.assertEqual(openai_payload["messages"][0]["role"], "system")
        self.assertIn("Find the invoice number", openai_payload["messages"][1]["content"])
        self.assertIn('"invoice_number"', openai_payload["messages"][1]["content"])

        anthropic_payload = AnthropicModel(api_key="test").request_payload(ir, schema, prompt)
        self.assertEqual(anthropic_payload["system"], "Return JSON.")
        self.assertEqual(anthropic_payload["messages"][0]["role"], "user")

        gemini_payload = GeminiModel(api_key="test").request_payload(ir, schema, prompt)
        self.assertEqual(gemini_payload["contents"][0]["role"], "user")
        self.assertEqual(gemini_payload["generationConfig"]["responseMimeType"], "application/json")

    def test_openai_structured_output_is_opt_in(self):
        model = OpenAICompatibleModel(api_key="test", model="gpt-4o", provider="openai")
        schema = {"type": "object", "properties": {"value": {"type": "string"}}}
        payload = model.request_payload(sample_ir(), schema, {"structured_outputs": True})
        self.assertEqual(payload["response_format"]["type"], "json_schema")
        self.assertEqual(payload["response_format"]["json_schema"]["schema"], strict_response_schema(response_schema(schema)))


if __name__ == "__main__":
    unittest.main()
