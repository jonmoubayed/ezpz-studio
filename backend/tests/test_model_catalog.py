import os
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlparse

from backend import model_catalog as catalog
from backend.model import AnthropicModel, OpenAICompatibleModel
from backend.tests.test_adapters import sample_ir


class ModelCatalogTests(unittest.TestCase):
    def test_offline_catalog_contains_current_models(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(catalog, "_fetch_json") as fetch:
            for provider, model in [("openai", "gpt-6-astra"), ("anthropic", "claude-sonnet-5"), ("google", "gemini-3.8-flash")]:
                result = catalog.get_model_catalog(provider)
                self.assertEqual(result["source"], "built-in")
                self.assertIn(model, [m["id"] for m in result["models"]])
                self.assertTrue(result["warnings"])
            fetch.assert_not_called()

    def test_anthropic_paginates_deduplicates_and_orders_newest_first(self):
        pages = [{"data": [{"id": "old", "created_at": "2025-01-01T00:00:00Z"}], "has_more": True, "last_id": "old"},
                 {"data": [{"id": "new", "created_at": "2026-09-01T00:00:00Z"}, {"id": "old"}], "has_more": False}]
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test"}, clear=True), patch.object(catalog, "_fetch_json", side_effect=pages) as fetch:
            result = catalog.get_model_catalog("anthropic")
        self.assertEqual(result["source"], "provider")
        self.assertEqual([m["id"] for m in result["models"]], ["new", "old"])
        self.assertIn("after_id=old", fetch.call_args_list[1].args[0])

    def test_gemini_follows_encoded_page_token_with_header_auth(self):
        pages = [{"models": [{"name": "models/gemini-3.8-flash"}], "nextPageToken": "next /+"},
                 {"models": [{"name": "models/new-model"}]}]
        with patch.dict(os.environ, {"GEMINI_API_KEY": "test-secret"}, clear=True), patch.object(catalog, "_fetch_json", side_effect=pages) as fetch:
            result = catalog.get_model_catalog("google")
        url, headers = fetch.call_args_list[1].args
        self.assertEqual(parse_qs(urlparse(url).query)["pageToken"], ["next /+"])
        self.assertNotIn("test-secret", url)
        self.assertEqual(headers["x-goog-api-key"], "test-secret")
        self.assertIn("new-model", [m["id"] for m in result["models"]])

    def test_failure_is_truthful_and_does_not_expose_credentials(self):
        error = HTTPError("https://example.test?key=secret", 401, "secret", {}, None)
        with patch.dict(os.environ, {"OPENAI_API_KEY": "secret"}, clear=True), patch.object(catalog, "_fetch_json", side_effect=error):
            result = catalog.get_model_catalog("openai")
        self.assertEqual(result["source"], "built-in")
        self.assertIn("401", result["warnings"][0])
        self.assertNotIn("secret", str(result))

    def test_invalid_or_repeated_pages_fall_back(self):
        for pages in [[{"oops": []}], [{"data": [], "has_more": True, "last_id": "same"}] * 2]:
            with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test"}, clear=True), patch.object(catalog, "_fetch_json", side_effect=pages):
                self.assertEqual(catalog.get_model_catalog("anthropic")["source"], "built-in")

    def test_unknown_variant_does_not_inherit_another_models_price(self):
        self.assertIsNone(catalog._pricing_for("openai", "gpt-5-future"))
        self.assertIsNone(catalog._pricing_for("anthropic", "claude-sonnet-5-1"))
        self.assertEqual(catalog._pricing_for("openai", "gpt-4.1-2025-04-14")["input_per_million"], 2)

    def test_local_server_does_not_receive_hosted_key(self):
        with patch.dict(os.environ, {"OPENAI_API_KEY": "secret"}, clear=True), patch.object(catalog, "_fetch_json", return_value={"data": [{"id": "local-model"}]}) as fetch:
            catalog.get_model_catalog("ollama")
            self.assertNotIn("Authorization", fetch.call_args.args[1])

    def test_compatible_provider_prefers_its_own_key(self):
        with patch.dict(os.environ, {"OPENAI_API_KEY": "hosted", "OPENAI_COMPATIBLE_API_KEY": "gateway"}, clear=True), patch.object(catalog, "_fetch_json", return_value={"data": [{"id": "custom"}]}) as fetch:
            catalog.get_model_catalog("openai-compatible", "https://gateway.example/v1")
            self.assertEqual(fetch.call_args.args[1]["Authorization"], "Bearer gateway")

    def test_current_models_use_supported_request_parameters(self):
        for name in ("gpt-6-astra", "gpt-5.6-terra"):
            payload = OpenAICompatibleModel(api_key="test", model=name).request_payload(sample_ir(), {}, {"max_tokens": 512, "temperature": 0})
            self.assertEqual(payload["max_completion_tokens"], 512)
            self.assertNotIn("max_tokens", payload)
            self.assertNotIn("temperature", payload)
        for name in ("claude-sonnet-5", "claude-opus-5", "claude-fable-5-1"):
            payload = AnthropicModel(api_key="test", model=name).request_payload(sample_ir(), {}, {"temperature": 0})
            self.assertNotIn("temperature", payload)


if __name__ == "__main__":
    unittest.main()
