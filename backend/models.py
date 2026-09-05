from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
import uuid


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def new_id(prefix: str) -> str:
    return "{}_{}".format(prefix, uuid.uuid4().hex[:16])


@dataclass
class Evidence:
    page: int
    bbox: List[float]
    text: str = ""
    block_id: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "page": self.page,
            "bbox": self.bbox,
            "text": self.text,
            "block_id": self.block_id,
            "metadata": self.metadata,
        }


@dataclass
class FieldResult:
    value: Any
    normalized_value: Any
    confidence: Optional[float]
    evidence: List[Evidence] = field(default_factory=list)
    errors: List[str] = field(default_factory=list)
    provenance: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "value": self.value,
            "normalized_value": self.normalized_value,
            "confidence": self.confidence,
            "evidence": [item.to_dict() for item in self.evidence],
            "errors": self.errors,
            "provenance": self.provenance,
        }


@dataclass
class CanonicalResult:
    fields: Dict[str, FieldResult]
    errors: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    provenance: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "fields": {key: value.to_dict() for key, value in self.fields.items()},
            "errors": self.errors,
            "warnings": self.warnings,
            "provenance": self.provenance,
        }


@dataclass
class DocumentBlock:
    block_id: str
    block_type: str
    text: str
    bbox: Optional[List[float]]
    confidence: Optional[float] = None
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.block_id,
            "type": self.block_type,
            "text": self.text,
            "bbox": self.bbox,
            "confidence": self.confidence,
            "metadata": self.metadata,
        }


@dataclass
class DocumentPage:
    page: int
    width: float
    height: float
    blocks: List[DocumentBlock] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "page": self.page,
            "width": self.width,
            "height": self.height,
            "blocks": [block.to_dict() for block in self.blocks],
        }


@dataclass
class DocumentIR:
    document_id: str
    parser: Dict[str, Any]
    metadata: Dict[str, Any]
    pages: List[DocumentPage]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "document_id": self.document_id,
            "parser": self.parser,
            "metadata": self.metadata,
            "pages": [page.to_dict() for page in self.pages],
        }


@dataclass
class ModelResult:
    output: Dict[str, Any]
    raw_response: Any
    usage: Dict[str, Any] = field(default_factory=dict)
    warnings: List[str] = field(default_factory=list)
