import unittest
from tempfile import TemporaryDirectory

from backend.harness_runtime import execute_harness
from backend.harness_spec import validate_spec
from backend.models import ModelResult
from backend.resumable import EvaluationInterrupted
from backend.tests.test_resumable_harness import SOURCE, extractor, version

I, O = "boundary:input", "boundary:output"
def B(name): return "block:" + name

def routes(*items):
    return {"edges": [{"id": str(index), "source": source, "target": target, "condition": condition}
                      for index, (source, target, condition) in enumerate(items)]}


class RoutingTests(unittest.TestCase):
    def execute(self, flow, confidence=.99):
        calls = []
        class Model:
            def __init__(self, config): self.name = config["name"]
            def run(self, ir, schema, prompt):
                calls.append(self.name)
                return ModelResult({"total": {"value": 200 if self.name == "strong" else 100, "confidence": confidence}}, {}, {"input_tokens": 7})
        with TemporaryDirectory() as root:
            _, result = execute_harness(SOURCE, b"Total 100", version(flow), Model, root, "routed")
        return calls, result

    def test_reconnected_accepted_arrow_changes_tier_execution(self):
        base = {"id": "tiers", "kind": "cascade", "threshold": .9, "tiers": [extractor("cheap"), extractor("strong")]}
        normal = {**base, "routing": routes((I, B("cheap"), "always"), (B("cheap"), O, "accepted"), (B("cheap"), B("strong"), "unresolved"), (B("strong"), O, "always"))}
        self.assertEqual(self.execute(normal)[0], ["cheap"])
        normal["routing"]["edges"][1]["target"] = B("strong")
        calls, result = self.execute(normal)
        self.assertEqual(calls, ["cheap", "strong"])
        self.assertEqual(result.output["total"]["value"], 200)
        self.assertTrue(any(step["kind"] == "connection" for step in result.steps))

    def test_edges_override_sequence_and_tier_array_order(self):
        for kind, key in (("sequence", "steps"), ("cascade", "tiers")):
            with self.subTest(kind=kind):
                flow = {"id": "flow", "kind": kind, key: [extractor("cheap"), extractor("strong")], "routing": routes((I, B("strong"), "always"), (B("strong"), B("cheap"), "always"), (B("cheap"), O, "always"))}
                self.assertEqual(self.execute(flow)[0], ["strong", "cheap"])

    def test_gate_connections_override_which_branch_is_taken(self):
        flow = {"id": "gate", "kind": "gate", "pass": extractor("yes"), "fail": extractor("no"), "routing": routes((I, B("yes"), "unresolved"), (I, B("no"), "accepted"), (B("yes"), O, "always"), (B("no"), O, "always"))}
        self.assertEqual(self.execute(flow)[0], ["yes"])

    def test_parallel_and_vote_do_not_run_disconnected_branches(self):
        for kind in ("parallel", "consensus"):
            flow = {"id": "fork", "kind": kind, "branches": [extractor(name) for name in ("a", "b", "c")], "routing": routes((I, B("a"), "always"), (B("a"), O, "always"))}
            calls, result = self.execute(flow)
            self.assertEqual(calls, ["a"])
            if kind == "consensus":
                self.assertIsNone(result.output["total"]["value"], "One connected voter must not become a majority")

    def test_duplicate_routes_from_a_voter_do_not_duplicate_votes(self):
        flow = {"id": "vote", "kind": "consensus", "branches": [extractor(name) for name in ("a", "b", "c")], "routing": routes((I, B("a"), "always"), (B("a"), O, "always"), (B("a"), O, "accepted"))}
        calls, result = self.execute(flow)
        self.assertEqual(calls, ["a"])
        self.assertIsNone(result.output["total"]["value"])

    def test_repair_and_pages_follow_saved_body_connections(self):
        for kind in ("repair", "pages"):
            flow = {"id": "repeat", "kind": kind, "body": extractor("body"), "routing": routes((I, O, "always"))}
            self.assertEqual(self.execute(flow)[0], [])

    def test_recovery_reuses_completed_parallel_routes(self):
        calls, fail = {}, True
        class Model:
            def __init__(self, config): self.name = config["name"]
            def run(self, ir, schema, prompt):
                calls[self.name] = calls.get(self.name, 0) + 1
                if self.name == "b" and fail: raise ConnectionError("sleep interrupted request")
                return ModelResult({"total": {"value": 100, "confidence": .99}}, {}, {"input_tokens": 7})
        names = ("a", "b", "c")
        flow = {"id": "vote", "kind": "consensus", "branches": [extractor(name) for name in names], "routing": routes(*[(I, B(name), "always") for name in names], *[(B(name), O, "always") for name in names])}
        with TemporaryDirectory() as root:
            with self.assertRaises(EvaluationInterrupted):
                execute_harness(SOURCE, b"Total 100", version(flow), Model, root, "resume")
            fail = False
            _, result = execute_harness(SOURCE, b"Total 100", version(flow), Model, root, "resume")
        self.assertEqual(calls, {"a": 1, "b": 2, "c": 1})
        self.assertEqual(result.usage["input_tokens"], 21)
        self.assertEqual(result.output["total"]["value"], 100)

    def test_invalid_connections_rejected_before_provider_calls(self):
        cases = [routes((I, B("a"), "always"), (B("a"), B("b"), "always"), (B("b"), B("a"), "always")), routes((I, B("missing"), "always")), routes((I, B("a"), "always")), routes((I, O, "unknown"))]
        for routing in cases:
            with self.subTest(routing=routing), self.assertRaises(ValueError):
                config = version({"id": "flow", "kind": "sequence", "steps": [extractor("a"), extractor("b")], "routing": routing})
                validate_spec(config["harness"], config["schema"])

if __name__ == "__main__": unittest.main()
