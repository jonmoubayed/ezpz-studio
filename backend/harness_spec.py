"""Versioned, provider-independent extraction programs and resolution policies."""

import json
import math
from copy import deepcopy
from decimal import Decimal, InvalidOperation

from jsonschema import Draft202012Validator
from .confidence import valid_confidence
from .harness_routing import routing_layers

KINDS = {"sequence", "extract", "parse", "validate", "gate", "cascade", "consensus", "parallel", "repair", "pages", "return"}


def leaves(schema, prefix=""):
    if schema.get("type") == "object":
        return [item for key, child in schema.get("properties", {}).items()
                for item in leaves(child, f"{prefix}.{key}" if prefix else key)]
    return [(prefix, schema)] if prefix else []


def get(value, path):
    for part in path.split("."):
        if not isinstance(value, dict):
            return None
        value = value.get(part)
    return value


def put(value, path, item):
    parts = path.split(".")
    for part in parts[:-1]:
        value = value.setdefault(part, {})
    value[parts[-1]] = item


def unwrap(value):
    if isinstance(value, dict):
        if "value" in value:
            return value["value"]
        return {key: unwrap(child) for key, child in value.items()}
    return value


def project(schema, paths):
    if not paths:
        return deepcopy(schema)
    result = {**deepcopy(schema), "properties": {}, "required": []}
    for key, child in schema.get("properties", {}).items():
        selected = [path[len(key) + 1:] for path in paths if path.startswith(key + ".")]
        if key in paths or selected:
            result["properties"][key] = project(child, selected) if selected and key not in paths else deepcopy(child)
            if key in schema.get("required", []):
                result["required"].append(key)
    return result


def validate_spec(spec, schema=None):
    if spec.get("name") != "workflow":
        return  # Older saved harnesses retain their behavior.
    if spec.get("version") != 1:
        raise ValueError("Unsupported harness format version")
    if spec.get("input", "parsed") not in ("parsed", "document"):
        raise ValueError("Harness input must be parsed or document")
    limits = spec.get("limits", {})
    for key, default, maximum in (("max_calls", 30, 1000), ("concurrency", 3, 16)):
        value = limits.get(key, default)
        if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= maximum:
            raise ValueError(f"{key} must be an integer between 1 and {maximum}")
    ids = set()
    paths = {path for path, _ in leaves(schema or {})}
    def visit(node, depth=0):
        if not isinstance(node, dict) or node.get("kind") not in KINDS:
            raise ValueError("Unknown or missing harness block type")
        if depth > 12 or len(ids) >= 100:
            raise ValueError("Harness exceeds 100 blocks or 12 nesting levels")
        node_id = node.get("id")
        if not isinstance(node_id, str) or not node_id or node_id in ids:
            raise ValueError("Every harness block requires a unique ID")
        ids.add(node_id)
        allowed_children = {"sequence": {"steps"}, "cascade": {"tiers"}, "consensus": {"branches"}, "parallel": {"branches"}, "gate": {"pass", "fail"}, "repair": {"body"}, "pages": {"body"}}.get(node["kind"], set())
        if any(key in node and key not in allowed_children for key in ("steps", "tiers", "branches", "pass", "fail", "body")):
            raise ValueError("This block has unsupported child connections")
        if "model" in node and (not isinstance(node["model"], dict) or not str(node["model"].get("name", "")).strip() or not node["model"].get("provider")):
            raise ValueError("Each model override needs a provider and model ID")
        if "prompt" in node and not isinstance(node["prompt"], dict):
            raise ValueError("Step prompt settings must be an object")
        if "parser" in node and (not isinstance(node["parser"], dict) or node["parser"].get("name") not in ("native", "docling", "llama-parse")):
            raise ValueError("Choose a supported parser")
        for setting in ("normalization", "field_policies", "row_keys"):
            if setting in node and not isinstance(node[setting], dict):
                raise ValueError(f"{setting} must be an object")
        policies = [node.get("normalization", {})] + list(node.get("field_policies", {}).values())
        for policy in policies:
            if not isinstance(policy, dict):
                raise ValueError("Field comparison policies must be objects")
            tolerance = policy.get("tolerance", 0)
            if type(tolerance) not in (int, float) or not math.isfinite(tolerance) or tolerance < 0:
                raise ValueError("Numeric tolerance must be finite and nonnegative")
        if "rules" in node and (not isinstance(node["rules"], list) or any(not isinstance(rule, dict) or not isinstance(rule.get("sum"), list) or not rule["sum"] or not isinstance(rule.get("equals"), str) for rule in node["rules"])):
            raise ValueError("Arithmetic checks require sum field paths and an equals field")
        if schema:
            for rule in node.get("rules", []):
                if any(path not in paths for path in rule["sum"] + [rule["equals"]]):
                    raise ValueError("Arithmetic check references an unknown field")
        if "threshold" in node and valid_confidence(node["threshold"]) is None:
            raise ValueError("Confidence threshold must be between 0 and 1")
        if node.get("missing_confidence", "escalate") not in ("escalate", "ignore"):
            raise ValueError("Unknown missing confidence policy")
        for key in ("fields", "critical_fields"):
            selected = node.get(key, [])
            if not isinstance(selected, list) or any(not isinstance(p, str) for p in selected):
                raise ValueError(f"{key} must be a list of field paths")
            if schema and set(selected) - paths:
                raise ValueError("Unknown field path: " + ", ".join(sorted(set(selected) - paths)))
        for key in ("steps", "tiers", "branches"):
            if key in node:
                if not isinstance(node[key], list) or not node[key]:
                    raise ValueError(f"{key} must contain at least one block")
                for child in node[key]:
                    visit(child, depth + 1)
        for key in ("pass", "fail", "body"):
            if node.get(key):
                visit(node[key], depth + 1)
        required = {"sequence": "steps", "cascade": "tiers", "consensus": "branches", "parallel": "branches", "pages": "body", "repair": "body"}.get(node["kind"])
        if required and not node.get(required):
            raise ValueError(f"{node['kind']} requires {required}")
        if "routing" in node:
            routing_layers(node)
        if node["kind"] == "consensus":
            count = len(node["branches"])
            quorum = node.get("quorum", count // 2 + 1)
            if isinstance(quorum, bool) or not isinstance(quorum, int) or not count // 2 < quorum <= count:
                raise ValueError("Consensus quorum must be a strict majority of configured voters")
        if node["kind"] == "repair" and (type(node.get("attempts", 1)) is not int or not 1 <= node.get("attempts", 1) <= 5):
            raise ValueError("Repair attempts must be between 1 and 5")
        if node.get("scope", "document") not in ("document", "unresolved"):
            raise ValueError("Cascade scope must be document or unresolved")
    visit(spec.get("flow"))
    if schema:
        Draft202012Validator.check_schema(schema)


def assess(output, schema, policy=None):
    policy = policy or {}
    plain = unwrap(output)
    errors = []
    for error in Draft202012Validator(schema).iter_errors(plain):
        errors.append({"field": ".".join(str(p) for p in error.absolute_path), "message": error.message})
    unresolved = []
    for path, _ in leaves(schema):
        field = get(output, path)
        if isinstance(field, dict) and field.get("errors"):
            unresolved.append(path)
            errors.extend({"field": path, "message": str(message)} for message in field["errors"])
    selected = policy.get("critical_fields") or [path for path, _ in leaves(schema)]
    threshold = policy.get("threshold")
    for path in selected:
        field = get(output, path)
        value = unwrap(field)
        if value is None or value == "":
            unresolved.append(path)
        elif threshold is not None:
            confidence = valid_confidence(field.get("confidence")) if isinstance(field, dict) else None
            if (confidence is None and policy.get("missing_confidence", "escalate") == "escalate") or (confidence is not None and confidence < threshold):
                unresolved.append(path)
    for rule in policy.get("rules", []):
        try:
            expected = sum(float(get(plain, path)) for path in rule["sum"])
            actual = float(get(plain, rule["equals"]))
            matches = math.isfinite(expected) and math.isfinite(actual) and abs(expected - actual) <= float(rule.get("tolerance", 0.01))
        except (ValueError, TypeError, KeyError):
            matches = False
        if not matches:
            path = rule.get("equals", "")
            errors.append({"field": path, "message": "Arithmetic consistency check failed"})
            unresolved.append(path)
    if errors:
        for error in errors:
            matches = [path for path, _ in leaves(schema) if not error["field"] or path == error["field"] or path.startswith(error["field"] + ".")]
            unresolved.extend(matches)
    return {"accepted": not errors and not unresolved, "errors": errors, "unresolved": sorted(set(unresolved))}


def normalized(value, policy):
    if isinstance(value, str):
        value = " ".join(value.split())
        if policy.get("case_insensitive"):
            value = value.casefold()
        if policy.get("numeric_strings"):
            try:
                return Decimal(value.replace(",", ""))
            except InvalidOperation:
                pass
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return Decimal(str(value))
    return value


def equal(left, right, policy):
    left, right = normalized(left, policy), normalized(right, policy)
    if isinstance(left, Decimal) and isinstance(right, Decimal):
        return abs(left - right) <= Decimal(str(policy.get("tolerance", 0)))
    # Explicit structural comparison; array voting never aligns by row position.
    if isinstance(left, list) and isinstance(right, list):
        key = policy.get("row_key")
        if not key or not all(isinstance(row, dict) and key in row for row in left + right):
            return False
        a, b = {str(row[key]): row for row in left}, {str(row[key]): row for row in right}
        return len(a) == len(left) and len(b) == len(right) and a == b
    return type(left) is type(right) and left == right


def vote(candidates, schema, policy):
    count = len(policy["branches"])
    quorum = policy.get("quorum", count // 2 + 1)
    output, decisions = {}, []
    for path, definition in leaves(schema):
        available = [(index, get(candidate, path)) for index, candidate in enumerate(candidates)]
        available = [(index, value) for index, value in available if unwrap(value) is not None and Draft202012Validator(definition).is_valid(unwrap(value))]
        groups = []
        field_policy = {**policy.get("normalization", {}), **policy.get("field_policies", {}).get(path, {})}
        for index, value in available:
            # A member must agree with every group member to avoid tolerance chains.
            group = next((group for group in groups if all(equal(unwrap(value), unwrap(member), field_policy) for _, member in group)), None)
            if group is None:
                groups.append([(index, value)])
            else:
                group.append((index, value))
        winners = [group for group in groups if len(group) >= quorum]
        winning = winners[0] if len(winners) == 1 else []
        if winning:
            value = deepcopy(winning[0][1])
            if not isinstance(value, dict) or "value" not in value:
                value = {"value": value, "confidence": None}
            value["selection"] = {"method": "majority_vote", "voters": [index for index, _ in winning], "agreement": len(winning) / count}
        else:
            value = {"value": None, "confidence": None, "errors": ["No majority consensus; array fields require a row key" if definition.get("type") == "array" else "No majority consensus"]}
        put(output, path, value)
        decisions.append({"field": path, "votes": len(winning), "voters": count, "quorum": quorum, "selected": bool(winning)})
    return output, decisions


def merge_scoped(current, incoming, schema, paths=None):
    result = deepcopy(current)
    for path, _ in leaves(schema):
        if paths is None or path in paths:
            value = get(incoming, path)
            if value is not None:
                put(result, path, deepcopy(value))
    return result
