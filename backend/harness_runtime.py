"""Execute saved extraction programs with local LangGraph task checkpoints."""

import hashlib
import json
import os
import sqlite3
import tempfile
import threading
import time
from copy import deepcopy
from dataclasses import asdict
from pathlib import Path

from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.func import entrypoint, task

from .harness import HarnessResult, run_harness, _add_usage
from .harness_spec import assess, get, leaves, merge_scoped, project, put, validate_spec, vote, unwrap, equal
from .models import DocumentIR, DocumentPage, DocumentBlock, ModelResult
from .parser import parse_document
from .resumable import EvaluationInterrupted, transient_error

ENGINE_VERSION = "harness-v1"


def saved_latency_ms(steps, kinds=None):
    """Count successful operation time once, excluding paused gaps and overlap."""
    intervals = []
    for step in steps:
        if kinds is not None and step.get("kind") not in kinds:
            continue
        attempts = step.get("attempts") or []
        if attempts and attempts[-1].get("status") == "completed":
            start = attempts[-1]["started_at"] * 1000
            intervals.append((start, start + step.get("latency_ms", 0)))
    total, end = 0, float("-inf")
    for start, finish in sorted(intervals):
        total += max(0, finish - max(start, end))
        end = max(end, finish)
    return round(total)


def saved_run_steps(database, run):
    """Read completed and interrupted attempts without changing the run."""
    results = []
    for document in run.get("metadata", {}).get("benchmark_snapshot", {}).get("documents", []):
        identity = run["id"] + ":" + document["id"]
        directory = database.path.parent / "harness-state" / hashlib.sha256(identity.encode()).hexdigest()
        if not directory.is_dir():
            continue
        artifacts = Artifacts(directory / "artifacts")
        steps = []
        for journal in directory.glob("*.attempts.json"):
            attempts = json.loads(journal.read_text())
            if not attempts:
                continue
            reference = attempts[-1].get("result_artifact")
            if reference:
                steps.append(artifacts.read(reference))
            else:
                steps.append({"kind": attempts[-1].get("kind"), "name": "Unfinished operation", "attempts": attempts})
        steps.sort(key=lambda step: (step.get("attempts") or [{}])[0].get("started_at", 0))
        if steps:
            results.append({"document_id": document["id"], "name": document.get("name"), "steps": steps})
    return results


def restore_ir(value):
    return DocumentIR(value["document_id"], value["parser"], value["metadata"], [
        DocumentPage(page["page"], page["width"], page["height"], [
            DocumentBlock(block["id"], block["type"], block["text"], block.get("bbox"), block.get("confidence"), block.get("metadata", {}))
            for block in page["blocks"]]) for page in value["pages"]])


class Artifacts:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)

    def save(self, value):
        data = json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False).encode()
        key = hashlib.sha256(data).hexdigest()
        self.write(self.directory / (key + ".json"), data)
        return key

    @staticmethod
    def write(path, data):
        descriptor, temporary = tempfile.mkstemp(dir=path.parent)
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
            if os.name != "nt":
                directory_fd = os.open(path.parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def read(self, key):
        if len(key) != 64 or any(c not in "0123456789abcdef" for c in key):
            raise ValueError("Invalid harness artifact reference")
        return json.loads((self.directory / (key + ".json")).read_text())


def execute_harness(document, data, version, model_factory, directory, execution_id, check=None):
    """One immutable document execution. Reinvoking resumes the same task sequence."""
    spec = version.get("harness") or {"name": "direct"}
    validate_spec(spec, version.get("schema", {}))
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    artifacts = Artifacts(directory / "artifacts")
    trace = []
    trace_lock = threading.Lock()
    limit = int(spec.get("limits", {}).get("max_calls", 30))
    concurrency = int(spec.get("limits", {}).get("concurrency", 3))
    slots = threading.BoundedSemaphore(concurrency)
    call_ids = {path.stem.removesuffix(".attempts") for path in directory.glob("*.attempts.json")
                if any(attempt.get("kind") == "extract" for attempt in json.loads(path.read_text()))}
    call_lock = threading.Lock()
    source = {key: document[key] for key in ("id", "filename", "mime_type")}
    if document.get("page_count"):
        source["page_count"] = document["page_count"]
    identity = hashlib.sha256(json.dumps({"version": version, "source": hashlib.sha256(data).hexdigest(), "engine": ENGINE_VERSION}, sort_keys=True).encode()).hexdigest()
    identity_file = directory / "identity.json"
    if identity_file.exists() and json.loads(identity_file.read_text()) != identity:
        raise ValueError("The saved harness or source changed; resume with its original version")
    Artifacts.write(identity_file, json.dumps(identity).encode())

    @task
    def operation(request):
        # Never call providers when the coordinator has requested a pause.
        if check:
            check()
        started = time.perf_counter()
        journal = directory / (hashlib.sha256(request["id"].encode()).hexdigest() + ".attempts.json")
        attempts = json.loads(journal.read_text()) if journal.exists() else []
        if attempts and attempts[-1].get("result_artifact"):
            # A task result may have committed just before the graph checkpoint.
            # The journal bridges that gap without repeating a paid request.
            return attempts[-1]["result_artifact"]
        ambiguous = any(attempt["status"] in ("running", "interrupted", "completed") and not attempt.get("result_artifact") for attempt in attempts)
        attempts.append({"started_at": time.time(), "status": "running", "kind": request["kind"]})
        Artifacts.write(journal, json.dumps(attempts).encode())
        try:
            context = artifacts.read(request["context"])
            kind = request["kind"]
            if kind == "parse":
                result = {"ir": parse_document(document, data, request["config"]).to_dict()}
            elif kind == "extract":
                adapter = model_factory(request["config"])
                ir = restore_ir(context["ir"])
                if context.get("input") == "document":
                    import base64
                    ir.metadata = {**ir.metadata, "source_input": {**source, "data": base64.b64encode(data).decode()}}
                with slots:
                    if check:
                        check()
                    model_result = adapter.run(ir, request["schema"], request["prompt"])
                result = asdict(model_result)
                for path, _ in leaves(request["schema"]):
                    value = get(result["output"], path)
                    if value is not None:
                        wrapped = deepcopy(value) if isinstance(value, dict) and "value" in value else {"value": value, "confidence": None}
                        wrapped["harness_provenance"] = {"step_id": request["id"], "model": request["config"].get("name"), "parser": context["ir"]["parser"]}
                        put(result["output"], path, wrapped)
            elif kind == "plugin":
                ir = restore_ir(context["ir"])
                result = asdict(run_harness(ir, request["schema"], request["prompt"], spec, model_factory(version["model"]), model_factory, version["model"], source_document=source, source_bytes=data))
            else:
                raise ValueError("Unknown operation")
            elapsed = int((time.perf_counter() - started) * 1000)
            attempts[-1].update(status="completed", latency_ms=elapsed)
            warnings = list(result.get("warnings", []))
            if ambiguous:
                warnings.append("An earlier attempt was interrupted before saving its response and may have been charged by the provider.")
            result["warnings"] = warnings
            result_artifact = artifacts.save({"id": request["id"], "kind": kind, "name": request.get("label") or kind,
                                   "model": request.get("config", {}).get("name"), "config": request.get("config"),
                                   "input_artifact": request["context"],
                                   "input": {"source": source, "mode": context.get("input"), "candidate": context.get("output"), "pages": context.get("ir", {}).get("pages")},
                                   "schema": request.get("schema"),
                                   "prompt": request.get("prompt"), "latency_ms": elapsed, "attempts": attempts, "result": result})
            attempts[-1]["result_artifact"] = result_artifact
            Artifacts.write(journal, json.dumps(attempts).encode())
            return result_artifact
        except BaseException as error:
            attempts[-1].update(status="interrupted" if transient_error(error) else "failed", error=str(error))
            Artifacts.write(journal, json.dumps(attempts).encode())
            if transient_error(error) and not isinstance(error, EvaluationInterrupted):
                raise EvaluationInterrupted(str(error)) from error
            raise

    def collect(future):
        reference = future.result()
        record = artifacts.read(reference)
        with trace_lock:
            trace.append({**record, "artifact": reference})
        return record["result"]

    def extract(node, context, path, pending=False):
        with call_lock:
            call_id = hashlib.sha256(path.encode()).hexdigest()
            if call_id not in call_ids and len(call_ids) >= limit:
                raise ValueError(f"Harness model-call limit ({limit}) reached")
            call_ids.add(call_id)
        config = deepcopy(node["model"]) if node.get("model") else deepcopy(version.get("model", {}))
        base_prompt = version.get("prompt", {})
        if node.get("model"):
            base_prompt = {key: value for key, value in base_prompt.items() if key in ("system", "extraction", "max_tokens")}
        prompt = {**base_prompt, **{key: value for key, value in node.get("prompt", {}).items() if value is not None}}
        if context.get("feedback"):
            prompt["extraction"] = (prompt.get("extraction", "") + "\n\nVerify and repair this candidate against the original source.\nCandidate:\n" + json.dumps(context.get("output", {})) + "\nValidation feedback:\n" + json.dumps(context["feedback"]))
        schema = project(version["schema"], node.get("fields") or context.get("fields"))
        future = operation({"id": path, "kind": "extract", "label": node.get("label"), "config": config,
                            "context": artifacts.save(context), "schema": schema, "prompt": prompt})
        if pending:
            return future
        result = collect(future)
        output = merge_scoped(context.get("output", {}), result["output"], version["schema"], node.get("fields") or context.get("fields"))
        return {**context, "output": output}

    def note(node, path, result):
        trace.append({"id": path, "kind": node["kind"], "name": node.get("label") or node["kind"], "result": result})

    def evaluate_routes(node, context, path):
        # Connections are execution data, not merely a rendering of array order.
        from .harness_routing import INPUT, OUTPUT, routing_layers, scope_blocks
        edges = node["routing"]["edges"]
        blocks = {"block:" + child["id"]: child for child in scope_blocks(node)}
        completed = {INPUT: deepcopy(context)}
        policy = {**context.get("acceptance_policy", {}), **node}

        def arrivals(target):
            sources = []
            for edge in edges:
                if edge["target"] != target or edge["source"] not in completed:
                    continue
                source = edge["source"]
                report = assess(completed[source].get("output", {}), version["schema"], {**completed[source].get("acceptance_policy", {}), **policy})
                condition = edge.get("condition", "always")
                taken = condition == "always" or (condition == "accepted") == report["accepted"]
                note({"kind": "connection", "label": condition}, path + "/edge/" + edge["id"],
                     {"source": source, "target": target, "condition": condition, "taken": taken})
                if taken and source not in sources:
                    sources.append(source)
            return sources

        def merge_inputs(sources):
            if len(sources) == 1:
                return deepcopy(completed[sources[0]])
            merged = deepcopy(context)
            output = {}
            for source in sources:
                candidate = completed[source]
                if source != sources[0] and candidate.get("ir") != completed[sources[0]].get("ir"):
                    raise ValueError("Connected branches returned incompatible parser inputs")
                for field, _ in leaves(version["schema"]):
                    incoming = get(candidate.get("output", {}), field)
                    if incoming is None or incoming == get(context.get("output", {}), field):
                        continue
                    previous = get(output, field)
                    if previous is not None and not equal(unwrap(previous), unwrap(incoming), {}):
                        incoming = {"value": None, "confidence": None, "errors": ["Connected branches conflict; resolve them with a majority-vote block"]}
                    put(output, field, deepcopy(incoming))
            merged.update(ir=deepcopy(completed[sources[0]]["ir"]), input=completed[sources[0]].get("input"),
                          output=merge_scoped(context.get("output", {}), output, version["schema"]))
            return merged

        @task
        def route_step(payload):
            child, initial, child_path = payload
            result = evaluate(child, initial, child_path)
            return {"context": result, "trace": [item for item in trace if item["id"].startswith(child_path + "/") or item["id"] == child_path]}

        for layer in routing_layers(node):
            futures = []
            for key in layer:
                if key == INPUT:
                    continue
                sources = arrivals(key)
                if not sources:
                    continue
                if key == OUTPUT:
                    if node["kind"] == "consensus":
                        # A source contributes at most one vote, even with multiple edges.
                        candidates = [completed[source].get("output", {}) for source in sources if source in blocks]
                        while len(candidates) < len(node["branches"]):
                            candidates.append({})
                        output, decisions = vote(candidates, project(version["schema"], context.get("fields")), node)
                        completed[OUTPUT] = {**deepcopy(context), "output": merge_scoped(context.get("output", {}), output, version["schema"], context.get("fields"))}
                        note(node, path + "/resolve", {"decisions": decisions})
                    else:
                        completed[OUTPUT] = merge_inputs(sources)
                    continue
                initial = merge_inputs(sources)
                if node["kind"] == "cascade" and node.get("scope") == "unresolved" and sources != [INPUT]:
                    initial["fields"] = assess(initial.get("output", {}), version["schema"], policy)["unresolved"] or None
                child = blocks[key]
                futures.append((key, route_step((child, initial, path + "/route/" + child["id"]))))
            for key, future in futures:
                saved = future.result()
                with trace_lock:
                    seen = {item["id"] for item in trace}
                    trace.extend(item for item in saved["trace"] if item["id"] not in seen)
                completed[key] = saved["context"]
        if OUTPUT not in completed:
            raise ValueError("No active connection reached output; connect both acceptance outcomes or use Always")
        final = completed[OUTPUT]
        final["fields"] = context.get("fields")
        final["acceptance_policy"] = {**final.get("acceptance_policy", {}), **policy}
        final["report"] = assess(final.get("output", {}), version["schema"], final["acceptance_policy"])
        return final

    def evaluate(node, context, path):
        kind = node["kind"]
        if node.get("routing") is not None and kind not in ("repair", "pages"):
            return evaluate_routes(node, context, path)
        if kind == "sequence":
            for child in node["steps"]:
                context = evaluate(child, context, path + "/" + child["id"])
            return context
        if kind == "parse":
            result = collect(operation({"id": path, "kind": "parse", "context": artifacts.save(context), "config": {**version.get("parser", {}), **node.get("parser", {})}}))
            return {**context, "ir": result["ir"], "input": "parsed"}
        if kind == "extract":
            return extract(node, context, path)
        if kind in ("validate", "return", "gate"):
            policy = {**context.get("acceptance_policy", {}), **node}
            report = assess(context.get("output", {}), version["schema"], policy)
            note(node, path, report)
            context = {**context, "report": report, "acceptance_policy": policy}
            if kind == "gate":
                branch = node.get("pass" if report["accepted"] else "fail")
                if branch:
                    return evaluate(branch, context, path + "/" + branch["id"])
            return context
        if kind == "cascade":
            for index, tier in enumerate(node["tiers"]):
                before = context.get("output", {})
                report = assess(before, version["schema"], node)
                fields = report["unresolved"] if index and node.get("scope") == "unresolved" else None
                context = evaluate(tier, {**context, "fields": fields}, path + "/" + tier["id"])
                context["fields"] = None
                report = assess(context.get("output", {}), version["schema"], node)
                note(node, path + f"/gate-{index}", report)
                if report["accepted"]:
                    break
            return {**context, "report": report, "acceptance_policy": node}
        if kind in ("consensus", "parallel"):
            branches = node["branches"]
            # LangGraph schedules each branch as a task; nested model tasks retain
            # their own identities and completed writes on recovery.
            @task
            def branch_task(payload):
                child, initial, child_path = payload
                result = evaluate(child, initial, child_path)
                return {"context": result, "trace": [item for item in trace if item["id"].startswith(child_path)]}
            futures = [branch_task((branch, deepcopy(context), path + "/" + branch["id"])) for branch in branches]
            candidates, errors = [], []
            for index, future in enumerate(futures):
                try:
                    saved_branch = future.result()
                    for item in saved_branch["trace"]:
                        if not any(existing["id"] == item["id"] for existing in trace):
                            trace.append(item)
                    candidates.append(saved_branch["context"].get("output", {}))
                except EvaluationInterrupted:
                    raise
                except RuntimeError as error:
                    candidates.append({})
                    errors.append({"branch": branches[index]["id"], "error": str(error)})
            if kind == "consensus":
                output, decisions = vote(candidates, project(version["schema"], context.get("fields")), node)
                note(node, path, {"decisions": decisions, "errors": errors})
                if errors and not all(item["selected"] for item in decisions):
                    raise EvaluationInterrupted("A voter was interrupted before consensus. Resume to retry unfinished work.")
            else:
                output = {}
                for candidate in candidates:
                    for field, _ in leaves(version["schema"]):
                        incoming = get(candidate, field)
                        if incoming == get(context.get("output", {}), field):
                            continue
                        if incoming is not None:
                            if get(output, field) is not None and not equal(unwrap(get(output, field)), unwrap(incoming), {}):
                                incoming = {"value": None, "confidence": None, "errors": ["Parallel branches conflict; use consensus or disjoint field scopes"]}
                            put(output, field, incoming)
                note(node, path, {"errors": errors})
            return {**context, "output": merge_scoped(context.get("output", {}), output, version["schema"], context.get("fields"))}
        if kind == "repair":
            for index in range(node.get("attempts", 1)):
                report = assess(context.get("output", {}), version["schema"], node)
                if report["accepted"] and not node.get("always_verify", False):
                    break
                initial = {**context, "feedback": report}
                context = evaluate_routes(node, initial, path + f"/attempt-{index}") if node.get("routing") is not None else evaluate(node["body"], initial, path + f"/attempt-{index}/" + node["body"]["id"])
            context.pop("feedback", None)
            report = assess(context.get("output", {}), version["schema"], node)
            note(node, path, report)
            return {**context, "report": report, "acceptance_policy": node}
        if kind == "pages":
            if context.get("input") != "parsed":
                raise ValueError("Per-page extraction requires a Parse block first")
            output = {}
            for page in context["ir"]["pages"]:
                page_context = {**context, "ir": {**context["ir"], "pages": [page]}, "output": {}}
                candidate = evaluate_routes(node, page_context, path + f"/page-{page['page']}") if node.get("routing") is not None else evaluate(node["body"], page_context, path + f"/page-{page['page']}/" + node["body"]["id"])
                for field, definition in leaves(version["schema"]):
                    incoming, previous = get(candidate.get("output", {}), field), get(output, field)
                    if incoming is None or (isinstance(incoming, dict) and incoming.get("value") is None):
                        continue
                    if isinstance(previous, dict) and previous.get("errors"):
                        continue
                    if previous is not None and previous.get("value") != incoming.get("value"):
                        key = node.get("row_keys", {}).get(field)
                        if definition.get("type") == "array" and key:
                            rows = previous["value"] + incoming["value"]
                            mapped = {}
                            for row in rows:
                                if not isinstance(row, dict) or key not in row or (str(row[key]) in mapped and mapped[str(row[key])] != row):
                                    raise ValueError("Page table rows have missing or conflicting keys")
                                mapped[str(row[key])] = row
                            incoming = {**incoming, "value": list(mapped.values()), "confidence": None}
                        else:
                            incoming = {"value": None, "confidence": None, "errors": ["Conflicting page values; configure a merge policy"]}
                    put(output, field, incoming)
            return {**context, "output": output}
        raise ValueError("Unsupported harness block")

    with sqlite3.connect(str(directory / "checkpoints.sqlite"), check_same_thread=False) as connection:
        connection.execute("PRAGMA synchronous=FULL")
        saver = SqliteSaver(connection)

        @entrypoint(checkpointer=saver)
        def workflow(_identity):
            context = {"input": spec.get("input", "parsed"), "output": {},
                       "ir": DocumentIR(source["id"], {"name": "none", "status": "unavailable", "warnings": []}, source, []).to_dict()}
            if context["input"] == "parsed":
                context = evaluate({"id": "input-parse", "kind": "parse"}, context, "input-parse")
            if spec.get("name") == "workflow":
                context = evaluate(spec["flow"], context, spec["flow"]["id"])
            else:
                # Preserve legacy harness behavior while checkpointing each model
                # call, including the calls made by cascade and verification.
                counter = 0
                class CheckpointModel:
                    def __init__(self, config):
                        self.config = config
                        self.name = config.get("name", "unknown")
                    def run(self, ir, schema, prompt):
                        nonlocal counter
                        counter += 1
                        result = collect(operation({"id": f"legacy-call-{counter}", "kind": "extract", "context": artifacts.save({**context, "ir": ir.to_dict()}), "config": self.config, "schema": schema, "prompt": prompt}))
                        return ModelResult(**{key: result[key] for key in ("output", "raw_response", "usage", "warnings")})
                if spec.get("name") == "custom":
                    result = collect(operation({"id": "legacy-plugin", "kind": "plugin", "context": artifacts.save(context), "schema": version["schema"], "prompt": version.get("prompt", {})}))
                    context["output"] = result["output"]
                    context["legacy_raw"] = result["raw_response"]
                else:
                    result = run_harness(restore_ir(context["ir"]), version["schema"], version.get("prompt", {}), spec,
                                         CheckpointModel(version["model"]), CheckpointModel, version["model"])
                    context["output"] = result.output
                    context["legacy_raw"] = result.raw_response
            report = assess(context["output"], version["schema"], context.get("acceptance_policy"))
            return artifacts.save({"context": context, "report": report, "trace": trace})

        config = {"configurable": {"thread_id": execution_id}, "max_concurrency": max(4, concurrency * 4)}
        state = workflow.get_state(config)
        if state.values and not state.next:
            final = state.values
        else:
            final = workflow.invoke(None if state.created_at else identity, config, durability="sync")
        bundle = artifacts.read(final)

    usage, model_usage, warnings = {}, [], []
    for step in bundle["trace"]:
        result = step.get("result", {})
        warnings.extend(result.get("warnings", []))
        if step["kind"] == "extract":
            usage = _add_usage(usage, result.get("usage", {}))
            model_usage.append({"model": step["model"], "usage": result.get("usage", {}), "pricing": step.get("config", {}).get("pricing", {})})
        elif step["kind"] == "plugin":
            usage = _add_usage(usage, result.get("usage", {}))
            model_usage.extend(result.get("model_usage", []))
    if not bundle["report"]["accepted"]:
        warnings.append("Extraction has unresolved fields or failed acceptance checks.")
    raw = bundle["context"].get("legacy_raw") if spec.get("name") != "workflow" else {"harness": "workflow", "acceptance": bundle["report"], "steps": bundle["trace"]}
    result = HarnessResult(bundle["context"]["output"], raw, usage, warnings, bundle["trace"], model_usage)
    return restore_ir(bundle["context"]["ir"]), result
