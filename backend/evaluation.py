"""Portable field-level evaluation primitives for extraction results.

The evaluator deliberately operates on dictionaries so it can be reused by the
local runtime, a future ezpz-evals adapter, and API clients without coupling
scoring to SQLite or a particular model provider.
"""

import re
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any, Dict, Iterable, List, Optional, Tuple


MISSING = object()


def _path_value(value: Any, path: str) -> Any:
    current = value
    for part in path.split("."):
        if not isinstance(current, dict) or part not in current:
            return MISSING
        current = current[part]
    return current


def _schema_for_path(schema: Dict[str, Any], path: str) -> Dict[str, Any]:
    current = schema or {}
    for part in path.split(".") if path else []:
        if current.get("type") != "object":
            return {}
        current = (current.get("properties") or {}).get(part) or {}
    return current if isinstance(current, dict) else {}


def _leaf_paths(schema: Dict[str, Any], prefix: str = "") -> List[str]:
    if schema.get("type") != "object":
        return [prefix] if prefix else []
    paths: List[str] = []
    for key, definition in (schema.get("properties") or {}).items():
        path = "{}.{}".format(prefix, key) if prefix else key
        if definition.get("type") == "object":
            paths.extend(_leaf_paths(definition, path))
        else:
            paths.append(path)
    return paths


def _flatten_value(value: Any, prefix: str = "") -> Iterable[str]:
    if isinstance(value, dict):
        for key, item in value.items():
            path = "{}.{}".format(prefix, key) if prefix else key
            yield from _flatten_value(item, path)
    elif prefix:
        yield prefix


def _prediction_paths(value: Any, prefix: str = "") -> Iterable[str]:
    """Yield field paths from flattened canonical fields or nested output."""
    if not isinstance(value, dict):
        if prefix:
            yield prefix
        return
    for key, item in value.items():
        path = "{}.{}".format(prefix, key) if prefix else str(key)
        if isinstance(item, dict) and "value" not in item:
            yield from _prediction_paths(item, path)
        else:
            yield path


def _prediction_field(fields: Dict[str, Any], path: str) -> Any:
    """Read a canonical field from flattened or nested client-provided output."""
    if path in fields:
        return fields[path]
    nested = _path_value(fields, path)
    return None if nested is MISSING else nested


def _is_missing_prediction(value: Any) -> bool:
    return value is None or value == ""


def _edit_distance(left: str, right: str) -> int:
    """Small dependency-free Levenshtein distance for optional fuzzy scoring."""
    previous = list(range(len(right) + 1))
    for row, left_char in enumerate(left, start=1):
        current = [row]
        for column, right_char in enumerate(right, start=1):
            current.append(min(
                current[-1] + 1,
                previous[column] + 1,
                previous[column - 1] + (left_char != right_char),
            ))
        previous = current
    return previous[-1]


def _normal_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value).strip()).casefold()


def _normal_number(value: Any) -> Optional[Decimal]:
    if isinstance(value, bool) or value is None:
        return None
    try:
        return Decimal(str(value).replace(",", "").replace("$", "").strip())
    except (InvalidOperation, ValueError):
        return None


def _normal_currency(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip().upper()
    symbols = {"$": "USD", "US$": "USD", "€": "EUR", "£": "GBP", "¥": "JPY"}
    if text in symbols:
        return symbols[text]
    if re.fullmatch(r"[A-Z]{3}", text):
        return text
    if "$" in text:
        return "USD"
    if "€" in text:
        return "EUR"
    if "£" in text:
        return "GBP"
    return _normal_text(text)


def _normal_date(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    text = str(value).strip()
    formats = (
        "%Y-%m-%d",
        "%Y/%m/%d",
        "%m/%d/%Y",
        "%m/%d/%y",
        "%b %d, %Y",
        "%B %d, %Y",
    )
    for pattern in formats:
        try:
            return datetime.strptime(text, pattern).date().isoformat()
        except ValueError:
            continue
    return _normal_text(text)


def _normalized_value(value: Any, definition: Dict[str, Any], path: str = "") -> Any:
    if value is None:
        return None
    field_type = definition.get("type")
    if definition.get("format") == "date":
        return _normal_date(value)
    if field_type in {"number", "integer"}:
        number = _normal_number(value)
        return number if number is not None else _normal_text(value)
    if field_type == "string" and (definition.get("format") == "currency" or path.endswith("currency")):
        return _normal_currency(value)
    if field_type == "string":
        return _normal_text(value)
    if field_type == "object" and isinstance(value, dict):
        properties = definition.get("properties") or {}
        return {
            key: _normalized_value(item, properties.get(key) or {}, "{}.{}".format(path, key) if path else key)
            for key, item in value.items()
        }
    if field_type == "array" and isinstance(value, list):
        item_definition = definition.get("items") or {}
        return [_normalized_value(item, item_definition, path) for item in value]
    return value


def _json_safe(value: Any) -> Any:
    """Convert evaluator-only numeric types into API/SQLite-safe JSON values."""
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, dict):
        return {key: _json_safe(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_json_safe(item) for item in value]
    return value


def _compare_values(expected: Any, actual: Any, definition: Dict[str, Any], path: str) -> Tuple[bool, str]:
    if expected == actual:
        return True, "exact"
    normalized_expected = _normalized_value(expected, definition, path)
    normalized_actual = _normalized_value(actual, definition, path)
    if normalized_expected == normalized_actual:
        return True, "normalized"
    return False, "none"


def _validation_errors(value: Any, definition: Dict[str, Any], path: str = "") -> List[str]:
    """Apply portable JSON-schema-like checks without requiring a validator package."""
    if value is None or not definition:
        return []
    if isinstance(value, dict) and "value" in value:
        value = value.get("value")
    if value is None:
        return []
    errors: List[str] = []
    field_type = definition.get("type")
    type_error = "{} must be {}".format(path or "value", field_type)
    if field_type == "object":
        if not isinstance(value, dict):
            return [type_error]
        for required in definition.get("required") or []:
            if required not in value or value[required] in (None, "") or (isinstance(value.get(required), dict) and "value" in value[required] and value[required].get("value") in (None, "")):
                errors.append("{} is required".format("{}.{}".format(path, required) if path else required))
        for key, child in (definition.get("properties") or {}).items():
            if key in value:
                child_path = "{}.{}".format(path, key) if path else key
                errors.extend(_validation_errors(value[key], child, child_path))
        return errors
    if field_type == "array":
        if not isinstance(value, list):
            return [type_error]
        item_definition = definition.get("items") or {}
        for index, item in enumerate(value):
            errors.extend(_validation_errors(item, item_definition, "{}[{}]".format(path or "value", index)))
        return errors
    if field_type == "string" and not isinstance(value, str):
        return [type_error]
    if field_type == "number" and (not isinstance(value, (int, float, Decimal)) or isinstance(value, bool)):
        return [type_error]
    if field_type == "integer" and (not isinstance(value, int) or isinstance(value, bool)):
        return [type_error]
    if field_type == "boolean" and not isinstance(value, bool):
        return [type_error]
    rules = definition.get("validation") if isinstance(definition.get("validation"), dict) else {}
    check_value = _normalized_value(value, definition) if definition.get("format") in {"date", "currency"} else value
    enum = rules.get("enum", definition.get("enum"))
    if isinstance(enum, list) and check_value not in enum and value not in enum:
        errors.append("value is not in enum")
    if isinstance(value, str):
        if rules.get("not_blank") and not value.strip():
            errors.append("value must not be blank")
        if definition.get("format") == "date":
            try:
                date.fromisoformat(str(check_value))
            except ValueError:
                errors.append("value is not a valid date")
        if definition.get("format") == "currency" and not re.fullmatch(r"[A-Z]{3}", str(check_value or "")):
            errors.append("value is not a supported ISO currency")
        if definition.get("minLength") is not None and len(value) < int(definition["minLength"]):
            errors.append("value is shorter than minLength")
        if definition.get("maxLength") is not None and len(value) > int(definition["maxLength"]):
            errors.append("value is longer than maxLength")
        pattern = definition.get("pattern")
        if pattern:
            try:
                if not re.search(str(pattern), value):
                    errors.append("value does not match pattern")
            except re.error:
                errors.append("schema pattern is invalid")
    if isinstance(value, (int, float, Decimal)) and not isinstance(value, bool):
        minimum = rules.get("minimum", rules.get("min", definition.get("minimum")))
        maximum = rules.get("maximum", rules.get("max", definition.get("maximum")))
        if minimum is not None and value < minimum:
            errors.append("value is below minimum")
        if maximum is not None and value > maximum:
            errors.append("value is above maximum")
    if definition.get("format") == "date" and rules.get("date_lte_today") and check_value:
        try:
            if date.fromisoformat(str(check_value)) > date.today():
                errors.append("date is in the future")
        except ValueError:
            pass
    return errors


def score_extraction(
    extraction: Dict[str, Any],
    ground_truth: Optional[Dict[str, Any]],
    schema: Optional[Dict[str, Any]] = None,
    scoring_config: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Score one extraction against one ground-truth revision."""
    scoring_config = scoring_config or {}
    result = extraction.get("result") or {}
    predicted_fields = result.get("fields") or extraction.get("fields") or {}
    ground_truth_value = (ground_truth or {}).get("value") or {}
    paths = _leaf_paths(schema or {})
    if not paths:
        paths = sorted(set(_prediction_paths(predicted_fields)) | set(_flatten_value(ground_truth_value)))

    annotated_paths = [path for path in paths if _path_value(ground_truth_value, path) is not MISSING]
    if scoring_config.get("required_fields"):
        annotated_paths = sorted(set(annotated_paths) | {
            str(path) for path in scoring_config["required_fields"] if str(path)
        })
    if scoring_config.get("include_hallucinations"):
        annotated_paths = sorted(set(annotated_paths) | (set(_prediction_paths(predicted_fields)) - set(paths)))
    if not ground_truth or not annotated_paths:
        return {
            "status": "unscored",
            "reason": "ground_truth_missing",
            "document_id": extraction.get("document_id"),
            "extraction_id": extraction.get("id"),
            "fields": {},
            "metrics": {
                "documents": 1,
                "scored_documents": 0,
                "unscored_documents": 1,
                "scored_fields": 0,
                "field_accuracy": None,
                "document_accuracy": None,
                "failure_count": 0,
                "precision": None,
                "recall": None,
                "f1": None,
                "field_completeness": None,
            },
        }

    field_results: Dict[str, Dict[str, Any]] = {}
    correct = exact = normalized = edit_distance_matches = incorrect = missing = hallucinated = validation_failed = 0
    confidences: List[float] = []
    for path in annotated_paths:
        expected = _path_value(ground_truth_value, path)
        field = _prediction_field(predicted_fields, path) or {}
        raw_actual = field.get("value") if isinstance(field, dict) else field
        normalized_actual = field.get("normalized_value") if isinstance(field, dict) else raw_actual
        actual = normalized_actual if normalized_actual is not None else raw_actual
        definition = _schema_for_path(schema or {}, path)
        confidence = field.get("confidence") if isinstance(field, dict) else None
        if confidence is not None:
            confidences.append(float(confidence))

        validation_errors = _validation_errors(actual, definition)
        if expected is None:
            if _is_missing_prediction(actual):
                status = "correct"
                match_type = "exact"
                correct += 1
                exact += 1
            else:
                status = "validation_failed" if validation_errors else "hallucinated"
                match_type = "none"
                if validation_errors:
                    validation_failed += 1
                else:
                    hallucinated += 1
        elif _is_missing_prediction(actual):
            status = "missing"
            match_type = "none"
            missing += 1
        else:
            matches, match_type = _compare_values(expected, actual, definition, path)
            tolerance = scoring_config.get("numeric_tolerance")
            if not matches and tolerance is not None:
                expected_number = _normal_number(expected)
                actual_number = _normal_number(actual)
                if expected_number is not None and actual_number is not None and abs(expected_number - actual_number) <= Decimal(str(tolerance)):
                    matches, match_type = True, "numeric_tolerance"
            edit_limit = int(scoring_config.get("edit_distance_max", 0) or 0)
            if not matches and edit_limit > 0 and isinstance(expected, str) and isinstance(actual, str):
                if _edit_distance(_normal_text(expected), _normal_text(actual)) <= edit_limit:
                    matches, match_type = True, "edit_distance"
            if validation_errors:
                status = "validation_failed"
                match_type = "none"
                validation_failed += 1
            elif matches:
                status = "correct"
                correct += 1
                if match_type == "exact":
                    exact += 1
                elif match_type == "edit_distance":
                    edit_distance_matches += 1
                else:
                    normalized += 1
            else:
                status = "validation_failed" if validation_errors else "incorrect"
                match_type = "none"
                if validation_errors:
                    validation_failed += 1
                else:
                    incorrect += 1

        field_results[path] = {
            "field_path": path,
            "status": status,
            "score": 1 if status == "correct" else 0,
            "match_type": match_type,
            "expected": expected,
            "actual": raw_actual,
            "normalized_expected": _json_safe(_normalized_value(expected, definition, path)),
            "normalized_actual": _json_safe(_normalized_value(actual, definition, path)),
            "confidence": confidence,
            "failure_type": None if status == "correct" else status,
            "validation_errors": validation_errors,
        }

    scored_fields = len(annotated_paths)
    failures = missing + hallucinated + incorrect + validation_failed
    predicted_positive = correct + incorrect + hallucinated + validation_failed
    actual_positive = correct + incorrect + missing + validation_failed
    precision = correct / predicted_positive if predicted_positive else None
    recall = correct / actual_positive if actual_positive else None
    f1 = (2 * precision * recall / (precision + recall)) if precision is not None and recall is not None and precision + recall else None
    metrics = {
        "documents": 1,
        "scored_documents": 1,
        "unscored_documents": 0,
        "scored_fields": scored_fields,
        "correct_fields": correct,
        "exact_matches": exact,
        "normalized_matches": normalized,
        "edit_distance_matches": edit_distance_matches,
        "incorrect_predictions": incorrect,
        "missing_fields": missing,
        "hallucinated_fields": hallucinated,
        "validation_failures": validation_failed,
        "failure_count": failures,
        "field_accuracy": round(correct / scored_fields, 4) if scored_fields else None,
        "overall_accuracy": round(correct / scored_fields, 4) if scored_fields else None,
        "precision": round(precision, 4) if precision is not None else None,
        "recall": round(recall, 4) if recall is not None else None,
        "f1": round(f1, 4) if f1 is not None else None,
        "field_completeness": round((scored_fields - missing) / scored_fields, 4) if scored_fields else None,
        "document_accuracy": 1 if failures == 0 else 0,
        "average_confidence": round(sum(confidences) / len(confidences), 4) if confidences else None,
    }
    return {
        "status": "scored",
        "document_id": extraction.get("document_id"),
        "extraction_id": extraction.get("id"),
        "ground_truth_revision": (ground_truth or {}).get("revision"),
        "fields": field_results,
        "metrics": metrics,
    }


def aggregate_evaluations(evaluations: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Aggregate persisted per-document evaluations into run metrics."""
    documents = len(evaluations)
    scored_documents = 0
    scored_fields = correct_fields = exact_matches = normalized_matches = 0
    incorrect_predictions = missing_fields = hallucinated_fields = validation_failures = failure_count = 0
    edit_distance_matches = 0
    confidence_values: List[float] = []
    precision_values: List[float] = []
    recall_values: List[float] = []
    f1_values: List[float] = []
    completeness_values: List[float] = []
    for evaluation in evaluations:
        metrics = evaluation.get("metrics") or {}
        if evaluation.get("status") == "scored":
            scored_documents += 1
        scored_fields += int(metrics.get("scored_fields") or 0)
        correct_fields += int(metrics.get("correct_fields") or 0)
        exact_matches += int(metrics.get("exact_matches") or 0)
        normalized_matches += int(metrics.get("normalized_matches") or 0)
        edit_distance_matches += int(metrics.get("edit_distance_matches") or 0)
        incorrect_predictions += int(metrics.get("incorrect_predictions") or 0)
        missing_fields += int(metrics.get("missing_fields") or 0)
        hallucinated_fields += int(metrics.get("hallucinated_fields") or 0)
        validation_failures += int(metrics.get("validation_failures") or 0)
        failure_count += int(metrics.get("failure_count") or 0)
        if metrics.get("average_confidence") is not None:
            confidence_values.append(float(metrics["average_confidence"]))
        for key, target in (("precision", precision_values), ("recall", recall_values), ("f1", f1_values), ("field_completeness", completeness_values)):
            if metrics.get(key) is not None:
                target.append(float(metrics[key]))
    precision = correct_fields / (correct_fields + incorrect_predictions + hallucinated_fields + validation_failures) if (correct_fields + incorrect_predictions + hallucinated_fields + validation_failures) else None
    recall = correct_fields / (correct_fields + incorrect_predictions + missing_fields + validation_failures) if (correct_fields + incorrect_predictions + missing_fields + validation_failures) else None
    f1 = (2 * precision * recall / (precision + recall)) if precision is not None and recall is not None and precision + recall else None
    return {
        "documents": documents,
        "scored_documents": scored_documents,
        "unscored_documents": documents - scored_documents,
        "scored_fields": scored_fields,
        "correct_fields": correct_fields,
        "exact_matches": exact_matches,
        "normalized_matches": normalized_matches,
        "edit_distance_matches": edit_distance_matches,
        "incorrect_predictions": incorrect_predictions,
        "missing_fields": missing_fields,
        "hallucinated_fields": hallucinated_fields,
        "validation_failures": validation_failures,
        "failure_count": failure_count,
        "field_accuracy": round(correct_fields / scored_fields, 4) if scored_fields else None,
        "overall_accuracy": round(correct_fields / scored_fields, 4) if scored_fields else None,
        "precision": round(precision, 4) if precision is not None else None,
        "recall": round(recall, 4) if recall is not None else None,
        "f1": round(f1, 4) if f1 is not None else None,
        "field_completeness": round((scored_fields - missing_fields) / scored_fields, 4) if scored_fields else None,
        "document_accuracy": round(
            sum(
                1
                for item in evaluations
                if item.get("status") == "scored"
                and int((item.get("metrics") or {}).get("failure_count") or 0) == 0
            )
            / scored_documents,
            4,
        ) if scored_documents else None,
        "average_confidence": round(sum(confidence_values) / len(confidence_values), 4) if confidence_values else None,
    }


def compare_evaluations(
    baseline: List[Dict[str, Any]],
    candidate: List[Dict[str, Any]],
    baseline_metrics: Optional[Dict[str, Any]] = None,
    candidate_metrics: Optional[Dict[str, Any]] = None,
    regression_threshold: float = 0.0,
) -> Dict[str, Any]:
    """Compare two runs at field and document level."""
    def field_map(items: List[Dict[str, Any]]) -> Dict[Tuple[str, str], Dict[str, Any]]:
        mapped: Dict[Tuple[str, str], Dict[str, Any]] = {}
        for evaluation in items:
            document_id = str(evaluation.get("document_id") or "")
            for field_path, field in (evaluation.get("fields") or {}).items():
                mapped[(document_id, field_path)] = field
        return mapped

    baseline_fields = field_map(baseline)
    candidate_fields = field_map(candidate)
    changes: List[Dict[str, Any]] = []
    for key in sorted(set(baseline_fields) | set(candidate_fields)):
        before = baseline_fields.get(key)
        after = candidate_fields.get(key)
        before_status = before.get("status") if before else None
        after_status = after.get("status") if after else None
        before_ok = before_status == "correct"
        after_ok = after_status == "correct"
        if before_ok and not after_ok:
            classification = "regressed"
        elif not before_ok and after_ok:
            classification = "improved"
        else:
            classification = "unchanged"
        failure_transition = None
        if not before_ok and after_status in {"incorrect", "missing", "hallucinated", "validation_failed"} and before_status is None:
            failure_transition = "new_failure"
        elif before_status in {"incorrect", "missing", "hallucinated", "validation_failed"} and after_ok:
            failure_transition = "fixed_failure"
        changes.append({
            "document_id": key[0],
            "field_path": key[1],
            "classification": classification,
            "failure_transition": failure_transition,
            "baseline": before,
            "candidate": after,
        })

    document_ids = sorted({item.get("document_id") for item in baseline + candidate if item.get("document_id")})
    document_changes: List[Dict[str, Any]] = []
    for document_id in document_ids:
        before_fields = [item for (doc, _), item in baseline_fields.items() if doc == document_id]
        after_fields = [item for (doc, _), item in candidate_fields.items() if doc == document_id]
        before_ok = bool(before_fields) and all(item.get("status") == "correct" for item in before_fields)
        after_ok = bool(after_fields) and all(item.get("status") == "correct" for item in after_fields)
        if before_ok and not after_ok:
            classification = "regressed"
        elif not before_ok and after_ok:
            classification = "improved"
        else:
            classification = "unchanged"
        failure_transition = None
        if not before_fields and any(item.get("status") in {"incorrect", "missing", "hallucinated", "validation_failed"} for item in after_fields):
            failure_transition = "new_failure"
        elif any(item.get("status") in {"incorrect", "missing", "hallucinated", "validation_failed"} for item in before_fields) and after_ok:
            failure_transition = "fixed_failure"
        document_changes.append({
            "document_id": document_id,
            "classification": classification,
            "failure_transition": failure_transition,
        })

    summary = {
        "improved": 0,
        "regressed": 0,
        "unchanged": 0,
        "new_failure": 0,
        "fixed_failure": 0,
    }
    for change in changes:
        summary[change["classification"]] += 1
        if change.get("failure_transition"):
            summary[change["failure_transition"]] += 1
    metric_delta = {}
    metric_gate = {"passed": True, "threshold": regression_threshold, "violations": []}
    baseline_metrics = baseline_metrics or {}
    candidate_metrics = candidate_metrics or {}
    for metric in ("field_accuracy", "document_accuracy", "precision", "recall", "f1", "field_completeness", "cost_usd", "average_latency_ms", "p95_latency_ms"):
        before = baseline_metrics.get(metric)
        after = candidate_metrics.get(metric)
        if before is None or after is None:
            continue
        delta = float(after) - float(before)
        metric_delta[metric] = {"baseline": before, "candidate": after, "delta": round(delta, 6)}
        if metric not in {"cost_usd", "average_latency_ms", "p95_latency_ms"} and delta < -abs(float(regression_threshold)):
            metric_gate["passed"] = False
            metric_gate["violations"].append(metric)
    return {
        "field_changes": changes,
        "document_changes": document_changes,
        "summary": summary,
        "metric_delta": metric_delta,
        "metric_gate": metric_gate,
    }
