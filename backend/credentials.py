"""Workspace-local secrets, kept out of browser responses and processor records."""

import json
import os
import tempfile
import threading
from pathlib import Path


PROVIDERS = {
    "openai": ("OpenAI", ("OPENAI_API_KEY",)),
    "anthropic": ("Anthropic", ("ANTHROPIC_API_KEY",)),
    "gemini": ("Google Gemini", ("GOOGLE_API_KEY", "GEMINI_API_KEY")),
    "openai-compatible": ("Compatible API", ("OPENAI_COMPATIBLE_API_KEY",)),
    "llama-parse": ("LlamaParse", ("LLAMA_CLOUD_API_KEY", "LLAMA_PARSE_API_KEY")),
}


class CredentialStore:
    def __init__(self, root: Path):
        self.path = Path(root) / ".ezpz" / "credentials.json"
        self._lock = threading.RLock()
        self._values = self._read()

    def _read(self):
        try:
            values = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}
        except (OSError, ValueError) as error:
            raise ValueError("Could not read the workspace API-key file.") from error
        if not isinstance(values, dict) or any(key not in PROVIDERS or not isinstance(value, str) for key, value in values.items()):
            raise ValueError("The workspace API-key file is invalid.")
        return values

    def resolve(self, name):
        """UI values override environment/dotenv aliases only in this runtime."""
        with self._lock:
            for provider, (_, names) in PROVIDERS.items():
                if name in names and self._values.get(provider):
                    return self._values[provider]
        return os.environ.get(name)

    def status(self):
        with self._lock:
            return {"providers": [
                {"id": provider, "label": label, "configured": bool(self._values.get(provider) or any(os.environ.get(name) for name in names)),
                 "source": "workspace" if self._values.get(provider) else "environment" if any(os.environ.get(name) for name in names) else "none"}
                for provider, (label, names) in PROVIDERS.items()
            ]}

    def update(self, provider, value=None):
        if provider not in PROVIDERS:
            raise ValueError("Unsupported API-key provider.")
        if value is not None:
            if not isinstance(value, str) or not value.strip() or len(value) > 4096 or any(char.isspace() or ord(char) < 32 or ord(char) > 126 for char in value.strip()):
                raise ValueError("Enter a valid API key without spaces or line breaks.")
            value = value.strip()
        with self._lock:
            values = dict(self._values)
            if value is None:
                values.pop(provider, None)
            else:
                values[provider] = value
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temporary = None
            try:
                descriptor, temporary = tempfile.mkstemp(prefix=".credentials-", dir=self.path.parent)
                with os.fdopen(descriptor, "w", encoding="utf-8") as output:
                    # mkstemp creates owner-only files on POSIX; replace is atomic.
                    json.dump(values, output)
                    output.write("\n")
                    output.flush()
                    os.fsync(output.fileno())
                os.replace(temporary, self.path)
                self._values = values
            except OSError as error:
                raise ValueError("Could not save API keys. Check that the workspace folder is writable.") from error
            finally:
                if temporary and os.path.exists(temporary):
                    os.unlink(temporary)
            return self.status()
