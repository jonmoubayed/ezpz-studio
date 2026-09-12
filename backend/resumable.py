"""Local evaluation ownership and recovery. No browser or process-local job state required."""

import json
import os
import threading
from contextvars import copy_context
from pathlib import Path


class EvaluationInterrupted(RuntimeError):
    """Work can continue from its persisted checkpoint."""


def transient_error(error):
    import urllib.error
    seen = set()
    while error and id(error) not in seen:
        seen.add(id(error))
        if isinstance(error, urllib.error.HTTPError):
            return error.code in (408, 429) or error.code >= 500
        if isinstance(error, (EvaluationInterrupted, TimeoutError, ConnectionError, urllib.error.URLError)):
            return True
        error = error.__cause__ or error.__context__
    return False


class RunLock:
    """OS-owned lock: released on process death, retained during laptop sleep."""

    def __init__(self, path):
        self.path = Path(path)
        self.file = None

    def acquire(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        handle = self.path.open("a+b")
        try:
            if os.name == "nt":
                import msvcrt
                handle.seek(0)
                if not handle.read(1):
                    handle.write(b"0")
                    handle.flush()
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            handle.close()
            return False
        self.file = handle
        return True

    def release(self):
        if self.file:
            if os.name == "nt":
                import msvcrt
                self.file.seek(0)
                msvcrt.locking(self.file.fileno(), msvcrt.LK_UNLCK, 1)
            self.file.close()
            self.file = None


class EvaluationRecovery:
    def __init__(self, service):
        self.service = service
        self.db = service.database
        self.directory = self.db.path.parent / "evaluation-state"
        self.directory.mkdir(parents=True, exist_ok=True)
        self.db._execute("""CREATE TABLE IF NOT EXISTS run_documents (
            run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
            document_id TEXT NOT NULL,
            status TEXT NOT NULL, error TEXT, PRIMARY KEY (run_id, document_id))""")
        self.stopping = threading.Event()

    def lock(self, run_id):
        # IDs originate in the database; hashing also keeps API input out of paths.
        import hashlib
        return RunLock(self.directory / (hashlib.sha256(run_id.encode()).hexdigest() + ".lock"))

    def recover_abandoned(self):
        for row in self.db._all("SELECT id, status FROM runs WHERE target_type = 'dataset' AND status IN ('running', 'pausing', 'cancelling')"):
            lock = self.lock(row["id"])
            if not lock.acquire():
                continue
            try:
                status = "cancelled" if row["status"] == "cancelling" else "paused" if row["status"] == "pausing" else "interrupted"
                self.db._execute("UPDATE runs SET status = ?, error_text = ? WHERE id = ? AND status = ?",
                                 (status, "Execution stopped. Resume to continue saved progress." if status == "interrupted" else None, row["id"], row["status"]))
            finally:
                lock.release()

    def check(self, run_id):
        row = self.db._one("SELECT status FROM runs WHERE id = ?", (run_id,))
        if self.stopping.is_set() or not row or row["status"] != "running":
            raise EvaluationInterrupted("Execution paused at a saved step.")

    def control(self, run_id, action):
        run = self.db.get_run(run_id)
        if not run or run["target_type"] != "dataset":
            raise ValueError("Evaluation run not found")
        if action == "resume":
            if run["status"] not in ("paused", "interrupted"):
                raise ValueError("Only paused or interrupted evaluations can resume")
            snapshot = run.get("metadata", {}).get("benchmark_snapshot", {})
            if not snapshot.get("documents"):
                raise ValueError("This older run has no frozen benchmark and cannot safely resume")
            version = run["processor_version"]
            documents = []
            for saved in snapshot["documents"]:
                document = self.db.get_document(saved["id"])
                if not document or document["sha256"] != saved["sha256"]:
                    raise ValueError("A saved source document is missing or changed")
                documents.append(document)
            return self.dispatch(run, documents, version["processor_id"], version["version"],
                                 run["scoring_config"], run["metadata"].get("fresh_extraction", True), True, resume=True)["run"]
        if action == "pause":
            self.db._execute("UPDATE runs SET status = 'pausing' WHERE id = ? AND status = 'running'", (run_id,))
        elif action == "cancel":
            self.db._execute("UPDATE runs SET status = CASE WHEN status IN ('paused', 'interrupted') THEN 'cancelled' ELSE 'cancelling' END WHERE id = ? AND status IN ('running', 'pausing', 'paused', 'interrupted')", (run_id,))
        else:
            raise ValueError("Unknown evaluation action")
        return self.db.get_run(run_id)

    def dispatch(self, run, documents, processor_ref, version, scoring_config, force_refresh, background, resume=False):
        lock = self.lock(run["id"])
        if not lock.acquire():
            raise ValueError("This evaluation already has an active worker")
        if resume and not self.service.background_slots.acquire(blocking=False):
            lock.release()
            raise ValueError("Another evaluation is running; pause it before resuming this one")
        if resume:
            self.db._execute("UPDATE runs SET status = 'running', error_text = NULL, completed_at = NULL WHERE id = ?", (run["id"],))
        def execute():
            try:
                return self.service._execute_dataset_run(run, documents, processor_ref, version, scoring_config, force_refresh)
            except Exception as error:
                self.db._execute("UPDATE runs SET status = 'interrupted', error_text = ? WHERE id = ?", (str(error), run["id"]))
                return {"run": self.db.get_run(run["id"]), "results": [], "failures": []}
            finally:
                lock.release()
                if background:
                    self.service.background_slots.release()
        if background:
            context = copy_context()
            threading.Thread(target=lambda: context.run(execute), daemon=True, name="ezpz-evaluation").start()
            return {"run": self.db.get_run(run["id"]), "results": [], "failures": []}
        return execute()

    def outcome(self, run_id, document_id, status, error=None):
        self.db._execute("INSERT INTO run_documents (run_id, document_id, status, error) VALUES (?, ?, ?, ?) ON CONFLICT(run_id, document_id) DO UPDATE SET status = excluded.status, error = excluded.error", (run_id, document_id, status, error))

    def outcomes(self, run_id):
        return {row["document_id"]: dict(row) for row in self.db._all("SELECT * FROM run_documents WHERE run_id = ?", (run_id,))}

    def interrupted_status(self, run_id, error):
        current = self.db._one("SELECT status FROM runs WHERE id = ?", (run_id,))["status"]
        status = "cancelled" if current == "cancelling" else "paused" if current == "pausing" else "interrupted"
        self.db._execute("UPDATE runs SET status = ?, error_text = ? WHERE id = ?", (status, str(error) if status == "interrupted" else None, run_id))
        return status
