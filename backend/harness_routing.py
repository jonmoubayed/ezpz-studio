"""Validation for explicit, acyclic connections inside harness scopes."""

INPUT = "boundary:input"
OUTPUT = "boundary:output"
CONDITIONS = {"always", "accepted", "unresolved"}


def scope_blocks(node):
    result = []
    for key in ("steps", "tiers", "branches"):
        result.extend(node.get(key, []))
    for key in ("pass", "fail", "body"):
        if node.get(key):
            result.append(node[key])
    return result


def routing_layers(node):
    blocks = scope_blocks(node)
    if not blocks:
        raise ValueError("Connections belong to a flow containing steps")
    routing = node["routing"]
    if not isinstance(routing, dict) or not isinstance(routing.get("edges"), list):
        raise ValueError("Flow connections must contain an edges list")
    edges = routing["edges"]
    if len(edges) > 500:
        raise ValueError("Use at most 500 connections per flow")
    nodes = [INPUT] + ["block:" + block["id"] for block in blocks] + [OUTPUT]
    known, ids, signatures = set(nodes), set(), set()
    incoming = {key: set() for key in nodes}
    for edge in edges:
        if not isinstance(edge, dict) or not isinstance(edge.get("id"), str) or not edge["id"] or edge["id"] in ids:
            raise ValueError("Connections need unique IDs")
        ids.add(edge["id"])
        source, target = edge.get("source"), edge.get("target")
        condition = edge.get("condition", "always")
        if not isinstance(source, str) or not isinstance(target, str) or source not in known or target not in known:
            raise ValueError("A connection references a missing step")
        if source == OUTPUT or target == INPUT or source == target:
            raise ValueError("Connections must lead from input toward output")
        if not isinstance(condition, str) or condition not in CONDITIONS:
            raise ValueError("Unknown connection condition")
        signature = (source, target, condition)
        if signature in signatures:
            raise ValueError("Duplicate connection")
        signatures.add(signature)
        incoming[target].add(source)
    layers, remaining, visited = [], set(nodes), set()
    while remaining:
        layer = [key for key in nodes if key in remaining and incoming[key] <= visited]
        if not layer:
            raise ValueError("Connections contain a cycle; use a bounded repair block to repeat work")
        layers.append(layer)
        visited.update(layer)
        remaining.difference_update(layer)
    reachable = {INPUT}
    for layer in layers:
        for key in layer:
            if incoming[key] & reachable:
                reachable.add(key)
    if OUTPUT not in reachable:
        raise ValueError("Connect input to output before running this flow")
    return layers
