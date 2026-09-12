"""SQLite persistence for documents, datasets, processors, and evaluation runs."""

import json
import sqlite3
import threading
from contextvars import ContextVar
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from .costing import run_cost_metrics
from .models import new_id, utc_now
from .collaboration import RevisionConflict, initialize_collaboration


_WORKSPACE_CONTEXT: ContextVar[Optional[str]] = ContextVar("ezpz_workspace_id", default=None)
_PROJECT_CONTEXT: ContextVar[Optional[str]] = ContextVar("ezpz_project_id", default=None)


def set_request_context(workspace_id: Optional[str], project_id: Optional[str] = None):
    return _WORKSPACE_CONTEXT.set(workspace_id), _PROJECT_CONTEXT.set(project_id)


def reset_request_context(tokens) -> None:
    if tokens:
        _WORKSPACE_CONTEXT.reset(tokens[0])
        _PROJECT_CONTEXT.reset(tokens[1])


SCHEMA = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    blob_key TEXT NOT NULL,
    page_count INTEGER NOT NULL DEFAULT 1,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    immutable INTEGER NOT NULL DEFAULT 1,
    UNIQUE (workspace_id, project_id, sha256)
);

CREATE TABLE IF NOT EXISTS document_folders (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    path TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (workspace_id, project_id, path)
);

CREATE TABLE IF NOT EXISTS datasets (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    archived_at TEXT,
    UNIQUE (workspace_id, project_id, name)
);

CREATE TABLE IF NOT EXISTS eval_groups (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    dataset_id TEXT REFERENCES datasets(id) ON DELETE RESTRICT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    archived_at TEXT,
    UNIQUE (workspace_id, project_id, name)
);

CREATE TABLE IF NOT EXISTS eval_experiments (
    id TEXT PRIMARY KEY,
    eval_group_id TEXT NOT NULL REFERENCES eval_groups(id) ON DELETE CASCADE,
    dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE RESTRICT,
    processor_version_id TEXT REFERENCES processor_versions(id) ON DELETE RESTRICT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE (eval_group_id, name)
);

CREATE TABLE IF NOT EXISTS dataset_documents (
    dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    split TEXT NOT NULL DEFAULT 'unspecified',
    tags_json TEXT NOT NULL DEFAULT '[]',
    added_at TEXT NOT NULL,
    PRIMARY KEY (dataset_id, document_id)
);

CREATE TABLE IF NOT EXISTS processors (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    archived_at TEXT,
    UNIQUE (workspace_id, project_id, name)
);

CREATE TABLE IF NOT EXISTS processor_versions (
    id TEXT PRIMARY KEY,
    processor_id TEXT NOT NULL REFERENCES processors(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    schema_json TEXT NOT NULL,
    prompt_json TEXT NOT NULL,
    parser_json TEXT NOT NULL,
    model_json TEXT NOT NULL,
    harness_json TEXT NOT NULL,
    normalization_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    immutable INTEGER NOT NULL DEFAULT 1,
    UNIQUE (processor_id, version)
);

CREATE TABLE IF NOT EXISTS processor_drafts (
    id TEXT PRIMARY KEY,
    processor_id TEXT NOT NULL UNIQUE REFERENCES processors(id) ON DELETE CASCADE,
    base_version_id TEXT REFERENCES processor_versions(id),
    schema_json TEXT NOT NULL,
    prompt_json TEXT NOT NULL,
    parser_json TEXT NOT NULL,
    model_json TEXT NOT NULL,
    harness_json TEXT NOT NULL,
    normalization_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'draft',
    published_version_id TEXT REFERENCES processor_versions(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    processor_version_id TEXT NOT NULL REFERENCES processor_versions(id),
    eval_experiment_id TEXT REFERENCES eval_experiments(id),
    dataset_id TEXT REFERENCES datasets(id),
    document_id TEXT REFERENCES documents(id),
    target_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    scoring_config_json TEXT NOT NULL DEFAULT '{}',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    metrics_json TEXT NOT NULL DEFAULT '{}',
    error_text TEXT,
    started_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS extractions (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    document_id TEXT NOT NULL REFERENCES documents(id),
    processor_version_id TEXT NOT NULL REFERENCES processor_versions(id),
    status TEXT NOT NULL DEFAULT 'completed',
    result_json TEXT NOT NULL DEFAULT '{}',
    raw_response_json TEXT NOT NULL DEFAULT '{}',
    parser_ir_json TEXT NOT NULL DEFAULT '{}',
    usage_json TEXT NOT NULL DEFAULT '{}',
    cost_usd REAL NOT NULL DEFAULT 0,
    latency_ms INTEGER NOT NULL DEFAULT 0,
    parser_latency_ms INTEGER NOT NULL DEFAULT 0,
    model_latency_ms INTEGER NOT NULL DEFAULT 0,
    cache_hit INTEGER NOT NULL DEFAULT 0,
    warnings_json TEXT NOT NULL DEFAULT '[]',
    error_text TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS extraction_fields (
    id TEXT PRIMARY KEY,
    extraction_id TEXT NOT NULL REFERENCES extractions(id) ON DELETE CASCADE,
    field_path TEXT NOT NULL,
    value_json TEXT,
    normalized_value_json TEXT,
    confidence REAL,
    evidence_json TEXT NOT NULL DEFAULT '[]',
    errors_json TEXT NOT NULL DEFAULT '[]',
    UNIQUE (extraction_id, field_path)
);

CREATE TABLE IF NOT EXISTS evaluations (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    extraction_id TEXT NOT NULL REFERENCES extractions(id) ON DELETE CASCADE,
    document_id TEXT NOT NULL REFERENCES documents(id),
    processor_version_id TEXT NOT NULL REFERENCES processor_versions(id),
    status TEXT NOT NULL,
    metrics_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    UNIQUE (run_id, extraction_id)
);

CREATE TABLE IF NOT EXISTS evaluation_fields (
    id TEXT PRIMARY KEY,
    evaluation_id TEXT NOT NULL REFERENCES evaluations(id) ON DELETE CASCADE,
    field_path TEXT NOT NULL,
    status TEXT NOT NULL,
    score REAL NOT NULL DEFAULT 0,
    match_type TEXT NOT NULL DEFAULT 'none',
    expected_json TEXT,
    actual_json TEXT,
    normalized_expected_json TEXT,
    normalized_actual_json TEXT,
    confidence REAL,
    failure_type TEXT,
    details_json TEXT NOT NULL DEFAULT '{}',
    UNIQUE (evaluation_id, field_path)
);

CREATE TABLE IF NOT EXISTS ground_truth (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    value_json TEXT NOT NULL,
    evidence_json TEXT NOT NULL DEFAULT '{}',
    table_annotations_json TEXT NOT NULL DEFAULT '{}',
    annotation_status TEXT NOT NULL DEFAULT 'complete',
    author TEXT NOT NULL DEFAULT 'local',
    created_at TEXT NOT NULL,
    UNIQUE (document_id, revision)
);

CREATE TABLE IF NOT EXISTS review_assignments (
    id TEXT PRIMARY KEY,
    dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    reviewer TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (dataset_id, document_id, reviewer)
);

CREATE TABLE IF NOT EXISTS review_decisions (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    evaluation_id TEXT NOT NULL REFERENCES evaluations(id) ON DELETE CASCADE,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    field_path TEXT NOT NULL,
    reviewer TEXT NOT NULL DEFAULT 'local',
    status TEXT NOT NULL DEFAULT 'unreviewed',
    reason TEXT,
    corrected_value_json TEXT,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (run_id, document_id, field_path, reviewer)
);

CREATE TABLE IF NOT EXISTS extraction_cache (
    cache_key TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    processor_version_id TEXT NOT NULL,
    document_sha256 TEXT NOT NULL,
    result_json TEXT NOT NULL DEFAULT '{}',
    raw_response_json TEXT NOT NULL DEFAULT '{}',
    parser_ir_json TEXT NOT NULL DEFAULT '{}',
    usage_json TEXT NOT NULL DEFAULT '{}',
    cost_usd REAL NOT NULL DEFAULT 0,
    latency_ms INTEGER NOT NULL DEFAULT 0,
    warnings_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    last_hit_at TEXT,
    hit_count INTEGER NOT NULL DEFAULT 0,
    UNIQUE (workspace_id, project_id, processor_version_id, document_sha256)
);

CREATE INDEX IF NOT EXISTS idx_documents_created_at ON documents(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_document_folders_path ON document_folders(workspace_id, project_id, path);
CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_eval_experiments_group ON eval_experiments(eval_group_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_extractions_document_id ON extractions(document_id);
CREATE INDEX IF NOT EXISTS idx_evaluations_run_id ON evaluations(run_id);
CREATE INDEX IF NOT EXISTS idx_evaluation_fields_status ON evaluation_fields(status);
CREATE INDEX IF NOT EXISTS idx_review_assignments_queue ON review_assignments(dataset_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_review_decisions_run ON review_decisions(run_id, updated_at DESC);
"""


def _json(value: Any, default: Any) -> Any:
    if value is None:
        return default
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return default


def _dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _merge_dicts(base: Dict[str, Any], updates: Dict[str, Any]) -> Dict[str, Any]:
    merged = dict(base)
    for key, value in updates.items():
        merged[key] = _merge_dicts(merged[key], value) if isinstance(value, dict) and isinstance(merged.get(key), dict) else value
    return merged


def normalize_folder_path(path: Any) -> str:
    """Return a safe, slash-delimited folder path with a trailing slash."""
    value = str(path or "").replace("\\", "/").strip("/")
    if not value:
        return ""
    segments = [segment.strip() for segment in value.split("/") if segment.strip()]
    if any(segment in {".", ".."} for segment in segments):
        raise ValueError("folder path cannot contain '.' or '..'")
    return "/".join(segments) + "/"


class Database:
    def __init__(self, path: Path, workspace_id: str = "ws_local", project_id: str = "project_local"):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._write_lock = threading.Lock()
        self._unit = threading.local()
        self.workspace_id = workspace_id or "ws_local"
        self.project_id = project_id or "project_local"

    def _workspace_id(self) -> str:
        return _WORKSPACE_CONTEXT.get() or self.workspace_id

    def _project_id(self) -> str:
        return _PROJECT_CONTEXT.get() or self.project_id

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(str(self.path), timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    def initialize(self) -> None:
        with self._write_lock:
            connection = self.connect()
            try:
                connection.executescript(SCHEMA)
                columns = {row["name"] for row in connection.execute("PRAGMA table_info(runs)").fetchall()}
                if "eval_experiment_id" not in columns:
                    connection.execute("ALTER TABLE runs ADD COLUMN eval_experiment_id TEXT REFERENCES eval_experiments(id)")
                group_columns = {row["name"] for row in connection.execute("PRAGMA table_info(eval_groups)").fetchall()}
                if "dataset_id" not in group_columns:
                    connection.execute("ALTER TABLE eval_groups ADD COLUMN dataset_id TEXT REFERENCES datasets(id)")
                experiment_columns = {row["name"] for row in connection.execute("PRAGMA table_info(eval_experiments)").fetchall()}
                if "processor_version_id" not in experiment_columns:
                    connection.execute("ALTER TABLE eval_experiments ADD COLUMN processor_version_id TEXT REFERENCES processor_versions(id)")
                connection.execute("CREATE INDEX IF NOT EXISTS idx_runs_eval_experiment ON runs(eval_experiment_id, created_at DESC)")
                connection.execute("CREATE INDEX IF NOT EXISTS idx_eval_groups_dataset ON eval_groups(dataset_id)")
                connection.execute("CREATE INDEX IF NOT EXISTS idx_eval_experiments_processor_version ON eval_experiments(processor_version_id)")
                initialize_collaboration(connection)
                self._backfill_eval_structure(connection)
                connection.commit()
            finally:
                connection.close()

    def _backfill_eval_structure(self, connection: sqlite3.Connection) -> None:
        """Map legacy dataset experiments onto benchmark groups and config experiments."""
        datasets = connection.execute(
            "SELECT id, workspace_id, project_id, name, description, created_at FROM datasets"
        ).fetchall()
        for dataset in datasets:
            group_id = "eval_group_{}".format(dataset["id"])
            experiment_id = "eval_experiment_{}".format(dataset["id"])
            connection.execute(
                "INSERT OR IGNORE INTO eval_groups (id, workspace_id, project_id, dataset_id, name, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (group_id, dataset["workspace_id"], dataset["project_id"], dataset["id"], dataset["name"], "Benchmark for {}".format(dataset["name"]), dataset["created_at"]),
            )
            connection.execute("UPDATE eval_groups SET dataset_id = COALESCE(dataset_id, ?) WHERE id = ?", (dataset["id"], group_id))
            connection.execute(
                "UPDATE eval_groups SET description = ? WHERE id = ? AND description = ?",
                ("Benchmark for {}".format(dataset["name"]), group_id, "Eval group for {}".format(dataset["name"])),
            )
            connection.execute(
                "INSERT OR IGNORE INTO eval_experiments (id, eval_group_id, dataset_id, name, description, created_at) SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM runs WHERE dataset_id = ? AND (eval_experiment_id IS NULL OR eval_experiment_id = ''))",
                (experiment_id, group_id, dataset["id"], "Baseline", "Original extraction configuration", dataset["created_at"], dataset["id"]),
            )
            connection.execute(
                "UPDATE runs SET eval_experiment_id = ? WHERE dataset_id = ? AND (eval_experiment_id IS NULL OR eval_experiment_id = '')",
                (experiment_id, dataset["id"]),
            )
            connection.execute(
                "UPDATE eval_experiments SET name = 'Baseline', description = 'Original extraction configuration' WHERE id = ? AND name = ? AND NOT EXISTS (SELECT 1 FROM eval_experiments other WHERE other.eval_group_id = ? AND other.name = 'Baseline' AND other.id != ?)",
                (experiment_id, dataset["name"], group_id, experiment_id),
            )
        connection.execute(
            "UPDATE eval_groups SET dataset_id = (SELECT ee.dataset_id FROM eval_experiments ee WHERE ee.eval_group_id = eval_groups.id ORDER BY ee.created_at LIMIT 1) WHERE dataset_id IS NULL"
        )
        connection.execute(
            "UPDATE eval_experiments SET processor_version_id = (SELECT r.processor_version_id FROM runs r WHERE r.eval_experiment_id = eval_experiments.id ORDER BY r.created_at DESC LIMIT 1) WHERE processor_version_id IS NULL"
        )
        connection.execute(
            "UPDATE eval_experiments SET processor_version_id = (SELECT pv.id FROM processor_versions pv JOIN processors p ON p.id = pv.processor_id JOIN eval_groups eg ON eg.workspace_id = p.workspace_id AND eg.project_id = p.project_id WHERE eg.id = eval_experiments.eval_group_id ORDER BY CASE WHEN pv.status = 'published' THEN 0 ELSE 1 END, pv.version DESC LIMIT 1) WHERE processor_version_id IS NULL"
        )
        groups = connection.execute("SELECT id, dataset_id FROM eval_groups WHERE archived_at IS NULL").fetchall()
        for group in groups:
            versions = connection.execute(
                "SELECT DISTINCT r.processor_version_id, pv.version, p.name AS processor_name, MIN(r.created_at) AS first_run_at FROM runs r JOIN eval_experiments ee ON ee.id = r.eval_experiment_id JOIN processor_versions pv ON pv.id = r.processor_version_id JOIN processors p ON p.id = pv.processor_id WHERE ee.eval_group_id = ? GROUP BY r.processor_version_id, pv.version, p.name",
                (group["id"],),
            ).fetchall()
            for version in versions:
                experiment = connection.execute(
                    "SELECT id FROM eval_experiments WHERE eval_group_id = ? AND processor_version_id = ? ORDER BY created_at LIMIT 1",
                    (group["id"], version["processor_version_id"]),
                ).fetchone()
                if not experiment:
                    experiment_id = "eval_experiment_{}_{}".format(group["id"], version["processor_version_id"])
                    experiment_name = "{} · v{}".format(version["processor_name"], version["version"])
                    if connection.execute("SELECT 1 FROM eval_experiments WHERE eval_group_id = ? AND name = ?", (group["id"], experiment_name)).fetchone():
                        experiment_name = "{} config".format(experiment_name)
                    connection.execute(
                        "INSERT OR IGNORE INTO eval_experiments (id, eval_group_id, dataset_id, processor_version_id, name, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                        (experiment_id, group["id"], group["dataset_id"], version["processor_version_id"], experiment_name, "Recovered configuration from existing run history", version["first_run_at"]),
                    )
                    experiment = connection.execute("SELECT id FROM eval_experiments WHERE id = ?", (experiment_id,)).fetchone()
                connection.execute(
                    "UPDATE runs SET eval_experiment_id = ? WHERE processor_version_id = ? AND eval_experiment_id IN (SELECT id FROM eval_experiments WHERE eval_group_id = ?)",
                    (experiment["id"], version["processor_version_id"], group["id"]),
                )

    def _one(self, query: str, params: Iterable[Any] = ()) -> Optional[sqlite3.Row]:
        if getattr(self._unit, "connection", None):
            return self._unit.connection.execute(query, tuple(params)).fetchone()
        connection = self.connect()
        try:
            return connection.execute(query, tuple(params)).fetchone()
        finally:
            connection.close()

    def _all(self, query: str, params: Iterable[Any] = ()) -> List[sqlite3.Row]:
        if getattr(self._unit, "connection", None):
            return self._unit.connection.execute(query, tuple(params)).fetchall()
        connection = self.connect()
        try:
            return connection.execute(query, tuple(params)).fetchall()
        finally:
            connection.close()

    def _execute(self, query: str, params: Iterable[Any] = ()) -> int:
        if getattr(self._unit, "connection", None):
            return self._unit.connection.execute(query, tuple(params)).rowcount
        with self._write_lock:
            connection = self.connect()
            try:
                cursor = connection.execute(query, tuple(params))
                connection.commit()
                return cursor.rowcount
            finally:
                connection.close()

    def _transaction(self, callback):
        if getattr(self._unit, "connection", None):
            return callback(self._unit.connection)
        with self._write_lock:
            connection = self.connect()
            try:
                connection.execute("BEGIN IMMEDIATE")
                result = callback(connection)
                connection.commit()
                return result
            except Exception:
                connection.rollback()
                raise
            finally:
                connection.close()

    @contextmanager
    def atomic(self):
        """Group a result, its fields, and its score into one durable commit."""
        if getattr(self._unit, "connection", None):
            yield
            return
        with self._write_lock:
            connection = self.connect()
            self._unit.connection = connection
            try:
                connection.execute("BEGIN IMMEDIATE")
                yield
                connection.commit()
            except BaseException:
                connection.rollback()
                raise
            finally:
                self._unit.connection = None
                connection.close()

    def get_document(self, document_id: str) -> Optional[Dict[str, Any]]:
        row = self._one("SELECT * FROM documents WHERE id = ? AND workspace_id = ? AND project_id = ?", (document_id, self._workspace_id(), self._project_id()))
        return self._document(row) if row else None

    def find_document_by_hash(self, sha256: str) -> Optional[Dict[str, Any]]:
        row = self._one("SELECT * FROM documents WHERE sha256 = ? AND workspace_id = ? AND project_id = ?", (sha256, self._workspace_id(), self._project_id()))
        return self._document(row) if row else None

    def list_documents(self, query: str = "") -> List[Dict[str, Any]]:
        like = "%{}%".format(query.lower())
        rows = self._all(
            """
            SELECT d.*,
              (SELECT GROUP_CONCAT(ds.name, '||') FROM dataset_documents dd JOIN datasets ds ON ds.id = dd.dataset_id WHERE dd.document_id = d.id) AS dataset_names,
              (SELECT gt.revision FROM ground_truth gt WHERE gt.document_id = d.id ORDER BY gt.revision DESC LIMIT 1) AS ground_truth_revision,
              (SELECT gt.annotation_status FROM ground_truth gt WHERE gt.document_id = d.id ORDER BY gt.revision DESC LIMIT 1) AS ground_truth_status
            FROM documents d
            WHERE d.workspace_id = ? AND d.project_id = ? AND (? = '' OR lower(d.filename) LIKE ? OR lower(d.mime_type) LIKE ?)
            ORDER BY d.created_at DESC
            """,
            (self._workspace_id(), self._project_id(), query.lower(), like, like),
        )
        return [self._document(row) for row in rows]

    def get_document_folder(self, path: str) -> Optional[Dict[str, Any]]:
        normalized = normalize_folder_path(path)
        if not normalized:
            return None
        row = self._one(
            "SELECT * FROM document_folders WHERE path = ? AND workspace_id = ? AND project_id = ?",
            (normalized, self._workspace_id(), self._project_id()),
        )
        return self._document_folder(row) if row else None

    def list_document_folders(self) -> List[Dict[str, Any]]:
        rows = self._all(
            "SELECT * FROM document_folders WHERE workspace_id = ? AND project_id = ? ORDER BY path ASC",
            (self._workspace_id(), self._project_id()),
        )
        documents = self.list_documents()
        counts: Dict[str, int] = {}
        for document in documents:
            folder_path = normalize_folder_path((document.get("metadata") or {}).get("folder_path", ""))
            if folder_path:
                counts[folder_path] = counts.get(folder_path, 0) + 1
        return [
            {**self._document_folder(row), "document_count": counts.get(row["path"], 0)}
            for row in rows
        ]

    def create_document_folder(self, path: str) -> Dict[str, Any]:
        normalized = normalize_folder_path(path)
        if not normalized:
            raise ValueError("folder name is required")
        if self.get_document_folder(normalized):
            raise ValueError("Folder already exists")
        segments = normalized.rstrip("/").split("/")

        def write(connection: sqlite3.Connection) -> None:
            for index in range(1, len(segments) + 1):
                folder_path = "/".join(segments[:index]) + "/"
                connection.execute(
                    "INSERT OR IGNORE INTO document_folders (id, workspace_id, project_id, path, created_at) VALUES (?, ?, ?, ?, ?)",
                    (new_id("folder"), self._workspace_id(), self._project_id(), folder_path, utc_now()),
                )

        self._transaction(write)
        return self.get_document_folder(normalized)  # type: ignore

    def update_document_folder(self, document_id: str, folder_path: str) -> Optional[Dict[str, Any]]:
        document = self.get_document(document_id)
        if not document:
            return None
        normalized = normalize_folder_path(folder_path)
        if normalized and not self.get_document_folder(normalized):
            raise ValueError("Folder not found")
        metadata = dict(document.get("metadata") or {})
        if normalized:
            metadata["folder_path"] = normalized
        else:
            metadata.pop("folder_path", None)
        self._execute(
            "UPDATE documents SET metadata_json = ? WHERE id = ? AND workspace_id = ? AND project_id = ?",
            (_dump(metadata), document_id, self._workspace_id(), self._project_id()),
        )
        return self.get_document(document_id)

    def insert_document(self, document: Dict[str, Any]) -> Dict[str, Any]:
        workspace_id = document.get("workspace_id", self._workspace_id())
        project_id = document.get("project_id", self._project_id())
        if workspace_id != self._workspace_id() or project_id != self._project_id():
            raise ValueError("document scope does not match the active workbench")
        self._execute(
            "INSERT INTO documents (id, workspace_id, project_id, filename, mime_type, size_bytes, sha256, blob_key, page_count, metadata_json, created_at, immutable) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)",
            (document["id"], workspace_id, project_id, document["filename"], document["mime_type"], document["size_bytes"], document["sha256"], document["blob_key"], document.get("page_count", 1), _dump(document.get("metadata", {})), document.get("created_at", utc_now())),
        )
        return self.get_document(document["id"])  # type: ignore

    def get_dataset(self, dataset_id: str) -> Optional[Dict[str, Any]]:
        row = self._one("SELECT * FROM datasets WHERE id = ? AND workspace_id = ? AND project_id = ?", (dataset_id, self._workspace_id(), self._project_id()))
        if not row:
            return None
        result = dict(row)
        result.pop("workspace_id", None)
        result.pop("project_id", None)
        result["document_count"] = self._one("SELECT COUNT(*) AS count FROM dataset_documents WHERE dataset_id = ?", (dataset_id,))["count"]
        result["annotated_count"] = self._one("SELECT COUNT(DISTINCT dd.document_id) AS count FROM dataset_documents dd JOIN ground_truth gt ON gt.document_id = dd.document_id WHERE dd.dataset_id = ?", (dataset_id,))["count"]
        result["gt_coverage"] = round(result["annotated_count"] / result["document_count"] * 100, 1) if result["document_count"] else 0
        return result

    def get_eval_group(self, group_id: str) -> Optional[Dict[str, Any]]:
        row = self._one(
            "SELECT * FROM eval_groups WHERE id = ? AND workspace_id = ? AND project_id = ? AND archived_at IS NULL",
            (group_id, self._workspace_id(), self._project_id()),
        )
        if not row:
            return None
        result = dict(row)
        result.pop("workspace_id", None)
        result.pop("project_id", None)
        result["dataset"] = self.get_dataset(result["dataset_id"]) if result.get("dataset_id") else None
        result["experiments"] = self.list_eval_experiments(group_id)
        result["experiment_count"] = len(result["experiments"])
        result["run_count"] = int(self._one(
            "SELECT COUNT(*) AS count FROM runs r JOIN eval_experiments ee ON ee.id = r.eval_experiment_id WHERE ee.eval_group_id = ?",
            (group_id,),
        )["count"] or 0)
        return result

    def list_eval_groups(self) -> List[Dict[str, Any]]:
        rows = self._all(
            "SELECT id FROM eval_groups WHERE workspace_id = ? AND project_id = ? AND archived_at IS NULL ORDER BY created_at DESC",
            (self._workspace_id(), self._project_id()),
        )
        return [self.get_eval_group(row["id"]) for row in rows]  # type: ignore

    def create_eval_group(self, name: str, description: str = "", group_id: Optional[str] = None, dataset_id: Optional[str] = None) -> Dict[str, Any]:
        name = str(name or "").strip()
        if not name:
            raise ValueError("eval group name is required")
        if not dataset_id or not self.get_dataset(dataset_id):
            raise ValueError("eval group dataset is required")
        group_id = group_id or new_id("eval_group")
        self._execute(
            "INSERT INTO eval_groups (id, workspace_id, project_id, dataset_id, name, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (group_id, self._workspace_id(), self._project_id(), dataset_id, name, str(description or "").strip(), utc_now()),
        )
        return self.get_eval_group(group_id)  # type: ignore

    def get_eval_experiment(self, experiment_id: str) -> Optional[Dict[str, Any]]:
        row = self._one(
            "SELECT ee.*, eg.name AS eval_group_name, eg.description AS eval_group_description, eg.dataset_id AS eval_group_dataset_id FROM eval_experiments ee JOIN eval_groups eg ON eg.id = ee.eval_group_id WHERE ee.id = ? AND eg.workspace_id = ? AND eg.project_id = ? AND eg.archived_at IS NULL",
            (experiment_id, self._workspace_id(), self._project_id()),
        )
        if not row:
            return None
        result = dict(row)
        group_dataset_id = result.pop("eval_group_dataset_id") or result.get("dataset_id")
        result["eval_group"] = {"id": result.pop("eval_group_id"), "name": result.pop("eval_group_name"), "description": result.pop("eval_group_description"), "dataset_id": group_dataset_id}
        result["dataset_id"] = group_dataset_id
        result["dataset"] = self.get_dataset(group_dataset_id) if group_dataset_id else None
        result["processor_version"] = self.get_processor_version(result["processor_version_id"]) if result.get("processor_version_id") else None
        result["run_count"] = int(self._one("SELECT COUNT(*) AS count FROM runs WHERE eval_experiment_id = ?", (experiment_id,))["count"] or 0)
        return result

    def list_eval_experiments(self, group_id: str) -> List[Dict[str, Any]]:
        rows = self._all(
            "SELECT ee.id FROM eval_experiments ee JOIN eval_groups eg ON eg.id = ee.eval_group_id WHERE ee.eval_group_id = ? AND eg.workspace_id = ? AND eg.project_id = ? AND eg.archived_at IS NULL ORDER BY ee.created_at DESC",
            (group_id, self._workspace_id(), self._project_id()),
        )
        return [self.get_eval_experiment(row["id"]) for row in rows]  # type: ignore

    def create_eval_experiment(self, group_id: str, processor_version_id: str, name: str, description: str = "", experiment_id: Optional[str] = None) -> Dict[str, Any]:
        group = self.get_eval_group(group_id)
        if not group:
            raise ValueError("Eval group not found")
        if not group.get("dataset_id") or not self.get_dataset(group["dataset_id"]):
            raise ValueError("Eval group has no benchmark dataset")
        if not self.get_processor_version(processor_version_id):
            raise ValueError("Processor version not found")
        name = str(name or "").strip()
        if not name:
            raise ValueError("eval experiment name is required")
        experiment_id = experiment_id or new_id("eval_experiment")
        self._execute(
            "INSERT INTO eval_experiments (id, eval_group_id, dataset_id, processor_version_id, name, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (experiment_id, group_id, group["dataset_id"], processor_version_id, name, str(description or "").strip(), utc_now()),
        )
        return self.get_eval_experiment(experiment_id)  # type: ignore

    def ensure_eval_experiment_for_dataset(self, dataset_id: str, processor_version_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
        """Return a config experiment for CLI/API runs that omit one explicitly."""
        dataset = self.get_dataset(dataset_id)
        if not dataset:
            return None
        existing = self._one(
            "SELECT ee.id FROM eval_experiments ee JOIN eval_groups eg ON eg.id = ee.eval_group_id WHERE eg.dataset_id = ? AND eg.workspace_id = ? AND eg.project_id = ? AND eg.archived_at IS NULL AND (? IS NULL OR ee.processor_version_id = ?) ORDER BY ee.created_at LIMIT 1",
            (dataset_id, self._workspace_id(), self._project_id(), processor_version_id, processor_version_id),
        )
        if existing:
            return self.get_eval_experiment(existing["id"])
        group_id = "eval_group_{}".format(dataset_id)
        experiment_id = "eval_experiment_{}_{}".format(dataset_id, processor_version_id or "baseline")
        self._execute(
            "INSERT OR IGNORE INTO eval_groups (id, workspace_id, project_id, dataset_id, name, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (group_id, self._workspace_id(), self._project_id(), dataset_id, dataset["name"], "Benchmark for {}".format(dataset["name"]), dataset["created_at"]),
        )
        self._execute("UPDATE eval_groups SET dataset_id = COALESCE(dataset_id, ?) WHERE id = ?", (dataset_id, group_id))
        version = self.get_processor_version(processor_version_id) if processor_version_id else None
        experiment_name = "{} · v{}".format(version.get("processor_name"), version.get("version")) if version else "Baseline"
        self._execute(
            "INSERT OR IGNORE INTO eval_experiments (id, eval_group_id, dataset_id, processor_version_id, name, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (experiment_id, group_id, dataset_id, processor_version_id, experiment_name, "Configuration captured for this benchmark", dataset["created_at"]),
        )
        return self.get_eval_experiment(experiment_id)

    def list_datasets(self) -> List[Dict[str, Any]]:
        rows = self._all("SELECT id FROM datasets WHERE workspace_id = ? AND project_id = ? AND archived_at IS NULL ORDER BY created_at DESC", (self._workspace_id(), self._project_id()))
        return [self.get_dataset(row["id"]) for row in rows]  # type: ignore

    def insert_dataset(self, name: str, description: str = "", dataset_id: Optional[str] = None) -> Dict[str, Any]:
        dataset_id = dataset_id or new_id("ds")
        created_at = utc_now()
        self._execute("INSERT INTO datasets (id, workspace_id, project_id, name, description, created_at) VALUES (?, ?, ?, ?, ?, ?)", (dataset_id, self._workspace_id(), self._project_id(), name, description, created_at))
        self._execute(
            "INSERT OR IGNORE INTO eval_groups (id, workspace_id, project_id, dataset_id, name, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            ("eval_group_{}".format(dataset_id), self._workspace_id(), self._project_id(), dataset_id, name, "Benchmark for {}".format(name), created_at),
        )
        result = self.get_dataset(dataset_id)  # type: ignore
        return result

    def update_dataset(self, dataset_id: str, updates: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        dataset = self.get_dataset(dataset_id)
        if not dataset:
            return None
        name = str(updates.get("name", dataset["name"])).strip()
        if not name:
            raise ValueError("dataset name is required")
        self._execute("UPDATE datasets SET name = ?, description = ? WHERE id = ? AND workspace_id = ? AND project_id = ?", (name, str(updates.get("description", dataset.get("description", ""))), dataset_id, self._workspace_id(), self._project_id()))
        return self.get_dataset(dataset_id)

    def add_document_to_dataset(self, dataset_id: str, document_id: str, split: str = "unspecified") -> None:
        if not self.get_dataset(dataset_id):
            raise ValueError("Dataset not found: {}".format(dataset_id))
        if not self.get_document(document_id):
            raise ValueError("Document not found: {}".format(document_id))
        self._execute("INSERT INTO dataset_documents (dataset_id, document_id, split, tags_json, added_at) VALUES (?, ?, ?, '[]', ?) ON CONFLICT(dataset_id, document_id) DO UPDATE SET split = excluded.split", (dataset_id, document_id, split or "unspecified", utc_now()))

    def update_dataset_document(self, dataset_id: str, document_id: str, split: Optional[str] = None, tags: Optional[List[str]] = None) -> bool:
        current = self._one("SELECT split, tags_json FROM dataset_documents WHERE dataset_id = ? AND document_id = ?", (dataset_id, document_id))
        if not current or not self.get_dataset(dataset_id):
            return False
        return self._execute("UPDATE dataset_documents SET split = ?, tags_json = ? WHERE dataset_id = ? AND document_id = ?", (split or current["split"] or "unspecified", _dump(tags if tags is not None else _json(current["tags_json"], [])), dataset_id, document_id)) > 0

    def list_dataset_documents(self, dataset_id: str) -> List[Dict[str, Any]]:
        rows = self._all(
            """
            SELECT d.*, dd.split, dd.tags_json, dd.added_at,
              (SELECT gt.revision FROM ground_truth gt WHERE gt.document_id = d.id ORDER BY gt.revision DESC LIMIT 1) AS ground_truth_revision,
              (SELECT gt.annotation_status FROM ground_truth gt WHERE gt.document_id = d.id ORDER BY gt.revision DESC LIMIT 1) AS ground_truth_status
            FROM dataset_documents dd JOIN documents d ON d.id = dd.document_id
            WHERE dd.dataset_id = ? AND d.workspace_id = ? AND d.project_id = ? ORDER BY d.created_at DESC
            """,
            (dataset_id, self._workspace_id(), self._project_id()),
        )
        return [self._document(row) for row in rows]

    def snapshot_dataset(self, dataset_id: str, document_ids=None) -> List[Dict[str, Any]]:
        """Read membership and annotation revisions in a single SQLite snapshot."""
        with self.connect() as connection:
            connection.execute("BEGIN")
            rows = connection.execute(
                "SELECT d.* FROM dataset_documents dd JOIN documents d ON d.id = dd.document_id WHERE dd.dataset_id = ? AND d.workspace_id = ? AND d.project_id = ? ORDER BY d.id",
                (dataset_id, self._workspace_id(), self._project_id()),
            ).fetchall()
            documents = []
            for row in rows:
                if document_ids is not None and row["id"] not in document_ids:
                    continue
                document = self._document(row)
                truth = connection.execute("SELECT * FROM ground_truth WHERE document_id = ? ORDER BY revision DESC LIMIT 1", (row["id"],)).fetchone()
                document["ground_truth"] = self._ground_truth(truth) if truth else None
                documents.append(document)
            return documents

    def update_run_progress(self, run_id: str, metrics: Dict[str, Any]) -> None:
        self._execute("UPDATE runs SET metrics_json = ? WHERE id = ? AND status IN ('running', 'pausing', 'cancelling')", (_dump(metrics), run_id))

    def cancel_run(self, run_id: str) -> Optional[Dict[str, Any]]:
        self._execute("UPDATE runs SET status = 'cancelling' WHERE id = ? AND status = 'running' AND workspace_id = ? AND project_id = ?", (run_id, self._workspace_id(), self._project_id()))
        return self.get_run(run_id)

    def remove_document_from_dataset(self, dataset_id: str, document_id: str) -> bool:
        return self._execute("DELETE FROM dataset_documents WHERE dataset_id = ? AND document_id = ?", (dataset_id, document_id)) > 0

    def clone_dataset(self, dataset_id: str, name: str, description: Optional[str] = None) -> Dict[str, Any]:
        source = self.get_dataset(dataset_id)
        if not source:
            raise ValueError("Dataset not found: {}".format(dataset_id))
        clone = self.insert_dataset(name, description if description is not None else "Copy of {}".format(source["name"]))
        for document in self.list_dataset_documents(dataset_id):
            self.add_document_to_dataset(clone["id"], document["id"], document.get("split") or "unspecified")
            if document.get("tags"):
                self.update_dataset_document(clone["id"], document["id"], tags=document["tags"])
        return self.get_dataset(clone["id"])  # type: ignore

    def has_blob_reference(self, blob_key: str) -> bool:
        return self._one("SELECT 1 FROM documents WHERE blob_key = ? LIMIT 1", (blob_key,)) is not None

    def delete_document(self, document_id: str) -> Optional[Dict[str, Any]]:
        document = self.get_document(document_id)
        if not document:
            return None
        def write(connection):
            connection.execute("UPDATE runs SET document_id = NULL WHERE document_id = ?", (document_id,))
            connection.execute("DELETE FROM evaluation_fields WHERE evaluation_id IN (SELECT id FROM evaluations WHERE document_id = ?)", (document_id,))
            connection.execute("DELETE FROM evaluations WHERE document_id = ?", (document_id,))
            connection.execute("DELETE FROM extraction_fields WHERE extraction_id IN (SELECT id FROM extractions WHERE document_id = ?)", (document_id,))
            connection.execute("DELETE FROM extractions WHERE document_id = ?", (document_id,))
            connection.execute("DELETE FROM ground_truth WHERE document_id = ?", (document_id,))
            connection.execute("DELETE FROM review_assignments WHERE document_id = ?", (document_id,))
            connection.execute("DELETE FROM documents WHERE id = ?", (document_id,))
        self._transaction(write)
        return document

    def get_processor(self, processor_ref: str) -> Optional[Dict[str, Any]]:
        row = self._one("SELECT * FROM processors WHERE workspace_id = ? AND project_id = ? AND (id = ? OR name = ?)", (self._workspace_id(), self._project_id(), processor_ref, processor_ref))
        if not row:
            return None
        result = dict(row)
        result.pop("workspace_id", None)
        result.pop("project_id", None)
        result["versions"] = self.list_processor_versions(row["id"])
        latest = result["versions"][0] if result["versions"] else None
        result["latest_version"] = {
            "id": latest.get("id"),
            "version": latest.get("version"),
            "status": latest.get("status"),
            "created_at": latest.get("created_at"),
        } if latest else None
        draft_row = self._one("SELECT status, updated_at FROM processor_drafts WHERE processor_id = ?", (row["id"],))
        if draft_row:
            next_version = (int(latest.get("version", 0)) + 1) if latest else 1
            result["draft"] = {
                "status": draft_row["status"],
                "updated_at": draft_row["updated_at"],
                "next_version": next_version,
            }
        else:
            result["draft"] = None
        return result

    def list_processors(self) -> List[Dict[str, Any]]:
        rows = self._all("SELECT id FROM processors WHERE workspace_id = ? AND project_id = ? AND archived_at IS NULL ORDER BY created_at DESC", (self._workspace_id(), self._project_id()))
        return [self.get_processor(row["id"]) for row in rows]  # type: ignore

    def insert_processor(self, name: str, description: str = "", processor_id: Optional[str] = None) -> Dict[str, Any]:
        processor_id = processor_id or new_id("proc")
        self._execute("INSERT INTO processors (id, workspace_id, project_id, name, description, created_at) VALUES (?, ?, ?, ?, ?, ?)", (processor_id, self._workspace_id(), self._project_id(), name, description, utc_now()))
        return self.get_processor(processor_id)  # type: ignore

    def update_processor(self, processor_ref: str, updates: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        processor = self.get_processor(processor_ref)
        if not processor:
            return None
        name = str(updates.get("name", processor["name"])).strip()
        if not name:
            raise ValueError("processor name is required")
        existing = self.get_processor(name)
        if existing and existing["id"] != processor["id"]:
            raise ValueError("processor already exists: {}".format(name))
        description = str(updates.get("description", processor.get("description", ""))).strip()
        self._execute("UPDATE processors SET name = ?, description = ? WHERE id = ? AND workspace_id = ? AND project_id = ?", (name, description, processor["id"], self._workspace_id(), self._project_id()))
        return self.get_processor(processor["id"])

    def insert_processor_version(self, version: Dict[str, Any]) -> Dict[str, Any]:
        from .harness_spec import validate_spec
        validate_spec(version.get("harness", {}), version.get("schema", {}))
        if not self._one("SELECT 1 FROM processors WHERE id = ? AND workspace_id = ? AND project_id = ?", (version["processor_id"], self._workspace_id(), self._project_id())):
            raise ValueError("Processor not found in the active workbench")
        self._execute("INSERT INTO processor_versions (id, processor_id, version, status, schema_json, prompt_json, parser_json, model_json, harness_json, normalization_json, created_at, immutable, author) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)", (version["id"], version["processor_id"], version["version"], version.get("status", "draft"), _dump(version.get("schema", {})), _dump(version.get("prompt", {})), _dump(version.get("parser", {})), _dump(version.get("model", {})), _dump(version.get("harness", {})), _dump(version.get("normalization", {})), version.get("created_at", utc_now()), version.get("author", "local")))
        return self.get_processor_version(version["id"])  # type: ignore

    def get_processor_version(self, version_id: str) -> Optional[Dict[str, Any]]:
        row = self._one("SELECT pv.*, p.name AS processor_name FROM processor_versions pv JOIN processors p ON p.id = pv.processor_id WHERE pv.id = ? AND p.workspace_id = ? AND p.project_id = ?", (version_id, self._workspace_id(), self._project_id()))
        return self._processor_version(row) if row else None

    def list_processor_versions(self, processor_id: str) -> List[Dict[str, Any]]:
        rows = self._all("SELECT pv.*, p.name AS processor_name FROM processor_versions pv JOIN processors p ON p.id = pv.processor_id WHERE pv.processor_id = ? AND p.workspace_id = ? AND p.project_id = ? ORDER BY pv.version DESC", (processor_id, self._workspace_id(), self._project_id()))
        return [self._processor_version(row) for row in rows]

    def resolve_processor_version(self, processor_ref: str, version: Optional[int] = None) -> Optional[Dict[str, Any]]:
        processor = self.get_processor(processor_ref)
        if not processor:
            return None
        if version is None:
            row = self._one("SELECT * FROM processor_versions WHERE processor_id = ? ORDER BY CASE WHEN status = 'published' THEN 0 ELSE 1 END, version DESC LIMIT 1", (processor["id"],))
        else:
            row = self._one("SELECT * FROM processor_versions WHERE processor_id = ? AND version = ?", (processor["id"], version))
        return self._processor_version(row) if row else None

    def get_processor_draft(self, processor_ref: str) -> Optional[Dict[str, Any]]:
        processor = self.get_processor(processor_ref)
        if not processor:
            return None
        row = self._one("SELECT * FROM processor_drafts WHERE processor_id = ?", (processor["id"],))
        if not row:
            return None
        draft = self._processor_draft(row, processor["name"])
        latest = self._one("SELECT COALESCE(MAX(version), 0) AS version FROM processor_versions WHERE processor_id = ?", (processor["id"],))
        draft["next_version"] = int(latest["version"]) + 1 if latest else 1
        return draft

    def upsert_processor_draft(self, processor_ref: str, config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        processor = self.get_processor(processor_ref)
        if not processor:
            raise ValueError("Processor not found: {}".format(processor_ref))
        current = self.get_processor_draft(processor["id"])
        base = self.get_processor_version(current["base_version_id"]) if current and current.get("base_version_id") else None
        base = base or self.resolve_processor_version(processor["id"])
        if not base:
            raise ValueError("Processor has no version to draft")
        supplied = config or {}
        values = {key: supplied.get(key, current.get(key) if current else base.get(key, {})) for key in ("schema", "prompt", "parser", "model", "harness", "normalization")}
        from .harness_spec import validate_spec
        validate_spec(values["harness"], values["schema"])
        now = utc_now()
        self._execute(
            "INSERT INTO processor_drafts (id, processor_id, base_version_id, schema_json, prompt_json, parser_json, model_json, harness_json, normalization_json, status, published_version_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', NULL, ?, ?) ON CONFLICT(processor_id) DO UPDATE SET base_version_id = excluded.base_version_id, schema_json = excluded.schema_json, prompt_json = excluded.prompt_json, parser_json = excluded.parser_json, model_json = excluded.model_json, harness_json = excluded.harness_json, normalization_json = excluded.normalization_json, status = 'draft', published_version_id = NULL, updated_at = excluded.updated_at",
            (current["id"] if current else new_id("draft"), processor["id"], base["id"], _dump(values["schema"]), _dump(values["prompt"]), _dump(values["parser"]), _dump(values["model"]), _dump(values["harness"]), _dump(values["normalization"]), now, now),
        )
        return self.get_processor_draft(processor["id"])  # type: ignore

    def publish_processor_draft(self, processor_ref: str) -> Dict[str, Any]:
        draft = self.get_processor_draft(processor_ref) or self.upsert_processor_draft(processor_ref)
        latest = self._one("SELECT COALESCE(MAX(version), 0) AS version FROM processor_versions WHERE processor_id = ?", (draft["processor_id"],))
        version = {"id": new_id("pv"), "processor_id": draft["processor_id"], "version": int(latest["version"]) + 1, "status": "published", **{key: draft[key] for key in ("schema", "prompt", "parser", "model", "harness", "normalization")}}
        self.insert_processor_version(version)
        self._execute("UPDATE processor_drafts SET status = 'published', published_version_id = ?, updated_at = ? WHERE id = ?", (version["id"], utc_now(), draft["id"]))
        return self.get_processor_version(version["id"])  # type: ignore

    def create_run(self, processor_version_id: str, target_type: str, dataset_id: Optional[str] = None, document_id: Optional[str] = None, scoring_config: Optional[Dict[str, Any]] = None, metadata: Optional[Dict[str, Any]] = None, eval_experiment_id: Optional[str] = None) -> Dict[str, Any]:
        if eval_experiment_id:
            experiment = self.get_eval_experiment(eval_experiment_id)
            if not experiment:
                raise ValueError("Eval experiment not found")
            if experiment.get("processor_version_id") != processor_version_id:
                raise ValueError("Run configuration must match its eval experiment")
            if dataset_id and experiment.get("dataset_id") != dataset_id:
                raise ValueError("Run dataset must match its eval group benchmark")
        run_id = new_id("run")
        now = utc_now()
        self._execute("INSERT INTO runs (id, workspace_id, project_id, processor_version_id, eval_experiment_id, dataset_id, document_id, target_type, status, scoring_config_json, metadata_json, started_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)", (run_id, self._workspace_id(), self._project_id(), processor_version_id, eval_experiment_id, dataset_id, document_id, target_type, _dump(scoring_config or {}), _dump(metadata or {}), now, now))
        return self.get_run(run_id)  # type: ignore

    def finish_run(self, run_id: str, status: str, metrics: Optional[Dict[str, Any]] = None, error_text: Optional[str] = None) -> Optional[Dict[str, Any]]:
        self._execute("UPDATE runs SET status = ?, metrics_json = ?, error_text = ?, completed_at = ? WHERE id = ? AND workspace_id = ? AND project_id = ?", (status, _dump(metrics or {}), error_text, utc_now(), run_id, self._workspace_id(), self._project_id()))
        return self.get_run(run_id)

    def get_run(self, run_id: str) -> Optional[Dict[str, Any]]:
        row = self._one("SELECT * FROM runs WHERE id = ? AND workspace_id = ? AND project_id = ?", (run_id, self._workspace_id(), self._project_id()))
        if not row:
            return None
        result = dict(row)
        result.pop("workspace_id", None)
        result.pop("project_id", None)
        result["metrics"] = _json(result.pop("metrics_json"), {})
        result["scoring_config"] = _json(result.pop("scoring_config_json"), {})
        result["metadata"] = _json(result.pop("metadata_json"), {})
        result["processor_version"] = self.get_processor_version(row["processor_version_id"])
        result["eval_experiment"] = self.get_eval_experiment(row["eval_experiment_id"]) if row["eval_experiment_id"] else None
        result["eval_group"] = result["eval_experiment"].get("eval_group") if result["eval_experiment"] else None
        result["dataset"] = self.get_dataset(row["dataset_id"]) if row["dataset_id"] else None
        result["extractions"] = self.list_extractions(run_id)
        result["metrics"].update(run_cost_metrics((result["processor_version"] or {}).get("model", {}), result["extractions"]))
        result["evaluations"] = self.list_evaluations(run_id)
        result["review_decisions"] = self.list_review_decisions(run_id)
        return result

    def list_runs(self) -> List[Dict[str, Any]]:
        rows = self._all("SELECT r.*, (SELECT COUNT(*) FROM extractions e WHERE e.run_id = r.id) AS extraction_count, (SELECT COUNT(*) FROM evaluations v WHERE v.run_id = r.id) AS evaluation_count FROM runs r WHERE r.workspace_id = ? AND r.project_id = ? ORDER BY r.created_at DESC", (self._workspace_id(), self._project_id()))
        result = []
        for row in rows:
            item = dict(row)
            item["metrics"] = _json(item.pop("metrics_json"), {})
            item["scoring_config"] = _json(item.pop("scoring_config_json"), {})
            item["metadata"] = _json(item.pop("metadata_json"), {})
            item["processor_version"] = self.get_processor_version(row["processor_version_id"])
            item["eval_experiment"] = self.get_eval_experiment(row["eval_experiment_id"]) if row["eval_experiment_id"] else None
            item["eval_group"] = item["eval_experiment"].get("eval_group") if item["eval_experiment"] else None
            item["dataset"] = self.get_dataset(row["dataset_id"]) if row["dataset_id"] else None
            item["extraction_count"] = int(item.pop("extraction_count", 0) or 0)
            item["evaluation_count"] = int(item.pop("evaluation_count", 0) or 0)
            cost_rows = self._all("SELECT cost_usd, usage_json, cache_hit FROM extractions WHERE run_id = ?", (item["id"],))
            item["metrics"].update(run_cost_metrics((item["processor_version"] or {}).get("model", {}), [
                {"cost_usd": e["cost_usd"], "usage": _json(e["usage_json"], {}), "cache_hit": bool(e["cache_hit"])} for e in cost_rows
            ]))
            result.append(item)
        return result

    def insert_extraction(self, extraction: Dict[str, Any]) -> Dict[str, Any]:
        self._execute("INSERT INTO extractions (id, run_id, document_id, processor_version_id, status, result_json, raw_response_json, parser_ir_json, usage_json, cost_usd, latency_ms, parser_latency_ms, model_latency_ms, cache_hit, warnings_json, error_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", (extraction["id"], extraction["run_id"], extraction["document_id"], extraction["processor_version_id"], extraction.get("status", "completed"), _dump(extraction.get("result", {})), _dump(extraction.get("raw_response", {})), _dump(extraction.get("parser_ir", {})), _dump(extraction.get("usage", {})), extraction.get("cost_usd", 0), extraction.get("latency_ms", 0), extraction.get("parser_latency_ms", 0), extraction.get("model_latency_ms", 0), 1 if extraction.get("cache_hit") else 0, _dump(extraction.get("warnings", [])), extraction.get("error_text"), extraction.get("created_at", utc_now())))
        return self.get_extraction(extraction["id"])  # type: ignore

    def insert_extraction_fields(self, extraction_id: str, fields: Dict[str, Dict[str, Any]]) -> None:
        def write(connection):
            for field_path, value in fields.items():
                connection.execute("INSERT INTO extraction_fields (id, extraction_id, field_path, value_json, normalized_value_json, confidence, evidence_json, errors_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", (new_id("field"), extraction_id, field_path, _dump(value.get("value")), _dump(value.get("normalized_value")), value.get("confidence"), _dump(value.get("evidence", [])), _dump(value.get("errors", []))))
        self._transaction(write)

    def get_extraction(self, extraction_id: str) -> Optional[Dict[str, Any]]:
        row = self._one("SELECT e.* FROM extractions e JOIN runs r ON r.id = e.run_id WHERE e.id = ? AND r.workspace_id = ? AND r.project_id = ?", (extraction_id, self._workspace_id(), self._project_id()))
        return self._extraction(row) if row else None

    def list_extractions(self, run_id: str) -> List[Dict[str, Any]]:
        rows = self._all("SELECT e.* FROM extractions e JOIN runs r ON r.id = e.run_id WHERE e.run_id = ? AND r.workspace_id = ? AND r.project_id = ? ORDER BY e.created_at", (run_id, self._workspace_id(), self._project_id()))
        return [self._extraction(row) for row in rows]

    def insert_evaluation(self, evaluation: Dict[str, Any]) -> Dict[str, Any]:
        self._execute("INSERT INTO evaluations (id, run_id, extraction_id, document_id, processor_version_id, status, metrics_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", (evaluation["id"], evaluation["run_id"], evaluation["extraction_id"], evaluation["document_id"], evaluation["processor_version_id"], evaluation.get("status", "unscored"), _dump(evaluation.get("metrics", {})), evaluation.get("created_at", utc_now())))
        return self.get_evaluation(evaluation["id"])  # type: ignore

    def insert_evaluation_fields(self, evaluation_id: str, fields: Dict[str, Dict[str, Any]]) -> None:
        def write(connection):
            for field_path, field in fields.items():
                connection.execute("INSERT INTO evaluation_fields (id, evaluation_id, field_path, status, score, match_type, expected_json, actual_json, normalized_expected_json, normalized_actual_json, confidence, failure_type, details_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", (new_id("evalf"), evaluation_id, field_path, field.get("status", "unscored"), field.get("score", 0), field.get("match_type", "none"), _dump(field.get("expected")), _dump(field.get("actual")), _dump(field.get("normalized_expected")), _dump(field.get("normalized_actual")), field.get("confidence"), field.get("failure_type"), _dump({**(field.get("details") or {}), **({"validation_errors": field.get("validation_errors")} if field.get("validation_errors") else {})})))
        self._transaction(write)

    def get_evaluation(self, evaluation_id: str) -> Optional[Dict[str, Any]]:
        row = self._one("SELECT e.* FROM evaluations e JOIN runs r ON r.id = e.run_id WHERE e.id = ? AND r.workspace_id = ? AND r.project_id = ?", (evaluation_id, self._workspace_id(), self._project_id()))
        return self._evaluation(row) if row else None

    def get_evaluation_for_extraction(self, extraction_id: str) -> Optional[Dict[str, Any]]:
        row = self._one("SELECT e.* FROM evaluations e JOIN runs r ON r.id = e.run_id WHERE e.extraction_id = ? AND r.workspace_id = ? AND r.project_id = ? ORDER BY e.created_at DESC LIMIT 1", (extraction_id, self._workspace_id(), self._project_id()))
        return self._evaluation(row) if row else None

    def list_evaluations(self, run_id: str) -> List[Dict[str, Any]]:
        rows = self._all("SELECT e.* FROM evaluations e JOIN runs r ON r.id = e.run_id WHERE e.run_id = ? AND r.workspace_id = ? AND r.project_id = ? ORDER BY e.created_at, e.id", (run_id, self._workspace_id(), self._project_id()))
        return [self._evaluation(row) for row in rows]

    def list_run_failures(self, run_id: str, status: Optional[str] = None, field_path: Optional[str] = None) -> List[Dict[str, Any]]:
        clauses = ["e.run_id = ?", "r.workspace_id = ?", "r.project_id = ?", "ef.status != 'correct'"]
        params: List[Any] = [run_id, self._workspace_id(), self._project_id()]
        if status:
            clauses.append("ef.status = ?")
            params.append(status)
        if field_path:
            clauses.append("ef.field_path = ?")
            params.append(field_path)
        rows = self._all("SELECT ef.*, e.document_id, e.extraction_id, e.status AS evaluation_status, ex.latency_ms, ex.cost_usd FROM evaluation_fields ef JOIN evaluations e ON e.id = ef.evaluation_id JOIN extractions ex ON ex.id = e.extraction_id JOIN runs r ON r.id = e.run_id WHERE {} ORDER BY e.document_id, ef.field_path".format(" AND ".join(clauses)), params)
        return [self._evaluation_field(row) for row in rows]

    def latest_extraction(self, document_id: str, processor_ref: Optional[str] = None) -> Optional[Dict[str, Any]]:
        clauses = ["e.document_id = ?", "r.workspace_id = ?", "r.project_id = ?"]
        params: List[Any] = [document_id, self._workspace_id(), self._project_id()]
        if processor_ref:
            clauses.extend(["p.workspace_id = ?", "p.project_id = ?", "(p.id = ? OR p.name = ?)"])
            params.extend([self._workspace_id(), self._project_id(), processor_ref, processor_ref])
            query = "SELECT e.* FROM extractions e JOIN runs r ON r.id = e.run_id JOIN processor_versions pv ON pv.id = e.processor_version_id JOIN processors p ON p.id = pv.processor_id WHERE {} ORDER BY e.created_at DESC LIMIT 1".format(" AND ".join(clauses))
        else:
            query = "SELECT e.* FROM extractions e JOIN runs r ON r.id = e.run_id WHERE {} ORDER BY e.created_at DESC LIMIT 1".format(" AND ".join(clauses))
        row = self._one(query, params)
        return self._extraction(row) if row else None

    def get_ground_truth(self, document_id: str) -> Optional[Dict[str, Any]]:
        if not self.get_document(document_id):
            return None
        row = self._one("SELECT * FROM ground_truth WHERE document_id = ? ORDER BY revision DESC LIMIT 1", (document_id,))
        return self._ground_truth(row) if row else None

    def list_ground_truth_revisions(self, document_id: str) -> List[Dict[str, Any]]:
        rows = self._all("SELECT * FROM ground_truth WHERE document_id = ? ORDER BY revision DESC", (document_id,))
        return [self._ground_truth(row) for row in rows]

    def save_ground_truth(self, document_id: str, value: Dict[str, Any], evidence: Optional[Dict[str, Any]] = None, annotation_status: str = "complete", author: str = "local", merge: bool = False, table_annotations: Optional[Dict[str, Any]] = None, expected_revision: Optional[int] = None) -> Dict[str, Any]:
        if expected_revision is not None and (type(expected_revision) is not int or expected_revision < 0):
            raise ValueError("expected_revision must be a nonnegative integer")
        if not isinstance(value, dict):
            raise ValueError("ground truth value must be an object")
        if not self.get_document(document_id):
            raise ValueError("Document not found: {}".format(document_id))
        def write(connection):
            current = connection.execute("SELECT revision, value_json, evidence_json, table_annotations_json FROM ground_truth WHERE document_id = ? ORDER BY revision DESC LIMIT 1", (document_id,)).fetchone()
            if expected_revision is not None and expected_revision != (int(current["revision"]) if current else 0):
                raise RevisionConflict("Expected values changed in another session. Reload them and reapply your edits.")
            value_to_save = _merge_dicts(_json(current["value_json"], {}), value) if current and merge else value
            evidence_to_save = _merge_dicts(_json(current["evidence_json"], {}), evidence or {}) if current and merge else evidence or {}
            tables_to_save = _merge_dicts(_json(current["table_annotations_json"], {}), table_annotations or {}) if current and merge else table_annotations or {}
            revision = int(current["revision"]) + 1 if current else 1
            ground_truth_id = new_id("gt")
            connection.execute("INSERT INTO ground_truth (id, document_id, revision, value_json, evidence_json, table_annotations_json, annotation_status, author, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", (ground_truth_id, document_id, revision, _dump(value_to_save), _dump(evidence_to_save), _dump(tables_to_save), annotation_status, author, utc_now()))
            return ground_truth_id
        ground_truth_id = self._transaction(write)
        row = self._one("SELECT * FROM ground_truth WHERE id = ?", (ground_truth_id,))
        return self._ground_truth(row)

    def create_review_assignment(self, dataset_id: str, document_id: str, reviewer: str = "local", status: str = "queued", note: str = "") -> Dict[str, Any]:
        now = utc_now()
        self._execute("INSERT INTO review_assignments (id, dataset_id, document_id, reviewer, status, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(dataset_id, document_id, reviewer) DO UPDATE SET status = excluded.status, note = excluded.note, updated_at = excluded.updated_at", (new_id("review"), dataset_id, document_id, reviewer, status, note, now, now))
        return self.get_review_assignment(dataset_id, document_id, reviewer)  # type: ignore

    def get_review_assignment(self, dataset_id: str, document_id: str, reviewer: str = "local") -> Optional[Dict[str, Any]]:
        row = self._one("SELECT * FROM review_assignments WHERE dataset_id = ? AND document_id = ? AND reviewer = ?", (dataset_id, document_id, reviewer))
        return dict(row) if row else None

    def list_review_assignments(self, dataset_id: str, reviewer: Optional[str] = None, status: Optional[str] = None) -> List[Dict[str, Any]]:
        clauses = ["dataset_id = ?"]
        params: List[Any] = [dataset_id]
        if reviewer:
            clauses.append("reviewer = ?")
            params.append(reviewer)
        if status:
            clauses.append("status = ?")
            params.append(status)
        return [dict(row) for row in self._all("SELECT * FROM review_assignments WHERE {} ORDER BY updated_at DESC".format(" AND ".join(clauses)), params)]

    def save_review_decision(
        self,
        run_id: str,
        document_id: str,
        field_path: str,
        status: str,
        reason: Optional[str] = None,
        corrected_value: Any = None,
        note: str = "",
        reviewer: str = "local",
        evaluation_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        allowed_statuses = {"accepted", "corrected", "ground_truth_issue", "ambiguous", "ignored"}
        if status not in allowed_statuses:
            raise ValueError("review status must be one of: {}".format(", ".join(sorted(allowed_statuses))))
        if not str(field_path or "").strip():
            raise ValueError("field_path is required")
        run = self._one(
            "SELECT id FROM runs WHERE id = ? AND workspace_id = ? AND project_id = ?",
            (run_id, self._workspace_id(), self._project_id()),
        )
        if not run:
            raise ValueError("Run not found")

        if evaluation_id:
            evaluation = self._one(
                "SELECT e.id FROM evaluations e JOIN runs r ON r.id = e.run_id JOIN evaluation_fields ef ON ef.evaluation_id = e.id WHERE e.id = ? AND e.run_id = ? AND e.document_id = ? AND ef.field_path = ? AND r.workspace_id = ? AND r.project_id = ?",
                (evaluation_id, run_id, document_id, field_path, self._workspace_id(), self._project_id()),
            )
        else:
            evaluation = self._one(
                "SELECT e.id FROM evaluations e JOIN runs r ON r.id = e.run_id JOIN evaluation_fields ef ON ef.evaluation_id = e.id WHERE e.run_id = ? AND e.document_id = ? AND ef.field_path = ? AND r.workspace_id = ? AND r.project_id = ?",
                (run_id, document_id, field_path, self._workspace_id(), self._project_id()),
            )
        if not evaluation:
            raise ValueError("Evaluation field not found for this run")

        now = utc_now()
        self._execute(
            "INSERT INTO review_decisions (id, run_id, evaluation_id, document_id, field_path, reviewer, status, reason, corrected_value_json, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(run_id, document_id, field_path, reviewer) DO UPDATE SET evaluation_id = excluded.evaluation_id, status = excluded.status, reason = excluded.reason, corrected_value_json = excluded.corrected_value_json, note = excluded.note, updated_at = excluded.updated_at",
            (
                new_id("review_decision"),
                run_id,
                evaluation["id"],
                document_id,
                field_path,
                reviewer or "local",
                status,
                reason,
                _dump(corrected_value) if corrected_value is not None else None,
                str(note or ""),
                now,
                now,
            ),
        )
        return self.get_review_decision(run_id, document_id, field_path, reviewer) or {}

    def get_review_decision(self, run_id: str, document_id: str, field_path: str, reviewer: str = "local") -> Optional[Dict[str, Any]]:
        row = self._one(
            "SELECT rd.* FROM review_decisions rd JOIN runs r ON r.id = rd.run_id WHERE rd.run_id = ? AND rd.document_id = ? AND rd.field_path = ? AND rd.reviewer = ? AND r.workspace_id = ? AND r.project_id = ?",
            (run_id, document_id, field_path, reviewer, self._workspace_id(), self._project_id()),
        )
        return self._review_decision(row) if row else None

    def list_review_decisions(
        self,
        run_id: str,
        reviewer: Optional[str] = None,
        document_id: Optional[str] = None,
        field_path: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        clauses = ["rd.run_id = ?", "r.workspace_id = ?", "r.project_id = ?"]
        params: List[Any] = [run_id, self._workspace_id(), self._project_id()]
        if reviewer:
            clauses.append("rd.reviewer = ?")
            params.append(reviewer)
        if document_id:
            clauses.append("rd.document_id = ?")
            params.append(document_id)
        if field_path:
            clauses.append("rd.field_path = ?")
            params.append(field_path)
        rows = self._all(
            "SELECT rd.* FROM review_decisions rd JOIN runs r ON r.id = rd.run_id WHERE {} ORDER BY rd.updated_at DESC".format(" AND ".join(clauses)),
            params,
        )
        return [self._review_decision(row) for row in rows]

    def get_extraction_cache(self, cache_key: str) -> Optional[Dict[str, Any]]:
        row = self._one("SELECT * FROM extraction_cache WHERE cache_key = ? AND workspace_id = ? AND project_id = ?", (cache_key, self._workspace_id(), self._project_id()))
        if not row:
            return None
        result = dict(row)
        for source, target, default in (("result_json", "result", {}), ("raw_response_json", "raw_response", {}), ("parser_ir_json", "parser_ir", {}), ("usage_json", "usage", {}), ("warnings_json", "warnings", [])):
            result[target] = _json(result.pop(source), default)
        self._execute("UPDATE extraction_cache SET last_hit_at = ?, hit_count = hit_count + 1 WHERE cache_key = ?", (utc_now(), cache_key))
        return result

    def put_extraction_cache(self, cache_key: str, document_sha256: str, processor_version_id: str, extraction: Dict[str, Any]) -> None:
        self._execute("INSERT INTO extraction_cache (cache_key, workspace_id, project_id, processor_version_id, document_sha256, result_json, raw_response_json, parser_ir_json, usage_json, cost_usd, latency_ms, warnings_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET result_json = excluded.result_json, raw_response_json = excluded.raw_response_json, parser_ir_json = excluded.parser_ir_json, usage_json = excluded.usage_json, cost_usd = excluded.cost_usd, latency_ms = excluded.latency_ms, warnings_json = excluded.warnings_json", (cache_key, self._workspace_id(), self._project_id(), processor_version_id, document_sha256, _dump(extraction.get("result", {})), _dump(extraction.get("raw_response", {})), _dump(extraction.get("parser_ir", {})), _dump(extraction.get("usage", {})), extraction.get("cost_usd", 0), extraction.get("latency_ms", 0), _dump(extraction.get("warnings", [])), utc_now()))


    @staticmethod
    def _document(row: sqlite3.Row) -> Dict[str, Any]:
        result = dict(row)
        result.pop("workspace_id", None)
        result.pop("project_id", None)
        result["metadata"] = _json(result.pop("metadata_json", "{}"), {})
        if "tags_json" in result:
            result["tags"] = _json(result.pop("tags_json"), [])
        dataset_names = result.pop("dataset_names", None)
        result["datasets"] = dataset_names.split("||") if dataset_names else []
        revision = result.pop("ground_truth_revision", None)
        status = result.pop("ground_truth_status", None)
        result["ground_truth"] = {"revision": int(revision), "annotation_status": status} if revision is not None else None
        result.setdefault("split", None)
        return result

    @staticmethod
    def _document_folder(row: sqlite3.Row) -> Dict[str, Any]:
        path = row["path"]
        trimmed = path.rstrip("/")
        return {
            "id": row["id"],
            "path": path,
            "name": trimmed.rsplit("/", 1)[-1],
            "parent_path": trimmed.rsplit("/", 1)[0] + "/" if "/" in trimmed else "",
            "created_at": row["created_at"],
        }

    @staticmethod
    def _processor_version(row: sqlite3.Row) -> Dict[str, Any]:
        result = dict(row)
        for source, target, default in (("schema_json", "schema", {}), ("prompt_json", "prompt", {}), ("parser_json", "parser", {}), ("model_json", "model", {}), ("harness_json", "harness", {}), ("normalization_json", "normalization", {})):
            result[target] = _json(result.pop(source), default)
        return result

    @staticmethod
    def _processor_draft(row: sqlite3.Row, processor_name: Optional[str] = None) -> Dict[str, Any]:
        result = dict(row)
        for source, target, default in (("schema_json", "schema", {}), ("prompt_json", "prompt", {}), ("parser_json", "parser", {}), ("model_json", "model", {}), ("harness_json", "harness", {}), ("normalization_json", "normalization", {})):
            result[target] = _json(result.pop(source), default)
        if processor_name:
            result["processor_name"] = processor_name
        return result

    @staticmethod
    def _ground_truth(row: sqlite3.Row) -> Dict[str, Any]:
        result = dict(row)
        result["value"] = _json(result.pop("value_json"), {})
        result["evidence"] = _json(result.pop("evidence_json"), {})
        result["table_annotations"] = _json(result.pop("table_annotations_json", "{}"), {})
        return result

    def _extraction(self, row: sqlite3.Row) -> Dict[str, Any]:
        result = dict(row)
        for source, target, default in (("result_json", "result", {}), ("raw_response_json", "raw_response", {}), ("parser_ir_json", "parser_ir", {}), ("usage_json", "usage", {}), ("warnings_json", "warnings", [])):
            result[target] = _json(result.pop(source), default)
        result["cache_hit"] = bool(result.get("cache_hit"))
        result["processor_version"] = self.get_processor_version(row["processor_version_id"])
        result["fields"] = {}
        for field in self._all("SELECT * FROM extraction_fields WHERE extraction_id = ? ORDER BY field_path", (row["id"],)):
            result["fields"][field["field_path"]] = {"provenance": (result.get("result", {}).get("fields", {}).get(field["field_path"], {}).get("provenance") or {}), "value": _json(field["value_json"], None), "normalized_value": _json(field["normalized_value_json"], None), "confidence": field["confidence"], "evidence": _json(field["evidence_json"], []), "errors": _json(field["errors_json"], [])}
        evaluation = self.get_evaluation_for_extraction(row["id"])
        if evaluation:
            result["evaluation"] = evaluation
        return result

    def _evaluation(self, row: sqlite3.Row) -> Dict[str, Any]:
        result = dict(row)
        result["metrics"] = _json(result.pop("metrics_json"), {})
        result["fields"] = {}
        for field in self._all("SELECT * FROM evaluation_fields WHERE evaluation_id = ? ORDER BY field_path", (row["id"],)):
            item = {"field_path": field["field_path"], "status": field["status"], "score": field["score"], "match_type": field["match_type"], "expected": _json(field["expected_json"], None), "actual": _json(field["actual_json"], None), "normalized_expected": _json(field["normalized_expected_json"], None), "normalized_actual": _json(field["normalized_actual_json"], None), "confidence": field["confidence"], "failure_type": field["failure_type"], "details": _json(field["details_json"], {})}
            if item["details"].get("validation_errors"):
                item["validation_errors"] = item["details"]["validation_errors"]
            result["fields"][field["field_path"]] = item
        return result

    @staticmethod
    def _evaluation_field(row: sqlite3.Row) -> Dict[str, Any]:
        result = dict(row)
        for source, target, default in (("expected_json", "expected", None), ("actual_json", "actual", None), ("normalized_expected_json", "normalized_expected", None), ("normalized_actual_json", "normalized_actual", None), ("details_json", "details", {})):
            result[target] = _json(result.pop(source), default)
        if result["details"].get("validation_errors"):
            result["validation_errors"] = result["details"]["validation_errors"]
        return result

    @staticmethod
    def _review_decision(row: sqlite3.Row) -> Dict[str, Any]:
        result = dict(row)
        result["corrected_value"] = _json(result.pop("corrected_value_json"), None)
        return result


def create_database(database_url: str, sqlite_path: Optional[Path] = None, workspace_id: str = "ws_local", project_id: str = "project_local") -> Database:
    if not database_url.startswith("sqlite://"):
        raise ValueError("Only SQLite is supported by the local workbench")
    return Database(sqlite_path or Path(database_url[len("sqlite://"):]), workspace_id, project_id)
