import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from backend.config import Settings


class ConfigTests(unittest.TestCase):
    def test_project_dotenv_supplies_provider_credentials_without_overriding_shell(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".env").write_text(
                "OPENAI_API_KEY=from-file\n"
                "LLAMA_CLOUD_API_KEY='quoted-value'\n"
                "EZPZ_PORT=4188\n",
                encoding="utf-8",
            )
            with patch.dict(
                os.environ,
                {"OPENAI_API_KEY": "from-shell"},
                clear=False,
            ):
                os.environ.pop("LLAMA_CLOUD_API_KEY", None)
                os.environ.pop("EZPZ_PORT", None)
                settings = Settings.from_env(root)
                self.assertEqual(os.environ["OPENAI_API_KEY"], "from-shell")
                self.assertEqual(os.environ["LLAMA_CLOUD_API_KEY"], "quoted-value")
                self.assertEqual(settings.port, 4188)


if __name__ == "__main__":
    unittest.main()
