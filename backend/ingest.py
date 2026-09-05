import re
from typing import Any, Dict, Optional

from .db import Database
from .models import new_id, utc_now
from .storage import BlobStore, count_pdf_pages, infer_mime_type, looks_like_pdf


class DocumentIngestor:
    def __init__(self, database: Database, blobs: BlobStore):
        self.database = database
        self.blobs = blobs

    def ingest(
        self,
        filename: str,
        data: bytes,
        mime_type: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        clean_name = re.sub(r"[^A-Za-z0-9._ -]", "_", filename or "document")
        sha256, blob_key, existed = self.blobs.put(data, clean_name)
        duplicate = self.database.find_document_by_hash(sha256)
        if duplicate:
            return {"document": duplicate, "duplicate": True, "blob_reused": existed}

        resolved_mime_type = infer_mime_type(clean_name, mime_type)
        if looks_like_pdf(data):
            # A few browsers and storage providers label binary uploads as
            # application/octet-stream. The file signature is authoritative
            # for PDF previewing and page counting.
            resolved_mime_type = "application/pdf"

        document = self.database.insert_document(
            {
                "id": new_id("doc"),
                "filename": clean_name,
                "mime_type": resolved_mime_type,
                "size_bytes": len(data),
                "sha256": sha256,
                "blob_key": blob_key,
                "page_count": count_pdf_pages(data) if resolved_mime_type == "application/pdf" else 1,
                "metadata": metadata or {},
                "created_at": utc_now(),
            }
        )
        return {"document": document, "duplicate": False, "blob_reused": existed}
