"""Provider model discovery and pricing metadata for the configuration UI.

Provider model-list APIs expose availability, but generally do not include
token prices.  The catalog therefore combines a live provider response with a
small, versioned price registry.  Unknown models remain selectable and are
marked as unpriced instead of silently receiving an inaccurate rate.
"""

import copy
import json
import os
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen


MODEL_CATALOG_TIMEOUT_SECONDS = 8

DEFAULT_CREDENTIALS = {
    "openai": "OPENAI_API_KEY",
    "openai_compatible": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "gemini": "GEMINI_API_KEY",
}

DEFAULT_ENDPOINTS = {
    "openai": "https://api.openai.com/v1",
    "anthropic": "https://api.anthropic.com/v1",
    "gemini": "https://generativelanguage.googleapis.com/v1beta",
    "openai_compatible": "http://127.0.0.1:11434/v1",
}

# Provider APIs do not return pricing in their model-list payloads.  Keep the
# registry in one place so the UI can surface rates without asking users to
# copy them into every processor draft.  Values are USD per 1M text tokens.
MODEL_PRICING: Dict[str, Dict[str, Dict[str, Any]]] = {
    "openai": {
        "gpt-5.6": {"input_per_million": 4.0, "output_per_million": 20.0, "source": "https://developers.openai.com/api/docs/models/gpt-5.6-sol"},
        "gpt-5.6-sol": {"input_per_million": 4.0, "output_per_million": 20.0, "source": "https://developers.openai.com/api/docs/models/gpt-5.6-sol"},
        "gpt-5.6-terra": {"input_per_million": 2.0, "output_per_million": 12.0, "source": "https://developers.openai.com/api/docs/models/gpt-5.6-terra"},
        "gpt-5.6-luna": {"input_per_million": 0.2, "output_per_million": 1.2, "source": "https://developers.openai.com/api/docs/models/gpt-5.6-luna"},
        "gpt-5": {"input_per_million": 1.25, "output_per_million": 10.0, "source": "https://developers.openai.com/api/docs/models/gpt-5"},
        "gpt-5-mini": {"input_per_million": 0.25, "output_per_million": 2.0, "source": "https://developers.openai.com/api/docs/models/gpt-5-mini"},
        "gpt-5-nano": {"input_per_million": 0.05, "output_per_million": 0.4, "source": "https://developers.openai.com/api/docs/models/gpt-5-nano"},
        "gpt-4.1": {"input_per_million": 2.0, "output_per_million": 8.0, "source": "https://developers.openai.com/api/docs/models/gpt-4.1"},
        "gpt-4.1-mini": {"input_per_million": 0.4, "output_per_million": 1.6, "source": "https://developers.openai.com/api/docs/models/gpt-4.1-mini"},
        "gpt-4.1-nano": {"input_per_million": 0.1, "output_per_million": 0.4, "source": "https://developers.openai.com/api/docs/models/gpt-4.1-nano"},
        "gpt-4o": {"input_per_million": 2.5, "output_per_million": 10.0, "source": "https://platform.openai.com/api/pricing"},
        "gpt-4o-mini": {"input_per_million": 0.15, "output_per_million": 0.6, "source": "https://platform.openai.com/api/pricing"},
        "o3": {"input_per_million": 2.0, "output_per_million": 8.0, "source": "https://platform.openai.com/api/pricing"},
        "o4-mini": {"input_per_million": 1.1, "output_per_million": 4.4, "source": "https://developers.openai.com/api/docs/models/o4-mini"},
    },
    "anthropic": {
        "claude-opus-4-1": {"input_per_million": 15.0, "output_per_million": 75.0, "source": "https://www.anthropic.com/pricing"},
        "claude-sonnet-4": {"input_per_million": 3.0, "output_per_million": 15.0, "source": "https://www.anthropic.com/pricing"},
        "claude-3-5-sonnet": {"input_per_million": 3.0, "output_per_million": 15.0, "source": "https://www.anthropic.com/pricing"},
        "claude-3-5-haiku": {"input_per_million": 0.8, "output_per_million": 4.0, "source": "https://www.anthropic.com/pricing"},
        "claude-3-opus": {"input_per_million": 15.0, "output_per_million": 75.0, "source": "https://www.anthropic.com/pricing"},
        "claude-3-haiku": {"input_per_million": 0.25, "output_per_million": 1.25, "source": "https://www.anthropic.com/pricing"},
    },
    "gemini": {
        "gemini-2.5-pro": {"input_per_million": 1.25, "output_per_million": 10.0, "source": "https://ai.google.dev/gemini-api/docs/pricing"},
        "gemini-2.5-flash": {"input_per_million": 0.3, "output_per_million": 2.5, "source": "https://ai.google.dev/gemini-api/docs/pricing"},
        "gemini-2.0-flash": {"input_per_million": 0.1, "output_per_million": 0.4, "source": "https://ai.google.dev/gemini-api/docs/pricing"},
        "gemini-1.5-pro": {"input_per_million": 1.25, "output_per_million": 5.0, "source": "https://ai.google.dev/gemini-api/docs/pricing"},
        "gemini-1.5-flash": {"input_per_million": 0.075, "output_per_million": 0.3, "source": "https://ai.google.dev/gemini-api/docs/pricing"},
    },
    "openai_compatible": {
        "llama3.2": {"input_per_million": 0.0, "output_per_million": 0.0, "source": "built-in"},
        "llama-3.1-8b": {"input_per_million": 0.0, "output_per_million": 0.0, "source": "built-in"},
        "qwen2.5-7b": {"input_per_million": 0.0, "output_per_million": 0.0, "source": "built-in"},
        "mistral-small": {"input_per_million": 0.0, "output_per_million": 0.0, "source": "built-in"},
        "deepseek-r1": {"input_per_million": 0.0, "output_per_million": 0.0, "source": "built-in"},
    },
}

BUILTIN_MODEL_IDS = {
    "openai": [
        "gpt-5.6",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-5",
        "gpt-5-mini",
        "gpt-5-nano",
        "gpt-4.1",
        "gpt-4.1-mini",
        "gpt-4.1-nano",
        "gpt-4o",
        "gpt-4o-mini",
        "o3",
        "o4-mini",
    ],
    "anthropic": [
        "claude-opus-4-1",
        "claude-sonnet-4",
        "claude-3-5-sonnet-20241022",
        "claude-3-5-haiku-20241022",
        "claude-3-opus-20240229",
        "claude-3-haiku-20240307",
    ],
    "gemini": [
        "gemini-2.5-pro",
        "gemini-2.5-flash",
        "gemini-2.0-flash",
        "gemini-1.5-pro",
        "gemini-1.5-flash",
    ],
    "openai_compatible": [
        "llama3.2",
        "llama-3.1-8b",
        "qwen2.5-7b",
        "mistral-small",
        "deepseek-r1",
    ],
}


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _normalize_provider(provider: str) -> str:
    value = str(provider or "").strip().lower().replace("-", "_")
    if value == "google":
        return "gemini"
    if value in {"openai_compatible", "openai"}:
        return value
    if value in {"ollama", "vllm", "lm_studio", "lmstudio", "openrouter", "together", "groq", "mistral", "deepseek"}:
        return "openai_compatible"
    if value in {"anthropic", "gemini", "local"}:
        return value
    raise ValueError("Unsupported model provider: {}".format(provider or "(empty)"))


def _validate_endpoint(endpoint: Optional[str]) -> str:
    value = str(endpoint or "").strip()
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
        raise ValueError("Model catalog endpoint must be an http(s) URL without credentials or fragments")
    return value.rstrip("/")


def _models_url(endpoint: str) -> str:
    return endpoint if endpoint.endswith("/models") else endpoint.rstrip("/") + "/models"


def _with_query(url: str, key: str, value: str) -> str:
    separator = "&" if "?" in url else "?"
    return "{}{}{}={}".format(url, separator, quote(key), quote(value))


def _fetch_json(url: str, headers: Dict[str, str]) -> Dict[str, Any]:
    request = Request(url, headers=headers, method="GET")
    with urlopen(request, timeout=MODEL_CATALOG_TIMEOUT_SECONDS) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Provider returned a non-object model catalog")
    return payload


def _safe_refresh_error(error: Exception) -> str:
    if isinstance(error, HTTPError):
        return "Provider returned HTTP {} while listing models.".format(error.code)
    if isinstance(error, (URLError, TimeoutError, OSError)):
        return "Provider model list could not be reached."
    return "Provider returned an invalid model list."


def _provider_records(provider: str, endpoint: Optional[str], api_key: Optional[str]) -> List[Dict[str, Any]]:
    base = _validate_endpoint(endpoint or DEFAULT_ENDPOINTS.get(provider, DEFAULT_ENDPOINTS["openai"]))
    headers = {"Accept": "application/json"}
    if api_key and provider in {"openai", "openai_compatible"}:
        headers["Authorization"] = "Bearer {}".format(api_key)
    if provider == "anthropic":
        if api_key:
            headers["x-api-key"] = api_key
        headers["anthropic-version"] = "2023-06-01"
        payload = _fetch_json(_models_url(base), headers)
        return payload.get("data") if isinstance(payload.get("data"), list) else []
    if provider == "gemini":
        models_url = _models_url(base)
        if api_key:
            models_url = _with_query(models_url, "key", api_key)
        payload = _fetch_json(models_url, headers)
        return payload.get("models") if isinstance(payload.get("models"), list) else []
    payload = _fetch_json(_models_url(base), headers)
    return payload.get("data") if isinstance(payload.get("data"), list) else []


def _pricing_for(provider: str, model_id: str) -> Optional[Dict[str, Any]]:
    normalized_id = str(model_id or "").strip().lower()
    entries = MODEL_PRICING.get(provider, {})
    exact = entries.get(normalized_id)
    if exact:
        return copy.deepcopy(exact)
    # Snapshot IDs normally use the priced alias as a prefix, e.g.
    # gpt-4.1-2025-04-14 or claude-3-5-sonnet-20241022.
    matches = [key for key in entries if normalized_id.startswith(key + "-")]
    if not matches:
        return None
    return copy.deepcopy(entries[max(matches, key=len)])


def _normalize_record(provider: str, record: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    raw_id = record.get("id") or record.get("name")
    model_id = str(raw_id or "").strip()
    if provider == "gemini" and model_id.startswith("models/"):
        model_id = model_id[7:]
    if not model_id:
        return None
    pricing = _pricing_for(provider, model_id)
    display_name = record.get("display_name") or record.get("displayName") or model_id
    normalized = {
        "id": model_id,
        "name": str(display_name),
        "description": str(record.get("description") or ""),
        "created": record.get("created") or record.get("created_at"),
        "owned_by": record.get("owned_by"),
        "pricing": pricing,
        "pricing_status": "known" if pricing else "unknown",
    }
    return normalized


def _builtin_models(provider: str) -> List[Dict[str, Any]]:
    return [
        _normalize_record(provider, {"id": model_id})
        for model_id in BUILTIN_MODEL_IDS.get(provider, [])
    ]


def get_model_catalog(provider: str, endpoint: Optional[str] = None) -> Dict[str, Any]:
    """Return live provider models enriched with local pricing metadata."""

    normalized_provider = _normalize_provider(provider)
    if normalized_provider == "local":
        return {
            "provider": normalized_provider,
            "source": "built-in",
            "credential_configured": True,
            "fetched_at": _utc_now(),
            "warnings": [],
            "models": [{
                "id": "deterministic-local",
                "name": "Local deterministic",
                "description": "Dependency-free local extraction adapter.",
                "created": None,
                "owned_by": "ezpz",
                "pricing": {"input_per_million": 0.0, "output_per_million": 0.0, "source": "built-in"},
                "pricing_status": "known",
            }],
        }

    credential_name = DEFAULT_CREDENTIALS.get(normalized_provider)
    api_key = os.environ.get(credential_name or "")
    warnings: List[str] = []
    records: List[Dict[str, Any]] = []
    source = "provider"
    try:
        # OpenAI-compatible gateways may intentionally expose a public model
        # list, so query them even when no credential is configured.
        if api_key or normalized_provider == "openai_compatible":
            records = _provider_records(normalized_provider, endpoint, api_key)
        else:
            source = "built-in"
            warnings.append("{} is not configured; showing the built-in model list.".format(credential_name))
    except (HTTPError, URLError, TimeoutError, OSError, ValueError, json.JSONDecodeError) as error:
        source = "built-in"
        warnings.append(_safe_refresh_error(error))

    models = [_normalize_record(normalized_provider, record) for record in records if isinstance(record, dict)]
    models = [model for model in models if model]
    if not models:
        source = "built-in"
        models = _builtin_models(normalized_provider)
        if not warnings:
            warnings.append("The provider returned no models; showing the built-in model list.")

    models.sort(key=lambda model: (str(model.get("name") or model.get("id")).lower(), str(model.get("id"))))
    return {
        "provider": normalized_provider,
        "source": source,
        "credential_configured": bool(api_key),
        "fetched_at": _utc_now(),
        "warnings": warnings,
        "models": models,
    }
