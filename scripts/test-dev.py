#!/usr/bin/env python3
"""Exercise the source development command using a disposable workspace."""

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.request import ProxyHandler, Request, build_opener

ROOT = Path(__file__).resolve().parents[1]
opener = build_opener(ProxyHandler({}))


def wait_for(predicate, process, log, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise AssertionError(log.read_text())
        try:
            if predicate():
                return
        except (OSError, ValueError):
            pass
        time.sleep(0.1)
    raise AssertionError("Development server timed out:\n" + log.read_text())


def request(path, value=None, method=None, headers=None):
    # Exercise the browser's origin and the Vite proxy, including Settings writes.
    req = Request("http://127.0.0.1:5180" + path, method=method,
                  data=json.dumps(value).encode() if value is not None else None,
                  headers={"Content-Type": "application/json", "Origin": "http://127.0.0.1:5180",
                           "Sec-Fetch-Site": "same-origin", **(headers or {})})
    with opener.open(req, timeout=2) as response:
        return response.read()


def main():
    with tempfile.TemporaryDirectory(prefix="ezpz-dev-test-") as directory:
        root = Path(directory)
        log = root / "dev.log"
        workspace = root / "workspace"
        workspace.mkdir()
        env = {key: value for key, value in os.environ.items()
               if not key.startswith(("EZPZ_", "VITE_", "PYTHON")) and key != "DATABASE_URL"}
        env["EZPZ_SEED_DEMO"] = "false"
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        command = [sys.executable, str(ROOT / "scripts/dev.py"), "--root", str(workspace), "--port", str(port)]
        probe = None
        with log.open("w") as output:
            process = subprocess.Popen(command, cwd=root, env=env, stdout=output, stderr=output)
            try:
                wait_for(lambda: json.loads(request("/v1/ready"))["ok"], process, log)
                assert b"/@vite/client" in request("/"), "UI is not served by Vite"
                assert b"createRoot" in request("/src/main.tsx"), "Source frontend was not served"
                dataset = json.loads(request("/v1/datasets", {"name": "Dev persistence"}))["dataset"]
                settings = {"X-Ezpz-Settings": "1"}
                request("/v1/settings/credentials/openai", {"api_key": "dev-test-placeholder"}, headers=settings)
                request("/v1/settings/credentials/openai", method="DELETE", headers=settings)

                # Add/remove a harmless source file rather than changing the user's code.
                with tempfile.NamedTemporaryFile(prefix="_dev_reload_", suffix=".py", dir=ROOT / "backend", delete=False) as source:
                    probe = Path(source.name)
                    source.write(b"# Development reload probe.\n")
                wait_for(lambda: log.read_text().count("ezpz running at") >= 2, process, log)
                wait_for(lambda: json.loads(request("/v1/ready"))["ok"], process, log)
                (workspace / "ezpz.yaml").write_text("# Config reload probe.\n")
                wait_for(lambda: log.read_text().count("ezpz running at") >= 3, process, log)
                wait_for(lambda: json.loads(request("/v1/ready"))["ok"], process, log)
                datasets = json.loads(request("/v1/datasets"))["datasets"]
                assert any(item["id"] == dataset["id"] for item in datasets), "Reload lost saved data"
            finally:
                process.terminate()
                try:
                    process.wait(timeout=40)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                    raise AssertionError("Dev supervisor did not stop:\n" + log.read_text())
                if probe is not None:
                    probe.unlink(missing_ok=True)
        assert process.returncode == 0, log.read_text()
        for server_port in (port, 5180):
            with socket.socket() as sock:
                assert sock.connect_ex(("127.0.0.1", server_port)) != 0, "Dev server left a child running"
        # An occupied API port must fail early without starting a frontend.
        with socket.socket() as occupied:
            occupied.bind(("127.0.0.1", 0))
            occupied.listen()
            result = subprocess.run(command[:-1] + [str(occupied.getsockname()[1])],
                                    cwd=root, env=env, capture_output=True, text=True, timeout=10)
            assert result.returncode != 0 and "is in use" in result.stderr, result.stderr
        print("PASS: Vite source UI, API/Settings proxy, Python/config reloads, data persistence, shutdown, occupied-port error.")


if __name__ == "__main__":
    main()
