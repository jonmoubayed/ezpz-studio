"""Agent-facing recipes for the same workflow format used by Studio."""

from copy import deepcopy
from jsonschema.exceptions import SchemaError

from .harness_spec import KINDS, validate_spec


def catalog():
    def extract(name):
        return {"id": name, "kind": "extract"}

    recipes = []
    for name, title in [("direct", "LLM only"), ("parsed", "Parse and extract"),
                        ("cascade", "Tiered extraction"), ("consensus", "Majority vote"),
                        ("verify", "Extract and verify"), ("pages", "Per-page extraction")]:
        step = extract("extract")
        if name == "cascade":
            step = {"id": "cascade", "kind": "cascade", "threshold": .85, "scope": "document",
                    "tiers": [extract("tier-1"), extract("tier-2")]}
        elif name == "consensus":
            step = {"id": "vote", "kind": "consensus", "branches": [extract(f"voter-{i}") for i in range(1, 4)]}
        elif name == "pages":
            step = {"id": "pages", "kind": "pages", "body": extract("page-extract")}
        steps = [step]
        if name == "verify":
            steps.append({"id": "verify", "kind": "repair", "attempts": 1, "always_verify": True, "body": extract("repair-extract")})
        steps.append({"id": "validate", "kind": "validate"})
        spec = {"name": "workflow", "version": 1, "input": "document" if name == "direct" else "parsed",
                "limits": {"max_calls": 30, "concurrency": 3}, "flow": {"id": "flow", "kind": "sequence", "steps": steps}}
        validate_spec(spec)
        recipes.append({"id": name, "name": title, "harness": spec})
    return {"format_version": 1, "recipes": recipes, "block_kinds": sorted(KINDS),
            "guidance": {
                "versioning": "Harnesses belong to processor versions. Save a candidate to preserve the shared editor draft.",
                "defaults": "Blocks inherit the processor model, parser and prompt. Set model.provider and model.name on a block to override the model.",
                "fields": "fields and critical_fields use dotted paths from the processor schema.",
                "routing": "Optional routing.edges uses unique id, source, target and condition (always, accepted, unresolved). Endpoints are boundary:input, block:<child-id>, boundary:output. Connections must be acyclic with a path to output; disconnected blocks do not execute.",
                "children": {"sequence": "steps", "cascade": "tiers", "consensus": "branches", "parallel": "branches", "gate": ["pass", "fail"], "repair": "body", "pages": "body"},
                "policies": "threshold is 0..1; missing_confidence is escalate or ignore; cascade scope is document or unresolved; repair attempts is 1..5. Consensus quorum must be a strict majority; array voting requires field_policies.<field>.row_key.",
                "input": "parsed uses the processor parser. document sends the original source and requires a compatible model/adapter; deterministic-local supports text only.",
                "limits": "max_calls: 1..1000; concurrency: 1..16; at most 100 blocks, 12 nesting levels. Limits count logical calls, not monetary spend.",
            }}


def validate_workflow(harness, schema):
    if not isinstance(harness, dict) or harness.get("name") != "workflow":
        raise ValueError("Provide a workflow harness; use get_processor to inspect legacy/custom configurations")
    if not isinstance(schema, dict) or schema.get("type") != "object":
        raise ValueError("Provide the processor's object JSON Schema")
    try:
        validate_spec(harness, schema)
    except (TypeError, AttributeError, KeyError, SchemaError) as error:
        raise ValueError(f"Malformed harness configuration: {error}") from error
    return {"valid": True, "harness": deepcopy(harness)}
