from pathlib import Path

from .db import Database
from .ingest import DocumentIngestor
from .models import new_id, utc_now
from .storage import BlobStore, count_pdf_pages


DEMO_DOCUMENT_ID = "doc_demo_invoice"
DEMO_DATASET_ID = "ds_invoice_eval_2026"
DEMO_PROCESSOR_ID = "proc_invoice_extractor"
DEMO_VERSION_ID = "pv_invoice_extractor_17"

DEMO_INVOICE = (
    "ACME INDUSTRIES INVOICE\n"
    "Invoice # INV-1042\n"
    "Issued 2026-01-03\n"
    "Vendor: ACME INDUSTRIES\n"
    "Bill to: Northstar Labs\n"
    "Precision sensor module 2 $840.00\n"
    "Calibration & QA service 1 $280.00\n"
    "Expedited shipping 1 $84.19\n"
    "Subtotal $1,204.19\n"
    "Tax (0%) $0.00\n"
    "Total due $1,204.19\n"
    "Currency USD\n"
).encode("utf-8")


def default_schema():
    return {
        "type": "object",
        "properties": {
            "invoice_number": {"type": "string", "description": "The invoice identifier"},
            "invoice_date": {"type": "string", "format": "date", "description": "The issue date"},
            "vendor": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Legal supplier name"},
                },
            },
            "total": {"type": "number", "description": "Total amount including tax"},
            "currency": {"type": "string", "description": "ISO 4217 currency code"},
            "line_items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "description": {"type": "string"},
                        "quantity": {"type": "integer"},
                        "amount": {"type": "number"},
                    },
                },
            },
        },
        "required": ["invoice_number", "vendor", "total", "currency", "line_items"],
    }


def default_prompt():
    return {
        "system": "You are an invoice extraction system. Return only valid JSON matching the schema. Never invent values.",
        "extraction": "Extract invoice_number, invoice_date, vendor.name, total, currency, and line_items.",
        "temperature": 0,
        "max_tokens": 4096,
    }


def blank_schema():
    """Return the neutral schema used when creating a new processor."""
    return {
        "type": "object",
        "properties": {},
    }


def blank_prompt():
    """Return the neutral extraction prompt used by new processors."""
    return {
        "system": "You are a document extraction system. Return only valid JSON matching the schema.",
        "extraction": "Extract the requested fields from this document.",
        "temperature": 0,
        "max_tokens": 4096,
    }


def ensure_empty_processor(database: Database) -> None:
    """Create the blank processor shell used by an unseeded workbench."""
    if database.get_processor(DEMO_PROCESSOR_ID):
        return
    database.insert_processor(
        "invoice-extractor",
        "Local document extraction processor.",
        DEMO_PROCESSOR_ID,
    )
    database.insert_processor_version(
        {
            "id": "pv_invoice_extractor_empty",
            "processor_id": DEMO_PROCESSOR_ID,
            "version": 1,
            "status": "published",
            "schema": {"type": "object", "properties": {}},
            "prompt": default_prompt(),
            "parser": {"name": "native", "version": "1"},
            "model": {"provider": "local", "name": "deterministic-local"},
            "harness": {"name": "direct", "version": "1"},
            "normalization": {},
        }
    )


def ensure_seed(database: Database, blobs: BlobStore) -> None:
    if not database.get_document(DEMO_DOCUMENT_ID):
        sha256, blob_key, _ = blobs.put(DEMO_INVOICE, "INV-1042.pdf")
        database.insert_document(
            {
                "id": DEMO_DOCUMENT_ID,
                "filename": "INV-1042.pdf",
                "mime_type": "application/pdf",
                "size_bytes": len(DEMO_INVOICE),
                "sha256": sha256,
                "blob_key": blob_key,
                "page_count": count_pdf_pages(DEMO_INVOICE),
                "metadata": {"seed": True, "description": "Local demo invoice"},
                "created_at": utc_now(),
            }
        )

    if not database.get_processor(DEMO_PROCESSOR_ID):
        database.insert_processor(
            "invoice-extractor",
            "Invoice extraction processor used by the local demo.",
            DEMO_PROCESSOR_ID,
        )
    if not database.get_processor_version(DEMO_VERSION_ID):
        database.insert_processor_version(
            {
                "id": DEMO_VERSION_ID,
                "processor_id": DEMO_PROCESSOR_ID,
                "version": 17,
                "status": "published",
                "schema": default_schema(),
                "prompt": default_prompt(),
                "parser": {"name": "native", "version": "1"},
                "model": {
                    "provider": "local",
                    "name": "deterministic-local",
                    "pricing": {"input_per_million": 3, "output_per_million": 15},
                },
                "harness": {"name": "parse_extract", "version": "1"},
                "normalization": {"dates": "iso-8601", "currency": "iso-4217"},
            }
        )
    if not database.get_dataset(DEMO_DATASET_ID):
        database.insert_dataset(
            "invoice-eval-2026",
            "Seeded invoice evaluation set for local development.",
            DEMO_DATASET_ID,
        )
    database.add_document_to_dataset(DEMO_DATASET_ID, DEMO_DOCUMENT_ID, "test")
    if not database.get_ground_truth(DEMO_DOCUMENT_ID):
        database.save_ground_truth(
            DEMO_DOCUMENT_ID,
            {
                "invoice_number": "INV-1042",
                "invoice_date": "2026-01-03",
                "vendor": {"name": "ACME INDUSTRIES"},
                "total": 1204.19,
                "currency": "USD",
            },
            annotation_status="complete",
            author="seed",
        )
