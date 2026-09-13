#!/usr/bin/env python3
"""Install a release outside the checkout and verify real work survives reinstall."""

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import venv
import zipfile
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import ProxyHandler, Request, build_opener


def start_studio(cli, root, env, log, timeout=120):
    """Include cold Python imports in a bounded startup deadline, with diagnostics."""
    started = time.monotonic()
    process = subprocess.Popen([str(cli), "studio", "--no-open", "--port", "0"],
                               cwd=root, env=env, stdout=log, stderr=log)
    try:
        while True:
            log.flush()
            content = Path(log.name).read_text(errors="replace")
            code = process.poll()
            if code is not None:
                raise AssertionError(f"Packaged launcher exited with status {code}:\n{content}")
            match = re.search(r"Studio is ready at (http://127\.0\.0\.1:\d+)/", content)
            if match:
                print(f"Installed Studio ready after {time.monotonic() - started:.1f}s", flush=True)
                return process, match[1]
            if time.monotonic() - started >= timeout:
                raise AssertionError(f"Packaged launcher did not become ready within {timeout}s. Import/startup log:\n{content}")
            time.sleep(0.1)
    except BaseException:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("wheel", type=Path)
    args = parser.parse_args()
    wheel = args.wheel.resolve(strict=True)
    with zipfile.ZipFile(wheel) as archive:
        prefix = "backend/studio/"
        manifest_path = prefix + "studio-manifest.json"
        manifest = json.loads(archive.read(manifest_path))
        shipped = {name[len(prefix):] for name in archive.namelist() if name.startswith(prefix) and not name.endswith("/")}
        assert shipped == set(manifest["files"]) | {"studio-manifest.json"}, "Wheel contains stale or missing assets"
    opener = build_opener(ProxyHandler({}))
    with tempfile.TemporaryDirectory(prefix="ezpz-install-") as directory:
        root = Path(directory)
        environment = root / "installation"
        venv.EnvBuilder(with_pip=True).create(environment)
        bin_dir = environment / ("Scripts" if os.name == "nt" else "bin")
        python = bin_dir / ("python.exe" if os.name == "nt" else "python")
        cli = bin_dir / ("ezpz.exe" if os.name == "nt" else "ezpz")
        env = {key: value for key, value in os.environ.items() if not (
            key.startswith(("EZPZ_", "VITE_", "PYTHON", "OPENAI_", "ANTHROPIC_", "GOOGLE_", "GEMINI_", "LLAMA_"))
            or key == "DATABASE_URL"
        )}
        env.update({"EZPZ_WORKSPACE": str(root / "saved-workspace"), "EZPZ_SEED_DEMO": "false"})
        install = [str(python), "-m", "pip", "install", "--disable-pip-version-check"]
        subprocess.run(install + [str(wheel)], cwd=root, env=env, check=True)
        runtime_env = {**env, "PATH": str(bin_dir), "PYTHONUNBUFFERED": "1",
                       "PYTHONPROFILEIMPORTTIME": "1"}
        assert shutil.which("node", path=runtime_env["PATH"]) is None
        assert shutil.which("docker", path=runtime_env["PATH"]) is None

        def request(base, path, value=None):
            req = Request(base + path, data=json.dumps(value).encode() if value is not None else None,
                          headers={"Content-Type": "application/json"})
            with opener.open(req, timeout=30) as response:
                return json.load(response)

        def start(log):
            return start_studio(cli, root, runtime_env, log)

        def stop(process):
            process.terminate()
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
                raise AssertionError("Launcher did not stop")
            if os.name != "nt":
                assert process.returncode == 0, process.returncode

        with (root / "first.log").open("w") as log:
            process, base = start(log)
            try:
                assert request(base, "/v1/ready")["ok"]
                assert {"harnesses", "run_steps", "resumable_evaluations"} <= set(request(base, "/v1/workspace/revision")["capabilities"])
                assert request(base, "/v1/workspaces")["workspaces"]
                assert request(base, "/v1/settings/credentials")["providers"]
                assert request(base, "/v1/hill-climbs")["hill_climbs"] == []
                assert request(base, "/v1/harnesses")
                subprocess.run([str(python), "-c", "from backend.notice_harness import run; assert callable(run)"], cwd=root, env=runtime_env, check=True)
                assert request(base, "/v1/documents")["documents"] == []
                with opener.open(base) as response:
                    html = response.read().decode()
                assert '<div id="root">' in html
                manifest = request(base, "/studio-manifest.json")
                assert manifest["application"] == "ezpz-live-studio"
                assert "vendor/pdfium.wasm" in manifest["files"]
                for name, checksum in manifest["files"].items():
                    with opener.open(base + "/" + quote(name, safe="/")) as response:
                        assert hashlib.sha256(response.read()).hexdigest() == checksum, name
                # Actual multipart upload, annotation, processor, and evaluation; no hosted model calls.
                document_bytes = b"Invoice # INV-1042\nTotal due $80.00\nCurrency USD\n"
                body = (b'--test-upload\r\nContent-Disposition: form-data; name="file"; filename="invoice.txt"\r\n'
                        b'Content-Type: text/plain\r\n\r\n' + document_bytes + b'\r\n--test-upload--\r\n')
                upload = Request(base + "/v1/documents", data=body,
                                 headers={"Content-Type": "multipart/form-data; boundary=test-upload"})
                with opener.open(upload) as response:
                    document = json.load(response)["document"]
                doc_id = document["id"]
                expected = {"total": 80, "invoice_number": "INV-1042"}
                request(base, f"/v1/documents/{doc_id}/ground-truth", {"value": expected})
                dataset = request(base, "/v1/datasets", {"name": "Installation benchmark"})["dataset"]
                request(base, f'/v1/datasets/{dataset["id"]}/documents', {"document_id": doc_id})
                processor = request(base, "/v1/processors", {
                    "name": "installation-check", "config": {
                        "schema": {"type": "object", "properties": {"total": {"type": "number"}, "invoice_number": {"type": "string"}}},
                        "parser": {"name": "native"}, "model": {"provider": "local", "name": "deterministic-local"},
                    },
                })["processor"]
                result = request(base, "/v1/runs", {"dataset_id": dataset["id"], "processor": processor["id"]})
                run = result["run"]
                assert run["status"] == "completed", run
                assert run["metrics"]["field_accuracy"] == 1, run["metrics"]
                assert run["metadata"]["benchmark_snapshot"]["fingerprint"]
                for path in ["/.ezpz/ezpz.db", "/.env"]:
                    try:
                        opener.open(base + path)
                        raise AssertionError("Workspace file was served: " + path)
                    except HTTPError as error:
                        assert error.code in (403, 404)
            finally:
                stop(process)

        subprocess.run(install + ["--force-reinstall", "--no-deps", str(wheel)], cwd=root, env=env, check=True)
        with (root / "reinstalled.log").open("w") as log:
            process, base = start(log)
            try:
                assert request(base, "/v1/documents")["documents"][0]["id"] == doc_id
                assert request(base, f"/v1/documents/{doc_id}/ground-truth")["ground_truth"]["value"] == expected
                assert request(base, f'/v1/runs/{run["id"]}')["run"]["status"] == "completed"
                assert request(base, f'/v1/processors/{processor["id"]}')["processor"]["name"] == "installation-check"
                with opener.open(base + f"/v1/documents/{doc_id}/source") as response:
                    assert response.read() == document_bytes
                assert (root / "saved-workspace" / ".ezpz" / "ezpz.db").exists()
                assert not list(environment.rglob("ezpz.db")), "Data was written inside the installation"
            finally:
                stop(process)
        print("PASS: source-free launch without Node/Docker, bundled live frontend, upload, evaluation, and workspace data preserved after reinstall.")


if __name__ == "__main__":
    main()
