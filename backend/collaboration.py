"""Shared API support for agents and Studio: revisions, candidates and durable jobs."""

import hashlib
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from contextvars import copy_context

from .models import new_id, utc_now


class RevisionConflict(ValueError):
    """The caller edited an older snapshot. No mutation was applied."""


CONFIG_KEYS = ("schema", "prompt", "parser", "model", "harness", "normalization")


def initialize_collaboration(connection):
    columns = {r["name"] for r in connection.execute("PRAGMA table_info(processor_versions)")}
    if "author" not in columns:
        connection.execute("ALTER TABLE processor_versions ADD COLUMN author TEXT NOT NULL DEFAULT 'local'")
    connection.execute("CREATE TABLE IF NOT EXISTS workspace_revision (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL)")
    connection.execute("INSERT OR IGNORE INTO workspace_revision VALUES (1, 0)")
    connection.execute("""CREATE TABLE IF NOT EXISTS agent_jobs (
        id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, payload_json TEXT NOT NULL,
        status TEXT NOT NULL, result_json TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )""")
    # Triggers include changes made through the CLI and other database connections.
    tables = [r["name"] for r in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")]
    for table in tables:
        if table == "workspace_revision" or table.startswith("sqlite_"):
            continue
        quoted = '"' + table.replace('"', '""') + '"'
        for action in ("INSERT", "UPDATE", "DELETE"):
            trigger = '"revision_' + table.replace('"', '""') + '_' + action + '"'
            connection.execute(f"CREATE TRIGGER IF NOT EXISTS {trigger} AFTER {action} ON {quoted} BEGIN UPDATE workspace_revision SET revision = revision + 1 WHERE id = 1; END")


def save_candidate(database, processor_ref, config, expected_version, author="local", status="draft"):
    """Append an immutable version without touching anyone's shared draft."""
    if type(expected_version) is not int or expected_version < 1:
        raise ValueError("expected_version must be the latest version number read from the processor")
    if not isinstance(config, dict) or set(config) - set(CONFIG_KEYS):
        raise ValueError("config must contain only schema, prompt, parser, model, harness, normalization")
    if any(not isinstance(value, dict) for value in config.values()):
        raise ValueError("Each configuration section must be an object")
    if status not in {"draft", "published"}:
        raise ValueError("status must be draft or published")
    processor = database.get_processor(processor_ref)
    if not processor:
        raise ValueError("Processor not found")
    version_id = new_id("pv")

    def write(connection):
        latest = connection.execute("SELECT * FROM processor_versions WHERE processor_id = ? ORDER BY version DESC LIMIT 1", (processor["id"],)).fetchone()
        if not latest or latest["version"] != expected_version:
            raise RevisionConflict("Processor changed in another session. Reload its versions and reapply your changes.")
        values = {key: config.get(key, json.loads(latest[key + "_json"])) for key in CONFIG_KEYS}
        if values["schema"].get("type") != "object" or not isinstance(values["schema"].get("properties", {}), dict):
            raise ValueError("schema must be an object JSON Schema with properties")
        if values["harness"].get("name") == "workflow":
            from .harness_catalog import validate_workflow
            validate_workflow(values["harness"], values["schema"])
        connection.execute(
            "INSERT INTO processor_versions (id, processor_id, version, status, schema_json, prompt_json, parser_json, model_json, harness_json, normalization_json, created_at, immutable, author) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)",
            (version_id, processor["id"], expected_version + 1, status, *(json.dumps(values[key], allow_nan=False) for key in CONFIG_KEYS), utc_now(), author),
        )

    database._transaction(write)
    return database.get_processor_version(version_id)


def benchmark_fingerprint(database, dataset_id):
    snapshot = []
    for doc in sorted(database.list_dataset_documents(dataset_id), key=lambda d: d["id"]):
        truth = database.get_ground_truth(doc["id"])
        snapshot.append([doc["id"], doc["sha256"], doc.get("split"), doc.get("tags"), truth])
    return hashlib.sha256(json.dumps(snapshot, sort_keys=True).encode()).hexdigest()


class AgentJobs:
    """Bounded execution in the API process; reconnecting MCP clients can recover results."""

    def __init__(self, runtime):
        self.runtime = runtime
        self.pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="ezpz-agent")
        self.lock = threading.Lock()

    def recover(self):
        self.runtime.database._execute("UPDATE agent_jobs SET status = 'interrupted', error = 'API restarted. Inspect any saved runs before starting a new job.', updated_at = ? WHERE status IN ('queued', 'running')", (utc_now(),))
        self.runtime.database._execute("UPDATE runs SET status = 'interrupted', error_text = 'API restarted during agent evaluation' WHERE status IN ('running', 'cancelling') AND json_extract(metadata_json, '$.agent_job_id') IN (SELECT id FROM agent_jobs WHERE status = 'interrupted')")

    def shutdown(self):
        self.pool.shutdown(wait=True)

    def get(self, job_id):
        row = self.runtime.database._one("SELECT * FROM agent_jobs WHERE id = ?", (job_id,))
        if not row:
            raise ValueError("Agent job not found")
        job = dict(row)
        job["result"] = json.loads(job.pop("result_json") or "null")
        job["request"] = json.loads(job.pop("payload_json"))
        # The evaluation can continue in Studio after the submitting worker exits.
        # Also expose the run while that worker is still executing its first call.
        saved = self.runtime.database._one("SELECT id FROM runs WHERE json_extract(metadata_json, '$.agent_job_id') = ? ORDER BY created_at DESC LIMIT 1", (job_id,))
        run = self.runtime.database.get_run(saved["id"]) if saved else None
        if run:
            job["result"] = {**(job["result"] or {}), "run_id": run["id"], "status": run["status"],
                             "metrics": run.get("metrics", {}), "failures": run.get("metrics", {}).get("failures", []),
                             "warning_count": sum(len(e.get("warnings", [])) for e in run.get("extractions", []))}
            # Never hide a failed submission/benchmark consistency check.
            # While running, the worker still owns the final consistency check.
            if job["status"] not in ("failed", "queued", "running"):
                job["status"] = run["status"]
                job["error"] = run.get("error_text")
        return job

    def start(self, payload):
        key = payload.get("request_key")
        if not isinstance(key, str) or not key.strip() or len(key) > 200:
            raise ValueError("request_key is required (reuse it only when retrying the same request)")
        db = self.runtime.database
        body = json.dumps(payload, sort_keys=True, allow_nan=False)
        with self.lock:
            existing = db._one("SELECT id, payload_json FROM agent_jobs WHERE request_key = ?", (key,))
            if existing:
                if existing["payload_json"] != body:
                    raise RevisionConflict("request_key was already used with different arguments")
                return self.get(existing["id"])
            if not db.get_dataset(payload.get("dataset_id", "")):
                raise ValueError("Dataset not found")
            if type(payload.get("version")) is not int or payload["version"] < 1:
                raise ValueError("An explicit positive processor version is required")
            if not isinstance(payload.get("scoring_config", {}), dict):
                raise ValueError("scoring_config must be an object")
            version = db.resolve_processor_version(payload.get("processor", ""), payload.get("version"))
            if not version:
                raise ValueError("Processor version not found")
            if db._one("SELECT COUNT(*) AS n FROM agent_jobs WHERE status IN ('queued', 'running')")["n"] >= 8:
                raise ValueError("Agent job queue is full; wait for existing jobs to finish")
            job_id = new_id("job")
            now = utc_now()
            db._execute("INSERT INTO agent_jobs (id, request_key, payload_json, status, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?)", (job_id, key, body, now, now))
            fingerprint = benchmark_fingerprint(db, payload["dataset_id"])
            self.pool.submit(copy_context().run, self._execute, job_id, payload, version, fingerprint)
            return self.get(job_id)

    def _execute(self, job_id, payload, version, fingerprint):
        db = self.runtime.database
        result = None
        try:
            db._execute("UPDATE agent_jobs SET status = 'running', updated_at = ? WHERE id = ?", (utc_now(), job_id))
            if benchmark_fingerprint(db, payload["dataset_id"]) != fingerprint:
                raise ValueError("Benchmark changed while queued. Start a new job against the updated dataset.")
            result = self.runtime.extractions.run_dataset(
                payload["dataset_id"], version["processor_id"], version["version"],
                scoring_config=payload.get("scoring_config") or {},
                metadata={"author": payload.get("author", "mcp"), "agent_job_id": job_id, "agent_benchmark_fingerprint": fingerprint},
                force_refresh=True,
            )
            run = result.get("run") or result
            summary = {"run_id": run.get("id"), "status": run.get("status"), "metrics": run.get("metrics"), "warning_count": sum(len(e.get("warnings", [])) for e in run.get("extractions", [])), "failures": result.get("failures", []), "benchmark_fingerprint": fingerprint}
            db._execute("UPDATE agent_jobs SET result_json = ? WHERE id = ?", (json.dumps(summary), job_id))
            if run.get("status") in ("paused", "interrupted", "cancelled"):
                db._execute("UPDATE agent_jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?", (run["status"], run.get("error_text"), utc_now(), job_id))
                return
            if benchmark_fingerprint(db, payload["dataset_id"]) != fingerprint:
                raise ValueError("Benchmark changed during evaluation. Results are saved, but rerun before comparing.")
            if run.get("status") != "completed":
                raise ValueError(run.get("error_text") or "Evaluation did not complete; inspect the saved run")
            db._execute("UPDATE agent_jobs SET status = 'completed', updated_at = ? WHERE id = ?", (utc_now(), job_id))
        except Exception as error:
            db._execute("UPDATE agent_jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?", (str(error), utc_now(), job_id))
            # A provider can fail after creating a run. Preserve a route to that
            # partial result even when run_dataset raised instead of returning.
            if result is None:
                saved = db._one("SELECT id, status FROM runs WHERE json_extract(metadata_json, '$.agent_job_id') = ? ORDER BY created_at DESC LIMIT 1", (job_id,))
                if saved:
                    db._execute("UPDATE agent_jobs SET result_json = ? WHERE id = ?", (json.dumps({"run_id": saved["id"], "status": saved["status"]}), job_id))


class CollaborationHandler:
    def _get_collaboration(self, path, query):
        if path == "/v1/harnesses":
            from .harness_catalog import catalog
            self._json(200, catalog())
            return True
        if path == "/v1/workspace/revision":
            self._json(200, {"revision": self.runtime.database._one("SELECT revision FROM workspace_revision WHERE id = 1")["revision"], "agent_api_version": 1, "capabilities": ["harnesses", "run_steps", "resumable_evaluations"]})
            return True
        if path.startswith("/v1/agent/jobs/"):
            self._json(200, {"job": self.runtime.agent_jobs.get(path.rsplit("/", 1)[1])})
            return True
        return False

    def _post_collaboration(self, path):
        if path == "/v1/harnesses/validate":
            from .harness_catalog import validate_workflow
            payload, _ = self._request_payload()
            self._json(200, validate_workflow(payload.get("harness"), payload.get("schema")))
            return True
        if path == "/v1/agent/jobs":
            payload, _ = self._request_payload()
            self._json(202, {"job": self.runtime.agent_jobs.start(payload)})
            return True
        parts = self._parts(path)
        if len(parts) == 3 and parts[0] == "processors" and parts[2] == "versions":
            payload, _ = self._request_payload()
            version = save_candidate(self.runtime.database, parts[1], payload.get("config"), payload.get("expected_version"), payload.get("author", "local"), payload.get("status", "draft"))
            self._json(201, {"version": version})
            return True
        return False
