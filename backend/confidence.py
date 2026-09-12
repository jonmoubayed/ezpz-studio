"""Per-field model confidence contract; never substitutes a default score."""
from copy import deepcopy
import math
from typing import Any, Dict, Optional

CONTRACT_VERSION = "field-confidence-evidence-v2"
CONFIDENCE_INSTRUCTIONS = (
    "Return JSON matching the response schema below. For every extraction leaf, return "
    "{\"value\": <extracted value>, \"confidence\": <number from 0 to 1 or null>}. "
    "Keep nested objects structured; arrays are one field whose value contains the original array. "
    "Confidence is your self-assessment that the entire field value is correctly supported by the document, "
    "not OCR quality or an evaluation score. Use high scores only for clear, direct evidence; lower scores "
    "for ambiguity, conflicting evidence, inference, or incomplete arrays. Do not assign a fixed score to every field. "
    "Use null for a value you cannot extract, and null confidence if you cannot assess it. "
    "Do not invent evidence or use a default confidence."
)


def valid_confidence(value: Any) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if math.isfinite(value) and 0 <= value <= 1 else None


def response_schema(schema: Dict[str, Any], include_evidence: bool = False) -> Dict[str, Any]:
    """Wrap the same leaves canonicalization scores; keep user extraction schema untouched."""
    if schema.get("type") == "object":
        properties = {key: response_schema(value, include_evidence) for key, value in schema.get("properties", {}).items()}
        return {**{key: deepcopy(schema[key]) for key in ("$defs", "definitions", "description") if key in schema},
                "type": "object", "properties": properties,
                "required": list(properties), "additionalProperties": False}
    wrapped = {
        "type": "object", "additionalProperties": False,
        "properties": {
            "value": {"anyOf": [deepcopy(schema), {"type": "null"}]},
            "confidence": {"anyOf": [{"type": "number", "minimum": 0, "maximum": 1}, {"type": "null"}],
                           "description": "Model-reported confidence in correctness of the entire field, from 0 to 1; null if unavailable."},
        },
        "required": ["value", "confidence"],
    }

    if include_evidence:
        wrapped["properties"]["evidence"] = {
            "type": "array",
            "description": "Visible source regions supporting this field; empty when not locatable.",
            "items": {
                "type": "object", "additionalProperties": False,
                "properties": {
                    "page": {"type": "integer", "minimum": 1, "description": "1-based physical page number."},
                    "bbox": {"type": "array", "minItems": 4, "maxItems": 4,
                             "items": {"type": "number", "minimum": 0, "maximum": 1},
                             "description": "[left, top, right, bottom], normalized to [0,1], top-left origin."},
                    "text": {"type": "string", "description": "Verbatim text visible inside this region."},
                },
                "required": ["page", "bbox", "text"],
            },
        }
        wrapped["required"].append("evidence")
    return wrapped


def mark_model_confidence(output: Any, schema: Dict[str, Any]) -> Any:
    # Apply provenance ourselves; never trust a confidence-source label emitted by a model.
    if schema.get("type") == "object" and isinstance(output, dict):
        return {key: mark_model_confidence(value, schema.get("properties", {}).get(key, {}))
                for key, value in output.items()}
    if isinstance(output, dict) and "value" in output:
        score = valid_confidence(output.get("confidence"))
        return {**output, "confidence": score, "confidence_source": "model_reported" if score is not None else None}
    return output


def strict_response_schema(schema: Dict[str, Any]) -> Dict[str, Any]:
    """Adapt object values (including array items) to OpenAI's strict object contract."""
    result = deepcopy(schema)
    def visit(node: Any) -> None:
        if not isinstance(node, dict):
            return
        if node.get("type") == "object":
            props = node.get("properties", {})
            required = node.get("required", [])
            for key in props:
                if key not in required:
                    props[key] = {"anyOf": [props[key], {"type": "null"}]}
            node["required"] = list(props)
            node["additionalProperties"] = False
        for key in ("properties", "$defs", "definitions"):
            for child in node.get(key, {}).values():
                visit(child)
        visit(node.get("items"))
        for key in ("anyOf", "oneOf", "allOf"):
            for child in node.get(key, []):
                visit(child)
    visit(result)
    return result
