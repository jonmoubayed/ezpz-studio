import re
import time
import threading
import math
import hashlib
import json
from copy import deepcopy
from decimal import Decimal, InvalidOperation
from typing import Any, Dict, List, Optional, Tuple

from .costing import estimate_cost
from .confidence import CONTRACT_VERSION, valid_confidence
from .grounding import valid_region
from .db import Database
from .evaluation import aggregate_evaluations, score_extraction
from .harness import run_harness
from .harness_runtime import execute_harness, saved_latency_ms
from .resumable import EvaluationRecovery, EvaluationInterrupted
from .model import create_model_adapter
from .models import CanonicalResult, DocumentIR, Evidence, FieldResult, new_id
from .parser import parse_document
from .storage import BlobStore


def _get_path(value: Any, path: str) -> Any:
    current = value
    for part in path.split("."):
        if not isinstance(current, dict) or part not in current:
            return None
        current = current[part]
    return current


def _schema_fields(schema: Dict[str, Any], prefix: str = "") -> List[Tuple[str, Dict[str, Any]]]:
    if schema.get("type") != "object":
        return [(prefix, schema)] if prefix else []
    fields = []
    for key, definition in (schema.get("properties") or {}).items():
        path = "{}.{}".format(prefix, key) if prefix else key
        if definition.get("type") == "object":
            fields.extend(_schema_fields(definition, path))
        else:
            fields.append((path, definition))
    return fields


def _unwrap_value(raw: Any) -> Tuple[Any, Optional[float], List[Dict[str, Any]], List[str]]:
    if isinstance(raw, dict) and "value" in raw:
        return (
            raw.get("value"),
            valid_confidence(raw.get("confidence")),
            raw.get("evidence") or [],
            raw.get("errors") or [],
        )
    return raw, None, [], []


def _normalize(value: Any, definition: Dict[str, Any]) -> Any:
    if value is None:
        return None
    field_type = definition.get("type")
    if field_type in {"number", "integer"}:
        if isinstance(value, (int, float)):
            return value
        try:
            number = Decimal(str(value).replace(",", "").replace("$", "").strip())
            return int(number) if field_type == "integer" else float(number)
        except (InvalidOperation, ValueError):
            return value
    if field_type == "string":
        return str(value).strip()
    if field_type == "object" and isinstance(value, dict):
        return {
            key: _normalize(item, (definition.get("properties") or {}).get(key, {}))
            for key, item in value.items()
        }
    if field_type == "array" and isinstance(value, list):
        item_definition = definition.get("items") or {}
        return [_normalize(item, item_definition) for item in value]
    return value


def _value_needle(value: Any) -> Optional[str]:
    if value in (None, ""):
        return None
    if isinstance(value, dict):
        for item in value.values():
            needle = _value_needle(item)
            if needle:
                return needle
        return None
    if isinstance(value, list):
        for item in value:
            needle = _value_needle(item)
            if needle:
                return needle
        return None
    return str(value)


def _value_matches_block(value: Any, text: str) -> bool:
    needle = _value_needle(value)
    if not needle or not text:
        return False
    haystack = str(text).lower()
    needle_text = needle.lower()
    if needle_text in haystack:
        return True
    # Tables commonly format numeric values as "$215,938" while the model
    # returns 215938. Compare a compact representation as a fallback.
    compact_haystack = re.sub(r"[^a-z0-9.]", "", haystack)
    compact_needle = re.sub(r"[^a-z0-9.]", "", needle_text)
    return bool(compact_needle) and compact_needle in compact_haystack


def _evidence_for_value(parser_ir: DocumentIR, value: Any) -> List[Evidence]:
    # Compatibility parsing preserves text for extraction but does not know
    # where that text appears on the source image. Returning its synthetic
    # full-width line boxes makes the inspector look precise while being wrong.
    if parser_ir.parser.get("status") != "available":
        return []
    candidates = []
    for page in parser_ir.pages:
        for block in page.blocks:
            if not block.bbox or not _value_matches_block(value, block.text):
                continue
            source = block.metadata.get("bbox_source") or block.metadata.get("grounding") or "parser"
            # Prefer the earliest matching page, then precise grounded boxes,
            # then the smallest matching block. Estimated boxes remain useful
            # citations when they are the only location available.
            inferred_rank = 1 if source == "inferred" else 0
            area = max(0.0, block.bbox[2] - block.bbox[0]) * max(0.0, block.bbox[3] - block.bbox[1])
            source_index = block.metadata.get("source_index", 10**9)
            candidates.append((page.page, inferred_rank, area, source_index, block))
    if not candidates:
        return []
    candidates.sort(key=lambda item: item[:4])
    page_number, _inferred_rank, _area, _source_index, block = candidates[0]
    metadata = {
        key: block.metadata[key]
        for key in ("bbox_source", "grounding", "source_index")
        if key in block.metadata
    }
    return [Evidence(page=page_number, bbox=block.bbox, text=block.text, block_id=block.block_id, metadata=metadata)]


def canonicalize(
    output: Dict[str, Any],
    schema: Dict[str, Any],
    processor_version: Dict[str, Any],
    parser_ir: DocumentIR,
    model_name: str,
) -> CanonicalResult:
    fields: Dict[str, FieldResult] = {}
    for path, definition in _schema_fields(schema):
        raw = _get_path(output, path)
        value, confidence, raw_evidence, errors = _unwrap_value(raw)
        evidence = []
        for item in raw_evidence if isinstance(raw_evidence, list) else []:
            if isinstance(item, Evidence):
                item = item.to_dict()
            if not isinstance(item, dict):
                continue
            region = valid_region(item, parser_ir.metadata.get("page_count"))
            if not region:
                continue
            metadata = dict(item["metadata"]) if isinstance(item.get("metadata"), dict) else {}
            for key in ("bbox_source", "grounding", "source_index"):
                if key in item and key not in metadata:
                    metadata[key] = item[key]
            evidence.append(Evidence(**region, block_id=item.get("block_id"), metadata=metadata))
        if not evidence:
            evidence = _evidence_for_value(parser_ir, value)
        fields[path] = FieldResult(
            value=value,
            normalized_value=_normalize(value, definition),
            confidence=confidence,
            evidence=evidence,
            errors=errors,
            provenance={
                "processor_version_id": processor_version["id"],
                "model": (raw.get("harness_provenance", {}).get("model") if isinstance(raw, dict) else None) or model_name,
                "harness": raw.get("harness_provenance") if isinstance(raw, dict) else None,
                "selection": raw.get("selection") if isinstance(raw, dict) else None,
                "confidence_source": raw.get("confidence_source") if isinstance(raw, dict) and confidence is not None else None,
                "parser": parser_ir.parser,
            },
        )
    return CanonicalResult(
        fields=fields,
        errors=[],
        warnings=list(parser_ir.parser.get("warnings", [])),
        provenance={
            "processor_version_id": processor_version["id"],
            "parser": parser_ir.parser,
            "model": model_name,
            "harness": processor_version.get("harness", {}),
        },
    )


class ExtractionService:
    def __init__(self, database: Database, blobs: BlobStore):
        self.database = database
        self.blobs = blobs
        self.background_slots = threading.BoundedSemaphore(1)
        self.recovery = EvaluationRecovery(self)

    def extract_document(
        self,
        document_id: str,
        processor_ref: str = "invoice-extractor",
        version: Optional[int] = None,
        run_id: Optional[str] = None,
        processor_version_override: Optional[Dict[str, Any]] = None,
        persist: bool = True,
        scoring_config: Optional[Dict[str, Any]] = None,
        force_refresh: bool = False,
    ) -> Dict[str, Any]:
        document = self.database.get_document(document_id)
        if not document:
            raise ValueError("Document not found: {}".format(document_id))
        processor_version = processor_version_override or self._resolve_processor_version(processor_ref, version)
        if not processor_version:
            raise ValueError("Processor version not found: {}".format(processor_ref))
        owns_run = run_id is None
        if persist:
            run = self.database.get_run(run_id) if run_id else self.database.create_run(
                processor_version_id=processor_version["id"],
                target_type="document",
                document_id=document_id,
                scoring_config=scoring_config,
            )
        else:
            run = {
                "id": run_id or new_id("preview"),
                "processor_version_id": processor_version["id"],
                "target_type": "preview",
                "document_id": document_id,
                "status": "preview",
            }
        if not run:
            raise ValueError("Run not found: {}".format(run_id))
        active_run_id = run["id"]
        if persist and not owns_run:
            # Result and evaluation commit together. Recover a commit whose worker
            # stopped before acknowledging the document in the coordinator.
            existing = next((e for e in self.database.list_extractions(active_run_id)
                             if e["document_id"] == document_id and e.get("evaluation")), None)
            if existing:
                existing["run"] = run
                existing["document"] = document
                self._decorate_response(existing, processor_ref)
                return existing
        started = time.perf_counter()
        cache_enabled = persist and processor_version_override is None and processor_version.get("cache", True) is not False
        cache_key = self._cache_key(document, processor_version) if cache_enabled else None
        try:
            cached = self.database.get_extraction_cache(cache_key) if cache_key and not force_refresh else None
            if cached:
                latency_ms = int((time.perf_counter() - started) * 1000)
                extraction_payload = {
                    "id": new_id("ext"),
                    "run_id": active_run_id,
                    "document_id": document_id,
                    "processor_version_id": processor_version["id"],
                    "status": "completed",
                    "result": cached["result"],
                    "raw_response": cached["raw_response"],
                    "parser_ir": cached["parser_ir"],
                    "usage": cached["usage"],
                    "cost_usd": 0,
                    "latency_ms": latency_ms,
                    "parser_latency_ms": 0,
                    "model_latency_ms": 0,
                    "cache_hit": True,
                    "warnings": cached.get("warnings", []),
                }
                with self.database.atomic():
                    extraction = self.database.insert_extraction(extraction_payload)
                    self.database.insert_extraction_fields(extraction_payload["id"], (cached["result"].get("fields") or {}))
                    extraction = self.database.get_extraction(extraction_payload["id"]) or extraction
                    evaluation = self._persist_evaluation(extraction, processor_version, active_run_id, scoring_config)
                    extraction = self.database.get_extraction(extraction_payload["id"]) or extraction
                metrics = {"documents": 1, "completed": 1, "failed": 0, "cache_hits": 1, "cache_misses": 0, "latency_ms": latency_ms, "cost_usd": extraction["cost_usd"]}
                metrics.update(evaluation.get("metrics", {}))
                if owns_run and persist:
                    self.database.finish_run(active_run_id, "completed", metrics)
                extraction["run"] = self.database.get_run(active_run_id) if persist else run
                extraction["document"] = document
                self._decorate_response(extraction, processor_ref)
                return extraction

            data = self.blobs.get(document["blob_key"])
            model_started = time.perf_counter()
            import tempfile
            from pathlib import Path
            from contextlib import nullcontext
            execution_id = active_run_id + ":" + document_id
            saved_directory = self.database.path.parent / "harness-state" / hashlib.sha256(execution_id.encode()).hexdigest()
            with (nullcontext(str(saved_directory)) if persist else tempfile.TemporaryDirectory()) as execution_directory:
                parser_ir, harness_result = execute_harness(
                    document, data, processor_version,
                    lambda model_config: self._model(processor_version) if model_config == processor_version.get("model") else self._model_from_config(model_config),
                    Path(execution_directory), execution_id,
                    (lambda: self.recovery.check(active_run_id)) if persist and not owns_run else None,
                )
            parser_latency_ms = saved_latency_ms(harness_result.steps, {"parse"})
            model_latency_ms = saved_latency_ms(harness_result.steps, {"extract", "plugin"})
            model = self._model(processor_version)
            canonical = canonicalize(
                harness_result.output,
                processor_version.get("schema", {}),
                processor_version,
                parser_ir,
                getattr(model, "name", processor_version.get("model", {}).get("name", "unknown")),
            )
            canonical.provenance["harness_steps"] = harness_result.steps
            canonical.warnings.extend(harness_result.warnings)
            latency_ms = max(int((time.perf_counter() - started) * 1000), saved_latency_ms(harness_result.steps))
            extraction_id = new_id("ext")
            extraction_payload = {
                "id": extraction_id,
                "run_id": active_run_id,
                "document_id": document_id,
                "processor_version_id": processor_version["id"],
                "status": "completed",
                "result": canonical.to_dict(),
                "raw_response": harness_result.raw_response,
                "parser_ir": parser_ir.to_dict(),
                "usage": {**harness_result.usage, "models": harness_result.model_usage},
                "cost_usd": self._cost(processor_version, harness_result.usage, harness_result.model_usage),
                "latency_ms": latency_ms,
                "parser_latency_ms": parser_latency_ms,
                "model_latency_ms": model_latency_ms,
                "cache_hit": False,
                "warnings": canonical.warnings,
            }
            field_payload = {path: field.to_dict() for path, field in canonical.fields.items()}
            if persist:
                with self.database.atomic():
                    extraction = self.database.insert_extraction(extraction_payload)
                    self.database.insert_extraction_fields(extraction_id, field_payload)
                    extraction = self.database.get_extraction(extraction_id) or extraction
                    evaluation = self._persist_evaluation(extraction, processor_version, active_run_id, scoring_config)
                    extraction = self.database.get_extraction(extraction_id) or extraction
                if cache_key:
                    self.database.put_extraction_cache(cache_key, document["sha256"], processor_version["id"], extraction_payload)
            else:
                extraction = dict(extraction_payload)
                extraction["fields"] = field_payload
                extraction["processor_version"] = processor_version
                evaluation = score_extraction(extraction, self.database.get_ground_truth(document_id), processor_version.get("schema", {}), scoring_config)
                extraction["evaluation"] = evaluation
            confidences = [item.confidence for item in canonical.fields.values() if item.confidence is not None]
            metrics = {
                "documents": 1,
                "completed": 1,
                "failed": 0,
                "field_count": len(canonical.fields),
                "average_confidence": round(
                    sum(confidences) / len(confidences),
                    4,
                ) if confidences else None,
                "latency_ms": latency_ms,
                "cost_usd": extraction["cost_usd"],
                "cache_hits": 0,
                "cache_misses": 1,
            }
            for key in (
                "scored_documents",
                "unscored_documents",
                "scored_fields",
                "correct_fields",
                "exact_matches",
                "normalized_matches",
                "edit_distance_matches",
                "incorrect_predictions",
                "missing_fields",
                "hallucinated_fields",
                "validation_failures",
                "failure_count",
                "field_accuracy",
                "overall_accuracy",
                "precision",
                "recall",
                "f1",
                "field_completeness",
                "document_accuracy",
            ):
                if key in evaluation.get("metrics", {}):
                    metrics[key] = evaluation["metrics"][key]
            metrics["evaluation_average_confidence"] = evaluation.get("metrics", {}).get("average_confidence")
            if owns_run and persist:
                self.database.finish_run(active_run_id, "completed", metrics)
            extraction["run"] = self.database.get_run(active_run_id) if persist else run
            extraction["document"] = document
            self._decorate_response(extraction, processor_ref)
            return extraction
        except Exception as error:
            if owns_run and persist:
                self.database.finish_run(active_run_id, "failed", {"documents": 1, "completed": 0, "failed": 1}, str(error))
            raise

    def preview_document(
        self,
        document_id: str,
        processor_ref: str = "invoice-extractor",
        config: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        base_version = self._resolve_processor_version(processor_ref, None)
        if not base_version:
            raise ValueError("Processor version not found: {}".format(processor_ref))
        preview_version = deepcopy(base_version)
        for key in ("schema", "prompt", "parser", "model", "harness", "normalization"):
            if config and key in config:
                preview_version[key] = config[key]
        result = self.extract_document(
            document_id,
            processor_ref=processor_ref,
            processor_version_override=preview_version,
            persist=False,
        )
        result["preview"] = True
        return result

    def run_dataset(
        self,
        dataset_id: str,
        processor_ref: str = "invoice-extractor",
        version: Optional[int] = None,
        document_ids: Optional[List[str]] = None,
        scoring_config: Optional[Dict[str, Any]] = None,
        metadata: Optional[Dict[str, Any]] = None,
        force_refresh: bool = True,
        eval_experiment_id: Optional[str] = None,
        background: bool = False,
        frozen_benchmark: Optional[Dict[str, Any]] = None,
        on_created=None,
    ) -> Dict[str, Any]:
        processor_version = self._resolve_processor_version(processor_ref, version)
        if not processor_version:
            raise ValueError("Processor version not found: {}".format(processor_ref))
        if eval_experiment_id:
            experiment = self.database.get_eval_experiment(eval_experiment_id)
            if not experiment:
                raise ValueError("Eval experiment not found: {}".format(eval_experiment_id))
            if experiment["dataset_id"] != dataset_id:
                raise ValueError("Eval experiment does not belong to this benchmark dataset")
            experiment_version = experiment.get("processor_version")
            if not experiment_version:
                raise ValueError("Eval experiment has no configuration snapshot")
            processor_version = experiment_version
            processor_ref = processor_version["processor_id"]
            version = processor_version["version"]
        else:
            experiment = self.database.ensure_eval_experiment_for_dataset(dataset_id, processor_version["id"])
            eval_experiment_id = experiment["id"] if experiment else None
        # Resolve once so publishing another version cannot change an in-flight run.
        processor_ref = processor_version["processor_id"]
        version = processor_version["version"]
        if document_ids is not None and not isinstance(document_ids, (list, tuple, set)):
            raise ValueError("document_ids must be a list")
        if frozen_benchmark is None:
            documents = self.database.snapshot_dataset(dataset_id, document_ids)
        else:
            documents = []
            for saved in frozen_benchmark["documents"]:
                document = self.database.get_document(saved["id"])
                if not document or document.get("sha256") != saved.get("sha256"):
                    raise ValueError("A frozen benchmark document was removed or changed. Stop and establish a new baseline.")
                documents.append({**document, "ground_truth": deepcopy(saved.get("ground_truth"))})
        if not documents:
            raise ValueError("Add documents to the benchmark before running an evaluation")
        benchmark = [{"id": d["id"], "sha256": d.get("sha256"), "name": d.get("filename"), "ground_truth": d.get("ground_truth")} for d in documents]
        fingerprint = [{"id": d["id"], "sha256": d["sha256"], "ground_truth": {k: d["ground_truth"].get(k) for k in ("revision", "value", "annotation_status")} if d["ground_truth"] else None} for d in benchmark]
        run_metadata = dict(metadata or {})
        run_metadata["cache_mode"] = "bypass" if force_refresh else "prefer"
        run_metadata["fresh_extraction"] = bool(force_refresh)
        run_metadata["benchmark_snapshot"] = {"documents": benchmark, "fingerprint": hashlib.sha256(json.dumps(fingerprint, sort_keys=True, separators=(",", ":")).encode()).hexdigest()}
        if frozen_benchmark is not None:
            if run_metadata["benchmark_snapshot"]["fingerprint"] != frozen_benchmark["fingerprint"]:
                raise ValueError("Frozen benchmark fingerprint does not match its documents")
            run_metadata["benchmark_snapshot"] = deepcopy(frozen_benchmark)
        if background and not self.background_slots.acquire(blocking=False):
            raise ValueError("An evaluation is already running. Wait for it to finish or cancel it before starting another.")
        try:
            run = self.database.create_run(
                processor_version_id=processor_version["id"],
                target_type="dataset",
                eval_experiment_id=eval_experiment_id,
                dataset_id=dataset_id,
                scoring_config=scoring_config,
                metadata=run_metadata,
            )
            self.database.update_run_progress(run["id"], {"documents": len(documents), "completed": 0, "failed": 0})
            if on_created:
                on_created(run)
        except Exception:
            if background:
                self.background_slots.release()
            raise
        return self.recovery.dispatch(run, documents, processor_ref, version, scoring_config, force_refresh, background)

    def _execute_dataset_run(self, run, documents, processor_ref, version, scoring_config, force_refresh):
        # Reconstruct progress from durable results; never depend on a surviving worker.
        outcomes = self.recovery.outcomes(run["id"])
        results = [result for result in self.database.list_extractions(run["id"])
                   if outcomes.get(result["document_id"], {}).get("status") == "completed"]
        failures = [{"document_id": key, "error": value["error"]} for key, value in outcomes.items() if value["status"] == "failed"]
        total_cost = sum(float(result.get("cost_usd") or 0) for result in results)
        total_latency = sum(int(result.get("latency_ms") or 0) for result in results)
        interrupted = None
        cancelled = False
        for document in documents:
            if outcomes.get(document["id"], {}).get("status") in ("completed", "failed"):
                continue
            try:
                self.recovery.check(run["id"])
                self.recovery.outcome(run["id"], document["id"], "running")
                result = self.extract_document(
                    document["id"],
                    processor_ref=processor_ref,
                    version=version,
                    run_id=run["id"],
                    scoring_config=scoring_config,
                    force_refresh=force_refresh,
                )
                self.recovery.outcome(run["id"], document["id"], "completed")
                results.append(result)
                total_cost += float(result.get("cost_usd", 0))
                total_latency += int(result.get("latency_ms", 0))
            except (EvaluationInterrupted, ConnectionError, TimeoutError) as error:
                interrupted = self.recovery.interrupted_status(run["id"], error)
                break
            except Exception as error:
                self.recovery.outcome(run["id"], document["id"], "failed", str(error))
                failures.append({"document_id": document["id"], "error": str(error)})
            self.database.update_run_progress(run["id"], {"documents": len(documents), "completed": len(results), "failed": len(failures), "failures": failures})
        metrics = {
            "documents": len(documents),
            "completed": len(results),
            "failed": len(failures),
            "average_latency_ms": round(total_latency / max(1, len(results))),
            "cost_usd": round(total_cost, 6),
            "cache_hits": sum(1 for result in results if result.get("cache_hit")),
            "cache_misses": sum(1 for result in results if not result.get("cache_hit")),
        }
        metrics.update(aggregate_evaluations([result["evaluation"] for result in results if result.get("evaluation")]))
        metrics["documents"] = len(documents)
        metrics["completed"] = len(results)
        metrics["failed"] = len(failures)
        metrics["average_latency_ms"] = round(total_latency / max(1, len(results)))
        metrics["cost_usd"] = round(total_cost, 6)
        latencies = sorted(int(result.get("latency_ms", 0)) for result in results)
        p95_index = min(len(latencies) - 1, max(0, int(math.ceil(len(latencies) * 0.95)) - 1))
        metrics["p95_latency_ms"] = latencies[p95_index] if latencies else 0
        metrics["cost_per_document"] = round(total_cost / max(1, len(documents)), 8)
        metrics["cost_per_correct_document"] = round(total_cost / max(1, int((metrics.get("document_accuracy") or 0) * int(metrics.get("scored_documents") or 0))), 8) if metrics.get("document_accuracy") is not None and metrics.get("scored_documents") else None
        metrics["failures"] = failures
        status = "cancelled" if cancelled or self.database.get_run(run["id"])["status"] == "cancelling" else ("completed" if not failures else "completed_with_failures" if results else "failed")
        if interrupted:
            self.database._execute("UPDATE runs SET metrics_json = ? WHERE id = ?", (json.dumps(metrics), run["id"]))
            final_run = self.database.get_run(run["id"])
        else:
            final_run = self.database.finish_run(run["id"], status, metrics)
        return {"run": final_run, "results": results, "failures": failures}

    def _persist_evaluation(
        self,
        extraction: Dict[str, Any],
        processor_version: Dict[str, Any],
        run_id: str,
        scoring_config: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        run_metadata = json.loads(self.database._one("SELECT metadata_json FROM runs WHERE id = ?", (run_id,))["metadata_json"] or "{}")
        snapshot = run_metadata.get("benchmark_snapshot")
        truth = next((d.get("ground_truth") for d in snapshot["documents"] if d["id"] == extraction["document_id"]), None) if snapshot else self.database.get_ground_truth(extraction["document_id"])
        evaluation = score_extraction(
            extraction,
            truth,
            processor_version.get("schema", {}),
            scoring_config,
        )
        evaluation.update(
            {
                "id": new_id("eval"),
                "run_id": run_id,
                "extraction_id": extraction["id"],
                "document_id": extraction["document_id"],
                "processor_version_id": processor_version["id"],
            }
        )
        persisted = self.database.insert_evaluation(evaluation)
        self.database.insert_evaluation_fields(evaluation["id"], evaluation.get("fields", {}))
        return self.database.get_evaluation(evaluation["id"]) or persisted

    def _resolve_processor_version(self, processor_ref: str, version: Optional[int]) -> Optional[Dict[str, Any]]:
        return self.database.resolve_processor_version(processor_ref, version)

    @staticmethod
    def _cache_key(document: Dict[str, Any], processor_version: Dict[str, Any]) -> str:
        payload = {
            "document_sha256": document.get("sha256"),
            "processor_version_id": processor_version.get("id"),
            # Bump when parser IR geometry changes; cached results must not
            # preserve stale layout boxes after a parser fix.
            "cache_schema": 3,
            "response_contract": CONTRACT_VERSION,
        }
        return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()

    @staticmethod
    def _decorate_response(extraction: Dict[str, Any], processor_ref: str) -> None:
        """Expose the stable extraction API shape while retaining legacy fields."""
        values: Dict[str, Any] = {}
        for path, field in (extraction.get("result", {}).get("fields") or {}).items():
            value = field.get("normalized_value") if isinstance(field, dict) else field
            if value is None and isinstance(field, dict):
                value = field.get("value")
            cursor = values
            parts = str(path).split(".")
            for part in parts[:-1]:
                cursor = cursor.setdefault(part, {})
            if parts:
                cursor[parts[-1]] = value
        extraction["processor"] = processor_ref
        extraction["processor_version"] = extraction.get("processor_version") or {"id": extraction.get("processor_version_id")}
        extraction["results"] = values
        extraction["_meta"] = {
            "request_id": extraction.get("request_id"),
            "run_id": extraction.get("run_id"),
            "extraction_id": extraction.get("id"),
            "latency_ms": extraction.get("latency_ms", 0),
            "cost_usd": extraction.get("cost_usd", 0),
            "cache_hit": bool(extraction.get("cache_hit")),
            "warnings": extraction.get("warnings", []),
        }

    @classmethod
    def _model(cls, processor_version: Dict[str, Any]):
        return cls._model_from_config(processor_version.get("model", {}))

    @staticmethod
    def _model_from_config(config: Optional[Dict[str, Any]] = None):
        return create_model_adapter(config)

    @staticmethod
    def _cost(processor_version: Dict[str, Any], usage: Dict[str, Any], model_usage: Optional[List[Dict[str, Any]]] = None) -> float:
        # The database keeps a numeric value; API responses distinguish unknown
        # pricing from a real zero using the saved usage and cost_status.
        return estimate_cost(processor_version.get("model", {}), usage, model_usage) or 0.0
