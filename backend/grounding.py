"""Direct visual evidence contract and validation; no OCR or text matching."""
import base64
import math
from typing import Any

from .confidence import mark_model_confidence
from .models import DocumentIR
from .storage import count_pdf_pages

GROUNDING_INSTRUCTIONS = (
    "For every extraction leaf also return an evidence array of {page, bbox, text}. "
    "Read the attached original PDF or image directly. Page is the 1-based physical PDF page "
    "(not a printed page label); a single image is page 1. bbox is exactly [left, top, right, bottom] "
    "normalized to [0,1] relative to the full displayed page, with origin at the top left, x increasing "
    "rightward and y downward. Require left < right and top < bottom. "
    "Draw tight boxes around the visible value or supporting passage and copy its verbatim text. "
    "Use multiple evidence entries for separate regions or pages; arrays may cite multiple rows. "
    "Use [] when the value is null, the source is not visible, or you cannot confidently locate it. "
    "Never invent coordinates, use pixel coordinates, or return a full-page placeholder. "
    "These coordinates are model estimates, not independently verified locations."
)


def visual_source(document_ir):
    source = document_ir.metadata.get("source_input") or {}
    return source.get("mime_type") in {"application/pdf", "image/png", "image/jpeg", "image/webp", "image/gif"}


def valid_region(item: Any, page_count=None):
    """Reject malformed geometry instead of clamping a bad box into apparent evidence."""
    if not isinstance(item, dict):
        return None
    page, bbox = item.get("page"), item.get("bbox")
    if isinstance(page, bool) or not isinstance(page, int) or page < 1:
        return None
    if isinstance(page_count, int) and page_count > 0 and page > page_count:
        return None
    if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
        return None
    if not all(not isinstance(v, bool) and isinstance(v, (int, float)) and 0 <= v <= 1 and math.isfinite(v) for v in bbox):
        return None
    if bbox[0] >= bbox[2] or bbox[1] >= bbox[3]:
        return None
    if not isinstance(item.get("text", ""), str):
        return None
    return {"page": page, "bbox": list(bbox), "text": item.get("text", "")}


def model_output(output, schema, document_ir):
    output = mark_model_confidence(output, schema)
    if not visual_source(document_ir):
        return output
    page_count = document_ir.metadata.get("page_count")
    if document_ir.metadata["source_input"]["mime_type"].startswith("image/"):
        page_count = 1

    def visit(value, definition):
        if not isinstance(value, dict):
            return value
        if definition.get("type") == "object":
            return {key: visit(child, definition.get("properties", {}).get(key, {})) for key, child in value.items()}
        if "value" not in value:
            return value
        evidence = []
        candidates = value.get("evidence")
        if value["value"] is not None and isinstance(candidates, list):
            for candidate in candidates:
                region = valid_region(candidate, page_count)
                if region:
                    # Provenance is assigned here, never accepted from the model.
                    region["metadata"] = {"bbox_source": "model", "grounding": "visual", "coordinate_system": "normalized_xyxy"}
                    if region not in evidence:
                        evidence.append(region)
        return {**value, "evidence": evidence}
    return visit(output, schema)


def original_document_ir(document, data):
    """Attach the source bytes without OCR, layout parsing, or text extraction."""
    metadata = {key: document[key] for key in ("filename", "mime_type")}
    metadata["page_count"] = document.get("page_count") or (count_pdf_pages(data) if document["mime_type"] == "application/pdf" else 1)
    metadata["source_input"] = {**metadata, "data": base64.b64encode(data).decode("ascii")}
    return DocumentIR(document["id"], {"name": "none", "version": "1", "status": "unavailable", "warnings": []}, metadata, [])
