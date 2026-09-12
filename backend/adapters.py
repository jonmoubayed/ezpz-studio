"""Provider-neutral adapter metadata and configuration normalization.

The playground stores one stable extraction configuration.  Provider adapters
consume that configuration and translate it into the request shape expected by
the selected service.  This module is deliberately dependency-free so the
server and the UI can use the same provider vocabulary without importing an
SDK or leaking credentials into processor versions.
"""

from copy import deepcopy
from typing import Any, Dict, List, Optional
from .model_catalog import BUILTIN_MODEL_IDS


OPENAI_COMPATIBLE_PROVIDERS = {
    "openai-compatible",
    "openai_compatible",
    "ollama",
    "vllm",
    "lm-studio",
    "lmstudio",
    "openrouter",
    "together",
    "groq",
    "mistral",
    "deepseek",
}


LLM_ADAPTERS: Dict[str, Dict[str, Any]] = {
    "local": {
        "label": "Local deterministic",
        "kind": "local",
        "credential_env": None,
        "default_endpoint": None,
        "models": ["deterministic-local"],
        "description": "Dependency-free fallback for local experiments.",
    },
    "openai": {
        "label": "OpenAI",
        "kind": "openai",
        "credential_env": "OPENAI_API_KEY",
        "default_endpoint": "https://api.openai.com/v1",
        "models": BUILTIN_MODEL_IDS["openai"],
        "description": "OpenAI Chat Completions with schema-aware JSON output.",
    },
    "anthropic": {
        "label": "Anthropic",
        "kind": "anthropic",
        "credential_env": "ANTHROPIC_API_KEY",
        "default_endpoint": "https://api.anthropic.com/v1",
        "models": BUILTIN_MODEL_IDS["anthropic"],
        "description": "Anthropic Messages API with system/user prompt separation.",
    },
    "gemini": {
        "label": "Google Gemini",
        "kind": "gemini",
        "credential_env": "GEMINI_API_KEY",
        "default_endpoint": "https://generativelanguage.googleapis.com/v1beta",
        "models": BUILTIN_MODEL_IDS["gemini"],
        "description": "Gemini generateContent with native JSON response configuration.",
    },
    "ollama": {
        "label": "Ollama (local open source)",
        "kind": "openai-compatible",
        "credential_env": None,
        "default_endpoint": "http://127.0.0.1:11434/v1",
        "models": ["llama3.2", "qwen2.5:7b", "mistral", "deepseek-r1"],
        "description": "Local open-source models through Ollama's OpenAI-compatible endpoint.",
    },
    "openai-compatible": {
        "label": "OpenAI-compatible / open source",
        "kind": "openai-compatible",
        "credential_env": "OPENAI_API_KEY",
        "default_endpoint": None,
        "models": [],
        "description": "OpenAI-compatible gateways such as Ollama, vLLM, LM Studio, and hosted gateways.",
    },
}


PARSER_ADAPTERS: Dict[str, Dict[str, Any]] = {
    "none": {
        "label": "Original document · no parser",
        "kind": "direct",
        "credential_env": None,
        "models": [],
        "description": "Send the original PDF or image to a compatible model and request model-estimated source boxes.",
    },
    "native": {
        "label": "Native text",
        "kind": "local",
        "credential_env": None,
        "models": [],
        "description": "Dependency-free text extraction with compatibility blocks.",
    },
    "docling": {
        "label": "Docling",
        "kind": "local",
        "credential_env": None,
        "models": [],
        "description": "Local document conversion with layout-aware blocks when installed.",
    },
    "llama-parse": {
        "label": "Llama Parse",
        "kind": "hosted",
        "credential_env": "LLAMA_CLOUD_API_KEY",
        "models": [],
        "description": "LlamaParse v2 with markdown, tables, and grounded layout boxes.",
    },
}


def infer_model_provider(model_name: str) -> str:
    """Infer a provider only for legacy configs that omitted ``provider``."""
    name = str(model_name or "").strip().lower()
    if not name or name.startswith(("deterministic", "local")):
        return "local"
    if "claude" in name:
        return "anthropic"
    if "gemini" in name:
        return "gemini"
    if name.startswith(("gpt-", "o1", "o3", "o4")):
        return "openai"
    return "openai-compatible"


def normalize_model_provider(provider: Optional[str], model_name: str = "") -> str:
    value = str(provider or "").strip().lower().replace("_", "-")
    if value in {"google", "gemini"}:
        return "gemini"
    if value in {"openai", "anthropic", "local"}:
        return value
    if value in OPENAI_COMPATIBLE_PROVIDERS:
        return "openai-compatible" if value == "openai-compatible" else value
    return infer_model_provider(model_name)


def normalize_model_config(config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Return a copied, canonical model config without resolving secrets."""
    normalized = deepcopy(config or {})
    model_name = str(normalized.get("name") or normalized.get("model") or "").strip()
    provider = normalize_model_provider(normalized.get("provider"), model_name)
    normalized["provider"] = provider
    if normalized.get("endpoint") and not normalized.get("base_url"):
        normalized["base_url"] = normalized["endpoint"]
    provider_spec = LLM_ADAPTERS.get(provider) or LLM_ADAPTERS["openai-compatible"]
    default_models = provider_spec.get("models") or ["llama3.2"]
    normalized["name"] = model_name or str(default_models[0])
    return normalized


def normalize_parser_name(name: Optional[str]) -> str:
    value = str(name or "native").strip().lower().replace("_", "-")
    aliases = {
        "llamaparse": "llama-parse",
        "llama-parse-v2": "llama-parse",
        "text": "native",
        "structured": "native",
        "local": "native",
    }
    return aliases.get(value, value)


def get_adapter_catalog() -> Dict[str, Any]:
    """Return safe metadata suitable for the configuration UI/API."""
    llm = []
    for provider, spec in LLM_ADAPTERS.items():
        llm.append({"id": provider, **{key: value for key, value in spec.items() if key != "models"}, "models": list(spec.get("models") or [])})
    parsers = [{"id": name, **spec} for name, spec in PARSER_ADAPTERS.items()]
    return {"version": 1, "llm": llm, "parsers": parsers}
