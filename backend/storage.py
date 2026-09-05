"""Content-addressed local storage for source documents."""

import hashlib
import io
import mimetypes
import re
from pathlib import Path
from typing import Optional, Tuple


class BlobNotFound(FileNotFoundError):
    pass


class BlobStore:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def put(self, data: bytes, filename: str = "") -> Tuple[str, str, bool]:
        digest = hashlib.sha256(data).hexdigest()
        suffix = Path(filename).suffix.lower()
        key = "{}/{}{}".format(digest[:2], digest, suffix)
        path = self.root / key
        path.parent.mkdir(parents=True, exist_ok=True)
        existed = path.exists()
        if not existed:
            path.write_bytes(data)
        return digest, key, existed

    def get(self, key: str) -> bytes:
        path = self._safe_path(key)
        if not path.exists():
            raise BlobNotFound(key)
        return path.read_bytes()

    def exists(self, key: str) -> bool:
        return self._safe_path(key).exists()

    def delete(self, key: str) -> bool:
        path = self._safe_path(key)
        if not path.exists():
            return False
        path.unlink()
        return True

    def _safe_path(self, key: str) -> Path:
        path = (self.root / key).resolve()
        root = self.root.resolve()
        if path != root and root not in path.parents:
            raise ValueError("Blob key escapes the blob root")
        return path


def create_blob_store(root: Path) -> BlobStore:
    return BlobStore(root)


def infer_mime_type(filename: str, supplied: Optional[str] = None) -> str:
    if supplied and supplied != "application/octet-stream":
        return supplied
    guessed, _ = mimetypes.guess_type(filename)
    return guessed or supplied or "application/octet-stream"


def looks_like_pdf(data: bytes) -> bool:
    return b"%PDF-" in (data or b"")[:1024]


def count_pdf_pages(data: bytes) -> int:
    if not looks_like_pdf(data):
        return 1
    try:
        from pypdf import PdfReader  # type: ignore

        return max(1, len(PdfReader(io.BytesIO(data), strict=False).pages))
    except Exception:
        page_objects = len(re.findall(rb"/Type\s*/Page\b", data))
        if page_objects:
            return page_objects
        match = re.search(rb"/Linearized\s+1.*?/N\s+(\d+)", data[:4096], re.DOTALL)
        return max(1, int(match.group(1))) if match else 1
