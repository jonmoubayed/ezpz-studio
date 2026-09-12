"""Start the packaged UI and API as one local process."""

import json
import signal
import threading
import time
import webbrowser
from urllib.error import URLError
from urllib.request import ProxyHandler, build_opener

from .paths import bundled_studio_root, default_workspace_root
from .server import make_server


def launch(root=None, host="127.0.0.1", port=4173, open_browser=True):
    assets = bundled_studio_root()
    if not (assets / "index.html").is_file():
        raise ValueError(
            "The packaged Studio UI is missing. Install a release wheel, or build it "
            "from source with: python scripts/build-package.py"
        )
    root = (root or default_workspace_root()).expanduser().resolve()
    try:
        server = make_server(root, host, port, static_root=assets)
    except OSError as error:
        raise ValueError(
            f"Could not start Studio on {host}:{port}: {error}. "
            "If that port is in use, try: ezpz studio --port 4174"
        ) from error
    browser_host = "127.0.0.1" if host in {"0.0.0.0", "localhost"} else host
    url = f"http://{browser_host}:{server.server_port}/"
    stopped = threading.Event()
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    previous_handlers = {}
    try:
        if threading.current_thread() is threading.main_thread():
            for sig in (signal.SIGINT, signal.SIGTERM):
                previous_handlers[sig] = signal.signal(sig, lambda *_: stopped.set())
        worker.start()
        opener = build_opener(ProxyHandler({}))
        deadline = time.monotonic() + 10
        while not stopped.is_set():
            try:
                with opener.open(url + "v1/ready", timeout=1) as response:
                    if json.load(response).get("ok"):
                        break
            except (URLError, OSError, ValueError):
                pass
            if time.monotonic() >= deadline:
                raise ValueError("Studio did not become ready. Check the workspace folder and retry.")
            stopped.wait(0.1)
        if not stopped.is_set():
            print(f"ezpz Studio is ready at {url}", flush=True)
            print(f"Workspace: {root}\nPress Ctrl+C to stop. Run the same launch command to reopen.", flush=True)
            if open_browser and host in {"127.0.0.1", "localhost"}:
                try:
                    webbrowser.open(url)
                except webbrowser.Error:
                    pass  # The printed URL also works on machines without a browser.
            stopped.wait()
    finally:
        if worker.is_alive():
            server.shutdown()
            worker.join(timeout=5)
        server.server_close()
        for sig, handler in previous_handlers.items():
            signal.signal(sig, handler)
    return {"status": "stopped", "root": str(root)}
