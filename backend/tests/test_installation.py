import json
import os
import signal
import socket
import threading
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from backend.launcher import launch
from backend.paths import default_workspace_root
from backend.server import make_server
from ezpz import build_parser


def multipart(data=b"\x00\xff\r\nPDF bytes\r\n", extra=b""):
    return (
        b'--upload-boundary\r\nContent-Disposition: form-data; name="note"\r\n\r\n'
        + "café".encode() + b'\r\n--upload-boundary\r\n'
        b'Content-Disposition: form-data; name="file"; filename="invoice.txt"\r\n'
        b'Content-Type: application/octet-stream\r\n\r\n'
        + data + b"\r\n" + extra + b"--upload-boundary--\r\n"
    )


class InstallationTests(unittest.TestCase):
    def test_default_paths_are_outside_installed_code(self):
        with patch.dict(os.environ, {}, clear=True), patch("pathlib.Path.home", return_value=Path("/users/test")):
            for platform, expected in [
                ("darwin", "/users/test/Library/Application Support/ezpz"),
                ("linux", "/users/test/.local/share/ezpz"),
                ("win32", "/users/test/AppData/Local/ezpz"),
            ]:
                with self.subTest(platform=platform), patch("sys.platform", platform):
                    self.assertEqual(default_workspace_root(), Path(expected))
            with patch("sys.platform", "linux"), patch.dict(os.environ, {"XDG_DATA_HOME": "/custom/data"}):
                self.assertEqual(default_workspace_root(), Path("/custom/data/ezpz"))
            with patch.dict(os.environ, {"EZPZ_WORKSPACE": "/custom/workspace"}):
                self.assertEqual(default_workspace_root(), Path("/custom/workspace"))

    def test_cli_aliases_share_persistent_default(self):
        with TemporaryDirectory() as directory, patch.dict(os.environ, {"EZPZ_WORKSPACE": directory}):
            for command in ["studio", "serve"]:
                args = build_parser().parse_args([command, "--no-open"])
                self.assertEqual(args.root, Path(directory).resolve())
                self.assertTrue(args.no_open)

    def test_http_upload_and_static_files_are_separate_from_workspace(self):
        with TemporaryDirectory() as directory, patch.dict(os.environ, {"EZPZ_SEED_DEMO": "false"}):
            root = Path(directory)
            assets = root / "ui"
            assets.mkdir()
            (assets / "index.html").write_text("<h1>Live Studio</h1>")
            workspace = root / "workspace"
            workspace.mkdir()
            (workspace / "private.txt").write_text("not a static asset")
            server = make_server(workspace, port=0, static_root=assets)
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            base = f"http://127.0.0.1:{server.server_port}"
            try:
                with urlopen(base + "/") as response:
                    self.assertIn(b"Live Studio", response.read())
                for path in ["/private.txt", "/../workspace/private.txt", "/.ezpz/ezpz.db"]:
                    with self.subTest(path=path), self.assertRaises(HTTPError) as error:
                        urlopen(base + path)
                    self.assertIn(error.exception.code, [403, 404])
                req = Request(base + "/v1/documents", data=multipart(b"invoice text"), headers={"Content-Type": "multipart/form-data; boundary=upload-boundary"})
                with urlopen(req) as response:
                    document = json.load(response)["document"]
                with urlopen(base + f'/v1/documents/{document["id"]}/source') as response:
                    self.assertEqual(response.read(), b"invoice text")
            finally:
                server.shutdown()
                server.server_close()
                worker.join()

    def test_browser_opens_only_after_ready_and_signals_are_restored(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            assets = root / "assets"
            assets.mkdir()
            (assets / "index.html").write_text("Studio")
            original = signal.getsignal(signal.SIGINT)
            def browser(url):
                with urlopen(url + "v1/ready") as response:
                    self.assertTrue(json.load(response)["ok"])
                signal.getsignal(signal.SIGINT)(signal.SIGINT, None)
                return True
            with patch("backend.launcher.bundled_studio_root", return_value=assets), patch("backend.launcher.webbrowser.open", side_effect=browser) as opened:
                launch(root / "workspace", port=0)
            opened.assert_called_once()
            self.assertIs(signal.getsignal(signal.SIGINT), original)

    def test_missing_assets_and_occupied_port_have_actionable_errors(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            with patch("backend.launcher.bundled_studio_root", return_value=root):
                with self.assertRaisesRegex(ValueError, "release wheel"):
                    launch(root / "workspace", open_browser=False)
                (root / "index.html").write_text("Studio")
                with socket.socket() as occupied:
                    occupied.bind(("127.0.0.1", 0))
                    occupied.listen()
                    with self.assertRaisesRegex(ValueError, "--port 4174"):
                        launch(root / "workspace", port=occupied.getsockname()[1], open_browser=False)


if __name__ == "__main__":
    unittest.main()
