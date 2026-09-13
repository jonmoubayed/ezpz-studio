"""Bounded, persistent hill climbing over prompt edits on a frozen benchmark."""

import json
import math
import threading
from contextvars import copy_context
from copy import deepcopy

from .models import new_id, utc_now
from .hill_analysis import compare, diagnose, passes, plan_candidate, validate_plan
from .adapters import normalize_model_config

ACTIVE = ("running", "stopping")
CONFIG_KEYS = ("schema", "prompt", "parser", "model", "harness", "normalization")



def valid_score(run):
    value = run.get("metrics", {}).get("field_accuracy")
    if run.get("status") != "completed" or isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= 1:
        raise ValueError("A complete evaluation with scored expected values is required. Inspect the run errors or add annotations before continuing.")
    return value


class HillClimbing:
    def __init__(self, database, extractions):
        self.db = database
        self.extractions = extractions
        self.lock = threading.RLock()
        self.jobs = {}
        self.db._execute("""CREATE TABLE IF NOT EXISTS hill_climbs (
            id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_id TEXT NOT NULL,
            status TEXT NOT NULL, state_json TEXT NOT NULL, created_at TEXT NOT NULL)""")

    def recover(self):
        # Called only after the server binds. Never resume paid work on restart.
        self.db._execute("UPDATE hill_climbs SET status = 'interrupted' WHERE status IN ('running', 'stopping')")

    def _decode(self, row):
        job = json.loads(row["state_json"])
        job["status"] = row["status"]
        if row["status"] == "interrupted":
            job["reason"] = "Server restarted. The loop was interrupted; completed runs and the best result are saved."
        return job

    def get(self, job_id):
        row = self.db._one("SELECT * FROM hill_climbs WHERE id = ? AND workspace_id = ? AND project_id = ?",
                           (job_id, self.db._workspace_id(), self.db._project_id()))
        return self._decode(row) if row else None

    def list(self):
        rows = self.db._all("SELECT * FROM hill_climbs WHERE workspace_id = ? AND project_id = ? ORDER BY created_at DESC LIMIT 30",
                            (self.db._workspace_id(), self.db._project_id()))
        return [self._decode(row) for row in rows]

    def _save(self, job):
        with self.lock:
            self.db._execute("UPDATE hill_climbs SET status = ?, state_json = ? WHERE id = ? AND workspace_id = ? AND project_id = ?",
                             (job["status"], json.dumps(job), job["id"], self.db._workspace_id(), self.db._project_id()))

    def start(self, payload):
        if not isinstance(payload, dict):
            raise ValueError("Hill-climbing options must be an object")
        job_id = str(payload.get("request_id") or new_id("hill"))
        with self.lock:
            existing = self.get(job_id)
            if existing:
                return existing
            if any(job["status"] in ACTIVE for job in self.list()):
                raise ValueError("A hill-climbing loop is already active. Stop it or wait for it to finish.")
            options = {}
            for key, default, maximum in [("max_candidates", 5, 20), ("patience", 2, 10), ("confirmation_pairs", 1, 3)]:
                value = payload.get(key, default)
                if type(value) is not int or not 1 <= value <= maximum:
                    raise ValueError(f"{key} must be an integer between 1 and {maximum}")
                options[key] = value
            gain = payload.get("min_gain", .005)
            if isinstance(gain, bool) or not isinstance(gain, (int, float)) or not math.isfinite(gain) or not 0 < gain <= 1:
                raise ValueError("min_gain must be greater than zero and at most 1")
            regressions = payload.get("max_regressions", 2)
            if type(regressions) is not int or not 0 <= regressions <= 1000:
                raise ValueError("max_regressions must be an integer between 0 and 1000")
            options.update(min_gain=gain, max_regressions=regressions)
            optimizer_name = payload.get("optimizer_model", "")
            if not isinstance(optimizer_name, str) or len(optimizer_name) > 200:
                raise ValueError("optimizer_model must be a model name")
            options["optimizer_model"] = optimizer_name.strip()
            budget = payload.get("max_cost_usd")
            if budget is not None and (isinstance(budget, bool) or not isinstance(budget, (int, float)) or not math.isfinite(budget) or budget <= 0):
                raise ValueError("Cost limit must be a positive number")
            options["max_cost_usd"] = budget
            dataset_id = str(payload.get("dataset_id") or "")
            if not self.db.get_dataset(dataset_id):
                raise ValueError("Choose an existing benchmark dataset")
            baseline = None
            if payload.get("baseline_run_id"):
                baseline = self.db.get_run(str(payload["baseline_run_id"]))
                if not baseline or baseline.get("dataset_id") != dataset_id:
                    raise ValueError("The baseline must belong to this dataset")
                score = valid_score(baseline)
                snapshot = baseline.get("metadata", {}).get("benchmark_snapshot")
                if not snapshot or not snapshot.get("documents") or not snapshot.get("fingerprint"):
                    raise ValueError("The baseline has no frozen benchmark. Run a new baseline first.")
                for saved in snapshot["documents"]:
                    document = self.db.get_document(saved["id"])
                    if not document or document.get("sha256") != saved.get("sha256"):
                        raise ValueError("A frozen benchmark document was removed or changed. Establish a new baseline.")
                config = baseline.get("processor_version")
                if not config:
                    raise ValueError("The baseline configuration is unavailable")
            else:
                config = payload.get("config")
                if not isinstance(config, dict) or not isinstance(config.get("schema"), dict) or config["schema"].get("type") != "object" or not config["schema"].get("properties"):
                    raise ValueError("Configure an object schema with fields before starting")
                if not all(isinstance(config.get(key, {}), dict) for key in CONFIG_KEYS):
                    raise ValueError("Invalid processor configuration")
                documents = self.db.snapshot_dataset(dataset_id)
                if not documents or not any(d.get("ground_truth", {}).get("value") for d in documents if d.get("ground_truth")):
                    raise ValueError("Add documents and expected values before starting")
                snapshot, score = None, None
            if not self.extractions.background_slots.acquire(blocking=False):
                raise ValueError("An evaluation is already running. Wait for it to finish before starting the loop.")
            try:
                group_id = (baseline.get("eval_group") or {}).get("id") if baseline else None
                if not group_id:
                    groups = [g for g in self.db.list_eval_groups() if g["dataset_id"] == dataset_id]
                    group_id = (groups[0] if groups else self.db.create_eval_group("Hill climbing " + job_id, dataset_id=dataset_id))["id"]
                job = {"id": job_id, "version": 2, "dataset_id": dataset_id, "group_id": group_id, "status": "running",
                       "created_at": utc_now(), "options": options, "baseline_run_id": baseline["id"] if baseline else None,
                       "best_run_id": baseline["id"] if baseline else None, "baseline_score": score, "best_score": score,
                       "active_run_id": None, "iterations": [], "planner_calls": [], "spent_usd": 0.0, "cost_complete": True,
                       "phase": "preparing", "evaluation_count": 0, "diagnosis": None,
                       "reason": "Preparing the loop", "stalled": 0}
                self.db._execute("INSERT INTO hill_climbs VALUES (?, ?, ?, ?, ?, ?)",
                                 (job_id, self.db._workspace_id(), self.db._project_id(), job["status"], json.dumps(job), job["created_at"]))
                self.jobs[job_id] = job
                context = copy_context()
                thread = threading.Thread(target=lambda: context.run(self._execute, job, deepcopy(config), baseline, deepcopy(snapshot)), daemon=True, name="ezpz-hill-climbing")
                thread.start()
            except Exception:
                if job_id in self.jobs:
                    self._finish(self.jobs.pop(job_id), "Could not start the loop worker.", "failed")
                self.extractions.background_slots.release()
                raise
            return deepcopy(job)

    def stop(self, job_id):
        with self.lock:
            if not self.get(job_id):
                return None
            job = self.jobs.get(job_id)
            if job and job["status"] in ACTIVE:
                job["status"] = "stopping"
                job["reason"] = "Stopping after the in-flight provider call. No further candidates will start."
                if job["active_run_id"]:
                    self.db.cancel_run(job["active_run_id"])
                self._save(job)
            return self.get(job_id)

    def _finish(self, job, reason, status="completed"):
        with self.lock:
            if job["status"] == "stopping":
                status, reason = "stopped", "Stopped by you. The best completed result is saved."
            job.update(status=status, phase="finished", reason=reason, active_run_id=None, completed_at=utc_now())
            self._save(job)

    def _run(self, job, config, snapshot, entry, attempt=None):
        with self.lock:
            if job["status"] != "running":
                return None
            # An isolated processor preserves the user's published versions and draft.
            processor = self.db.insert_processor(f"Hill climb {job['id']} · {entry['index']}", "Automatic prompt experiment")
            version = self.db.insert_processor_version({**{key: deepcopy(config.get(key, {})) for key in CONFIG_KEYS},
                "id": new_id("pv"), "processor_id": processor["id"], "version": 1, "status": "published"})
            experiment = self.db.create_eval_experiment(job["group_id"], version["id"], f"{entry['title']} · {job['id']} · {entry['index']}")
            entry.update(status="running", parent_run_id=job["best_run_id"], started_at=utc_now())
            if attempt is None:
                job["iterations"].append(entry)
            else:
                attempt.setdefault("verification_runs", []).append(entry)
            job["evaluation_count"] += 1
            job["phase"] = entry.get("phase", "screening")
            job["reason"] = "Evaluating " + entry["title"]
            self._save(job)
        def created(run):
            with self.lock:
                job["active_run_id"] = entry["run_id"] = run["id"]
                if job["status"] == "stopping":
                    self.db.cancel_run(run["id"])
                self._save(job)
        result = self.extractions.run_dataset(job["dataset_id"], processor["id"], 1,
            scoring_config=job.get("scoring_config", {}), metadata={"name": entry["title"], "hill_climb_id": job["id"], "hill_climb_phase": entry.get("phase", "screening") },
            force_refresh=True, eval_experiment_id=experiment["id"], frozen_benchmark=snapshot, on_created=created, _slot_held=True)
        run = result["run"]
        with self.lock:
            cost = run.get("metrics", {}).get("cost_usd")
            self._add_cost(job, cost)
            entry.update(run_id=run["id"], cost_usd=cost, score=run.get("metrics", {}).get("field_accuracy"), completed_at=utc_now())
            job["active_run_id"] = None
            if job["status"] == "stopping" or run["status"] == "cancelled":
                entry["status"] = "cancelled"
                job["status"] = "stopping"
            elif run["status"] != "completed":
                entry["status"] = "failed"
            self._save(job)
        return run

    def _add_cost(self, job, cost):
        if cost is None or isinstance(cost, bool) or not isinstance(cost, (float, int)) or not math.isfinite(cost) or cost < 0:
            job["cost_complete"] = False
        else:
            job["spent_usd"] += cost

    def _can_continue(self, job, estimate=0):
        if job["status"] != "running":
            self._finish(job, "Stopped")
            return False
        budget = job["options"]["max_cost_usd"]
        if budget is not None:
            if not job["cost_complete"]:
                self._finish(job, "Cost is unavailable; stopped because the cost threshold cannot be checked.")
                return False
            if job["spent_usd"] >= budget or job["spent_usd"] + (estimate or 0) > budget:
                self._finish(job, "Cost threshold reached or insufficient estimated budget for the next evaluation.")
                return False
        return True

    @staticmethod
    def _check_run(run, snapshot):
        valid_score(run)
        if run.get("metadata", {}).get("benchmark_snapshot", {}).get("fingerprint") != snapshot["fingerprint"]:
            raise ValueError("Benchmark changed. Candidate was not accepted.")

    def _execute(self, job, config, baseline, snapshot):
        entry = None
        try:
            job["scoring_config"] = deepcopy(baseline.get("scoring_config", {})) if baseline else {}
            optimizer = normalize_model_config(config.get("model", {}))
            if job["options"]["optimizer_model"]:
                optimizer["name"] = job["options"]["optimizer_model"]
                optimizer.pop("pricing", None)
            # Credentials and endpoints remain inside the adapter config, never in job JSON.
            job["optimizer"] = {"provider": optimizer.get("provider"), "name": optimizer.get("name")}
            if not baseline:
                baseline = self._run(job, config, None, {"index": 0, "title": "Initial baseline", "prompt": "", "phase": "baseline"})
                if not baseline or job["status"] == "stopping":
                    return self._finish(job, "Stopped")
                score = valid_score(baseline)
                snapshot = baseline["metadata"]["benchmark_snapshot"]
                job.update(baseline_run_id=baseline["id"], best_run_id=baseline["id"], baseline_score=score, best_score=score)
                job["iterations"][-1]["status"] = "baseline"
                self._save(job)
            best = baseline
            tried = set()
            history = []
            for index in range(1, job["options"]["max_candidates"] + 1):
                if not self._can_continue(job):
                    return
                diagnosis = diagnose(best)
                job.update(diagnosis=diagnosis, phase="diagnosing", reason="Diagnosing recurring errors and generating a concrete prompt edit")
                self._save(job)
                if diagnosis["failed"] == 0:
                    return self._finish(job, "All scored benchmark fields passed.")
                call = {"index": index, "parent_run_id": best["id"], "status": "running", "started_at": utc_now()}
                job["planner_calls"].append(call)
                self._save(job)
                def usage(tokens, cost):
                    with self.lock:
                        call.update(usage=tokens, cost_usd=cost)
                        self._add_cost(job, cost)
                        self._save(job)
                planned = plan_candidate(best["processor_version"], diagnosis, history, optimizer, usage, credential_resolver=self.extractions.credential_resolver)
                call.update(status="completed" if planned.get("model_called", True) else "unavailable", completed_at=utc_now(), summary=planned["summary"], concerns=planned["concerns"])
                if not planned.get("model_called", True):
                    call["cost_usd"] = 0
                self._save(job)
                if not self._can_continue(job):
                    return
                if not planned["plans"]:
                    return self._finish(job, planned["summary"] or "No evidence-supported untried prompt changes remain.")
                proposal = planned["plans"][0]
                candidate_config, signature = validate_plan(proposal, best["processor_version"], diagnosis, tried)
                tried.add(signature)
                estimate = best.get("metrics", {}).get("cost_usd")
                if not self._can_continue(job, estimate):
                    return
                entry = {"index": index, **proposal, "prompt": "\n\n".join(c["after"] for c in proposal["changes"]),
                         "parent_score": job["best_score"], "phase": "screening", "diagnosis": diagnosis,
                         "verification_runs": [], "comparisons": [], "decision": "Evaluating the proposed change"}
                candidate = self._run(job, candidate_config, snapshot, entry)
                if not candidate or job["status"] == "stopping":
                    return self._finish(job, "Stopped")
                self._check_run(candidate, snapshot)
                paired = compare(best, candidate)
                entry.update(comparison=paired, delta=paired["gain"])
                improved = passes(paired, job["options"])
                verified = [candidate]
                entry["decision"] = "Screening gain or regression limit did not pass."
                if improved:
                    entry.update(status="verifying", decision="Promising screening result; checking fresh baseline and candidate repeats")
                    self._save(job)
                    for repeat in range(1, job["options"]["confirmation_pairs"] + 1):
                        for role, repeat_config in (("baseline", best["processor_version"]), ("candidate", candidate_config)):
                            if not self._can_continue(job, estimate):
                                entry.update(status="unverified", decision="Verification was not completed; the previous best is retained.")
                                self._save(job)
                                return
                            repeat_entry = {"index": f"{index}.{repeat}.{role}", "title": f"Confirmation {repeat} · {role}", "phase": "confirming_" + role}
                            result = self._run(job, repeat_config, snapshot, repeat_entry, entry)
                            if not result or job["status"] == "stopping":
                                entry.update(status="unverified", decision="Stopped during verification; the previous best is retained.")
                                return self._finish(job, "Stopped")
                            self._check_run(result, snapshot)
                            repeat_entry["status"] = "completed"
                            if role == "baseline":
                                control = result
                            else:
                                verified.append(result)
                                repeat_comparison = compare(control, result)
                                against_saved = compare(best, result)
                                entry["comparisons"].append({"round": repeat, "baseline_run_id": control["id"], "candidate_run_id": result["id"],
                                    "paired": repeat_comparison, "against_saved": against_saved, "baseline_drift": compare(best, control)})
                                improved = passes(repeat_comparison, job["options"]) and passes(against_saved, job["options"])
                            self._save(job)
                        if not improved:
                            entry["decision"] = "The gain or regression limit did not hold on fresh repeat evaluations."
                            break
                with self.lock:
                    # Stop can arrive after the final provider call but before promotion.
                    if job["status"] != "running":
                        entry.update(status="unverified", decision="Stopped before promotion; the previous best is retained.")
                        return self._finish(job, "Stopped")
                    entry["status"] = "accepted" if improved else "rejected"
                    if improved:
                        # Retain the weakest observed candidate run, not its luckiest score.
                        best = min(verified, key=valid_score)
                        entry.update(accepted_run_id=best["id"], confirmed_score=valid_score(best), decision="Minimum gain and regression limits passed screening and every confirmation pair.")
                        job.update(best_run_id=best["id"], best_score=valid_score(best), stalled=0)
                    else:
                        job["stalled"] += 1
                    history.append({key: entry.get(key) for key in ("title", "rationale", "changes", "status", "decision", "comparison", "comparisons")})
                    self._save(job)
                if job["stalled"] >= job["options"]["patience"]:
                    return self._finish(job, f"Stopped after {job['stalled']} candidates without improvement.")
            self._finish(job, "Candidate limit reached.")
        except Exception as error:
            with self.lock:
                for attempt in job["iterations"]:
                    for run_entry in [attempt] + attempt.get("verification_runs", []):
                        if run_entry["status"] in ("running", "verifying"):
                            run_entry.update(status="failed", decision="Evaluation or verification failed; the previous best is retained.")
                for call in job["planner_calls"]:
                    if call["status"] == "running":
                        call.update(status="failed", error=str(error))
                        if "cost_usd" not in call:
                            job["cost_complete"] = False
                if job["active_run_id"]:
                    self.db.finish_run(job["active_run_id"], "failed", error_text=str(error))
            self._finish(job, str(error), "failed")
        finally:
            self.extractions.background_slots.release()
            with self.lock:
                self.jobs.pop(job["id"], None)
