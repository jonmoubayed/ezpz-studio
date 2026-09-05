#!/usr/bin/env python3
"""Command-line tools for the local ezpz evaluation workbench."""

import argparse
import json
import mimetypes
import sys
import webbrowser
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from backend.evaluation import compare_evaluations
from backend.server import create_runtime
from backend.models import new_id
from backend.project_config import write_project_config
from backend.project_config import dump_yaml


def _json_value(value: Optional[str], default: Any) -> Any:
    if not value:
        return default
    try:
        return json.loads(value)
    except json.JSONDecodeError as error:
        raise ValueError("invalid JSON: {}".format(error)) from error


def _load_manifest(path: Path) -> Dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("could not read manifest {}: {}".format(path, error)) from error
    if not isinstance(value, dict) or not isinstance(value.get("documents"), list):
        raise ValueError("manifest must be an object with a documents list")
    return value


def _clean_tags(value: Any) -> List[str]:
    if isinstance(value, str):
        value = value.split(",")
    if not isinstance(value, (list, tuple, set)):
        return []
    result: List[str] = []
    for item in value:
        tag = str(item).strip().lower()
        if tag and tag not in result:
            result.append(tag[:80])
    return result[:50]


def _manifest(runtime, dataset_id: str) -> Dict[str, Any]:
    dataset = runtime.database.get_dataset(dataset_id)
    if not dataset:
        raise ValueError("Dataset not found: {}".format(dataset_id))
    documents = []
    for document in runtime.database.list_dataset_documents(dataset_id):
        ground_truth = runtime.database.get_ground_truth(document["id"])
        documents.append(
            {
                "document_id": document["id"],
                "filename": document["filename"],
                "sha256": document.get("sha256"),
                "mime_type": document.get("mime_type"),
                "split": document.get("split") or "unspecified",
                "tags": document.get("tags") or [],
                "ground_truth": {
                    "value": ground_truth.get("value", {}) if ground_truth else {},
                    "evidence": ground_truth.get("evidence", {}) if ground_truth else {},
                    "table_annotations": ground_truth.get("table_annotations", {}) if ground_truth else {},
                    "annotation_status": ground_truth.get("annotation_status", "complete") if ground_truth else "not_started",
                    "revision": ground_truth.get("revision") if ground_truth else None,
                }
                if ground_truth
                else None,
            }
        )
    return {
        "version": 1,
        "dataset": {"id": dataset["id"], "name": dataset["name"], "description": dataset.get("description", "")},
        "documents": documents,
    }


def _import_manifest(runtime, dataset_id: str, manifest: Dict[str, Any], dry_run: bool, author: str) -> Dict[str, Any]:
    known = runtime.database.list_documents()
    by_id = {document["id"]: document for document in known}
    by_hash = {document.get("sha256"): document for document in known if document.get("sha256")}
    imported: List[Dict[str, Any]] = []
    errors: List[Dict[str, Any]] = []
    for index, entry in enumerate(manifest["documents"]):
        if not isinstance(entry, dict):
            errors.append({"index": index, "reason": "entry must be an object"})
            continue
        document = by_id.get(str(entry.get("document_id") or "")) or by_hash.get(str(entry.get("sha256") or ""))
        if not document:
            errors.append({"index": index, "filename": entry.get("filename"), "reason": "document_id or sha256 does not match a workbench document"})
            continue
        split = str(entry.get("split") or "unspecified")
        tags = _clean_tags(entry.get("tags"))
        imported.append({"document_id": document["id"], "filename": document["filename"], "split": split, "tags": tags})
        if dry_run:
            continue
        runtime.database.add_document_to_dataset(dataset_id, document["id"], split)
        runtime.database.update_dataset_document(dataset_id, document["id"], split, tags)
        ground_truth = entry.get("ground_truth")
        if isinstance(ground_truth, dict) and isinstance(ground_truth.get("value"), dict):
            runtime.database.save_ground_truth(
                document["id"],
                ground_truth["value"],
                ground_truth.get("evidence") if isinstance(ground_truth.get("evidence"), dict) else {},
                str(ground_truth.get("annotation_status") or "complete"),
                author,
                merge=False,
                table_annotations=ground_truth.get("table_annotations") if isinstance(ground_truth.get("table_annotations"), dict) else {},
            )
    return {"dataset": runtime.database.get_dataset(dataset_id), "imported": imported, "errors": errors, "dry_run": dry_run}


def _print(value: Any, as_json: bool) -> None:
    if as_json:
        print(json.dumps(value, ensure_ascii=False, indent=2, default=str))
        return
    if isinstance(value, (dict, list)):
        print(json.dumps(value, ensure_ascii=False, indent=2, default=str))
    else:
        print(value)


def _add_common(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent, help="ezpz project/runtime root")
    parser.add_argument("--json", action="store_true", dest="as_json", help="emit machine-readable JSON")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="ezpz", description="Manage documents, eval sets, processors, and runs.")
    _add_common(parser)
    commands = parser.add_subparsers(dest="command", required=True)

    init = commands.add_parser("init", help="initialize a local ezpz project")
    init.add_argument("--name", default="ezpz project")

    serve = commands.add_parser("serve", help="start the local web workbench and API")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=4173)
    serve.add_argument("--no-open", action="store_true", help="do not open the workbench in a browser")

    documents = commands.add_parser("documents", aliases=["docs"], help="ingest and inspect source artifacts")
    document_commands = documents.add_subparsers(dest="documents_command", required=True)
    documents_list = document_commands.add_parser("list")
    documents_list.add_argument("--query", default="")
    documents_add = document_commands.add_parser("add")
    documents_add.add_argument("paths", nargs="+", type=Path)
    documents_add.add_argument("--dataset")
    documents_add.add_argument("--split", default="unspecified")
    documents_add.add_argument("--metadata", help="JSON object")

    datasets = commands.add_parser("datasets", help="create, curate, and exchange eval sets")
    dataset_commands = datasets.add_subparsers(dest="datasets_command", required=True)
    dataset_list = dataset_commands.add_parser("list")
    dataset_create = dataset_commands.add_parser("create")
    dataset_create.add_argument("name")
    dataset_create.add_argument("--description", default="")
    dataset_export = dataset_commands.add_parser("export")
    dataset_export.add_argument("dataset_id")
    dataset_export.add_argument("--output", type=Path)
    dataset_import = dataset_commands.add_parser("import")
    dataset_import.add_argument("dataset_id")
    dataset_import.add_argument("manifest", type=Path)
    dataset_import.add_argument("--author", default="cli")
    dataset_import.add_argument("--dry-run", action="store_true")
    dataset_sample = dataset_commands.add_parser("sample")
    dataset_sample.add_argument("dataset_id")
    dataset_sample.add_argument("--count", type=int, required=True)
    dataset_sample.add_argument("--seed", default="ezpz")
    dataset_sample.add_argument("--tag", action="append", default=[])
    dataset_sample.add_argument("--dry-run", action="store_true")
    dataset_split = dataset_commands.add_parser("split")
    dataset_split.add_argument("dataset_id")
    dataset_split.add_argument("--splits", default='{"train":0.8,"validation":0.1,"test":0.1}', help="JSON object of split ratios")
    dataset_split.add_argument("--seed", default="ezpz")
    dataset_split.add_argument("--stratify-by")
    dataset_split.add_argument("--dry-run", action="store_true")

    processors = commands.add_parser("processors", help="manage processor contracts")
    processor_commands = processors.add_subparsers(dest="processors_command", required=True)
    processor_commands.add_parser("list")
    processor_create = processor_commands.add_parser("create")
    processor_create.add_argument("name")
    processor_create.add_argument("--description", default="")
    processor_create.add_argument("--config", help="JSON processor config")
    processor_export = processor_commands.add_parser("export")
    processor_export.add_argument("processor")
    processor_export.add_argument("--output", type=Path)
    processor_export.add_argument("--format", choices=("json", "yaml"), default="json")

    extract = commands.add_parser("extract", help="extract one document")
    extract.add_argument("document_id")
    extract.add_argument("--processor", default="invoice-extractor")
    extract.add_argument("--version", type=int)
    extract.add_argument("--scoring-config", help="JSON scoring configuration")

    run = commands.add_parser("run", help="run a processor against an eval set")
    run.add_argument("dataset_id")
    run.add_argument("--processor", default="invoice-extractor")
    run.add_argument("--version", type=int)
    run.add_argument("--document-id", action="append", dest="document_ids")
    run.add_argument("--scoring-config", help="JSON scoring configuration")
    run.add_argument("--label")

    compare = commands.add_parser("compare", help="compare a baseline with one or more candidate runs")
    compare.add_argument("run_ids", nargs="+", help="first ID is baseline")
    compare.add_argument("--threshold", type=float, default=0.0)

    eval_command = commands.add_parser("eval", help="alias for running a processor against an eval set")
    eval_command.add_argument("dataset_id")
    eval_command.add_argument("--processor", default="invoice-extractor")
    eval_command.add_argument("--version", type=int)
    eval_command.add_argument("--document-id", action="append", dest="document_ids")
    eval_command.add_argument("--scoring-config", help="JSON scoring configuration")
    eval_command.add_argument("--label")

    export = commands.add_parser("export", help="export a dataset manifest")
    export.add_argument("dataset_id")
    export.add_argument("--output", type=Path)

    return parser


def _normalize_global_options(argv: List[str]) -> List[str]:
    """Allow documented global flags to appear after a subcommand as well."""
    normalized: List[str] = []
    global_options: List[str] = []
    index = 0
    while index < len(argv):
        value = argv[index]
        if value == "--json":
            global_options.append(value)
        elif value == "--root" and index + 1 < len(argv):
            global_options.extend((value, argv[index + 1]))
            index += 1
        elif value.startswith("--root="):
            global_options.extend(("--root", value.split("=", 1)[1]))
        else:
            normalized.append(value)
        index += 1
    return global_options + normalized


def _run(args: argparse.Namespace) -> Any:
    if args.command == "serve":
        from backend.server import make_server

        server = make_server(args.root, args.host, args.port)
        url = "http://{}:{}/".format(args.host, args.port)
        print("ezpz running at {}".format(url))
        if not args.no_open and args.host in {"127.0.0.1", "localhost", "::1"}:
            webbrowser.open(url)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()
        return {"status": "stopped"}

    if args.command == "init":
        args.root.mkdir(parents=True, exist_ok=True)
        for directory in ("datasets", "processors", "exports", ".ezpz"):
            (args.root / directory).mkdir(parents=True, exist_ok=True)
        write_project_config(args.root, args.name)
    runtime = create_runtime(args.root)
    try:
        if args.command == "init":
            runtime.database.initialize()
            return {"root": str(args.root), "project": args.name, "config": str(args.root / "ezpz.yaml"), "database": str(runtime.database.path), "blob_root": str(runtime.blobs.root)}

        if args.command in {"documents", "docs"}:
            if args.documents_command == "list":
                return {"documents": runtime.database.list_documents(args.query)}
            metadata = _json_value(args.metadata, {})
            if not isinstance(metadata, dict):
                raise ValueError("metadata must be a JSON object")
            paths = []
            for path in args.paths:
                if path.is_dir():
                    paths.extend(sorted(item for item in path.rglob("*") if item.is_file()))
                elif path.is_file():
                    paths.append(path)
                else:
                    raise ValueError("document path does not exist: {}".format(path))
            if not paths:
                raise ValueError("no files found to ingest")
            results = []
            for path in paths:
                ingested = runtime.ingestor.ingest(path.name, path.read_bytes(), mimetypes.guess_type(path.name)[0], metadata)
                if args.dataset:
                    if not runtime.database.get_dataset(args.dataset):
                        raise ValueError("Dataset not found: {}".format(args.dataset))
                    runtime.database.add_document_to_dataset(args.dataset, ingested["document"]["id"], args.split)
                document = runtime.database.get_document(ingested["document"]["id"])
                results.append({**ingested, "document": document or ingested["document"]})
            return {"documents": results}

        if args.command == "datasets":
            if args.datasets_command == "list":
                return {"datasets": runtime.database.list_datasets()}
            if args.datasets_command == "create":
                return {"dataset": runtime.database.insert_dataset(args.name, args.description)}
            if args.datasets_command == "export":
                manifest = _manifest(runtime, args.dataset_id)
                if args.output:
                    args.output.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
                    return {"output": str(args.output), "documents": len(manifest["documents"])}
                return {"manifest": manifest}
            if args.datasets_command == "import":
                return _import_manifest(runtime, args.dataset_id, _load_manifest(args.manifest), args.dry_run, args.author)
            dataset = runtime.database.get_dataset(args.dataset_id)
            if not dataset:
                raise ValueError("Dataset not found: {}".format(args.dataset_id))
            documents = runtime.database.list_dataset_documents(args.dataset_id)
            if args.datasets_command == "sample":
                import hashlib

                tags = set(_clean_tags(args.tag))
                candidates = [document for document in documents if not tags or tags.intersection(document.get("tags") or [])]
                candidates.sort(key=lambda document: hashlib.sha256((args.seed + document["sha256"]).encode("utf-8")).hexdigest())
                selected = candidates[: max(0, args.count)]
                if not args.dry_run:
                    runtime.database.append_audit_event("dataset.sampled", "dataset", args.dataset_id, {"count": len(selected), "seed": args.seed}, "cli")
                return {"dataset_id": args.dataset_id, "selected": selected, "count": len(selected), "dry_run": args.dry_run}
            ratios = _json_value(args.splits, {})
            if not isinstance(ratios, dict) or not ratios:
                raise ValueError("--splits must be a non-empty JSON object")
            cleaned = {str(key): float(value) for key, value in ratios.items() if float(value) > 0}
            total = sum(cleaned.values())
            if not total:
                raise ValueError("--splits must include a positive ratio")
            normalized = {key: value / total for key, value in cleaned.items()}
            import hashlib

            groups: Dict[str, List[Dict[str, Any]]] = {}
            for document in documents:
                key = str(document.get(args.stratify_by) or "unknown") if args.stratify_by else "all"
                groups.setdefault(key, []).append(document)
            assignments = []
            for group in groups.values():
                group.sort(key=lambda document: hashlib.sha256((args.seed + document["sha256"]).encode("utf-8")).hexdigest())
                cursor = 0
                split_names = list(normalized)
                for split in split_names:
                    target = len(group) - cursor if split == split_names[-1] else round(len(group) * normalized[split])
                    assignments.extend({"document_id": document["id"], "split": split} for document in group[cursor : cursor + target])
                    cursor += target
            if not args.dry_run:
                for item in assignments:
                    runtime.database.update_dataset_document(args.dataset_id, item["document_id"], item["split"])
                runtime.database.append_audit_event("dataset.stratified_split", "dataset", args.dataset_id, {"assignments": len(assignments), "ratios": normalized, "seed": args.seed}, "cli")
            return {"dataset_id": args.dataset_id, "assignments": assignments, "ratios": normalized, "dry_run": args.dry_run}

        if args.command == "processors":
            if args.processors_command == "list":
                return {"processors": runtime.database.list_processors()}
            if args.processors_command == "export":
                processor = runtime.database.get_processor(args.processor)
                if not processor:
                    raise ValueError("Processor not found: {}".format(args.processor))
                versions = processor.get("versions") or []
                if not versions:
                    raise ValueError("Processor has no version: {}".format(args.processor))
                version = versions[0]
                config = {
                    "name": processor["name"],
                    "version": version.get("version"),
                    "schema": version.get("schema", {}),
                    "prompt": version.get("prompt", {}),
                    "parser": version.get("parser", {}),
                    "model": version.get("model", {}),
                    "harness": version.get("harness", {}),
                    "normalization": version.get("normalization", {}),
                }
                if args.output:
                    content = dump_yaml(config) if args.format == "yaml" else json.dumps(config, ensure_ascii=False, indent=2) + "\n"
                    args.output.write_text(content, encoding="utf-8")
                    return {"output": str(args.output), "processor": processor["name"], "version": version.get("version")}
                return {"config": config}
            config = _json_value(args.config, {})
            if not isinstance(config, dict):
                raise ValueError("--config must be a JSON object")
            processor = runtime.database.insert_processor(args.name, args.description)
            from backend.seed import default_prompt, default_schema

            runtime.database.insert_processor_version(
                {
                    "id": new_id("pv"),
                    "processor_id": processor["id"],
                    "version": 1,
                    "status": "draft",
                    "schema": config.get("schema", default_schema()),
                    "prompt": config.get("prompt", default_prompt()),
                    "parser": config.get("parser", {"name": "native", "version": "1"}),
                    "model": config.get("model", {"provider": "local", "name": "deterministic-local"}),
                    "harness": config.get("harness", {"name": "direct", "version": "1"}),
                    "normalization": config.get("normalization", {}),
                }
            )
            return {"processor": runtime.database.get_processor(processor["id"])}

        if args.command == "extract":
            return runtime.extractions.extract_document(args.document_id, args.processor, args.version, scoring_config=_json_value(args.scoring_config, {}))
        if args.command in {"run", "eval"}:
            return runtime.extractions.run_dataset(
                args.dataset_id,
                args.processor,
                args.version,
                args.document_ids,
                _json_value(args.scoring_config, {}),
                {"label": args.label} if args.label else {},
            )
        if args.command == "export":
            manifest = _manifest(runtime, args.dataset_id)
            if args.output:
                args.output.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
                return {"output": str(args.output), "documents": len(manifest["documents"])}
            return {"manifest": manifest}
        if args.command == "compare":
            if len(args.run_ids) < 2:
                raise ValueError("compare requires at least two run IDs")
            runs = [runtime.database.get_run(run_id) for run_id in args.run_ids]
            if any(run is None for run in runs):
                raise ValueError("one or more runs were not found")
            baseline = runs[0]
            comparisons = []
            for candidate in runs[1:]:
                comparisons.append(
                    {
                        "baseline_run_id": baseline["id"],
                        "candidate_run_id": candidate["id"],
                        "comparison": compare_evaluations(
                            baseline.get("evaluations", []), candidate.get("evaluations", []), baseline.get("metrics", {}), candidate.get("metrics", {}), args.threshold
                        ),
                    }
                )
            return {"baseline_run_id": baseline["id"], "comparisons": comparisons}
        raise ValueError("unsupported command")
    finally:
        runtime.shutdown()


def main(argv: Optional[Iterable[str]] = None) -> int:
    parser = build_parser()
    raw_args = list(argv) if argv is not None else sys.argv[1:]
    args = parser.parse_args(_normalize_global_options(raw_args))
    try:
        _print(_run(args), args.as_json)
        return 0
    except (OSError, ValueError, KeyError) as error:
        print("ezpz: {}".format(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
