"""Execution harnesses for extraction processors.

Harnesses are deliberately small and provider-agnostic. They orchestrate model
calls; canonicalization and persistence remain owned by the pipeline service.
"""

import importlib
import importlib.metadata
from copy import deepcopy
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

from .confidence import valid_confidence
from .models import DocumentIR, DocumentPage, ModelResult


@dataclass
class HarnessResult:
    output: Dict[str, Any]
    raw_response: Any
    usage: Dict[str, Any] = field(default_factory=dict)
    warnings: List[str] = field(default_factory=list)
    steps: List[Dict[str, Any]] = field(default_factory=list)
    model_usage: List[Dict[str, Any]] = field(default_factory=list)


ModelFactory = Callable[[Dict[str, Any]], Any]
HarnessHandler = Callable[..., HarnessResult]
_REGISTRY: Dict[str, HarnessHandler] = {}


def register_harness(name: str, handler: HarnessHandler) -> None:
    """Register a process-local harness, useful for plugins and tests."""
    clean_name = str(name or "").strip().lower()
    if not clean_name or not callable(handler):
        raise ValueError("a harness name and callable handler are required")
    _REGISTRY[clean_name] = handler


def _add_usage(total: Dict[str, Any], usage: Dict[str, Any]) -> Dict[str, Any]:
    merged = dict(total)
    for key, value in (usage or {}).items():
        if isinstance(value, (int, float)):
            merged[key] = merged.get(key, 0) + value
        elif key not in merged:
            merged[key] = value
    return merged


def _usage_entry(model: Any, usage: Dict[str, Any], config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    return {
        "model": getattr(model, "name", "unknown"),
        "provider": (config or {}).get("provider"),
        "usage": dict(usage or {}),
        "pricing": dict((config or {}).get("pricing") or {}),
    }


def _merge_values(current: Any, incoming: Any) -> Any:
    if current is None or current == "":
        return incoming
    if isinstance(current, dict) and isinstance(incoming, dict):
        if "value" in current or "value" in incoming:
            current_confidence = (valid_confidence(current.get("confidence")) or 0)
            incoming_confidence = (valid_confidence(incoming.get("confidence")) or 0)
            winner = incoming if incoming_confidence > current_confidence and incoming.get("value") not in (None, "") else current
            result = dict(winner)
            evidence = []
            for item in (current.get("evidence") or []) + (incoming.get("evidence") or []):
                if item not in evidence:
                    evidence.append(item)
            if evidence:
                result["evidence"] = evidence
            errors = []
            for item in (current.get("errors") or []) + (incoming.get("errors") or []):
                if item not in errors:
                    errors.append(item)
            if errors:
                result["errors"] = errors
            # Preserve the chosen value’s own confidence, including a missing score.
            result["confidence"] = valid_confidence(winner.get("confidence"))
            return result
        result = dict(current)
        for key, value in incoming.items():
            result[key] = _merge_values(result[key], value) if key in result else value
        return result
    if isinstance(current, list) and isinstance(incoming, list):
        return current + incoming
    return current


def _merge_outputs(outputs: List[Dict[str, Any]]) -> Dict[str, Any]:
    merged: Dict[str, Any] = {}
    for output in outputs:
        for key, value in (output or {}).items():
            merged[key] = _merge_values(merged[key], value) if key in merged else value
    return merged


def _page_ir(document_ir: DocumentIR, page: DocumentPage) -> DocumentIR:
    metadata = dict(document_ir.metadata)
    metadata["harness_page"] = page.page
    return DocumentIR(
        document_id=document_ir.document_id,
        parser=dict(document_ir.parser),
        metadata=metadata,
        pages=[page],
    )


def _required_and_type_errors(output: Dict[str, Any], schema: Dict[str, Any]) -> List[str]:
    errors: List[str] = []

    def inspect(value: Any, definition: Dict[str, Any], path: str) -> None:
        if isinstance(value, dict) and "value" in value:
            value = value.get("value")
        if value is None:
            return
        field_type = definition.get("type")
        valid = True
        if field_type == "object":
            valid = isinstance(value, dict)
        elif field_type == "array":
            valid = isinstance(value, list)
        elif field_type == "string":
            valid = isinstance(value, str)
        elif field_type == "number":
            valid = isinstance(value, (int, float)) and not isinstance(value, bool)
        elif field_type == "integer":
            valid = isinstance(value, int) and not isinstance(value, bool)
        elif field_type == "boolean":
            valid = isinstance(value, bool)
        if not valid:
            errors.append("{} must be {}".format(path, field_type))
            return
        if field_type == "object":
            for required in definition.get("required") or []:
                if required not in value or value[required] in (None, ""):
                    errors.append("{} is required".format("{}.{}".format(path, required) if path else required))
            for key, child in (definition.get("properties") or {}).items():
                if key in value:
                    inspect(value[key], child, "{}.{}".format(path, key) if path else key)
        elif field_type == "array":
            item_definition = definition.get("items") or {}
            for index, item in enumerate(value):
                inspect(item, item_definition, "{}[{}]".format(path, index))

    root = output or {}
    for required in schema.get("required") or []:
        if required not in root or (isinstance(root.get(required), dict) and "value" in root[required] and root[required].get("value") in (None, "")):
            errors.append("{} is required".format(required))
    inspect(root, schema, "")
    return sorted(set(errors))


def _direct(parser_ir: DocumentIR, schema: Dict[str, Any], prompt: Dict[str, Any], model: Any, model_config: Optional[Dict[str, Any]] = None, **_: Any) -> HarnessResult:
    result = model.run(parser_ir, schema, prompt)
    return HarnessResult(result.output, result.raw_response, result.usage, list(result.warnings), [{"name": "direct", "model": getattr(model, "name", "unknown")}], [_usage_entry(model, result.usage, model_config)])


def _page_extract(parser_ir: DocumentIR, schema: Dict[str, Any], prompt: Dict[str, Any], model: Any, model_config: Optional[Dict[str, Any]] = None, **_: Any) -> HarnessResult:
    outputs: List[Dict[str, Any]] = []
    raw_pages: List[Any] = []
    usage: Dict[str, Any] = {}
    warnings: List[str] = []
    steps: List[Dict[str, Any]] = []
    for page in parser_ir.pages:
        result = model.run(_page_ir(parser_ir, page), schema, prompt)
        outputs.append(result.output)
        raw_pages.append({"page": page.page, "response": result.raw_response})
        usage = _add_usage(usage, result.usage)
        warnings.extend(result.warnings)
        steps.append({"name": "page_extract", "page": page.page, "model": getattr(model, "name", "unknown")})
    return HarnessResult(_merge_outputs(outputs), {"harness": "page_extract", "pages": raw_pages}, usage, warnings, steps, [_usage_entry(model, usage, model_config)])


def _verify(parser_ir: DocumentIR, schema: Dict[str, Any], prompt: Dict[str, Any], model: Any, model_factory: ModelFactory, config: Dict[str, Any], model_config: Optional[Dict[str, Any]] = None, **_: Any) -> HarnessResult:
    primary = model.run(parser_ir, schema, prompt)
    verifier_config = config.get("verifier_model") or config.get("verify_model") or {}
    verifier = model_factory(verifier_config) if verifier_config else model
    verification_prompt = deepcopy(prompt)
    verification_prompt["extraction"] = "Verify and correct the extracted JSON against the schema. Return only JSON.\n\n{}".format(prompt.get("extraction") or "")
    checked = verifier.run(parser_ir, schema, verification_prompt)
    errors = _required_and_type_errors(checked.output, schema)
    warnings = list(primary.warnings) + list(checked.warnings)
    if errors:
        warnings.append("Verifier output failed validation: {}".format("; ".join(errors)))
        output = primary.output
    else:
        output = checked.output
    return HarnessResult(
        output,
        {"harness": "verify", "initial": primary.raw_response, "verified": checked.raw_response, "validation_errors": errors},
        _add_usage(primary.usage, checked.usage),
        warnings,
        [
            {"name": "extract", "model": getattr(model, "name", "unknown")},
            {"name": "verify", "model": getattr(verifier, "name", "unknown"), "validation_errors": errors},
        ],
        [_usage_entry(model, primary.usage, model_config), _usage_entry(verifier, checked.usage, verifier_config or model_config)],
    )


def _confidence(output: Any) -> float:
    scores: List[float] = []
    def collect(value: Any) -> None:
        if isinstance(value, dict):
            if "value" in value and "confidence" in value and not isinstance(value.get("confidence"), dict):
                score = valid_confidence(value.get("confidence"))
                if score is not None:
                    scores.append(score)
            else:
                for item in value.values():
                    collect(item)
        elif isinstance(value, list):
            for item in value:
                collect(item)
    collect(output)
    return sum(scores) / len(scores) if scores else 0.0


def _cascade(parser_ir: DocumentIR, schema: Dict[str, Any], prompt: Dict[str, Any], model: Any, model_factory: ModelFactory, config: Dict[str, Any], model_config: Optional[Dict[str, Any]] = None, **_: Any) -> HarnessResult:
    primary = model.run(parser_ir, schema, prompt)
    threshold = float(config.get("threshold", config.get("confidence_threshold", 0.75)) or 0.75)
    confidence = _confidence(primary.output)
    if confidence >= threshold:
        return HarnessResult(primary.output, {"harness": "cascade", "selected": "primary", "primary": primary.raw_response, "confidence": confidence, "threshold": threshold}, primary.usage, list(primary.warnings), [{"name": "primary", "model": getattr(model, "name", "unknown"), "confidence": confidence, "selected": True}], [_usage_entry(model, primary.usage, model_config)])
    fallback_config = config.get("fallback_model") or config.get("fallback") or {"provider": "local", "name": "deterministic-local"}
    if isinstance(fallback_config, str):
        fallback_config = {"provider": "local", "name": fallback_config}
    fallback = model_factory(fallback_config)
    checked = fallback.run(parser_ir, schema, prompt)
    warnings = list(primary.warnings) + list(checked.warnings)
    warnings.append("Cascade selected fallback because confidence {:.3f} was below {:.3f}.".format(confidence, threshold))
    return HarnessResult(
        checked.output,
        {"harness": "cascade", "selected": "fallback", "primary": primary.raw_response, "fallback": checked.raw_response, "confidence": confidence, "threshold": threshold},
        _add_usage(primary.usage, checked.usage),
        warnings,
        [{"name": "primary", "model": getattr(model, "name", "unknown"), "confidence": confidence, "selected": False}, {"name": "fallback", "model": getattr(fallback, "name", "unknown"), "selected": True}],
        [_usage_entry(model, primary.usage, model_config), _usage_entry(fallback, checked.usage, fallback_config)],
    )


def _load_external(ref: str) -> HarnessHandler:
    if ":" not in ref:
        raise ValueError("plugin must use module:attribute notation")
    module_name, attribute = ref.split(":", 1)
    handler = getattr(importlib.import_module(module_name), attribute)
    if not callable(handler):
        raise ValueError("plugin {} is not callable".format(ref))
    return handler


def _plugin(parser_ir: DocumentIR, schema: Dict[str, Any], prompt: Dict[str, Any], model: Any, config: Dict[str, Any], **kwargs: Any) -> HarnessResult:
    ref = config.get("plugin") or config.get("handler")
    handler = _REGISTRY.get(str(ref or "").lower()) if ref else None
    handler = handler or (_load_external(str(ref)) if ref else None)
    if not handler:
        try:
            candidates = importlib.metadata.entry_points(group="ezpz.harnesses")
        except TypeError:
            candidates = importlib.metadata.entry_points().get("ezpz.harnesses", [])
        entry = next((item for item in candidates if item.name == str(config.get("name") or "custom")), None)
        handler = entry.load() if entry else None
    if not handler:
        raise ValueError("Harness plugin not found: {}".format(ref or config.get("name")))
    result = handler(parser_ir=parser_ir, schema=schema, prompt=prompt, model=model, config=config, **kwargs)
    if isinstance(result, HarnessResult):
        return result
    if isinstance(result, ModelResult):
        return HarnessResult(result.output, result.raw_response, result.usage, result.warnings, [{"name": "plugin", "plugin": ref}])
    if isinstance(result, dict) and isinstance(result.get("output"), dict):
        return HarnessResult(result["output"], result.get("raw_response", result), result.get("usage", {}), result.get("warnings", []), result.get("steps", [{"name": "plugin", "plugin": ref}]), result.get("model_usage", []))
    raise ValueError("Harness plugin must return HarnessResult, ModelResult, or an output mapping")


def run_harness(parser_ir: DocumentIR, schema: Dict[str, Any], prompt: Dict[str, Any], harness_config: Optional[Dict[str, Any]], model: Any, model_factory: ModelFactory, model_config: Optional[Dict[str, Any]] = None, source_document: Optional[Dict[str, Any]] = None, source_bytes: Optional[bytes] = None) -> HarnessResult:
    config = dict(harness_config or {})
    name = str(config.get("name") or "direct").strip().lower()
    builtins = {"direct": _direct, "parse_extract": _direct, "page_extract": _page_extract, "verify": _verify, "cascade": _cascade, "custom": _plugin}
    handler = _REGISTRY.get(name) or builtins.get(name)
    if not handler:
        try:
            handler = importlib.metadata.entry_points(group="ezpz.harnesses").select(name=name)[0].load()
        except (AttributeError, IndexError, TypeError):
            raise ValueError("Unsupported extraction harness: {}".format(name))
    source = {"source_document": source_document, "source_bytes": source_bytes} if name == "custom" and source_document is not None else {}
    return handler(parser_ir=parser_ir, schema=schema, prompt=prompt, harness_config=config, config=config, model=model, model_factory=model_factory, model_config=model_config, **source)
