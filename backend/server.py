"""Local HTTP server for the document extraction evaluation workbench."""

import argparse
from email import policy
from email.parser import BytesParser
import csv
import io
import json
import mimetypes
import os
import subprocess
import sys
import tempfile
import time
from collections import defaultdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, unquote, urlparse

from .config import Settings
from .collaboration import AgentJobs, CollaborationHandler, RevisionConflict
from .adapters import get_adapter_catalog
from .db import Database, create_database, normalize_folder_path
from .evaluation import compare_evaluations
from .ingest import DocumentIngestor
from .model_catalog import get_model_catalog
from .models import new_id
from .parser import parse_document
from .pipeline import ExtractionService, _evidence_for_value
from .project_config import dump_yaml, load_yaml_text
from .seed import ensure_empty_processor, ensure_seed
from .storage import count_pdf_pages, create_blob_store, looks_like_pdf


class Runtime:
    def __init__(self, root: Path):
        self.settings = Settings.from_env(Path(root))
        self.root = self.settings.root
        self.database = create_database(self.settings.database_url, self.settings.sqlite_path)
        self.blobs = create_blob_store(self.settings.blob_root)
        self.database.initialize()
        if self.settings.seed_demo:
            ensure_seed(self.database, self.blobs)
        else:
            ensure_empty_processor(self.database)
        self.ingestor = DocumentIngestor(self.database, self.blobs)
        self.extractions = ExtractionService(self.database, self.blobs)
        self.agent_jobs = AgentJobs(self)

    def shutdown(self) -> None:
        """Wait for submitted agent jobs before closing the runtime."""
        self.agent_jobs.shutdown()
        self.extractions.recovery.stopping.set()


def create_runtime(root: Optional[Path] = None) -> Runtime:
    return Runtime(root or Path(__file__).resolve().parents[1])


class EzpzHandler(CollaborationHandler, BaseHTTPRequestHandler):
    runtime: Runtime
    static_root: Path
    server_version = "ezpz-local/0.1"

    def log_message(self, format_string: str, *args: Any) -> None:
        elapsed = int((time.perf_counter() - getattr(self, "request_started", time.perf_counter())) * 1000)
        sys.stderr.write("[ezpz] request_id={} duration_ms={} {}\n".format(getattr(self, "request_id", "-"), elapsed, format_string % args))

    def _trusted_request(self) -> bool:
        host = self.headers.get("Host", "").split(":")[0].lower()
        allowed = {"localhost", "127.0.0.1"} | set(os.environ.get("EZPZ_ALLOWED_HOSTS", "").lower().split(","))
        origin = self.headers.get("Origin")
        origin_host = urlparse(origin).hostname if origin else None
        trusted_origins = set(self.runtime.settings.cors_origin.split(","))
        if host not in allowed or (origin and origin_host not in {"localhost", "127.0.0.1"} and origin not in trusted_origins):
            self._error(403, "Untrusted host or browser origin")
            return False
        return True

    def do_OPTIONS(self) -> None:
        self._begin_request()
        if not self._trusted_request():
            return
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        self._begin_request()
        if not self._trusted_request():
            return
        try:
            if path.startswith("/v1/"):
                self._get_api(path, parse_qs(parsed.query))
            else:
                self._serve_static(path)
        except RevisionConflict as error:
            self._error(409, str(error))
        except ValueError as error:
            self._error(400, str(error))
        except Exception as error:
            self._error(500, str(error))
        finally:
            self._end_request()

    def do_POST(self) -> None:
        path = urlparse(self.path).path.rstrip("/")
        self._begin_request()
        if not self._trusted_request():
            return
        try:
            if path.startswith("/v1/"):
                self._post_api(path)
            else:
                self._error(404, "Not found")
        except RevisionConflict as error:
            self._error(409, str(error))
        except ValueError as error:
            self._error(400, str(error))
        except Exception as error:
            self._error(500, str(error))
        finally:
            self._end_request()

    def do_PATCH(self) -> None:
        path = urlparse(self.path).path.rstrip("/")
        self._begin_request()
        if not self._trusted_request():
            return
        try:
            if path.startswith("/v1/"):
                self._patch_api(path)
            else:
                self._error(404, "Not found")
        except RevisionConflict as error:
            self._error(409, str(error))
        except ValueError as error:
            self._error(400, str(error))
        except Exception as error:
            self._error(500, str(error))
        finally:
            self._end_request()

    def do_PUT(self) -> None:
        self.do_PATCH()

    def do_DELETE(self) -> None:
        path = urlparse(self.path).path.rstrip("/")
        self._begin_request()
        if not self._trusted_request():
            return
        try:
            if path.startswith("/v1/"):
                self._delete_api(path)
            else:
                self._error(404, "Not found")
        except RevisionConflict as error:
            self._error(409, str(error))
        except ValueError as error:
            self._error(400, str(error))
        except Exception as error:
            self._error(500, str(error))
        finally:
            self._end_request()

    def _begin_request(self) -> None:
        self.request_started = time.perf_counter()
        self.request_id = self.headers.get("X-Request-ID") or new_id("req")

    def _end_request(self) -> None:
        return None

    def _get_api(self, path: str, query: Dict[str, Any]) -> None:
        if self._get_collaboration(path, query):
            return
        if path == "/v1/health":
            self._json(200, {"ok": True, "service": "ezpz", "mode": "local", "api_version": "v1"})
            return
        if path == "/v1/ready":
            ready = False
            try:
                ready = bool(self.runtime.database._one("SELECT 1")) and all(
                    hasattr(self.runtime.blobs, method) for method in ("get", "put", "exists")
                )
            except Exception:
                pass
            self._json(200 if ready else 503, {"ok": ready, "service": "ezpz", "checks": {"database": ready, "blob_store": ready}})
            return
        if path == "/v1/documents":
            search = (query.get("q") or query.get("query") or [""])[0]
            self._json(200, {"documents": self.runtime.database.list_documents(search)})
            return
        if path == "/v1/document-folders":
            self._json(200, {"folders": self.runtime.database.list_document_folders()})
            return
        if path == "/v1/datasets":
            self._json(200, {"datasets": self.runtime.database.list_datasets()})
            return
        if path == "/v1/eval-groups":
            self._json(200, {"eval_groups": self.runtime.database.list_eval_groups()})
            return
        if path == "/v1/model-catalog":
            provider = (query.get("provider") or [""])[0]
            endpoint = (query.get("endpoint") or [None])[0]
            self._json(200, get_model_catalog(provider, endpoint))
            return
        if path == "/v1/adapters":
            self._json(200, get_adapter_catalog())
            return
        if path == "/v1/processors":
            self._json(200, {"processors": self.runtime.database.list_processors()})
            return
        if path == "/v1/runs":
            self._json(200, {"runs": self.runtime.database.list_runs()})
            return
        if path == "/v1/runs/compare":
            run_ids = [item for item in (query.get("run_ids") or [""])[0].split(",") if item]
            self._compare_runs(run_ids, float((query.get("threshold") or [0])[0] or 0))
            return
        parts = self._parts(path)
        if len(parts) >= 2 and parts[0] == "eval-groups":
            group = self.runtime.database.get_eval_group(parts[1])
            if not group:
                self._error(404, "Eval group not found")
                return
            if len(parts) == 2:
                self._json(200, {"eval_group": group})
            elif len(parts) == 3 and parts[2] == "experiments":
                self._json(200, {"eval_group_id": parts[1], "experiments": self.runtime.database.list_eval_experiments(parts[1])})
            else:
                self._error(404, "Not found")
            return
        if len(parts) >= 2 and parts[0] == "documents":
            document = self.runtime.database.get_document(parts[1])
            if not document:
                self._error(404, "Document not found")
                return
            document = self._document_response(document)
            if len(parts) == 3 and parts[2] == "preview":
                self._pdf_preview(document, query)
            elif len(parts) == 3 and parts[2] in {"source", "content"}:
                self._source(document)
            elif len(parts) == 3 and parts[2] == "layout":
                self._document_layout(document)
            elif len(parts) == 3 and parts[2] == "ground-truth":
                self._json(200, {"ground_truth": self.runtime.database.get_ground_truth(parts[1])})
            elif len(parts) == 4 and parts[2] == "ground-truth" and parts[3] == "history":
                self._json(200, {"revisions": self.runtime.database.list_ground_truth_revisions(parts[1])})
            elif len(parts) == 3 and parts[2] == "table-annotations":
                ground_truth = self.runtime.database.get_ground_truth(parts[1]) or {}
                self._json(200, {"document_id": parts[1], "tables": ground_truth.get("table_annotations") or {}, "revision": ground_truth.get("revision")})
            elif len(parts) == 3 and parts[2] == "extraction":
                processor_ref = (query.get("processor") or [None])[0]
                self._json(200, {"extraction": self.runtime.database.latest_extraction(parts[1], processor_ref)})
            else:
                processor_ref = (query.get("processor") or [None])[0]
                self._json(200, {"document": document, "ground_truth": self.runtime.database.get_ground_truth(parts[1]), "extraction": self.runtime.database.latest_extraction(parts[1], processor_ref)})
            return
        if len(parts) >= 2 and parts[0] == "datasets":
            dataset = self.runtime.database.get_dataset(parts[1])
            if not dataset:
                self._error(404, "Dataset not found")
                return
            documents = self.runtime.database.list_dataset_documents(parts[1])
            split = (query.get("split") or [None])[0]
            tag = (query.get("tag") or [None])[0]
            if split:
                documents = [document for document in documents if (document.get("split") or "unspecified") == split]
            if tag:
                documents = [document for document in documents if tag in (document.get("tags") or [])]
            if len(parts) == 3 and parts[2] == "manifest":
                self._json(200, {"manifest": self._build_manifest(dataset, documents)})
            elif len(parts) == 3 and parts[2] == "reviews":
                self._json(200, {"dataset_id": parts[1], "assignments": self.runtime.database.list_review_assignments(parts[1], (query.get("reviewer") or [None])[0], (query.get("assignment_status") or [None])[0])})
            else:
                self._json(200, {"dataset": dataset, "documents": documents})
            return
        if len(parts) >= 2 and parts[0] == "processors":
            processor = self.runtime.database.get_processor(unquote(parts[1]))
            if not processor:
                self._error(404, "Processor not found")
                return
            if len(parts) == 3 and parts[2] == "draft":
                draft = self.runtime.database.get_processor_draft(unquote(parts[1])) or self.runtime.database.upsert_processor_draft(unquote(parts[1]))
                self._json(200, {"draft": draft})
            elif len(parts) == 3 and parts[2] == "config":
                version = (processor.get("versions") or [None])[0]
                if not version:
                    self._error(404, "Processor has no version")
                    return
                config = {key: version.get(key, {}) for key in ("schema", "prompt", "parser", "model", "harness", "normalization")}
                config["name"] = processor["name"]
                config["version"] = version.get("version")
                if (query.get("format") or ["json"])[0].lower() in {"yaml", "yml"}:
                    self._send_text(200, dump_yaml(config), "application/yaml; charset=utf-8", "{}-v{}.yaml".format(processor["name"], version.get("version")))
                else:
                    self._json(200, {"processor": {"id": processor["id"], "name": processor["name"], "description": processor.get("description", "")}, "processor_version": version, "config": config})
            else:
                self._json(200, {"processor": processor})
            return
        if len(parts) >= 2 and parts[0] == "runs":
            run = self.runtime.database.get_run(parts[1])
            if not run:
                self._error(404, "Run not found")
                return
            if len(parts) == 3 and parts[2] == "steps":
                from .harness_runtime import saved_run_steps
                self._json(200, {"documents": saved_run_steps(self.runtime.database, run)})
            elif len(parts) == 3 and parts[2] == "reviews":
                self._json(200, {"run_id": parts[1], "review_decisions": self.runtime.database.list_review_decisions(parts[1], (query.get("reviewer") or [None])[0], (query.get("document_id") or [None])[0], (query.get("field") or query.get("field_path") or [None])[0])})
            elif len(parts) == 3 and parts[2] == "failures":
                self._json(200, {"run_id": parts[1], "failures": self.runtime.database.list_run_failures(parts[1], (query.get("status") or [None])[0], (query.get("field") or query.get("field_path") or [None])[0])})
            elif len(parts) == 3 and parts[2] == "report":
                self._run_report(run, query)
            elif len(parts) == 3 and parts[2] == "compare":
                baseline_id = (query.get("against") or query.get("baseline") or [None])[0]
                if not baseline_id:
                    raise ValueError("against run id is required")
                self._compare_runs([baseline_id, parts[1]], float((query.get("threshold") or [0])[0] or 0))
            else:
                self._json(200, {"run": run})
            return
        if len(parts) >= 2 and parts[0] == "extractions":
            extraction = self.runtime.database.get_extraction(parts[1])
            if not extraction:
                self._error(404, "Extraction not found")
                return
            if len(parts) == 3 and parts[2] == "evaluation":
                self._json(200, {"evaluation": self.runtime.database.get_evaluation_for_extraction(parts[1])})
            else:
                self._json(200, {"extraction": extraction})
            return
        self._error(404, "Not found")

    def _post_api(self, path: str) -> None:
        if self._post_collaboration(path):
            return
        if path == "/v1/documents":
            payload, file_part = self._request_payload()
            if not file_part:
                raise ValueError("multipart field 'file' is required")
            filename, data, mime_type = file_part
            result = self.runtime.ingestor.ingest(filename, data, mime_type, payload.get("metadata") if isinstance(payload.get("metadata"), dict) else None)
            if payload.get("dataset_id"):
                self.runtime.database.add_document_to_dataset(
                    str(payload["dataset_id"]),
                    result["document"]["id"],
                    str(payload.get("split") or "unspecified"),
                )
                result["document"] = self.runtime.database.get_document(result["document"]["id"]) or result["document"]
            self._json(201, result)
            return
        if path == "/v1/document-folders":
            payload, _ = self._request_payload()
            parent_path = normalize_folder_path(payload.get("parent_path", ""))
            name = str(payload.get("name") or "").strip().strip("/")
            if not name or name in {".", ".."} or "/" in name or "\\" in name:
                raise ValueError("folder name must be a single path segment")
            folder = self.runtime.database.create_document_folder(f"{parent_path}{name}")
            self._json(201, {"folder": folder})
            return
        if path == "/v1/datasets":
            payload, _ = self._request_payload()
            name = str(payload.get("name") or "").strip()
            if not name:
                raise ValueError("dataset name is required")
            self._json(201, {"dataset": self.runtime.database.insert_dataset(name, payload.get("description", ""), payload.get("id"))})
            return
        if path == "/v1/eval-groups":
            payload, _ = self._request_payload()
            self._json(201, {"eval_group": self.runtime.database.create_eval_group(payload.get("name", ""), payload.get("description", ""), payload.get("id"), str(payload.get("dataset_id") or ""))})
            return
        if path == "/v1/processors":
            self._create_processor()
            return
        if path == "/v1/runs":
            payload, _ = self._request_payload()
            document_ids = payload.get("document_ids")
            if document_ids is not None and not isinstance(document_ids, list):
                raise ValueError("document_ids must be a list")
            eval_experiment_id = str(payload.get("eval_experiment_id") or "") or None
            dataset_id = str(payload.get("dataset_id") or "")
            processor_ref = payload.get("processor", "invoice-extractor")
            version = payload.get("version")
            if eval_experiment_id:
                experiment = self.runtime.database.get_eval_experiment(eval_experiment_id)
                if not experiment:
                    self._error(404, "Eval experiment not found")
                    return
                if dataset_id and experiment["dataset_id"] != dataset_id:
                    raise ValueError("Eval experiment does not belong to this benchmark dataset")
                dataset_id = experiment["dataset_id"]
                processor_version = experiment.get("processor_version")
                if not processor_version:
                    raise ValueError("Eval experiment has no configuration snapshot")
                processor_ref = processor_version["processor_id"]
                version = processor_version["version"]
            if not self.runtime.database.get_dataset(dataset_id):
                self._error(404, "Dataset not found")
                return
            metadata = payload.get("metadata") or {}
            if not isinstance(metadata, dict):
                raise ValueError("metadata must be an object")
            result = self.runtime.extractions.run_dataset(
                dataset_id,
                processor_ref,
                version,
                document_ids,
                payload.get("scoring_config") or {},
                metadata,
                force_refresh=bool(payload.get("force_refresh", payload.get("fresh", True))),
                eval_experiment_id=eval_experiment_id,
                background=bool(payload.get("background", False)),
            )
            self._json(202 if payload.get("background") else 201, result)
            return
        parts = self._parts(path)
        if len(parts) == 3 and parts[0] == "runs" and parts[2] in ("cancel", "pause", "resume"):
            run = self.runtime.extractions.recovery.control(parts[1], parts[2])
            self._json(202 if run else 404, {"run": run} if run else {"error": "Run not found"})
            return
        if len(parts) == 3 and parts[0] == "eval-groups" and parts[2] == "experiments":
            payload, _ = self._request_payload()
            self._json(201, {"eval_experiment": self.runtime.database.create_eval_experiment(parts[1], str(payload.get("processor_version_id") or ""), payload.get("name", ""), payload.get("description", ""), payload.get("id"))})
            return
        if len(parts) == 3 and parts[0] == "runs" and parts[2] == "reviews":
            self._save_review_decision(parts[1])
            return
        if len(parts) == 3 and parts[0] == "datasets" and parts[2] == "documents":
            payload, _ = self._request_payload()
            self._add_dataset_document(parts[1], payload)
            return
        if len(parts) == 3 and parts[0] == "datasets" and parts[2] == "manifest":
            self._import_dataset_manifest(parts[1])
            return
        if len(parts) == 3 and parts[0] == "datasets" and parts[2] == "reviews":
            payload, _ = self._request_payload()
            document_id = str(payload.get("document_id") or "")
            if document_id not in {document["id"] for document in self.runtime.database.list_dataset_documents(parts[1])}:
                raise ValueError("document_id must belong to this dataset")
            assignment = self.runtime.database.create_review_assignment(parts[1], document_id, str(payload.get("reviewer") or payload.get("author") or "local"), str(payload.get("status") or "queued"), str(payload.get("note") or ""))
            self._json(201, {"assignment": assignment})
            return
        if len(parts) == 3 and parts[0] == "datasets" and parts[2] in {"sample", "split"}:
            self._curate_dataset(parts[1], parts[2])
            return
        if len(parts) == 3 and parts[0] == "datasets" and parts[2] == "clone":
            payload, _ = self._request_payload()
            name = str(payload.get("name") or "").strip()
            if not name:
                raise ValueError("clone name is required")
            self._json(201, {"dataset": self.runtime.database.clone_dataset(parts[1], name, payload.get("description"))})
            return
        if len(parts) == 3 and parts[0] == "processors" and parts[2] == "extract":
            payload, file_part = self._request_payload()
            document_id = payload.get("document_id")
            if file_part:
                filename, data, mime_type = file_part
                document_id = self.runtime.ingestor.ingest(filename, data, mime_type)["document"]["id"]
            if not document_id:
                raise ValueError("document_id or multipart file is required")
            result = self.runtime.extractions.extract_document(str(document_id), unquote(parts[1]), payload.get("version"), scoring_config=payload.get("scoring_config") or {})
            result["request_id"] = self.request_id
            result.setdefault("_meta", {})["request_id"] = self.request_id
            self._json(201, result)
            return
        if len(parts) == 4 and parts[0] == "processors" and parts[2] == "draft" and parts[3] == "preview":
            payload, _ = self._request_payload()
            config = payload.get("config") if isinstance(payload.get("config"), dict) else payload
            self._json(200, self.runtime.extractions.preview_document(str(payload.get("document_id") or "doc_demo_invoice"), unquote(parts[1]), config))
            return
        if len(parts) == 4 and parts[0] == "processors" and parts[2] == "draft" and parts[3] == "publish":
            self._json(201, {"version": self.runtime.database.publish_processor_draft(unquote(parts[1]))})
            return
        if len(parts) == 2 and parts[0] == "runs" and parts[1] == "compare":
            payload, _ = self._request_payload()
            run_ids = payload.get("run_ids") or []
            self._compare_runs([str(run_id) for run_id in run_ids], float(payload.get("threshold", 0) or 0))
            return
        if len(parts) == 3 and parts[0] == "documents" and parts[2] == "ground-truth":
            self._save_ground_truth(parts[1])
            return
        if len(parts) == 3 and parts[0] == "documents" and parts[2] == "table-annotations":
            self._save_ground_truth(parts[1], table_only=True)
            return
        self._error(404, "Not found")

    def _patch_api(self, path: str) -> None:
        parts = self._parts(path)
        if len(parts) == 2 and parts[0] == "documents":
            payload, _ = self._request_payload()
            folder_path = payload.get("folder_path")
            if folder_path is None and isinstance(payload.get("metadata"), dict):
                folder_path = payload["metadata"].get("folder_path", "")
            document = self.runtime.database.update_document_folder(parts[1], folder_path or "")
            if not document:
                self._error(404, "Document not found")
                return
            self._json(200, {"document": document})
            return
        if len(parts) == 2 and parts[0] == "processors":
            payload, _ = self._request_payload()
            processor = self.runtime.database.update_processor(parts[1], payload)
            if not processor:
                self._error(404, "Processor not found")
                return
            self._json(200, {"processor": processor})
            return
        if len(parts) == 3 and parts[0] == "processors" and parts[2] == "draft":
            self._save_processor_draft(parts[1])
            return
        if len(parts) == 3 and parts[0] == "documents" and parts[2] == "ground-truth":
            self._save_ground_truth(parts[1])
            return
        if len(parts) == 2 and parts[0] == "datasets":
            payload, _ = self._request_payload()
            dataset = self.runtime.database.update_dataset(parts[1], payload)
            if not dataset:
                self._error(404, "Dataset not found")
                return
            self._json(200, {"dataset": dataset})
            return
        if len(parts) == 3 and parts[0] == "datasets" and parts[2] == "documents":
            payload, _ = self._request_payload()
            if not self.runtime.database.update_dataset_document(parts[1], str(payload.get("document_id") or ""), payload.get("split"), self._clean_tags(payload.get("tags")) if payload.get("tags") is not None else None):
                self._error(404, "Document is not in this dataset")
                return
            self._json(200, {"dataset": self.runtime.database.get_dataset(parts[1]), "documents": self.runtime.database.list_dataset_documents(parts[1])})
            return
        self._error(404, "Not found")

    def _delete_api(self, path: str) -> None:
        parts = self._parts(path)
        if len(parts) == 2 and parts[0] == "documents":
            document = self.runtime.database.get_document(parts[1])
            if not document or not self.runtime.database.delete_document(parts[1]):
                self._error(404, "Document not found")
                return
            blob_deleted = False
            if not self.runtime.database.has_blob_reference(document["blob_key"]):
                blob_deleted = self.runtime.blobs.delete(document["blob_key"])
            self._json(200, {"deleted": True, "document_id": parts[1], "filename": document["filename"], "blob_deleted": blob_deleted})
            return
        if len(parts) == 3 and parts[0] == "datasets" and parts[2] == "documents":
            payload, _ = self._request_payload()
            if not self.runtime.database.remove_document_from_dataset(parts[1], str(payload.get("document_id") or "")):
                self._error(404, "Document is not in this dataset")
                return
            self._json(200, {"dataset": self.runtime.database.get_dataset(parts[1])})
            return
        self._error(404, "Not found")

    def _create_processor(self) -> None:
        payload, _ = self._request_payload()
        name = str(payload.get("name") or "").strip()
        if not name:
            raise ValueError("processor name is required")
        if self.runtime.database.get_processor(name):
            raise ValueError("processor already exists: {}".format(name))
        processor = self.runtime.database.insert_processor(name, payload.get("description", ""), payload.get("id"))
        config = payload.get("config") if isinstance(payload.get("config"), dict) else payload
        from .seed import blank_prompt, blank_schema

        self.runtime.database.insert_processor_version({
            "id": new_id("pv"),
            "processor_id": processor["id"],
            "version": 1,
            "author": payload.get("author", "local"),
            "status": "draft",
            "schema": config.get("schema", blank_schema()),
            "prompt": config.get("prompt", blank_prompt()),
            "parser": config.get("parser", {"name": "native", "version": "1"}),
            "model": config.get("model", {"provider": "local", "name": "deterministic-local"}),
            "harness": config.get("harness", {"name": "direct", "version": "1"}),
            "normalization": config.get("normalization", {}),
        })
        self._json(201, {"processor": self.runtime.database.get_processor(processor["id"])})

    def _add_dataset_document(self, dataset_id: str, payload: Dict[str, Any]) -> None:
        if not self.runtime.database.get_dataset(dataset_id):
            self._error(404, "Dataset not found")
            return
        document_id = str(payload.get("document_id") or "")
        if not self.runtime.database.get_document(document_id):
            self._error(404, "Document not found")
            return
        if payload.get("tags") is not None:
            if not self.runtime.database.update_dataset_document(dataset_id, document_id, payload.get("split"), self._clean_tags(payload.get("tags"))):
                self._error(404, "Document is not in this dataset")
                return
        else:
            self.runtime.database.add_document_to_dataset(dataset_id, document_id, payload.get("split", "unspecified"))
        self._json(201, {"dataset": self.runtime.database.get_dataset(dataset_id)})

    def _compare_runs(self, run_ids: List[str], threshold: float = 0) -> None:
        if len(run_ids) < 2:
            raise ValueError("run_ids must contain at least two runs")
        runs = [self.runtime.database.get_run(run_id) for run_id in run_ids]
        if any(run is None for run in runs):
            self._error(404, "One or more runs were not found")
            return
        group_ids = {(run.get("eval_group") or {}).get("id") for run in runs if run}
        dataset_ids = {run.get("dataset_id") for run in runs if run}
        if len(group_ids) > 1 or None in group_ids or len(dataset_ids) > 1:
            raise ValueError("Runs can only be compared within the same eval group")
        if any(r["status"] != "completed" for r in runs):
            raise ValueError("Only completed runs can be compared")
        fingerprints = {(r.get("metadata", {}).get("benchmark_snapshot") or {}).get("fingerprint") for r in runs}
        if len(fingerprints) != 1 or None in fingerprints:
            raise ValueError("Runs have different or unrecorded benchmark snapshots. Run the experiments on the same current benchmark before comparing.")
        baseline = runs[0]
        comparisons = [{"baseline_run_id": baseline["id"], "candidate_run_id": candidate["id"], "comparison": compare_evaluations(baseline.get("evaluations", []), candidate.get("evaluations", []), baseline.get("metrics", {}), candidate.get("metrics", {}), threshold)} for candidate in runs[1:]]
        self._json(200, {"baseline_run_id": baseline["id"], "comparisons": comparisons})

    def _save_processor_draft(self, processor_ref: str) -> None:
        payload, _ = self._request_payload()
        config = payload.get("config") if isinstance(payload.get("config"), dict) else payload
        self._json(200, {"draft": self.runtime.database.upsert_processor_draft(unquote(processor_ref), config)})

    def _save_ground_truth(self, document_id: str, table_only: bool = False) -> None:
        payload, _ = self._request_payload()
        document = self.runtime.database.get_document(document_id)
        if not document:
            self._error(404, "Document not found")
            return
        existing = self.runtime.database.get_ground_truth(document_id) or {}
        value = payload.get("value", existing.get("value", {}))
        evidence = payload.get("evidence", existing.get("evidence", {}))
        tables = payload.get("table_annotations", existing.get("table_annotations", {}))
        if table_only and payload.get("table_annotations") is None:
            raise ValueError("table_annotations is required")
        ground_truth = self.runtime.database.save_ground_truth(document_id, value, evidence, payload.get("annotation_status", existing.get("annotation_status", "complete")), payload.get("author", "local"), bool(payload.get("replace")), tables, expected_revision=payload.get("expected_revision"))
        self._json(200, {"ground_truth": ground_truth})

    def _save_review_decision(self, run_id: str) -> None:
        payload, _ = self._request_payload()
        document_id = str(payload.get("document_id") or "")
        field_path = str(payload.get("field_path") or "")
        if not document_id or not field_path:
            raise ValueError("document_id and field_path are required")
        decision = self.runtime.database.save_review_decision(
            run_id=run_id,
            document_id=document_id,
            field_path=field_path,
            status=str(payload.get("status") or ""),
            reason=str(payload.get("reason") or "") or None,
            corrected_value=payload.get("corrected_value"),
            note=str(payload.get("note") or ""),
            reviewer=str(payload.get("reviewer") or payload.get("author") or "local"),
            evaluation_id=str(payload.get("evaluation_id") or "") or None,
        )
        self._json(200, {"review_decision": decision})

    @staticmethod
    def _clean_tags(value: Any) -> List[str]:
        if value is None:
            return []
        if isinstance(value, str):
            value = value.split(",")
        if not isinstance(value, (list, tuple, set)):
            raise ValueError("tags must be a list or comma-separated string")
        return sorted({str(item).strip() for item in value if str(item).strip()})

    def _build_manifest(self, dataset: Dict[str, Any], documents: List[Dict[str, Any]]) -> Dict[str, Any]:
        return {"version": 1, "dataset": {"id": dataset["id"], "name": dataset["name"], "description": dataset.get("description", "")}, "documents": [{"document_id": document["id"], "filename": document["filename"], "sha256": document["sha256"], "split": document.get("split", "unspecified"), "tags": document.get("tags", []), "ground_truth": (self.runtime.database.get_ground_truth(document["id"]) or {}).get("value")} for document in documents]}

    def _import_dataset_manifest(self, dataset_id: str) -> None:
        payload, _ = self._request_payload()
        manifest = payload.get("manifest") if isinstance(payload.get("manifest"), dict) else payload
        entries = manifest.get("documents") if isinstance(manifest, dict) else None
        if not isinstance(entries, list):
            raise ValueError("manifest.documents must be a list")
        matched, errors = [], []
        documents = self.runtime.database.list_documents()
        by_hash = {document["sha256"]: document for document in documents}
        by_id = {document["id"]: document for document in documents}
        for index, entry in enumerate(entries):
            if not isinstance(entry, dict):
                errors.append({"index": index, "reason": "entry must be an object"})
                continue
            document = by_id.get(str(entry.get("document_id") or "")) or by_hash.get(str(entry.get("sha256") or ""))
            if not document:
                errors.append({"index": index, "reason": "document_id or sha256 does not match a document", "filename": entry.get("filename")})
                continue
            self.runtime.database.add_document_to_dataset(dataset_id, document["id"], entry.get("split", "unspecified"))
            if entry.get("tags") is not None:
                self.runtime.database.update_dataset_document(dataset_id, document["id"], entry.get("split"), self._clean_tags(entry.get("tags")))
            if isinstance(entry.get("ground_truth"), dict):
                self.runtime.database.save_ground_truth(document["id"], entry["ground_truth"], author=payload.get("author", "manifest"))
            matched.append(document["id"])
        self._json(200, {"dataset_id": dataset_id, "matched": matched, "errors": errors, "dry_run": bool(payload.get("dry_run"))})

    def _curate_dataset(self, dataset_id: str, operation: str) -> None:
        payload, _ = self._request_payload()
        documents = self.runtime.database.list_dataset_documents(dataset_id)
        if operation == "sample":
            try:
                count = max(1, min(len(documents), int(payload.get("count", 1))))
            except (TypeError, ValueError):
                raise ValueError("count must be an integer")
            seed = str(payload.get("seed") or "ezpz")
            import hashlib

            selected = sorted(documents, key=lambda document: hashlib.sha256((seed + document["sha256"]).encode()).hexdigest())[:count]
            self._json(200, {"dataset_id": dataset_id, "selected": [document["id"] for document in selected], "count": len(selected), "dry_run": bool(payload.get("dry_run"))})
            return
        ratios = payload.get("splits") or {"train": 0.8, "validation": 0.1, "test": 0.1}
        if not isinstance(ratios, dict) or not ratios:
            raise ValueError("splits must be a non-empty object")
        cleaned = {str(key): float(value) for key, value in ratios.items() if float(value) > 0}
        total = sum(cleaned.values())
        if not total:
            raise ValueError("splits must include positive ratios")
        normalized = {key: value / total for key, value in cleaned.items()}
        assignments = []
        cursor = 0
        for index, document in enumerate(sorted(documents, key=lambda item: item["sha256"])):
            if index and cursor < len(normalized) - 1:
                current_key = list(normalized)[cursor]
                if index >= round(len(documents) * sum(list(normalized.values())[:cursor + 1])):
                    cursor += 1
            assignments.append({"document_id": document["id"], "split": list(normalized)[min(cursor, len(normalized) - 1)]})
        if not payload.get("dry_run"):
            for assignment in assignments:
                self.runtime.database.update_dataset_document(dataset_id, assignment["document_id"], assignment["split"])
        self._json(200, {"dataset_id": dataset_id, "assignments": assignments, "ratios": normalized, "dry_run": bool(payload.get("dry_run"))})

    def _run_report(self, run: Dict[str, Any], query: Dict[str, Any]) -> None:
        report = {"version": 1, "run": {"id": run["id"], "status": run.get("status"), "created_at": run.get("created_at"), "completed_at": run.get("completed_at")}, "processor_version": run.get("processor_version"), "dataset": run.get("dataset"), "scoring_config": run.get("scoring_config", {}), "failures": self.runtime.database.list_run_failures(run["id"]), "evaluations": run.get("evaluations", []), "metrics": run.get("metrics", {})}
        field_metrics = defaultdict(lambda: {"documents": 0, "correct": 0, "failures": 0})
        for evaluation in report["evaluations"]:
            for path, field in (evaluation.get("fields") or {}).items():
                stat = field_metrics[path]
                stat["documents"] += 1
                stat["correct" if field.get("status") == "correct" else "failures"] += 1
        report["field_metrics"] = {path: {**stat, "accuracy": round(stat["correct"] / stat["documents"], 4) if stat["documents"] else None} for path, stat in field_metrics.items()}
        if (query.get("format") or ["json"])[0].lower() == "csv":
            output = io.StringIO()
            writer = csv.writer(output)
            writer.writerow(["document_id", "field_path", "status", "expected", "actual", "confidence", "failure_type"])
            for evaluation in report["evaluations"]:
                for path, field in (evaluation.get("fields") or {}).items():
                    writer.writerow([evaluation.get("document_id"), path, field.get("status"), json.dumps(field.get("expected"), ensure_ascii=False), json.dumps(field.get("actual"), ensure_ascii=False), field.get("confidence"), field.get("failure_type")])
            self._send_text(200, output.getvalue(), "text/csv; charset=utf-8", "{}.csv".format(run["id"]))
        else:
            self._json(200, {"report": report})

    def _document_response(self, document: Dict[str, Any]) -> Dict[str, Any]:
        if not looks_like_pdf(self.runtime.blobs.get(document["blob_key"])):
            return document
        page_count = count_pdf_pages(self.runtime.blobs.get(document["blob_key"]))
        if page_count <= int(document.get("page_count") or 0):
            return document
        return {**document, "page_count": page_count}

    def _document_layout(self, document: Dict[str, Any]) -> None:
        content = self.runtime.blobs.get(document["blob_key"])
        extraction = self.runtime.database.latest_extraction(document["id"]) or {}
        parser_config = dict(extraction.get("processor_version", {}).get("parser") or {})
        parser_config["config"] = {**(parser_config.get("config") or {}), "ocr": True}
        parser_ir = parse_document(document, content, parser_config or {"name": "native", "version": "1"})
        evidence = {}
        for field_path, field in ((extraction.get("result") or {}).get("fields") or {}).items():
            value = field.get("normalized_value", field.get("value")) if isinstance(field, dict) else field
            evidence[field_path] = [item.to_dict() for item in _evidence_for_value(parser_ir, value)]
        self._json(200, {"document_id": document["id"], "parser": parser_ir.parser, "pages": [page.to_dict() for page in parser_ir.pages], "evidence": evidence})

    def _pdf_preview(self, document: Dict[str, Any], query: Dict[str, Any]) -> None:
        content = self.runtime.blobs.get(document["blob_key"])
        if not looks_like_pdf(content):
            self._error(415, "Document is not a valid PDF source")
            return
        page = max(1, int((query.get("page") or ["1"])[0]))
        if page > max(int(document.get("page_count") or 1), count_pdf_pages(content)):
            self._error(404, "PDF page not found")
            return
        try:
            with tempfile.TemporaryDirectory(prefix="ezpz-pdf-preview-") as directory:
                directory_path = Path(directory)
                source_path = directory_path / "source.pdf"
                output_prefix = directory_path / "page"
                source_path.write_bytes(content)
                completed = subprocess.run(["pdftoppm", "-png", "-f", str(page), "-l", str(page), "-singlefile", "-scale-to", "1600", str(source_path), str(output_prefix)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, check=False)
                output_path = output_prefix.with_suffix(".png")
                if completed.returncode != 0 or not output_path.exists():
                    raise RuntimeError(completed.stderr.decode("utf-8", errors="ignore").strip() or "pdftoppm could not render this PDF page")
                preview = output_path.read_bytes()
        except FileNotFoundError:
            self._error(503, "PDF previews require Poppler (pdftoppm)")
            return
        except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
            self._error(422, "Unable to render PDF page: {}".format(error))
            return
        self._send_binary(200, preview, "image/png", "{}-page-{}.png".format(Path(document["filename"]).stem, page))

    def _source(self, document: Dict[str, Any]) -> None:
        content = self.runtime.blobs.get(document["blob_key"])
        content_type = "application/pdf" if looks_like_pdf(content) else document.get("mime_type") or mimetypes.guess_type(document.get("filename", ""))[0] or "application/octet-stream"
        # Uploaded documents are untrusted, even in a local workspace.
        # Only inert viewer formats may open inline on the application origin.
        inline_types = {"application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/tiff", "text/plain", "text/csv", "application/json"}
        inline = content_type.split(";", 1)[0].strip().lower() in inline_types
        if not inline:
            content_type = "application/octet-stream"
        self.send_response(200)
        self._cors()
        self.send_header("X-Request-ID", self.request_id)
        self.send_header("X-Document-SHA256", document.get("sha256", ""))
        self.send_header("Content-Type", content_type)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "sandbox; default-src 'none'")
        self.send_header("Content-Disposition", '{}; filename="{}"'.format("inline" if inline else "attachment", document.get("filename", "document").replace('"', "")))
        self.send_header("Cache-Control", "private, max-age=3600")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def _send_binary(self, status: int, content: bytes, content_type: str, filename: Optional[str] = None) -> None:
        self.send_response(status)
        self._cors()
        self.send_header("X-Request-ID", self.request_id)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        if filename:
            self.send_header("Content-Disposition", 'inline; filename="{}"'.format(filename.replace('"', "")))
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def _send_text(self, status: int, body: str, content_type: str, filename: Optional[str] = None) -> None:
        self._send_binary(status, body.encode("utf-8"), content_type, filename)

    def _json(self, status: int, payload: Dict[str, Any]) -> None:
        content = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
        self.send_response(status)
        self._cors()
        self.send_header("X-Request-ID", self.request_id)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def _error(self, status: int, message: str) -> None:
        self._json(status, {"error": {"message": message, "status": status}})

    def _cors(self) -> None:
        origin = self.headers.get("Origin")
        if origin and (urlparse(origin).hostname in {"localhost", "127.0.0.1"} or origin in self.runtime.settings.cors_origin.split(",")):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Filename, X-Request-ID")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")

    def _request_payload(self) -> Tuple[Dict[str, Any], Optional[Tuple[str, bytes, Optional[str]]]]:
        try:
            length = int(self.headers.get("Content-Length", "0") or 0)
        except (TypeError, ValueError) as error:
            raise ValueError("Content-Length must be an integer") from error
        if length < 0 or length > self.runtime.settings.max_body_bytes:
            raise ValueError("Request body is too large")
        body = self.rfile.read(length) if length else b""
        content_type = self.headers.get("Content-Type", "")
        if content_type.startswith("multipart/form-data"):
            message = BytesParser(policy=policy.default).parsebytes(
                ("Content-Type: " + content_type + "\r\nMIME-Version: 1.0\r\n\r\n").encode("utf-8") + body
            )
            if not message.is_multipart() or message.defects:
                raise ValueError("Invalid multipart upload")
            payload = {}
            upload = None
            for part in message.iter_parts():
                key = part.get_param("name", header="content-disposition")
                if not key:
                    continue
                content = part.get_payload(decode=True) or b""
                filename = part.get_filename()
                if filename is not None and key == "file" and upload is None:
                    upload = (filename or "document", content, part.get_content_type())
                elif filename is None and key not in payload:
                    payload[key] = content.decode(part.get_content_charset() or "utf-8")
            return payload, upload
        if not body:
            return {}, None
        try:
            decoded = body.decode("utf-8")
        except UnicodeDecodeError as error:
            raise ValueError("Request body must be UTF-8 encoded JSON or YAML") from error
        if "yaml" in content_type.lower() or "yml" in content_type.lower():
            value = load_yaml_text(decoded, "request body")
        else:
            try:
                value = json.loads(decoded)
            except json.JSONDecodeError as error:
                raise ValueError("Expected JSON, YAML, or multipart/form-data") from error
        if not isinstance(value, dict):
            raise ValueError("JSON body must be an object")
        return value, None

    def _serve_static(self, path: str) -> None:
        relative = "index.html" if path == "/" else unquote(path).lstrip("/")
        if any(part.startswith(".") for part in Path(relative).parts) or "\\" in relative:
            self._error(403, "Forbidden")
            return
        if not (self.static_root / "index.html").is_file():
            self._error(404, "Frontend is not built; build the studio or use the packaged release")
            return
        target = (self.static_root / relative).resolve()
        root = self.static_root.resolve()
        if target != root and root not in target.parents:
            self._error(403, "Forbidden")
            return
        if not target.exists() or not target.is_file():
            if Path(relative).suffix:
                self._error(404, "Not found")
                return
            target = self.static_root / "index.html"
        content = target.read_bytes()
        content_type = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        self._send_binary(200, content, content_type)

    @staticmethod
    def _parts(path: str) -> List[str]:
        clean = path.strip("/")
        if clean.startswith("v1/"):
            clean = clean[3:]
        return [unquote(part) for part in clean.split("/") if part]


def make_server(root: Optional[Path] = None, host: str = "127.0.0.1", port: int = 4173) -> ThreadingHTTPServer:
    runtime = create_runtime(root)

    class Handler(EzpzHandler):
        pass

    class RuntimeHTTPServer(ThreadingHTTPServer):
        def server_close(self):
            runtime.shutdown()
            return super().server_close()

    Handler.runtime = runtime
    built_frontend = runtime.root / "dist"
    Handler.static_root = Path(os.environ.get("EZPZ_STATIC_ROOT", str(built_frontend))).resolve()
    server = RuntimeHTTPServer((host, port), Handler)
    try:
        # CLI readers must not change active jobs. Recover only after the API
        # successfully binds, so a failed duplicate startup cannot stop a run.
        runtime.extractions.recovery.recover_abandoned()
        # Single-document runs have no dataset recovery lock or resumable worker.
        runtime.database._execute("UPDATE runs SET status = 'interrupted', error_text = 'Server restarted before the run finished.' WHERE target_type != 'dataset' AND status IN ('running', 'cancelling')")
        runtime.agent_jobs.recover()
    except Exception:
        server.server_close()
        raise
    return server


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the local ezpz evaluation workbench.")
    parser.add_argument("--host", default=os.environ.get("EZPZ_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("EZPZ_PORT", "4173")))
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    server = make_server(args.root, args.host, args.port)
    print("ezpz running at http://{}:{}/".format(args.host, args.port))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
