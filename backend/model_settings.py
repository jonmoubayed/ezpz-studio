"""Supported processor generation controls, shared with the frontend export."""
import math

EFFORTS = ["low", "medium", "high", "xhigh", "max"]
MODEL_SETTING_RULES = [
    {"provider": "openai", "prefixes": ["gpt-6-astra"], "efforts": EFFORTS, "sampling": False},
    {"provider": "openai", "prefixes": ["gpt-5.6"], "efforts": ["none"] + EFFORTS, "sampling": False, "verbosity": True},
    {"provider": "openai", "prefixes": ["gpt-5"], "efforts": ["low", "medium", "high"], "sampling": False, "verbosity": True},
    {"provider": "openai", "prefixes": ["o1", "o3", "o4"], "efforts": ["low", "medium", "high"], "sampling": False},
    {"provider": "anthropic", "prefixes": ["claude-sonnet-5", "claude-opus-5", "claude-fable-5", "claude-opus-4-7", "claude-opus-4-8"], "efforts": EFFORTS, "sampling": False, "adaptive": True},
    {"provider": "anthropic", "prefixes": ["claude-sonnet-4-6"], "efforts": ["low", "medium", "high"], "adaptive": True},
    {"provider": "anthropic", "prefixes": ["claude-opus-4-6"], "efforts": ["low", "medium", "high", "max"], "adaptive": True},
    {"provider": "anthropic", "prefixes": ["claude-haiku-4-5", "claude-sonnet-4-5"], "budget_min": 1024, "budget_max": 63999},
    {"provider": "gemini", "prefixes": ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.1-pro"], "efforts": ["low", "medium", "high"]},
    {"provider": "gemini", "prefixes": ["gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-3-flash"], "efforts": ["minimal", "low", "medium", "high"]},
    {"provider": "gemini", "prefixes": ["gemini-3-pro"], "efforts": ["low", "high"]},
    {"provider": "gemini", "prefixes": ["gemini-2.5-pro"], "budget_min": 128, "budget_max": 32768},
    {"provider": "gemini", "prefixes": ["gemini-2.5-flash"], "budget_min": 0, "budget_max": 24576},
]


def model_capabilities(provider, model):
    provider = "gemini" if provider == "google" else provider
    result = {"efforts": [], "sampling": provider != "local", "verbosity": False,
              "strict": provider in {"openai", "gemini"}, "adaptive": False}
    for rule in MODEL_SETTING_RULES:
        if rule["provider"] == provider and any(model.lower().startswith(prefix) for prefix in rule["prefixes"]):
            result.update(rule)
            break
    return result


def validate_model_settings(provider, model, prompt):
    caps = model_capabilities(provider, model)
    for key, low, high, integer in [("max_tokens", 1, 1000000, True), ("temperature", 0, 1 if provider == "anthropic" else 2, False), ("top_p", 0, 1, False)]:
        if key not in prompt:
            continue
        value = prompt[key]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high or (integer and value != int(value)):
            raise ValueError("{} must be {}between {} and {}".format(key, "an integer " if integer else "", low, high))
    effort = prompt.get("reasoning_effort")
    if effort is not None and effort not in caps["efforts"]:
        raise ValueError("Reasoning effort {} is not supported for {}".format(effort, model))
    if "verbosity" in prompt and (not caps["verbosity"] or prompt["verbosity"] not in {"low", "medium", "high"}):
        raise ValueError("Verbosity is not supported for this model or has an invalid value")
    if "thinking_budget" in prompt:
        budget = prompt["thinking_budget"]
        dynamic = provider == "gemini" and budget == -1
        if "budget_min" not in caps or isinstance(budget, bool) or not isinstance(budget, int) or not (dynamic or caps["budget_min"] <= budget <= caps["budget_max"]):
            raise ValueError("Thinking token budget is not supported or is outside this model's range")
        if provider == "anthropic" and budget >= prompt.get("max_tokens", 4096):
            raise ValueError("Thinking token budget must be smaller than the output token limit")
    if "structured_outputs" in prompt and not isinstance(prompt["structured_outputs"], bool):
        raise ValueError("structured_outputs must be a boolean")
    return caps
