#!/usr/bin/env python3
"""Run live Studio from source, with Vite HMR and Python/config reloads."""

import argparse
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend.paths import default_workspace_root


def snapshot(workspace):
    # Do not watch databases, blobs, generated assets, or node_modules.
    paths = [*ROOT.glob("*.py"), *(ROOT / "backend").rglob("*.py"),
             workspace / ".env", workspace / "ezpz.yaml"]
    result = {}
    for path in paths:
        try:
            stat = path.stat()
            result[path] = (stat.st_mtime_ns, stat.st_size)
        except FileNotFoundError:
            pass
    return result


def stop(process, backend=False):
    if process is None or process.poll() is not None:
        return
    # Both children are launched directly, without npm/shell wrapper processes.
    if backend:
        process.send_signal(signal.CTRL_BREAK_EVENT if os.name == "nt" else signal.SIGINT)
    else:
        process.terminate()
    try:
        process.wait(timeout=15)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=default_workspace_root(),
                        help="workspace directory (same default as the installed Studio)")
    parser.add_argument("--port", type=int, default=int(os.environ.get("EZPZ_PORT", "4173")),
                        help="backend port; the live frontend stays on port 5180")
    args = parser.parse_args()
    workspace = args.root.expanduser().resolve()
    node = shutil.which("node")
    vite = ROOT / "node_modules/vite/bin/vite.js"
    if not node or not vite.is_file():
        parser.error("Install Node.js 24 and run: npm ci")
    try:
        import PIL, pypdf, yaml  # noqa: F401 -- fail before starting either service
    except ImportError:
        parser.error("Install dependencies with this Python: python -m pip install -r requirements.lock")
    if not 1 <= args.port <= 65535 or args.port == 5180:
        parser.error("Backend port must be 1–65535 and different from the frontend port 5180.")
    for port in (args.port, 5180):
        try:
            with socket.socket() as probe:
                if os.name != "nt":
                    probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                probe.bind(("127.0.0.1", port))
        except OSError:
            parser.error(f"Port {port} is in use. Stop the other Studio/dev server first.")

    env = {**os.environ, "PYTHONUNBUFFERED": "1",
           "EZPZ_API_URL": f"http://127.0.0.1:{args.port}"}
    process_options = ({"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
                       if os.name == "nt" else {"start_new_session": True})

    def start_backend():
        return subprocess.Popen(
            [sys.executable, "-m", "backend.server", "--root", str(workspace),
             "--host", "127.0.0.1", "--port", str(args.port)],
            cwd=ROOT, env=env, **process_options,
        )

    stopping = False

    def request_stop(*_):
        nonlocal stopping
        stopping = True

    previous = {sig: signal.signal(sig, request_stop) for sig in (signal.SIGINT, signal.SIGTERM)}
    backend = frontend = None
    try:
        watched = snapshot(workspace)
        backend = start_backend()
        frontend = subprocess.Popen(
            [node, str(vite), "--host", "127.0.0.1", "--port", "5180", "--strictPort"],
            cwd=ROOT, env=env, **process_options,
        )
        print(f"\nLive Studio: http://127.0.0.1:5180/\nWorkspace: {workspace}\n"
              "Frontend edits update in the browser. Python/.env/ezpz.yaml edits restart the API.\n"
              "Ctrl+C stops both services.\n", flush=True)
        failure_reported = False
        while not stopping:
            if frontend.poll() is not None:
                print("Frontend exited; stopping development services.", file=sys.stderr)
                return frontend.returncode or 1
            current = snapshot(workspace)
            if current != watched:
                # Coalesce editor save bursts before restarting the backend.
                time.sleep(0.2)
                watched = snapshot(workspace)
                print("\nSource/config changed; restarting API...", flush=True)
                stop(backend, backend=True)
                if stopping:
                    break
                backend = start_backend()
                failure_reported = False
            elif backend.poll() is not None and not failure_reported:
                print("API exited. Fix the error and save a Python/config file to retry.",
                      file=sys.stderr, flush=True)
                failure_reported = True
            time.sleep(0.3)
    finally:
        stop(frontend)
        stop(backend, backend=True)
        for sig, handler in previous.items():
            signal.signal(sig, handler)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
