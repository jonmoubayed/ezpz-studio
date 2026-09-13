"""Persist Notice-specific datasets and frozen experiments via Studio's API."""
import json
from pathlib import Path

from .cuad import digest


def import_notice(api, bundle, output, progress=print):
    api.request("GET", "/ready")
    docs = bundle["documents"]
    tag = bundle["fingerprint"][:12]
    dataset_ids = {name: "ds_notice_" + tag + "_" + name for name in ("all", "dev", "holdout", "regression")}
    groups = {
        "all": ("Notice · all 60 documents", docs),
        "dev": ("Notice · vendor contracts · development", [d for d in docs if d["cohort"] == "real" and d["split"] == "dev"]),
        "holdout": ("Notice · vendor contracts · holdout", [d for d in docs if d["cohort"] == "real" and d["split"] == "test"]),
        "regression": ("Notice · authored edge cases", [d for d in docs if d["cohort"] == "regression"]),
    }
    existing = {d["sha256"]: d for d in api.request("GET", "/documents")["documents"]}

    def expected(d):
        return {"value": d["value"], "evidence": {**d["evidence"], "_notice_benchmark": bundle["fingerprint"]},
                "annotation_status": "complete" if d["cohort"] == "regression" else "partial", "author": "Notice benchmark source review"}

    def check(old, new, title):
        if not old:
            return
        if old.get("value") == new["value"] and old.get("evidence") == new["evidence"]:
            return
        # Migration of the earlier machine-imported CUAD references is allowed
        # only at untouched revision 1. The API retains that revision verbatim.
        if old.get("author") == "CUAD v1 import" and old.get("revision") == 1 and (old.get("evidence") or {}).get("_cuad"):
            return
        raise ValueError("Ground truth was edited for {}. It was preserved; review this conflict before importing.".format(title))

    # Preflight all existing annotations and memberships before writes.
    for d in docs:
        if d["sha256"] in existing:
            old = api.request("GET", "/documents/{}/ground-truth".format(existing[d["sha256"]]["id"]))["ground_truth"]
            check(old, expected(d), d["title"])
    memberships = {}
    for key, (_, members) in groups.items():
        current = api.request("GET", "/datasets/" + dataset_ids[key])
        memberships[key] = {d["sha256"]: d for d in current["documents"]} if current else {}
        planned = {d["sha256"]: d for d in members}
        if any(sha not in planned or d["split"] != planned[sha]["split"] for sha, d in memberships[key].items()):
            raise ValueError("Notice dataset membership changed; existing edits were preserved")
    config = bundle["processor"]
    config_hash = digest(config)[:12]
    processor_id = "proc_notice_" + config_hash
    current_processor = api.request("GET", "/processors/" + processor_id)
    if current_processor and not any(all(v.get(k) == value for k, value in config.items()) for v in current_processor["processor"]["versions"]):
        raise ValueError("Notice processor configuration differs from this import")
    for key, (name, members) in groups.items():
        if not api.request("GET", "/datasets/" + dataset_ids[key]):
            api.request("POST", "/datasets", {"id": dataset_ids[key], "name": name,
                "description": "{} documents. Notice's 17 production fields. {} Unknown references are unscored. Source and review provenance are in the benchmark bundle.".format(len(members), "Authored fictional regression cases; report separately from real contracts." if key == "regression" else "Real vendor contracts sourced from CUAD, with Notice-specific partial references." if key != "all" else "50 real contracts plus 10 authored regression cases.")})
    imported = []
    uploaded = revised = 0
    for index, d in enumerate(docs):
        stored = existing.get(d["sha256"])
        if not stored:
            stored = api.upload(Path(d["path"]), d["sha256"])
            uploaded += 1
        doc_id = stored["id"]
        old = api.request("GET", "/documents/{}/ground-truth".format(doc_id))["ground_truth"]
        new = expected(d)
        check(old, new, d["title"])
        if not old or old.get("value") != new["value"] or old.get("evidence") != new["evidence"]:
            api.request("POST", "/documents/{}/ground-truth".format(doc_id), new)
            revised += 1
        target = "regression" if d["cohort"] == "regression" else "holdout" if d["split"] == "test" else "dev"
        for key in ("all", target):
            if d["sha256"] not in memberships[key]:
                api.request("POST", "/datasets/{}/documents".format(dataset_ids[key]), {"document_id": doc_id, "split": d["split"]})
                api.request("POST", "/datasets/{}/documents".format(dataset_ids[key]), {"document_id": doc_id, "tags": ["Notice", d["kind"], d["cohort"]]})
        imported.append({"id": doc_id, "title": d["title"], "cohort": d["cohort"], "split": d["split"], "sha256": d["sha256"]})
        if (index + 1) % 10 == 0:
            progress("Notice: verified {} / {} documents".format(index + 1, len(docs)))
    if not current_processor:
        current_processor = api.request("POST", "/processors", {"id": processor_id, "name": "Notice · production extractor · " + config_hash,
            "description": "Notice's real provider, PDF input, 17-field schema and validation. Edit System prompt, publish a version, and compare within the same cohort. OpenAI only; source code drift is detected.", "config": config})
    versions = current_processor["processor"]["versions"]
    version = next((v for v in versions if v["status"] == "published" and all(v.get(k) == val for k, val in config.items())), None)
    if not version:
        draft = api.request("GET", "/processors/{}/draft".format(processor_id))["draft"]
        if any(draft.get(k) != value for k, value in config.items()):
            raise ValueError("Notice draft changed; refusing to publish someone else's edits")
        version = api.request("POST", "/processors/{}/draft/publish".format(processor_id), {})["version"]
    experiments = {}
    for key in ("dev", "holdout", "regression"):
        group_id = "eval_group_" + dataset_ids[key]
        exp_id = "exp_notice_" + tag + "_" + key + "_" + config_hash
        exps = api.request("GET", "/eval-groups/{}/experiments".format(group_id))["experiments"]
        found = next((e for e in exps if e["id"] == exp_id), None)
        if found and found["processor_version_id"] != version["id"]:
            raise ValueError("Existing experiment has a different processor snapshot")
        if not found:
            api.request("POST", "/eval-groups/{}/experiments".format(group_id), {"id": exp_id, "name": "Notice baseline",
                "processor_version_id": version["id"], "description": "Unrun baseline using Notice's production extraction code. " + ("Fictional regression cases, not a real-world accuracy estimate." if key == "regression" else "Score only reference fields supported by the reviewed source.")})
        experiments[key] = {"group_id": group_id, "experiment_id": exp_id}
    for key, (_, members) in groups.items():
        current = api.request("GET", "/datasets/" + dataset_ids[key])["documents"]
        if {d["sha256"] for d in current} != {d["sha256"] for d in members}:
            raise ValueError("Notice membership verification failed")
    for stored, d in zip(imported, docs):
        gold = api.request("GET", "/documents/{}/ground-truth".format(stored["id"]))["ground_truth"]
        if not gold or gold["value"] != d["value"] or gold["evidence"] != expected(d)["evidence"]:
            raise ValueError("Notice ground-truth verification failed")
    result = {"fingerprint": bundle["fingerprint"], "datasets": dataset_ids, "processor_id": processor_id,
              "processor_version_id": version["id"], "experiments": experiments, "documents": imported,
              "uploaded": uploaded, "new_ground_truth_revisions": revised, "model_runs_started": 0}
    Path(output, "import-result.json").write_text(json.dumps(result, indent=2) + "\n")
    return result
