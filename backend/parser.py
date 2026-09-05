import csv
import io
import json
import os
import re
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
import uuid
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from xml.etree import ElementTree

from .adapters import get_adapter_catalog, normalize_parser_name
from .models import DocumentBlock, DocumentIR, DocumentPage
from .storage import count_pdf_pages, looks_like_pdf


def _printable_text(data: bytes) -> str:
    decoded = data.decode("utf-8", errors="ignore")
    if len(re.findall(r"[A-Za-z0-9]", decoded)) < 12:
        decoded = data.decode("latin-1", errors="ignore")
    decoded = re.sub(r"[^\x09\x0A\x0D\x20-\x7E]", " ", decoded)
    decoded = re.sub(r"[ \t]+", " ", decoded)
    decoded = re.sub(r"\n[ \t]+", "\n", decoded)
    return decoded.strip()


def _pdf_text(data: bytes) -> str:
    """Extract PDF text when pypdf is available, without decoding binary streams."""
    if not looks_like_pdf(data):
        return ""
    try:
        from pypdf import PdfReader  # type: ignore

        reader = PdfReader(io.BytesIO(data), strict=False)
        return "\f".join((page.extract_text() or "").strip() for page in reader.pages)
    except Exception:
        # Never fall back to _printable_text for a valid PDF: compressed object
        # streams are binary data and rendering them as text produces the dense
        # PDF syntax/garbage shown in the inspector.
        return ""


class _HTMLTextParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts: List[str] = []
        self._ignored_depth = 0

    def handle_starttag(self, tag: str, attrs: List[Tuple[str, Optional[str]]]) -> None:
        if tag.lower() in {"script", "style", "noscript", "template"}:
            self._ignored_depth += 1

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() in {"script", "style", "noscript", "template"} and self._ignored_depth:
            self._ignored_depth -= 1

    def handle_data(self, data: str) -> None:
        if self._ignored_depth:
            return
        cleaned = " ".join(data.split())
        if cleaned:
            self.parts.append(cleaned)


def _html_text(data: bytes) -> str:
    parser = _HTMLTextParser()
    parser.feed(data.decode("utf-8", errors="ignore"))
    parser.close()
    return "\n".join(parser.parts)


def _zip_xml_text(data: bytes, member: str) -> str:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            root = ElementTree.fromstring(archive.read(member))
    except (KeyError, OSError, ValueError, ElementTree.ParseError, zipfile.BadZipFile):
        return ""
    namespace = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    lines = []
    for paragraph in root.findall(".//w:p", namespace):
        line = "".join(item.text or "" for item in paragraph.findall(".//w:t", namespace)).strip()
        if line:
            lines.append(line)
    return "\n".join(lines)


def _xlsx_text(data: bytes) -> str:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            shared_strings = []
            if "xl/sharedStrings.xml" in archive.namelist():
                shared_root = ElementTree.fromstring(archive.read("xl/sharedStrings.xml"))
                shared_strings = ["".join(node.text or "" for node in item.iter() if node.tag.endswith("}t") or node.tag == "t") for item in shared_root]
            lines = []
            for name in sorted(item for item in archive.namelist() if item.startswith("xl/worksheets/") and item.endswith(".xml")):
                root = ElementTree.fromstring(archive.read(name))
                row_values = []
                for row in root.iter():
                    if not row.tag.endswith("}row") and row.tag != "row":
                        continue
                    values = []
                    for cell in row:
                        if not (cell.tag.endswith("}c") or cell.tag == "c"):
                            continue
                        cell_type = cell.attrib.get("t")
                        value_node = next((child for child in cell if child.tag.endswith("}v") or child.tag == "v"), None)
                        inline = next((child for child in cell.iter() if child.tag.endswith("}t") or child.tag == "t"), None)
                        value = inline.text if inline is not None else (value_node.text if value_node is not None else "")
                        if cell_type == "s" and value and value.isdigit() and int(value) < len(shared_strings):
                            value = shared_strings[int(value)]
                        values.append(value or "")
                    if values:
                        row_values.append(" | ".join(values))
                lines.extend(row_values)
            return "\n".join(line for line in lines if line.strip())
    except (KeyError, OSError, ValueError, ElementTree.ParseError, zipfile.BadZipFile):
        return ""


def _document_text(document: Dict[str, Any], data: bytes) -> str:
    metadata = document.get("metadata") if isinstance(document.get("metadata"), dict) else {}
    supplied_text = metadata.get("ocr_text") or metadata.get("extracted_text")
    if isinstance(supplied_text, str) and supplied_text.strip():
        return supplied_text.strip()
    filename = str(document.get("filename", "")).lower()
    mime_type = str(document.get("mime_type", "")).lower()
    if filename.endswith(".pdf") or mime_type == "application/pdf":
        return _pdf_text(data) if looks_like_pdf(data) else _printable_text(data)
    if filename.endswith(".docx") or mime_type == "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
        return _zip_xml_text(data, "word/document.xml") or _printable_text(data)
    if filename.endswith(".xlsx") or mime_type == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
        return _xlsx_text(data) or _printable_text(data)
    if filename.endswith((".html", ".htm")) or mime_type in {"text/html", "application/xhtml+xml"}:
        return _html_text(data)
    return _printable_text(data)


def _text_blocks(text: str, page_number: int) -> List[DocumentBlock]:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines and text:
        lines = [text]
    blocks = []
    line_count = max(1, len(lines))
    for index, line in enumerate(lines):
        top = min(0.92, 0.06 + (index / line_count) * 0.84)
        bottom = min(0.98, top + 0.04)
        blocks.append(
            DocumentBlock(
                block_id="p{}-b{}".format(page_number, index + 1),
                block_type="text",
                text=line,
                bbox=[0.06, round(top, 4), 0.94, round(bottom, 4)],
                confidence=None,
            )
        )
    return blocks


def _is_image_document(document: Dict[str, Any]) -> bool:
    mime_type = str(document.get("mime_type", "")).lower()
    filename = str(document.get("filename", "")).lower()
    return mime_type.startswith("image/") or filename.endswith((".png", ".jpg", ".jpeg", ".tif", ".tiff", ".webp", ".bmp"))


def _image_layout_pages(document: Dict[str, Any], data: bytes, supplied_text: str) -> Optional[List[DocumentPage]]:
    """Run local Tesseract on an image and return line-level, top-left boxes.

    The imported public invoice/receipt set contains OCR text but not OCR
    coordinates. Tesseract supplies the missing geometry while the supplied
    text is retained when its line count matches, so extraction behavior stays
    stable and the inspector can still draw useful evidence boxes.
    """
    if not _is_image_document(document):
        return None
    try:
        from PIL import Image  # type: ignore

        with Image.open(io.BytesIO(data)) as image:
            page_width, page_height = image.size
    except (ImportError, OSError, ValueError):
        return None
    if page_width <= 0 or page_height <= 0:
        return None

    suffix = Path(document.get("filename", "document.png")).suffix or ".png"
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix) as source:
            source.write(data)
            source.flush()
            result = subprocess.run(
                ["tesseract", source.name, "stdout", "--psm", "6", "tsv"],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
                timeout=30,
            )
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0 or not result.stdout:
        return None

    grouped: Dict[Tuple[int, int, int, int], Dict[str, Any]] = {}
    try:
        rows = csv.DictReader(io.StringIO(result.stdout.decode("utf-8", errors="replace")), delimiter="\t")
        for row in rows:
            word = str(row.get("text") or "").strip()
            if not word:
                continue
            key = tuple(int(row.get(name) or 0) for name in ("page_num", "block_num", "par_num", "line_num"))
            left = float(row.get("left") or 0)
            top = float(row.get("top") or 0)
            word_width = float(row.get("width") or 0)
            word_height = float(row.get("height") or 0)
            # Ignore page borders and other spurious connected components that
            # Tesseract occasionally reports as a word spanning most of a page.
            if word_width <= 0 or word_height <= 0 or word_height > page_height * 0.12:
                continue
            right = left + word_width
            bottom = top + word_height
            item = grouped.setdefault(key, {"words": [], "bbox": [left, top, right, bottom], "conf": []})
            item["words"].append(word)
            item["bbox"] = [min(item["bbox"][0], left), min(item["bbox"][1], top), max(item["bbox"][2], right), max(item["bbox"][3], bottom)]
            confidence = float(row.get("conf") or -1)
            if confidence >= 0:
                item["conf"].append(confidence)
    except (TypeError, ValueError):
        return None
    if not grouped:
        return None

    supplied_pages = supplied_text.split("\f") if "\f" in supplied_text else [supplied_text]
    pages: List[DocumentPage] = []
    page_numbers = sorted({key[0] for key in grouped})
    for page_number in page_numbers:
        lines = sorted((key, item) for key, item in grouped.items() if key[0] == page_number)
        ocr_lines = [line.strip() for line in (supplied_pages[page_number - 1] if page_number <= len(supplied_pages) else "").splitlines() if line.strip()]
        use_supplied_lines = len(ocr_lines) == len(lines)
        blocks: List[DocumentBlock] = []
        for index, (key, item) in enumerate(lines):
            left, top, right, bottom = item["bbox"]
            if right <= left or bottom <= top:
                continue
            block_text = ocr_lines[index] if use_supplied_lines else " ".join(item["words"])
            confidence_values = item["conf"]
            confidence = sum(confidence_values) / len(confidence_values) / 100 if confidence_values else None
            blocks.append(
                DocumentBlock(
                    block_id="p{}-b{}".format(page_number, index + 1),
                    block_type="text",
                    text=block_text,
                    bbox=[round(left / page_width, 4), round(top / page_height, 4), round(right / page_width, 4), round(bottom / page_height, 4)],
                    confidence=round(confidence, 4) if confidence is not None else None,
                    metadata={"source": "tesseract", "layout": True},
                )
            )
        if blocks:
            pages.append(DocumentPage(page=page_number, width=float(page_width), height=float(page_height), blocks=blocks))
    return pages or None


def _bbox_values(value: Any) -> Optional[List[float]]:
    if isinstance(value, (list, tuple)) and len(value) >= 4:
        return [float(value[0]), float(value[1]), float(value[2]), float(value[3])]
    if isinstance(value, dict):
        keys = ("l", "t", "r", "b") if "l" in value else ("left", "top", "right", "bottom")
        if all(key in value for key in keys):
            return [float(value[key]) for key in keys]
    return None


def _normalized_layout_bbox(raw_bbox_data: Any, provenance: Dict[str, Any], page_width: float, page_height: float) -> Optional[List[float]]:
    """Convert a parser bbox into normalized top-left coordinates for the UI."""
    raw_bbox = _bbox_values(raw_bbox_data)
    if not raw_bbox or page_width <= 0 or page_height <= 0:
        return None
    origin = provenance.get("coord_origin")
    if not origin and isinstance(raw_bbox_data, dict):
        origin = raw_bbox_data.get("coord_origin")
    # Docling defaults to bottom-left; CSS and the browser image overlay use
    # top-left coordinates. Keep explicit top-left exports intact.
    is_top_left = "TOPLEFT" in str(origin or "BOTTOMLEFT").upper().replace("_", "")
    top = raw_bbox[1] if is_top_left else page_height - raw_bbox[3]
    bottom = raw_bbox[3] if is_top_left else page_height - raw_bbox[1]
    left = max(0.0, min(1.0, raw_bbox[0] / page_width))
    right = max(0.0, min(1.0, raw_bbox[2] / page_width))
    top = max(0.0, min(1.0, top / page_height))
    bottom = max(0.0, min(1.0, bottom / page_height))
    if right <= left or bottom <= top:
        return None
    return [round(left, 4), round(top, 4), round(right, 4), round(bottom, 4)]


def _docling_pages(document: Dict[str, Any], data: bytes) -> Optional[List[DocumentPage]]:
    """Best-effort conversion of a DoclingDocument export into the local IR."""
    try:
        from docling.document_converter import DocumentConverter

        suffix = Path(document.get("filename", "document.pdf")).suffix or ".pdf"
        with tempfile.NamedTemporaryFile(suffix=suffix) as source:
            source.write(data)
            source.flush()
            converted = DocumentConverter().convert(source.name)
        docling_document = getattr(converted, "document", converted)
        exported = docling_document.export_to_dict() if hasattr(docling_document, "export_to_dict") else {}
        if not isinstance(exported, dict):
            return None

        raw_pages = exported.get("pages") or {}
        if isinstance(raw_pages, dict):
            raw_pages = list(raw_pages.values())
        if not isinstance(raw_pages, list):
            raw_pages = []
        page_sizes: Dict[int, Tuple[float, float]] = {}
        for index, raw_page in enumerate(raw_pages):
            if not isinstance(raw_page, dict):
                continue
            page_number = int(raw_page.get("page_no") or raw_page.get("page") or index + 1)
            size = raw_page.get("size") or {}
            page_sizes[page_number] = (float(size.get("width", 1) or 1), float(size.get("height", 1) or 1))

        grouped: Dict[int, List[DocumentBlock]] = {}
        for index, item in enumerate(exported.get("texts") or []):
            if not isinstance(item, dict):
                continue
            text = str(item.get("text") or item.get("orig") or "").strip()
            provenance = item.get("prov") or item.get("provenance") or []
            provenance_item = provenance[0] if isinstance(provenance, list) and provenance else {}
            page_number = int(provenance_item.get("page_no") or provenance_item.get("page") or 1)
            page_width, page_height = page_sizes.get(page_number, (1.0, 1.0))
            raw_bbox_data = provenance_item.get("bbox")
            bbox = _normalized_layout_bbox(raw_bbox_data, provenance_item, page_width, page_height) or [0.06, 0.06, 0.94, 0.1]
            grouped.setdefault(page_number, []).append(
                DocumentBlock(
                    block_id="p{}-b{}".format(page_number, index + 1),
                    block_type="text",
                    text=text,
                    bbox=bbox,
                    confidence=None,
                    metadata={"source": "docling"},
                )
            )
        if not grouped:
            return None

        page_count = max(max(grouped), len(raw_pages), 1)
        return [
            DocumentPage(
                page=page_number,
                width=page_sizes.get(page_number, (1.0, 1.0))[0],
                height=page_sizes.get(page_number, (1.0, 1.0))[1],
                blocks=grouped.get(page_number, []),
            )
            for page_number in range(1, page_count + 1)
        ]
    except (ImportError, OSError, RuntimeError, TypeError, ValueError, AttributeError):
        return None


def _llama_bbox_rects(raw_bbox: Any) -> List[List[float]]:
    """Return LlamaParse bboxes as x/y/width/height rectangles."""
    values = raw_bbox if isinstance(raw_bbox, list) else [raw_bbox]
    rects: List[List[float]] = []
    for value in values:
        if isinstance(value, dict):
            if all(key in value for key in ("x", "y", "w", "h")):
                rects.append([float(value["x"]), float(value["y"]), float(value["w"]), float(value["h"])])
            elif all(key in value for key in ("left", "top", "right", "bottom")):
                left = float(value["left"])
                top = float(value["top"])
                rects.append([left, top, float(value["right"]) - left, float(value["bottom"]) - top])
            elif all(key in value for key in ("l", "t", "r", "b")):
                left = float(value["l"])
                top = float(value["t"])
                rects.append([left, top, float(value["r"]) - left, float(value["b"]) - top])
        elif isinstance(value, (list, tuple)) and len(value) >= 4:
            left, top, right, bottom = [float(item) for item in value[:4]]
            rects.append([left, top, right - left, bottom - top])
    return [rect for rect in rects if rect[2] > 0 and rect[3] > 0]


def _llama_normalized_bbox(raw_bbox: Any, page_width: float, page_height: float) -> Optional[List[float]]:
    rects = _llama_bbox_rects(raw_bbox)
    if not rects or page_width <= 0 or page_height <= 0:
        return None
    left = min(rect[0] for rect in rects)
    top = min(rect[1] for rect in rects)
    right = max(rect[0] + rect[2] for rect in rects)
    bottom = max(rect[1] + rect[3] for rect in rects)
    return [
        round(max(0.0, min(1.0, left / page_width)), 4),
        round(max(0.0, min(1.0, top / page_height)), 4),
        round(max(0.0, min(1.0, right / page_width)), 4),
        round(max(0.0, min(1.0, bottom / page_height)), 4),
    ]


def _llama_item_text(item: Dict[str, Any]) -> str:
    value = _llama_raw_item_text(item)
    return value.strip()


def _llama_table_cell_text(cell: Any) -> str:
    if isinstance(cell, str):
        return cell.strip()
    if isinstance(cell, dict):
        return _llama_item_text(cell) or str(cell.get("value") or "").strip()
    return str(cell or "").strip()


def _llama_table_text(item: Dict[str, Any]) -> str:
    """Keep a useful text representation when a table has no markdown field."""
    text = _llama_item_text(item)
    if text:
        return text
    rows = item.get("rows") or item.get("cells")
    if not isinstance(rows, list):
        return ""
    lines = []
    for row in rows:
        if isinstance(row, list):
            values = [_llama_table_cell_text(cell) for cell in row]
        else:
            values = [_llama_table_cell_text(row)]
        if any(values):
            lines.append(" | ".join(values))
    return "\n".join(lines)


def _llama_list_text(item: Dict[str, Any]) -> str:
    text = _llama_item_text(item)
    if not text:
        return ""
    if re.match(r"^\s*(?:[-*+•‣◦▪]|\d+[.)])(?:\s|$)", text):
        return text
    marker = str(item.get("marker") or item.get("bullet") or "•").strip()
    return "{} {}".format(marker, text)


def _llama_is_table_item(item: Dict[str, Any]) -> bool:
    normalized = str(item.get("type") or "").lower()
    return normalized in {"table", "table_cell", "cell"} or isinstance(item.get("rows"), list)


def _llama_item_block_type(item: Dict[str, Any]) -> str:
    block_type = _llama_block_type(item.get("type"))
    text = _llama_item_text(item)
    if block_type == "text" and (
        item.get("is_list")
        or item.get("list_type")
        or re.match(r"^\s*(?:[-*+•‣◦▪]|\d+[.)])(?:\s|$)", text)
    ):
        return "list"
    return block_type


def _llama_grounding_boxes(raw: Any) -> List[Any]:
    """Collect nested x/y/w/h or l/t/r/b boxes from table grounding."""
    if isinstance(raw, dict):
        if any(all(key in raw for key in keys) for keys in (("x", "y", "w", "h"), ("left", "top", "right", "bottom"), ("l", "t", "r", "b"))):
            return [raw]
        return []
    if isinstance(raw, (list, tuple)):
        if len(raw) >= 4 and all(isinstance(value, (int, float)) for value in raw[:4]):
            return [list(raw[:4])]
        boxes: List[Any] = []
        for value in raw:
            boxes.extend(_llama_grounding_boxes(value))
        return boxes
    return []


def _llama_table_grounding_bbox(grounding: Dict[str, Any], page_width: float, page_height: float) -> Optional[List[float]]:
    raw_boxes: List[Any] = []
    for row in grounding.get("rows") or []:
        for cell in row or []:
            if isinstance(cell, dict):
                raw_boxes.extend(_llama_grounding_boxes(cell.get("bbox")))
    for key in ("row_bboxes", "column_bboxes"):
        raw_boxes.extend(_llama_grounding_boxes(grounding.get(key)))
    return _llama_normalized_bbox(raw_boxes, page_width, page_height) if raw_boxes else None


def _llama_table_row_count(text: str) -> int:
    """Count meaningful markdown table rows for display-box estimation."""
    rows = []
    for line in str(text or "").splitlines():
        normalized = line.strip()
        if not normalized or "|" not in normalized:
            continue
        cells = [cell.strip() for cell in normalized.strip("|").split("|")]
        if cells and all(set(cell.replace(" ", "")) <= {"-", ":"} for cell in cells):
            continue
        rows.append(normalized)
    return max(1, len(rows))


def _llama_usable_table_bbox(bbox: Optional[List[float]], text: str) -> bool:
    """Reject cell-only boxes when a table contains more content."""
    if not bbox or len(bbox) < 4:
        return False
    width = max(0.0, float(bbox[2]) - float(bbox[0]))
    height = max(0.0, float(bbox[3]) - float(bbox[1]))
    row_count = _llama_table_row_count(text)
    return width >= 0.35 and height >= max(0.035, min(0.18, row_count * 0.014))


def _llama_inferred_table_bboxes(
    items: List[Any],
    blocks: List[DocumentBlock],
    page_width: float,
    page_height: float,
) -> Dict[int, List[float]]:
    """Estimate missing table extents from neighboring grounded blocks.

    LlamaParse can return complete markdown/table content while omitting an
    item bbox or returning grounding for only one header/cell. The estimate is
    intentionally broad and marked as inferred; it is useful for the layout
    viewer but must not be used as a precise citation location.
    """
    table_entries = []
    table_text_by_index = {}
    for index, item in enumerate(items):
        if not isinstance(item, dict) or not _llama_is_table_item(item):
            continue
        text = _llama_table_text(item)
        table_entries.append((index, text))
        table_text_by_index[index] = text

    missing = []
    usable = {}
    for index, text in table_entries:
        item_bbox = _llama_normalized_bbox(items[index].get("bbox"), page_width, page_height)
        if _llama_usable_table_bbox(item_bbox, text):
            usable[index] = item_bbox
        else:
            # A small bbox is often the first/header cell rather than the
            # whole table. Keep its vertical position as a placement hint,
            # but never expose it as the table's actual extent.
            missing.append((index, text, item_bbox))
    if not missing:
        return {}

    anchors = []
    for block in blocks:
        source_index = block.metadata.get("source_index")
        if block.bbox and isinstance(source_index, int):
            anchors.append((source_index, block.block_id, block.bbox))
    for index, bbox in usable.items():
        anchors.append((index, "table-{}".format(index), bbox))
    anchors.sort(key=lambda item: item[0])

    # Calibrate the estimated row height from a complete table on the same
    # page when possible. This avoids stretching multiple missing tables to
    # fill all remaining page whitespace.
    row_heights = []
    for index, bbox in usable.items():
        row_count = _llama_table_row_count(table_text_by_index[index])
        height = max(0.0, bbox[3] - bbox[1])
        if row_count and height:
            row_heights.append(height / row_count)
    estimated_row_height = sum(row_heights) / len(row_heights) if row_heights else 0.018
    estimated_row_height = max(0.012, min(0.028, estimated_row_height))

    # Infer each table in source order. A missing table may have a tiny cell
    # bbox, and the next table may have no bbox at all, so a group-wide split
    # can place an earlier table on top of a later one. Sequential placement
    # keeps each estimate in its section and gives every table a realistic
    # content-sized height.
    inferred: Dict[int, List[float]] = {}
    gap = 0.018
    missing_by_index = sorted(missing, key=lambda entry: entry[0])
    for index, text, hint_bbox in missing_by_index:
        previous = next((anchor for anchor in reversed(anchors) if anchor[0] < index), None)
        following = next((anchor for anchor in anchors if anchor[0] > index), None)
        next_hint = next(
            (entry[2] for entry in missing_by_index if entry[0] > index and entry[2]),
            None,
        )

        previous_top = (previous[2][3] + gap) if previous else 0.06
        hinted_top = hint_bbox[1] if hint_bbox else None
        top = max(previous_top, hinted_top or previous_top)
        top = max(0.04, min(0.92, top))

        row_count = _llama_table_row_count(text)
        expected_bottom = top + max(0.06, row_count * estimated_row_height)
        boundaries = []
        if following:
            boundaries.append(following[2][1] - gap)
        if next_hint:
            boundaries.append(next_hint[1] - gap)
        bottom = min([expected_bottom] + boundaries) if boundaries else expected_bottom
        bottom = max(top + 0.06, min(0.96, bottom))
        inferred[index] = [0.035, round(top, 4), 0.965, round(bottom, 4)]
        anchors.append((index, "inferred-{}".format(index), inferred[index]))
        anchors.sort(key=lambda item: item[0])
    return inferred


def _llama_grounded_item(item: Dict[str, Any], index: int, grounded_items: List[Any]) -> Dict[str, Any]:
    if index < len(grounded_items) and isinstance(grounded_items[index], dict):
        candidate = grounded_items[index]
        if _llama_block_type(candidate.get("type")) == _llama_block_type(item.get("type")):
            return candidate
    item_type = _llama_block_type(item.get("type"))
    item_text = _llama_table_text(item) if item_type == "table" else _llama_item_text(item)
    for candidate in grounded_items:
        if not isinstance(candidate, dict) or _llama_block_type(candidate.get("type")) != item_type:
            continue
        candidate_text = _llama_table_text(candidate) if item_type == "table" else _llama_item_text(candidate)
        if item_text and candidate_text == item_text:
            return candidate
    return {}


def _llama_raw_item_text(item: Dict[str, Any]) -> str:
    for key in ("md", "value", "text", "content"):
        value = item.get(key)
        if isinstance(value, str) and value:
            return value
    return ""


def _llama_block_type(item_type: Any) -> str:
    normalized = str(item_type or "text").lower()
    if normalized in {"heading", "title", "header"}:
        return "heading"
    if normalized in {"list", "list_item", "list-item", "bullet", "numbered_list_item"}:
        return "list"
    if normalized in {"table", "table_cell", "cell"}:
        return "table"
    return "text"


def _llama_json_request(url: str, api_key: str, method: str = "GET", payload: Optional[Dict[str, Any]] = None, timeout: float = 60) -> Dict[str, Any]:
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"Authorization": "Bearer {}".format(api_key), "Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError("Llama Parse request failed ({}): {}".format(error.code, detail[:300])) from error
    except (urllib.error.URLError, TimeoutError) as error:
        raise RuntimeError("Llama Parse request failed: {}".format(error)) from error
    try:
        value = json.loads(raw) if raw else {}
    except ValueError as error:
        raise RuntimeError("Llama Parse returned invalid JSON") from error
    return value if isinstance(value, dict) else {}


def _llama_multipart_payload(filename: str, data: bytes, mime_type: str, configuration: Dict[str, Any]) -> Tuple[bytes, str]:
    boundary = "----ezpz-llama-{}".format(uuid.uuid4().hex)
    chunks = []

    def add_field(name: str, value: str) -> None:
        chunks.extend([
            "--{}\r\n".format(boundary).encode(),
            'Content-Disposition: form-data; name="{}"\r\n\r\n'.format(name).encode(),
            value.encode("utf-8"),
            b"\r\n",
        ])

    add_field("configuration", json.dumps(configuration, separators=(",", ":")))
    chunks.extend([
        "--{}\r\n".format(boundary).encode(),
        'Content-Disposition: form-data; name="file"; filename="{}"\r\n'.format(Path(filename).name or "document").encode(),
        "Content-Type: {}\r\n\r\n".format(mime_type or "application/octet-stream").encode(),
        data,
        b"\r\n",
        "--{}--\r\n".format(boundary).encode(),
    ])
    return b"".join(chunks), "multipart/form-data; boundary={}".format(boundary)


def _llama_upload(url: str, api_key: str, filename: str, data: bytes, mime_type: str, configuration: Dict[str, Any], timeout: float) -> Dict[str, Any]:
    body, content_type = _llama_multipart_payload(filename, data, mime_type, configuration)
    request = urllib.request.Request(
        url,
        data=body,
        headers={"Authorization": "Bearer {}".format(api_key), "Accept": "application/json", "Content-Type": content_type},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError("Llama Parse upload failed ({}): {}".format(error.code, detail[:300])) from error
    except (urllib.error.URLError, TimeoutError) as error:
        raise RuntimeError("Llama Parse upload failed: {}".format(error)) from error
    try:
        value = json.loads(raw) if raw else {}
    except ValueError as error:
        raise RuntimeError("Llama Parse upload returned invalid JSON") from error
    return value if isinstance(value, dict) else {}


def _llama_grounded_pages(url: Optional[str], timeout: float) -> List[Dict[str, Any]]:
    if not url:
        return []
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError):
        return []
    pages = []
    for line in raw.splitlines():
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except ValueError:
            continue
        if isinstance(value, dict):
            pages.append(value)
    return pages


def _llama_grounded_blocks(raw_page: Dict[str, Any], page_width: float, page_height: float) -> List[DocumentBlock]:
    blocks: List[DocumentBlock] = []
    for item_index, item in enumerate(raw_page.get("items") or []):
        if not isinstance(item, dict):
            continue
        item_text = _llama_raw_item_text(item)
        grounding = item.get("grounding") if isinstance(item.get("grounding"), dict) else {}
        for line_index, line in enumerate(grounding.get("lines") or []):
            if not isinstance(line, dict):
                continue
            span = line.get("span") or []
            try:
                start, end = int(span[0]), int(span[1])
            except (IndexError, TypeError, ValueError):
                continue
            text = item_text[start:end].strip()
            block_type = _llama_item_block_type(item)
            if block_type == "list" and text:
                text = _llama_list_text({**item, "md": text})
            bbox = _llama_normalized_bbox(line.get("bbox"), page_width, page_height)
            if not text or not bbox:
                continue
            blocks.append(
                DocumentBlock(
                    block_id="p{}-g{}-{}".format(raw_page.get("page_number", 1), item_index + 1, line_index + 1),
                    block_type=block_type,
                    text=text,
                    bbox=bbox,
                    confidence=None,
                    metadata={
                        "source": "llama-parse",
                        "grounding": "line",
                        "source_index": item_index,
                        "line_index": line_index,
                        **({"layoutClass": "List Item"} if block_type == "list" else {}),
                    },
                )
            )
    return blocks


def _llama_pages_from_result(result: Dict[str, Any], document: Dict[str, Any], grounded_pages: List[Dict[str, Any]]) -> Tuple[List[DocumentPage], bool]:
    item_pages = ((result.get("items") or {}).get("pages") or [])
    markdown_pages = ((result.get("markdown") or {}).get("pages") or [])
    text_pages = ((result.get("text") or {}).get("pages") or [])
    by_number: Dict[int, Dict[str, Any]] = {}
    for source_pages, source_name in ((item_pages, "items"), (markdown_pages, "markdown"), (text_pages, "text")):
        for raw_page in source_pages:
            if not isinstance(raw_page, dict):
                continue
            try:
                page_number = int(raw_page.get("page_number") or len(by_number) + 1)
            except (TypeError, ValueError):
                page_number = len(by_number) + 1
            by_number.setdefault(page_number, {}).update({source_name: raw_page})
    for raw_page in grounded_pages:
        try:
            page_number = int(raw_page.get("page_number") or len(by_number) + 1)
        except (TypeError, ValueError):
            page_number = len(by_number) + 1
        by_number.setdefault(page_number, {})["grounded"] = raw_page

    if not by_number:
        return [], False
    pages: List[DocumentPage] = []
    has_layout = False
    for page_number in sorted(by_number):
        sources = by_number[page_number]
        item_page = sources.get("items") or {}
        markdown_page = sources.get("markdown") or {}
        text_page = sources.get("text") or {}
        grounded_page = sources.get("grounded") or {}
        page_width = float(item_page.get("page_width") or grounded_page.get("page_width") or 1)
        page_height = float(item_page.get("page_height") or grounded_page.get("page_height") or 1)
        blocks = _llama_grounded_blocks(grounded_page, page_width, page_height)
        if blocks:
            has_layout = True
        grounded_items = grounded_page.get("items") or []
        inferred_table_bboxes = _llama_inferred_table_bboxes(
            item_page.get("items") or [],
            blocks,
            page_width,
            page_height,
        )
        for index, item in enumerate(item_page.get("items") or []):
            if not isinstance(item, dict) or not _llama_is_table_item(item):
                continue
            table_text = _llama_table_text(item)
            grounded_item = _llama_grounded_item(item, index, grounded_items)
            grounding = grounded_item.get("grounding") if isinstance(grounded_item.get("grounding"), dict) else {}
            grounding_bbox = _llama_table_grounding_bbox(grounding, page_width, page_height)
            item_bbox = _llama_normalized_bbox(item.get("bbox"), page_width, page_height)
            bbox = grounding_bbox or item_bbox
            display_bbox = inferred_table_bboxes.get(index) or bbox
            if not table_text and not display_bbox:
                continue
            if any(block.block_type == "table" and block.text == table_text for block in blocks):
                continue
            blocks.append(
                DocumentBlock(
                    block_id="p{}-t{}".format(page_number, index + 1),
                    block_type="table",
                    text=table_text or "Table",
                    bbox=display_bbox,
                    confidence=None,
                    metadata={
                        "source": "llama-parse",
                        "layout": bool(display_bbox),
                        "bbox_source": "inferred" if index in inferred_table_bboxes else ("grounding" if grounding_bbox else "item"),
                        "grounding": "cell" if grounding.get("rows") else "table",
                        "source_index": index,
                    },
                )
            )
            has_layout = has_layout or bool(bbox)
        for index, item in enumerate(item_page.get("items") or []):
            if not isinstance(item, dict) or _llama_item_block_type(item) != "list":
                continue
            grounded_item = _llama_grounded_item(item, index, grounded_items)
            grounding = grounded_item.get("grounding") if isinstance(grounded_item.get("grounding"), dict) else {}
            if grounding.get("lines"):
                continue
            list_text = _llama_list_text(item)
            if not list_text:
                continue
            bbox = _llama_normalized_bbox(item.get("bbox"), page_width, page_height)
            blocks.append(
                DocumentBlock(
                    block_id="p{}-l{}".format(page_number, index + 1),
                    block_type="list",
                    text=list_text,
                    bbox=bbox,
                    confidence=None,
                    metadata={
                        "source": "llama-parse",
                        "layout": bool(bbox),
                        "source_index": index,
                        "layoutClass": "List Item",
                    },
                )
            )
            has_layout = has_layout or bool(bbox)
        if not blocks:
            for index, item in enumerate(item_page.get("items") or []):
                if not isinstance(item, dict):
                    continue
                item_type = _llama_item_block_type(item)
                text = _llama_list_text(item) if item_type == "list" else _llama_item_text(item)
                if not text:
                    continue
                bbox = _llama_normalized_bbox(item.get("bbox"), page_width, page_height)
                if bbox:
                    has_layout = True
                blocks.append(
                    DocumentBlock(
                        block_id="p{}-b{}".format(page_number, index + 1),
                        block_type=item_type,
                        text=text,
                        bbox=bbox or [0.06, 0.06 + min(0.84, index * 0.05), 0.94, 0.1 + min(0.84, index * 0.05)],
                        confidence=None,
                        metadata={
                            "source": "llama-parse",
                            "layout": bool(bbox),
                            "source_index": index,
                            **({"layoutClass": "List Item"} if item_type == "list" else {}),
                        },
                    )
                )
        blocks.sort(key=lambda block: (
            0 if block.bbox else 1,
            block.bbox[1] if block.bbox and len(block.bbox) > 1 else 1.0,
            block.bbox[0] if block.bbox else 0.0,
            block.metadata.get("source_index", 10**9),
            block.metadata.get("line_index", 10**9),
        ))
        if not blocks:
            page_text = str(markdown_page.get("markdown") or text_page.get("text") or "")
            blocks = _text_blocks(page_text, page_number)
        pages.append(DocumentPage(page=page_number, width=page_width, height=page_height, blocks=blocks))
    return pages, has_layout


def _llama_parse_pages(document: Dict[str, Any], data: bytes, parser_config: Dict[str, Any]) -> Tuple[List[DocumentPage], Dict[str, Any], List[str]]:
    config = parser_config.get("config") if isinstance(parser_config.get("config"), dict) else {}
    credential_ref = str(config.get("credential_ref") or parser_config.get("credential_ref") or "").strip()
    api_key = os.environ.get(credential_ref) if credential_ref else (os.environ.get("LLAMA_CLOUD_API_KEY") or os.environ.get("LLAMA_PARSE_API_KEY"))
    if not api_key:
        raise RuntimeError("LLAMA_CLOUD_API_KEY is not set")
    base_url = str(config.get("base_url") or os.environ.get("LLAMA_PARSE_BASE_URL") or "https://api.cloud.llamaindex.ai/api/v2").rstrip("/")
    timeout = max(10.0, float(config.get("timeout_s") or 120))
    tier = str(config.get("tier") or "agentic")
    version = str(config.get("api_version") or "latest")
    output_options = dict(config.get("output_options") or {})
    # LlamaParse v2 models spatial_text as an options object, not a boolean.
    # Keep accepting the old boolean config so existing saved drafts do not
    # cause a validation error on the next live parse.
    if output_options.get("spatial_text") is True:
        output_options["spatial_text"] = {}
    elif output_options.get("spatial_text") is False:
        output_options.pop("spatial_text", None)
    else:
        output_options.setdefault("spatial_text", {})
    output_options.setdefault("granular_bboxes", ["word", "line", "cell"])
    configuration = {"tier": tier, "version": version, "output_options": output_options}
    upload = _llama_upload(
        base_url + "/parse/upload",
        api_key,
        str(document.get("filename") or "document"),
        data,
        str(document.get("mime_type") or "application/octet-stream"),
        configuration,
        timeout,
    )
    job_id = str(upload.get("id") or "")
    if not job_id:
        raise RuntimeError("Llama Parse upload did not return a job id")
    status = str(upload.get("status") or "PENDING").upper()
    result = upload
    deadline = time.monotonic() + timeout
    while status not in {"COMPLETED", "FAILED", "CANCELLED"}:
        if time.monotonic() >= deadline:
            raise RuntimeError("Llama Parse job {} timed out".format(job_id))
        time.sleep(min(2.0, max(0.0, deadline - time.monotonic())))
        query = urllib.parse.urlencode({"expand": "markdown,items,metadata,usage"})
        result = _llama_json_request("{}/parse/{}?{}".format(base_url, urllib.parse.quote(job_id, safe=""), query), api_key, timeout=timeout)
        job = result.get("job") if isinstance(result.get("job"), dict) else result
        status = str(job.get("status") or "PENDING").upper()
    if status != "COMPLETED":
        job = result.get("job") if isinstance(result.get("job"), dict) else result
        raise RuntimeError("Llama Parse job {} ended with {}{}".format(job_id, status, ": {}".format(job.get("error_message")) if job.get("error_message") else ""))
    if not result.get("items") and not result.get("markdown") and not result.get("text"):
        query = urllib.parse.urlencode({"expand": "markdown,items,metadata,usage"})
        result = _llama_json_request("{}/parse/{}?{}".format(base_url, urllib.parse.quote(job_id, safe=""), query), api_key, timeout=timeout)
    content_metadata = result.get("result_content_metadata") if isinstance(result.get("result_content_metadata"), dict) else {}
    grounded = content_metadata.get("grounded_items") if isinstance(content_metadata.get("grounded_items"), dict) else {}
    grounded_pages = _llama_grounded_pages(grounded.get("presigned_url"), timeout)
    pages, has_layout = _llama_pages_from_result(result, document, grounded_pages)
    details = {
        "job_id": job_id,
        "tier": tier,
        "api_version": version,
        "grounded_bboxes": bool(grounded_pages),
        "layout_boxes": bool(has_layout),
    }
    warnings = []
    if output_options.get("granular_bboxes") and not grounded_pages:
        warnings.append("Llama Parse completed, but its grounded-items sidecar was unavailable; using item-level layout boxes.")
    return pages, details, warnings


def parse_document(document: Dict[str, Any], data: bytes, parser_config: Dict[str, Any]) -> DocumentIR:
    parser_name = normalize_parser_name(parser_config.get("name") or parser_config.get("provider") or "docling")
    parser_version = parser_config.get("version", "2.10")
    recorded_page_count = int(document.get("page_count") or 0)
    detected_page_count = count_pdf_pages(data) if looks_like_pdf(data) else 1
    page_count = max(recorded_page_count, detected_page_count, 1)
    text = _document_text(document, data)
    page_texts = text.split("\f") if "\f" in text else [text]
    page_count = max(page_count, len(page_texts))
    pages = []
    for index in range(page_count):
        page_text = page_texts[index] if index < len(page_texts) else ""
        pages.append(
            DocumentPage(
                page=index + 1,
                width=1.0,
                height=1.0,
                blocks=_text_blocks(page_text, index + 1),
            )
        )

    warnings = []
    adapter_status = "compatibility"
    parser_details: Dict[str, Any] = {}
    image_pages = _image_layout_pages(document, data, text) if parser_config.get("config", {}).get("ocr", True) is not False else None
    if parser_name in {"llama-parse", "llamaparse", "llama_parse"}:
        try:
            llama_pages, parser_details, llama_warnings = _llama_parse_pages(document, data, parser_config)
            if llama_pages:
                pages = llama_pages
                page_count = len(pages)
                adapter_status = "available"
                warnings.extend(llama_warnings)
            else:
                warnings.append("Llama Parse returned no page content; compatibility parsing preserved the local text.")
        except RuntimeError as error:
            warnings.append("Llama Parse unavailable: {}. Compatibility parsing preserved local text.".format(error))
    elif image_pages:
        pages = image_pages
        page_count = len(pages)
        adapter_status = "available"
    elif parser_name == "docling":
        docling_pages = _docling_pages(document, data)
        if docling_pages:
            pages = docling_pages
            page_count = len(pages)
            adapter_status = "available"
        else:
            warnings.append(
                "Layout OCR is unavailable for this image and Docling is unavailable for other source types; "
                "compatibility parsing preserved text blocks without evidence coordinates."
            )
    else:
        warnings.append("Parser adapter '{}' is running in local text compatibility mode.".format(parser_name))

    return DocumentIR(
        document_id=document["id"],
        parser={
            "name": parser_name,
            "version": parser_version,
            "status": adapter_status,
            "warnings": warnings,
            **parser_details,
        },
        metadata={
            "filename": document["filename"],
            "mime_type": document["mime_type"],
            "page_count": page_count,
            "text_length": len(text),
        },
        pages=pages,
    )


def get_parser_catalog() -> List[Dict[str, Any]]:
    """Return parser adapters that can be selected by the playground."""
    return get_adapter_catalog()["parsers"]
