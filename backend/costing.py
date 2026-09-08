"""Token-based model cost estimates, including legacy runs without saved rates."""

from .model_catalog import _pricing_for


def estimate_cost(model, usage, model_usage=None):
    entries = model_usage or [{"model": model.get("name"), "usage": usage}]
    total = 0.0
    for entry in entries:
        provider = entry.get("provider") or model.get("provider")
        name = entry.get("model") or model.get("name")
        pricing = entry.get("pricing") or (
            model.get("pricing") if name == model.get("name") else None
        ) or _pricing_for(provider, name)
        if not pricing and provider == "local":
            continue
        if not pricing or not all(key in pricing for key in ("input_per_million", "output_per_million")):
            return None
        tokens = entry.get("usage") or {}
        if not all(key in tokens for key in ("input_tokens", "output_tokens")):
            return None
        total += (float(tokens["input_tokens"]) * float(pricing["input_per_million"])
                  + float(tokens["output_tokens"]) * float(pricing["output_per_million"])) / 1_000_000
    return round(total, 8)


def run_cost_metrics(model, extractions):
    """Enrich responses without rewriting historical run or extraction records."""
    total = 0.0
    for extraction in extractions:
        if extraction.get("cache_hit"):
            continue
        cost = extraction.get("cost_usd")
        if not cost:
            usage = extraction.get("usage") or {}
            cost = estimate_cost(model, usage, usage.get("models"))
        if cost is None:
            return {"cost_usd": None, "cost_per_document": None, "cost_status": "unavailable"}
        total += cost
    if not extractions:
        return {"cost_usd": None, "cost_per_document": None, "cost_status": "unavailable"}
    return {"cost_usd": round(total, 8), "cost_per_document": round(total / len(extractions), 8), "cost_status": "estimated"}
