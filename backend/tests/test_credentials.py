import json
import os
import stat
import threading
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from backend.credentials import CredentialStore
from backend.model import create_model_adapter
from backend.model_catalog import get_model_catalog
from backend.parser import _llama_parse_pages
from backend.server import make_server


class CredentialTests(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        environment = patch.dict(os.environ, {}, clear=True)
        environment.start()
        self.addCleanup(environment.stop)

    def test_save_replace_remove_persists_and_only_returns_status(self):
        store = CredentialStore(self.root)
        result = store.update("openai", "fake-key-one")
        self.assertNotIn("fake-key", json.dumps(result))
        self.assertEqual(CredentialStore(self.root).resolve("OPENAI_API_KEY"), "fake-key-one")
        if os.name != "nt":
            self.assertEqual(stat.S_IMODE(store.path.stat().st_mode), 0o600)
        store.update("openai", "fake-key-two")
        self.assertNotIn("fake-key-one", store.path.read_text())
        self.assertEqual(store.resolve("OPENAI_API_KEY"), "fake-key-two")
        store.update("openai")
        self.assertIsNone(CredentialStore(self.root).resolve("OPENAI_API_KEY"))
        self.assertNotIn("OPENAI_API_KEY", os.environ)

    def test_saved_keys_override_environment_and_removal_restores_it(self):
        os.environ["GOOGLE_API_KEY"] = "external-key"
        store = CredentialStore(self.root)
        self.assertEqual(store.status()["providers"][2]["source"], "environment")
        store.update("gemini", "saved-key")
        self.assertEqual(store.resolve("GOOGLE_API_KEY"), "saved-key")
        self.assertEqual(store.resolve("GEMINI_API_KEY"), "saved-key")
        self.assertEqual(os.environ["GOOGLE_API_KEY"], "external-key")
        store.update("gemini")
        self.assertEqual(store.resolve("GOOGLE_API_KEY"), "external-key")

    def test_workspaces_do_not_share_saved_keys(self):
        first, second = CredentialStore(self.root / "one"), CredentialStore(self.root / "two")
        first.update("openai", "one-key")
        second.update("openai", "two-key")
        config = {"provider": "openai", "name": "test-model"}
        self.assertEqual(create_model_adapter(config, first.resolve).api_key, "one-key")
        self.assertEqual(create_model_adapter(config, second.resolve).api_key, "two-key")
        self.assertNotIn("api_key", config)

    def test_atomic_write_failure_keeps_existing_key(self):
        store = CredentialStore(self.root)
        store.update("openai", "original-key")
        with patch("backend.credentials.os.replace", side_effect=OSError("write failed")):
            with self.assertRaisesRegex(ValueError, "Could not save"):
                store.update("openai", "replacement-key")
        self.assertEqual(store.resolve("OPENAI_API_KEY"), "original-key")
        self.assertEqual(CredentialStore(self.root).resolve("OPENAI_API_KEY"), "original-key")
        self.assertEqual(list(store.path.parent.glob(".credentials-*")), [])

    def test_invalid_values_are_rejected_without_echoing_keys(self):
        store = CredentialStore(self.root)
        for key in ["", "fake secret", "fake\nsecret", "x" * 4097, 123]:
            with self.subTest(key_type=type(key).__name__), self.assertRaises(ValueError) as error:
                store.update("openai", key)
            self.assertNotIn("fake", str(error.exception))
        with self.assertRaises(ValueError):
            store.update("../../escape", "key")
        self.assertFalse(store.path.exists())

    def test_adapters_discovery_and_parser_resolve_saved_keys(self):
        store = CredentialStore(self.root)
        for provider, config_provider in [("openai", "openai"), ("anthropic", "anthropic"), ("gemini", "google"), ("openai-compatible", "openai-compatible")]:
            store.update(provider, provider + "-fake-key")
            config = {"provider": config_provider, "name": "test-model"}
            self.assertEqual(create_model_adapter(config, store.resolve).api_key, provider + "-fake-key")
        with patch("backend.model_catalog._provider_records", return_value=[{"id": "test-model"}]) as records:
            result = get_model_catalog("google", credential_resolver=store.resolve)
            self.assertEqual(records.call_args.args[2], "gemini-fake-key")
            self.assertNotIn("fake-key", json.dumps(result))
        store.update("llama-parse", "parser-fake-key")
        with patch("backend.parser._llama_upload", side_effect=RuntimeError("mock upload")) as upload:
            with self.assertRaisesRegex(RuntimeError, "mock upload"):
                _llama_parse_pages({"id": "test", "filename": "test.pdf", "mime_type": "application/pdf"}, b"pdf", {"name": "llama-parse"}, store.resolve)
            self.assertEqual(upload.call_args.args[1], "parser-fake-key")

    def test_settings_http_controls_and_existing_dotenv_are_preserved(self):
        dotenv = "OPENAI_API_KEY=external-key\nEZPZ_PORT=4173\n"
        (self.root / ".env").write_text(dotenv)
        server = make_server(self.root, port=0)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        self.addCleanup(worker.join)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        base = f"http://127.0.0.1:{server.server_port}"
        route = "/v1/settings/credentials"

        def send(path, method="GET", data=None, headers=None):
            req = Request(base + path, data=json.dumps(data).encode() if data is not None else None,
                          method=method, headers=headers or {})
            return urlopen(req)

        headers = {"Content-Type": "application/json", "X-Ezpz-Settings": "1", "Origin": base}
        with send(route) as response:
            self.assertEqual(response.headers["Cache-Control"], "no-store")
            self.assertNotIn("external-key", response.read().decode())
        with patch.object(server.RequestHandlerClass.runtime.database, "clear_extraction_cache") as clear:
            with send(route + "/openai", "POST", {"api_key": "ui-fake-key"}, headers) as response:
                result = response.read().decode()
                self.assertNotIn("ui-fake-key", result)
                self.assertEqual(response.headers["Access-Control-Allow-Origin"], base)
            clear.assert_called_once()
        self.assertEqual(server.RequestHandlerClass.runtime.extractions._model_from_config({"provider": "openai"}).api_key, "ui-fake-key")
        for bad_headers in [
            {**headers, "Origin": "https://evil.example"},
            {**headers, "Host": f"evil.example:{server.server_port}"},
            {"Content-Type": "application/json", "Origin": base},
            {**headers, "Content-Type": "text/plain"},
        ]:
            with self.assertRaises(HTTPError) as error:
                send(route + "/openai", "POST", {"api_key": "rejected-key"}, bad_headers)
            self.assertEqual(error.exception.code, 403)
            error.exception.close()
        self.assertEqual(server.RequestHandlerClass.runtime.credentials.resolve("OPENAI_API_KEY"), "ui-fake-key")
        # Foreign pages cannot cause the service to forward credentials elsewhere.
        with patch("backend.server.get_model_catalog") as catalog:
            for bad_headers in [{"Origin": "https://evil.example"}, {"Host": "evil.example", "Sec-Fetch-Site": "same-origin"}]:
                with self.assertRaises(HTTPError) as error:
                    send("/v1/model-catalog?provider=openai&endpoint=https://evil.example", headers=bad_headers)
                self.assertEqual(error.exception.code, 403)
                error.exception.close()
            catalog.assert_not_called()
        with send(route + "/openai", "DELETE", headers=headers) as response:
            self.assertEqual(json.load(response)["providers"][0]["source"], "environment")
        self.assertEqual((self.root / ".env").read_text(), dotenv)
        self.assertEqual(server.RequestHandlerClass.runtime.credentials.resolve("OPENAI_API_KEY"), "external-key")


if __name__ == "__main__":
    unittest.main()
