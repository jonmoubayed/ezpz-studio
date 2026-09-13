"""Import prepared CUAD bundles through Studio's local public API."""

import json
import mimetypes
import re
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

from .cuad import digest, file_hash


class LocalStudio:
    def __init__(self, base_url="http://127.0.0.1:4173"):
        parsed = urllib.parse.urlparse(base_url)
        if parsed.scheme != "http" or parsed.hostname not in {"localhost", "127.0.0.1", "::1"} or parsed.username or parsed.password or parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
            raise ValueError("Use a local Studio API origin, for example http://127.0.0.1:4173")
        self.base_url = base_url.rstrip("/")

    def request(self, method, path, payload=None, body=None, content_type="application/json"):
        if payload is not None:
            body = json.dumps(payload).encode()
        request = urllib.request.Request(self.base_url + "/v1" + path, data=body, method=method, headers={"Content-Type": content_type})
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            if method == "GET" and error.code == 404:
                return None
            raise RuntimeError("Studio {} {} failed (HTTP {})".format(method, path, error.code)) from error
        except urllib.error.URLError as error:
            raise RuntimeError("Cannot reach local Studio at {}. Start it with npm start.".format(self.base_url)) from error

    def upload(self, path, expected_sha):
        # Recheck at the last moment rather than importing a source modified
        # between preparation and upload. No ground truth travels with the PDF.
        if file_hash(path) != expected_sha:
            raise ValueError("Source PDF changed since preparation: " + str(path))
        boundary = "cuad_" + uuid.uuid4().hex
        name = re.sub(r"[^A-Za-z0-9._ -]", "_", Path(path).name)
        mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
        body = ('--{}\r\nContent-Disposition: form-data; name="file"; filename="{}"\r\nContent-Type: {}\r\n\r\n'.format(boundary, name, mime)).encode()
        body += Path(path).read_bytes() + ("\r\n--{}--\r\n".format(boundary)).encode()
        return self.request("POST", "/documents", body=body, content_type="multipart/form-data; boundary=" + boundary)["document"]


def ground_truth_payload(document, fingerprint):
    return {
        "value": document["value"],
        "evidence": {**document["evidence"], "_cuad": {
            "fingerprint": fingerprint, "title": document["title"],
            "pdf_sha256": document["pdf_sha256"],
            "raw_labels_sha256": digest([document["qas"], document["csv_row"]]),
        }},
        "annotation_status": "complete", "author": "CUAD v1 import",
    }


def check_ground_truth(existing, expected, title):
    if existing and (existing.get("value") != expected["value"] or existing.get("evidence") != expected["evidence"]):
        raise ValueError("Existing ground truth differs for {}. No labels were overwritten; review the conflict or import into a separate workspace.".format(title))


def import_bundle(api, bundle, output, progress=print):
    if not api.request("GET", "/ready").get("ok"):
        raise RuntimeError("Studio is not ready")
    documents = bundle["documents"]
    fingerprint = bundle["fingerprint"]
    prefix = "cuad_" + fingerprint[:12]
    all_id, dev_id, test_id = ["ds_" + prefix + "_" + part for part in ("all", "dev", "test")]
    existing_docs = {d["sha256"]: d for d in api.request("GET", "/documents")["documents"]}
    targets = [
        (all_id, "CUAD renewals · {} documents".format(len(documents)), documents),
        (dev_id, "CUAD renewals · development", [d for d in documents if d["split"] == "dev"]),
        (test_id, "CUAD renewals · holdout", [d for d in documents if d["split"] == "test"]),
    ]
    # Preflight all conflicts before writes. Import can safely resume after a
    # transport failure; existing labels/configurations are never replaced.
    memberships = {}
    for dataset_id, _, members in targets:
        current = api.request("GET", "/datasets/" + dataset_id)
        memberships[dataset_id] = {d["sha256"]: d for d in current["documents"]} if current else {}
        planned = {d["pdf_sha256"]: d for d in members}
        for sha, current_doc in memberships[dataset_id].items():
            if sha not in planned or current_doc["split"] != planned[sha]["split"]:
                raise ValueError("Dataset membership/split was edited: " + dataset_id)
    for document in documents:
        path = Path(bundle["source_root"]) / document["pdf_path"]
        if file_hash(path) != document["pdf_sha256"]:
            raise ValueError("Source PDF changed: " + str(path))
        existing = existing_docs.get(document["pdf_sha256"])
        if existing:
            truth = api.request("GET", "/documents/{}/ground-truth".format(existing["id"]))["ground_truth"]
            check_ground_truth(truth, ground_truth_payload(document, fingerprint), document["title"])
    config = bundle["processor"]
    config_hash = digest(config)
    processor_id = "proc_" + prefix + "_" + config_hash[:8]
    current_processor = api.request("GET", "/processors/" + processor_id)
    version = None
    if current_processor:
        versions = current_processor["processor"]["versions"]
        matching = [v for v in versions if all(v.get(k) == value for k, value in config.items())]
        if not matching:
            raise ValueError("Imported processor configuration differs; existing edits were preserved")
        version = next((v for v in matching if v["status"] == "published"), matching[0])

    for dataset_id, name, members in targets:
        if not api.request("GET", "/datasets/" + dataset_id):
            api.request("POST", "/datasets", {
                "id": dataset_id, "name": name,
                "description": "{} contracts. CUAD v1 / The Atticus Project / CC-BY-4.0. Seven renewal-related fields; ambiguous answers remain unscored. Fingerprint {}. {}".format(len(members), fingerprint, "Tune prompts on development only; reserve holdout for final evaluation."),
            })
    imported = []
    uploaded = 0
    for index, document in enumerate(documents, start=1):
        source = Path(bundle["source_root"]) / document["pdf_path"]
        stored = existing_docs.get(document["pdf_sha256"])
        if not stored:
            stored = api.upload(source, document["pdf_sha256"])
            uploaded += 1
        if stored["sha256"] != document["pdf_sha256"]:
            raise ValueError("Uploaded document hash mismatch")
        doc_id = stored["id"]
        expected = ground_truth_payload(document, fingerprint)
        truth = api.request("GET", "/documents/{}/ground-truth".format(doc_id))["ground_truth"]
        check_ground_truth(truth, expected, document["title"])
        if not truth:
            api.request("POST", "/documents/{}/ground-truth".format(doc_id), expected)
        for dataset_id in (all_id, test_id if document["split"] == "test" else dev_id):
            if document["pdf_sha256"] not in memberships[dataset_id]:
                api.request("POST", "/datasets/{}/documents".format(dataset_id), {"document_id": doc_id, "split": document["split"]})
        imported.append({"document_id": doc_id, "title": document["title"], "sha256": document["pdf_sha256"], "split": document["split"]})
        if index % 10 == 0 or index == len(documents):
            progress("Imported/verified {} of {} contracts".format(index, len(documents)))
    if not current_processor:
        created = api.request("POST", "/processors", {
            "id": processor_id, "name": "CUAD renewal extraction · {} · {}".format(config["model"]["name"], config_hash[:8]),
            "description": "Seven renewal fields from CUAD. Edit the prompt and publish a new version to compare experiments. No Notice financial/seat fields are inferred.",
            "config": config,
        })
        version = created["processor"]["versions"][0]
    if version["status"] != "published":
        # Check the draft before publishing so a resumed import cannot publish
        # someone's intervening prompt edits as the original baseline.
        draft_result = api.request("GET", "/processors/{}/draft".format(processor_id))
        if draft_result and draft_result.get("draft") and any(draft_result["draft"].get(k) != value for k, value in config.items()):
            raise ValueError("Processor draft changed; refusing to publish it as the CUAD baseline")
        version = api.request("POST", "/processors/{}/draft/publish".format(processor_id), {})["version"]
    experiments = {}
    for dataset_id, split in ((dev_id, "dev"), (test_id, "test")):
        # Studio creates an evaluation group alongside each dataset.
        group_id = "eval_group_" + dataset_id
        experiment_id = "exp_" + prefix + "_" + split + "_" + config_hash[:8]
        existing = api.request("GET", "/eval-groups/{}/experiments".format(group_id))["experiments"]
        experiment = next((e for e in existing if e["id"] == experiment_id), None)
        if experiment and experiment["processor_version_id"] != version["id"]:
            raise ValueError("Baseline experiment configuration was changed")
        if not experiment:
            api.request("POST", "/eval-groups/{}/experiments".format(group_id), {
                "id": experiment_id, "processor_version_id": version["id"],
                "name": "Renewal extraction baseline", "description": "Unrun starting prompt. {}".format("Use this set to develop prompts." if split == "dev" else "Run only after choosing the prompt on development documents."),
            })
        experiments[split] = {"group_id": group_id, "experiment_id": experiment_id}
    # Verify the completed import from persisted API data, not local counters.
    for dataset_id, _, members in targets:
        current = api.request("GET", "/datasets/" + dataset_id)["documents"]
        if {d["sha256"] for d in current} != {d["pdf_sha256"] for d in members}:
            raise ValueError("Dataset verification failed: " + dataset_id)
    for entry, document in zip(imported, documents):
        truth = api.request("GET", "/documents/{}/ground-truth".format(entry["document_id"]))["ground_truth"]
        if not truth:
            raise ValueError("Ground truth missing after import")
        check_ground_truth(truth, ground_truth_payload(document, fingerprint), document["title"])
    result = {"fingerprint": fingerprint, "api_url": api.base_url, "uploaded": uploaded, "verified_documents": len(imported),
              "datasets": {"all": all_id, "dev": dev_id, "test": test_id}, "processor_id": processor_id,
              "processor_version_id": version["id"], "experiments": experiments, "documents": imported,
              "model_runs_started": 0}
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    (output / "import-result.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    return result
