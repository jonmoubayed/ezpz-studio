import unittest

from backend.model import AnthropicModel, GeminiModel, OpenAICompatibleModel
from backend.model_settings import validate_model_settings
from backend.tests.test_adapters import sample_ir


class ModelSettingsTests(unittest.TestCase):
    def test_openai_controls_reach_request(self):
        model = OpenAICompatibleModel(api_key="test", model="gpt-5.6-terra", provider="openai")
        payload = model.request_payload(sample_ir(), {"type": "object", "properties": {}}, {
            "max_tokens": 12000, "reasoning_effort": "high", "verbosity": "low", "structured_outputs": True, "system": "Extract carefully.",
        })
        self.assertEqual(payload["reasoning_effort"], "high")
        self.assertEqual(payload["verbosity"], "low")
        self.assertEqual(payload["max_completion_tokens"], 12000)
        self.assertEqual(payload["response_format"]["type"], "json_schema")
        self.assertEqual(payload["messages"][0]["content"], "Extract carefully.")
        self.assertNotIn("temperature", payload)

    def test_anthropic_effort_enables_adaptive_thinking_without_sampling(self):
        for name in ("claude-sonnet-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-4-6"):
            payload = AnthropicModel(api_key="test", model=name).request_payload(sample_ir(), {}, {"reasoning_effort": "high", "max_tokens": 16000, "temperature": 0.4, "top_p": 0.8})
            self.assertEqual(payload["output_config"]["effort"], "high")
            self.assertEqual(payload["thinking"], {"type": "adaptive"})
            self.assertEqual(payload["max_tokens"], 16000)
            self.assertNotIn("temperature", payload)
            self.assertNotIn("top_p", payload)

    def test_haiku_budget_and_top_p_are_mutually_exclusive_in_request(self):
        model = AnthropicModel(api_key="test", model="claude-haiku-4-5-20251001")
        payload = model.request_payload(sample_ir(), {}, {"thinking_budget": 2048, "max_tokens": 6000, "top_p": 0.9})
        self.assertEqual(payload["thinking"], {"type": "enabled", "budget_tokens": 2048})
        self.assertNotIn("top_p", payload)
        payload = model.request_payload(sample_ir(), {}, {"temperature": 0.2, "top_p": 0.9})
        self.assertEqual(payload["top_p"], 0.9)
        self.assertNotIn("temperature", payload)

    def test_gemini_levels_budget_and_generation_controls(self):
        model = GeminiModel(api_key="test", model="gemini-3.8-flash")
        config = model.request_payload(sample_ir(), {}, {"reasoning_effort": "medium", "max_tokens": 8192, "temperature": 1, "top_p": 0.9})["generationConfig"]
        self.assertEqual(config["thinkingConfig"], {"thinkingLevel": "MEDIUM"})
        self.assertEqual(config["maxOutputTokens"], 8192)
        self.assertEqual(config["topP"], 0.9)
        for budget in (0, -1, 4096):
            config = GeminiModel(api_key="test", model="gemini-2.5-flash").request_payload(sample_ir(), {}, {"thinking_budget": budget})["generationConfig"]
            self.assertEqual(config["thinkingConfig"], {"thinkingBudget": budget})

    def test_invalid_settings_fail_before_a_provider_request(self):
        cases = [("openai", "gpt-6-astra", {"reasoning_effort": "none"}),
                 ("gemini", "gemini-3.8-flash", {"reasoning_effort": "minimal"}),
                 ("anthropic", "claude-haiku-4-5", {"reasoning_effort": "high"}),
                 ("anthropic", "claude-haiku-4-5", {"thinking_budget": 4096, "max_tokens": 4096}),
                 ("gemini", "gemini-2.5-pro", {"thinking_budget": 0}),
                 ("openai", "gpt-4.1", {"max_tokens": 0}),
                 ("openai", "gpt-4.1", {"max_tokens": 1.5}),
                 ("openai", "gpt-4.1", {"temperature": float("nan")}),
                 ("openai", "gpt-4.1", {"top_p": 2})]
        for provider, name, settings in cases:
            with self.subTest(provider=provider, settings=settings), self.assertRaises(ValueError):
                validate_model_settings(provider, name, settings)

    def test_older_model_sampling_and_unset_defaults_still_work(self):
        payload = OpenAICompatibleModel(api_key="test", model="gpt-4.1", provider="openai").request_payload(sample_ir(), {}, {"temperature": 0, "top_p": 0.75})
        self.assertEqual(payload["temperature"], 0)
        self.assertEqual(payload["top_p"], 0.75)
        self.assertEqual(payload["max_tokens"], 4096)
        self.assertNotIn("reasoning_effort", payload)

    def test_custom_gateway_settings_are_not_suppressed_by_model_name(self):
        payload = OpenAICompatibleModel(api_key="test", model="gpt-5-custom", provider="openai-compatible").request_payload(sample_ir(), {}, {"temperature": 0.3, "top_p": 0.8})
        self.assertEqual(payload["temperature"], 0.3)
        self.assertEqual(payload["top_p"], 0.8)


if __name__ == "__main__":
    unittest.main()
