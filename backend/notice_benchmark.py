"""Notice-specific reference preparation; CUAD is a document source only."""
import calendar
import csv
import json
import re
import subprocess
import unicodedata
from collections import Counter
from datetime import datetime
from pathlib import Path

from .cuad import ATTRIBUTION, column_key, digest, file_hash, title_key, unique_index
from .notice_fixtures import fixtures


ROOT = Path(__file__).resolve().parents[1]


def compact(text):
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", text)).casefold().replace("’", "'").replace("‘", "'")


def explicit_date(raw, spans):
    try:
        value = next(datetime.strptime(raw.strip(), fmt).date() for fmt in ("%m/%d/%Y", "%m/%d/%y", "%Y-%m-%d") if _parses(raw, fmt))
    except StopIteration:
        return None
    year, month, day = value.year, value.month, value.day
    patterns = [rf"\b{year}-{month:02}-{day:02}\b", rf"\b0?{month}/0?{day}/(?:{year}|{str(year)[2:]})\b",
                rf"\b(?:{calendar.month_name[month]}|{calendar.month_abbr[month]})\.?\s+0?{day}(?:st|nd|rd|th)?\s*,?\s*{year}\b",
                rf"\b0?{day}(?:st|nd|rd|th)?\s+(?:day of\s+)?(?:{calendar.month_name[month]}|{calendar.month_abbr[month]})\s*,?\s*{year}\b"]
    return value.isoformat() if any(re.search(pattern, span["text"], re.I) for span in spans for pattern in patterns) else None


def _parses(raw, fmt):
    try:
        datetime.strptime(raw.strip(), fmt)
        return True
    except ValueError:
        return False


def notice_period(raw, spans):
    # Only uncomplicated durations are reusable. Never collapse notice ranges,
    # after-term requirements, or redacted conditions into a numeric deadline.
    match = re.fullmatch(r"\s*(\d+)\s+(days?|months?)\s*", raw, re.I)
    if not match or not spans:
        return None
    text = " ".join(s["text"] for s in spans)
    if re.search(r"within|October 1|interruptible|firm transportation", text, re.I):
        return None
    number, unit = match.groups()
    if unit.lower().startswith("month"):
        unit = "months"
    elif re.search(r"business\s+days", text, re.I):
        unit = "business days"
    elif re.search(r"calendar\s+days", text, re.I):
        unit = "calendar days"
    else:
        unit = "unclear"  # Notice explicitly forbids inferring calendar days.
    return number, unit


def export_processor(notice_root, model="gpt-4.1-mini"):
    root = Path(notice_root).resolve()
    process = subprocess.run(["node", "--import", "tsx", "scripts/eval-bridge.ts", "--spec"], cwd=root, capture_output=True, text=True, check=True)
    spec = json.loads(process.stdout)
    paths = ["scripts/eval-bridge.ts", "server/extraction.ts", "shared/domain.ts"]
    return {
        "schema": spec["schema"], "prompt": {"system": spec["instructions"], "extraction": "", "max_tokens": 7000},
        "model": {"provider": "openai", "name": model}, "parser": {"name": "native", "version": "1"},
        "harness": {"name": "custom", "plugin": "backend.notice_harness:run", "notice_root": str(root),
                    "schema_hash": spec["schemaHash"], "source_hashes": {p: file_hash(root / p) for p in paths}},
        "normalization": {},
    }


def prepare(source, notice_root, output, model="gpt-4.1-mini"):
    from pypdf import PdfReader
    source = Path(source).expanduser().resolve()
    if (source / "CUAD_v1").exists():
        source = source / "CUAD_v1"
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    chosen = json.loads((ROOT / "benchmarks/notice/selection.json").read_text())
    data = unique_index(json.loads((source / "CUAD_v1.json").read_text())["data"], lambda d: title_key(d["title"]))
    pdfs = unique_index((p for p in (source / "full_contract_pdf").rglob("*") if p.suffix.lower() == ".pdf"), lambda p: title_key(p.stem))
    with (source / "master_clauses.csv").open(encoding="utf-8-sig", newline="") as stream:
        rows = unique_index(csv.DictReader(stream), lambda r: title_key(Path(r["Filename"]).stem))
    processor = export_processor(notice_root, model)
    keys = list(processor["schema"]["properties"])
    documents, source_labels = [], []
    for index, selection in enumerate(chosen):
        key = title_key(selection["title"])
        doc, pdf, row = data[key], pdfs[key], rows[key]
        paragraph = doc["paragraphs"][0]
        qas = {q["id"].rsplit("__", 1)[-1]: q for q in paragraph["qas"]}
        context = paragraph["context"]
        pages = [page.extract_text() or "" for page in PdfReader(pdf).pages]
        page_keys = [compact(page) for page in pages]
        if sum(len(p) for p in pages) < 100:
            raise ValueError("PDF has no usable text: " + pdf.name)
        columns = {column_key(k): v for k, v in row.items()}
        truth, evidence = {}, {}

        def add(field, value, quote, origin="source_review", status="extracted", status_only=False):
            # Only source-backed targets are scored. Absence is never inferred
            # from CUAD's lack of an annotation or a failed quote match.
            quote_key = compact(quote)
            page_numbers = [i + 1 for i, page in enumerate(page_keys) if quote_key in page] if quote_key else []
            joined = "".join(page_keys)
            if not quote_key or quote_key not in compact(context) or quote_key not in joined:
                return False
            truth[field] = {"status": status} if status_only else {"value": value, "status": status}
            evidence[field] = {"excerpt": quote, "pages": page_numbers, "reference_type": origin,
                               "note": "Empty page list means the supporting passage crosses PDF pages; no page location was fabricated."}
            return True

        # Direct, stated dates only. Agreement/amendment execution dates and
        # CUAD-derived initial expiration dates are not substituted for renewals.
        is_amendment = bool(re.search(r"amendment|addendum", context[:1100], re.I))
        for field, category in (("startDate", "Effective Date"), ("endDate", "Expiration Date")):
            spans = qas[category]["answers"]
            answer = explicit_date(columns[column_key(category + "-Answer")], spans)
            if answer and not is_amendment:
                for span in spans:
                    if explicit_date(columns[column_key(category + "-Answer")], [span]) and add(field, answer, span["text"], "CUAD_human_label_with_explicit_source_date"):
                        break
        spans = qas["Notice Period To Terminate Renewal"]["answers"]
        parsed = notice_period(columns[column_key("Notice Period To Terminate Renewal-Answer")], spans)
        if parsed:
            for span in spans:
                if add("noticePeriod", parsed[0], span["text"], "CUAD_human_label_with_notice_definition_mapping"):
                    add("noticeUnit", parsed[1], span["text"], "Notice_unit_definition_applied_to_source")
                    break
        review = selection["review"]
        if review.get("vendor"):
            # Supplier role was reviewed in the source; preserve a verbatim
            # name, allowing PDF whitespace/case normalization, never rename a
            # customer into a supplier based on CUAD's unordered parties list.
            wanted = compact(review["vendor"])
            # The reviewed spelling is normally itself in the source. If not,
            # defer it rather than fabricating an exact quote.
            if wanted in compact(context):
                add("vendor", review["vendor"], review["vendor"], "Codex_supplier_role_review")
        renewal_spans = qas["Renewal Term"]["answers"]
        for field in ("autoRenew", "months"):
            if field in review:
                for span in renewal_spans:
                    if add(field, review[field], span["text"], "Codex_renewal_clause_review"):
                        break
        for field in ("conditions", "uplift"):
            if review.get(field + "_present"):
                for span in spans + renewal_spans:
                    if add(field, None, span["text"], "Codex_clause_presence_review", status_only=True):
                        break
        for annotation in selection.get("extra_references", []):
            add(annotation["field"], annotation.get("value"), annotation["excerpt"],
                "Codex_additional_source_clause_review", status_only=annotation.get("status_only", False))
        # This entire short hosting agreement was inspected. It supplies rates
        # but no total next-term commitment or renewal/notice procedure.
        if selection["title"].startswith("BANGIINC"):
            for field in ("renewalDate", "autoRenew", "noticePeriod", "noticeUnit", "timezone", "amount", "seats", "uplift", "method", "recipient", "conditions"):
                truth[field] = {"value": None, "status": "not_found"}
                evidence[field] = {"reference_type": "Codex_full_document_absence_review", "pages": list(range(1, len(pages) + 1))}
            add("months", "12", "The effective term is 12 months beginning March 1, 2005 and ending February 28, 2006.")
            add("billing", "monthly", "The billing cycle is the 1st of each month.")
        if not truth:
            raise ValueError("No source-supported Notice reference fields: " + selection["title"])
        evidence["_notice"] = {"reference_type": "real_contract_partial_reference", "review_note": selection["review_note"],
                                "unscored_fields": [k for k in keys if k not in truth], "source": "CUAD v1", "source_pdf_sha256": file_hash(pdf)}
        documents.append({"title": selection["title"], "path": str(pdf), "kind": selection["kind"], "family": selection["family"],
                          "cohort": "real", "value": truth, "evidence": evidence, "pages": len(pages)})
        source_labels.append({"title": doc["title"], "csv_row": row, "qas": paragraph["qas"], "context": context})
    # Keep documents from the same filing-company family together across the
    # 40/10 split (for example an order form and its related amendment).
    families = Counter(d["family"] for d in documents)
    held, remaining = set(), 10
    for family in sorted(families, key=lambda family: digest(["notice-v1", family])):
        if families[family] <= remaining:
            held.add(family)
            remaining -= families[family]
        if remaining == 0:
            break
    if remaining:
        raise ValueError("Cannot form a family-disjoint ten-document holdout")
    for d in documents:
        d["split"] = "test" if d["family"] in held else "dev"
    documents += fixtures(output / "fixtures", keys)
    for d in documents:
        d["sha256"] = file_hash(d["path"])
    fingerprint = digest([{k: d[k] for k in ("title", "sha256", "cohort", "split", "value", "evidence")} for d in documents])
    coverage = {"documents": len(documents), "real": 50, "authored_regressions": 10,
                "real_kinds": dict(Counter(d["kind"] for d in documents if d["cohort"] == "real")),
                "fields": {key: {cohort: {"value_targets": sum("value" in d["value"].get(key, {}) for d in documents if d["cohort"] == cohort),
                                          "status_targets": sum("status" in d["value"].get(key, {}) for d in documents if d["cohort"] == cohort)}
                                  for cohort in ("real", "regression")} for key in keys}}
    bundle = {"fingerprint": fingerprint, "documents": documents, "processor": processor, "coverage": coverage,
              "attribution": ATTRIBUTION, "source_hashes": {"squad": file_hash(source / "CUAD_v1.json"), "csv": file_hash(source / "master_clauses.csv")}}
    (output / "benchmark.json").write_text(json.dumps(bundle, ensure_ascii=False, indent=2) + "\n")
    (output / "coverage.json").write_text(json.dumps(coverage, indent=2) + "\n")
    (output / "source-labels.jsonl").write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in source_labels))
    (output / "review-queue.json").write_text(json.dumps([{"title": d["title"], "unscored_fields": d["evidence"]["_notice"].get("unscored_fields", [])} for d in documents if d["cohort"] == "real"], indent=2) + "\n")
    return bundle
