import unittest
from backend.costing import estimate_cost, run_cost_metrics
from backend.pipeline import ExtractionService


class CostingTests(unittest.TestCase):
    model = {"provider": "openai", "name": "gpt-4.1-mini"}
    usage = {"input_tokens": 561316, "output_tokens": 45737}

    def test_catalog_fallback_for_saved_usage_without_pricing(self):
        entries = [{"model": "gpt-4.1-mini", "pricing": {}, "usage": self.usage}]
        self.assertAlmostEqual(estimate_cost(self.model, self.usage, entries), .2977056)
        self.assertAlmostEqual(ExtractionService._cost({"model": self.model}, self.usage, entries), .2977056)
        metrics = run_cost_metrics(self.model, [{"cost_usd": 0, "usage": {**self.usage, "models": entries}}])
        self.assertAlmostEqual(metrics["cost_usd"], .2977056)
        self.assertEqual(metrics["cost_status"], "estimated")

    def test_explicit_pricing_and_saved_cost_are_preserved(self):
        model = {**self.model, "pricing": {"input_per_million": 0, "output_per_million": 0}}
        self.assertEqual(estimate_cost(model, self.usage), 0)
        self.assertEqual(run_cost_metrics(self.model, [{"cost_usd": .123}])["cost_usd"], .123)

    def test_unknown_or_missing_usage_is_not_free(self):
        self.assertIsNone(estimate_cost({**self.model, "name": "unpriced"}, self.usage))
        self.assertIsNone(estimate_cost(self.model, {}))
        self.assertIsNone(run_cost_metrics(self.model, [
            {"cost_usd": 1}, {"cost_usd": 0, "usage": {}}
        ])["cost_usd"])
        self.assertIsNone(run_cost_metrics(self.model, [])["cost_usd"])
        self.assertEqual(estimate_cost({"provider": "local"}, {}), 0)

    def test_multimodel_costs_use_each_models_rate(self):
        entries = [
            {"model": "gpt-4.1-mini", "usage": {"input_tokens": 1000000, "output_tokens": 0}},
            {"model": "gpt-4.1", "usage": {"input_tokens": 1000000, "output_tokens": 0}},
        ]
        self.assertEqual(estimate_cost(self.model, {}, entries), 2.4)

    def test_cached_tokens_do_not_add_new_cost(self):
        cached = {"cost_usd": 0, "cache_hit": True, "usage": self.usage}
        self.assertEqual(run_cost_metrics(self.model, [cached])["cost_usd"], 0)
        self.assertEqual(run_cost_metrics(self.model, [cached, {"cost_usd": .1}])["cost_usd"], .1)
