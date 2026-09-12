import json
import base64
import os
import re
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional

from .confidence import CONFIDENCE_INSTRUCTIONS, response_schema, strict_response_schema
from .grounding import GROUNDING_INSTRUCTIONS, model_output, visual_source
from .adapters import normalize_model_config, normalize_model_provider
from .model_settings import validate_model_settings
from .models import DocumentIR, Evidence, ModelResult


DEFAULT_SYSTEM_PROMPT = "Return only valid JSON matching the supplied schema."
DEFAULT_EXTRACTION_PROMPT = "Extract the requested fields from this document."


def extraction_text(schema: Dict[str, Any], prompt: Dict[str, Any], document_ir: DocumentIR) -> str:
    """Render the extraction contract, including visual evidence for original files."""
    return "{}\n\n{}\n\nResponse schema:\n{}\n\nDocument:\n{}".format(
        prompt.get("extraction") or DEFAULT_EXTRACTION_PROMPT,
        CONFIDENCE_INSTRUCTIONS + ("\n\n" + GROUNDING_INSTRUCTIONS if visual_source(document_ir) else ""),
        json.dumps(response_schema(schema, include_evidence=visual_source(document_ir)), ensure_ascii=False),
        document_text(document_ir),
    )


def document_text(document_ir: DocumentIR) -> str:
    source = document_ir.metadata.get("source_input")
    if source:
        if source["mime_type"].startswith("text/") or source["mime_type"] in ("application/json", "application/xml"):
            return base64.b64decode(source["data"]).decode("utf-8")
        return "See the attached original document."
    return "\n".join(
        block.text
        for page in document_ir.pages
        for block in page.blocks
        if block.text
    )


def source_content(document_ir: DocumentIR, text: str, provider: str):
    """Build original-file content without silently substituting parser text."""
    source = document_ir.metadata.get("source_input")
    if not source or source["mime_type"].startswith("text/") or source["mime_type"] in ("application/json", "application/xml"):
        return [{"text": text}] if provider == "gemini" else text
    mime = source["mime_type"]
    if mime not in ("application/pdf", "image/png", "image/jpeg", "image/webp", "image/gif"):
        raise ValueError("Original document input supports PDF, PNG, JPEG, WebP, GIF, and UTF-8 text. Add a Parse block for this file type.")
    if provider not in ("openai", "anthropic", "gemini"):
        raise ValueError("This adapter does not support direct PDF/image input. Choose a compatible hosted model or add a Parse block.")
    if provider == "gemini":
        return [{"inlineData": {"mimeType": mime, "data": source["data"]}}, {"text": text}]
    if provider == "anthropic":
        return [{"type": "document" if mime == "application/pdf" else "image", "source": {"type": "base64", "media_type": mime, "data": source["data"]}}, {"type": "text", "text": text}]
    url = "data:{};base64,{}".format(mime, source["data"])
    file_part = {"type": "file", "file": {"filename": source["filename"], "file_data": url}} if mime == "application/pdf" else {"type": "image_url", "image_url": {"url": url}}
    return [file_part, {"type": "text", "text": text}]


def _first_match(patterns: List[str], text: str) -> Optional[str]:
    for pattern in patterns:
        match = re.search(pattern, text, flags=re.IGNORECASE | re.MULTILINE)
        if match:
            return match.group(1).strip()
    return None


class DeterministicInvoiceModel:
    name = "local-deterministic"
    version = "1"
    provider = "local"

    def run(self, document_ir: DocumentIR, schema: Dict[str, Any], prompt: Dict[str, Any]) -> ModelResult:
        source_content(document_ir, "", "local")
        text = document_text(document_ir)
        invoice_number = _first_match([r"invoice\s*(?:#|number|no\.?)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]+)", r"\b(INV-[A-Z0-9-]+)\b"], text)
        invoice_date = _first_match([r"(?:issued|invoice\s+date|date)\s*[:\-]?\s*(\d{4}-\d{2}-\d{2})"], text)
        vendor_name = _first_match([r"vendor\s*[:\-]\s*([^\n]+)", r"^([A-Z][A-Z &.-]{3,})\s+INVOICE$"], text)
        total_text = _first_match([r"(?:total\s+due|amount\s+due|grand\s+total|total)\s*[:\-]?\s*\$?\s*([0-9][0-9,]*(?:\.[0-9]{2})?)"], text)
        total = float(total_text.replace(",", "")) if total_text else None
        currency = "USD" if "$" in text or re.search(r"\bUSD\b", text, re.IGNORECASE) else None
        line_items = []
        for match in re.finditer(r"^(.+?)\s+(\d+)\s+\$?([0-9][0-9,]*\.[0-9]{2})$", text, flags=re.IGNORECASE | re.MULTILINE):
            description = match.group(1).strip()
            if description.lower().startswith(("subtotal", "tax", "total")):
                continue
            line_items.append(
                {
                    "description": description,
                    "quantity": int(match.group(2)),
                    "amount": float(match.group(3).replace(",", "")),
                }
            )
        output = {
            "invoice_number": self._field(invoice_number, 0.98, document_ir, invoice_number),
            "invoice_date": self._field(invoice_date, 0.95, document_ir, invoice_date),
            "vendor": {"name": self._field(vendor_name, 0.96, document_ir, vendor_name)},
            "total": self._field(total, 0.97, document_ir, total_text),
            "currency": self._field(currency, 0.99, document_ir, currency),
            "line_items": self._field(line_items, 0.91, document_ir, line_items[0]["description"] if line_items else None),
        }
        return ModelResult(
            output=output,
            raw_response={"adapter": self.name, "model": self.version, "output": output, "finish_reason": "local_completion"},
            usage={"input_tokens": max(1, len(text) // 4), "output_tokens": max(1, len(json.dumps(output)) // 4)},
            warnings=[],
        )

    @staticmethod
    def _field(value: Any, confidence: float, document_ir: DocumentIR, needle: Any) -> Dict[str, Any]:
        evidence = []
        if needle not in (None, "") and document_ir.parser.get("status") == "available":
            for page in document_ir.pages:
                for block in page.blocks:
                    if block.bbox and str(needle).lower() in block.text.lower():
                        metadata = {
                            key: block.metadata[key]
                            for key in ("bbox_source", "grounding", "source_index")
                            if key in block.metadata
                        }
                        evidence.append(Evidence(page=page.page, bbox=block.bbox, text=block.text, block_id=block.block_id, metadata=metadata).to_dict())
                        break
                if evidence:
                    break
        return {"value": value, "confidence": confidence if value not in (None, "") else 0.0, "confidence_source": "heuristic", "evidence": evidence}


class AnthropicModel:
    """Anthropic Messages adapter."""

    def __init__(self, api_key: Optional[str] = None, model: str = "claude-3-5-sonnet-20241022"):
        self.api_key = api_key or os.environ.get("ANTHROPIC_API_KEY")
        self.model = model
        self.name = model
        self.provider = "anthropic"

    def request_payload(self, document_ir: DocumentIR, schema: Dict[str, Any], prompt: Dict[str, Any]) -> Dict[str, Any]:
        caps = validate_model_settings(self.provider, self.model, prompt)
        message = {
            "model": self.model,
            "max_tokens": int(prompt.get("max_tokens", 4096)),
            "system": prompt.get("system") or DEFAULT_SYSTEM_PROMPT,
            "messages": [{"role": "user", "content": source_content(document_ir, extraction_text(schema, prompt, document_ir), "anthropic")}],
        }

        # Current adaptive-thinking Claude models reject custom sampling.
        if prompt.get("reasoning_effort"):
            message["output_config"] = {"effort": prompt["reasoning_effort"]}
            if caps["adaptive"]:
                message["thinking"] = {"type": "adaptive"}
        if "thinking_budget" in prompt:
            message["thinking"] = {"type": "enabled", "budget_tokens": prompt["thinking_budget"]}
        if caps["sampling"] and "thinking" not in message:
            if "top_p" in prompt:
                message["top_p"] = prompt["top_p"]
            else:
                message["temperature"] = float(prompt.get("temperature", 0))
        return message

    def run(self, document_ir: DocumentIR, schema: Dict[str, Any], prompt: Dict[str, Any]) -> ModelResult:
        if not self.api_key:
            raise RuntimeError("{} model request failed or credentials are missing. Check the selected provider and backend credentials; no fallback model was used.".format(self.provider))

        message = self.request_payload(document_ir, schema, prompt)
        request = urllib.request.Request(
            "https://api.anthropic.com/v1/messages",
            data=json.dumps(message).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "x-api-key": self.api_key,
                "anthropic-version": "2023-06-01",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                payload = json.loads(response.read().decode("utf-8"))
            text = "".join(
                item.get("text", "")
                for item in payload.get("content", [])
                if item.get("type") == "text"
            )
            parsed = model_output(_parse_json_response(text), schema, document_ir)
            return ModelResult(output=parsed, raw_response=payload, usage=payload.get("usage", {}), warnings=[])
        except (urllib.error.URLError, TimeoutError, ValueError, KeyError) as error:
            raise RuntimeError("{} model request failed or credentials are missing. Check the selected provider and backend credentials; no fallback model was used.".format(self.provider))


class OpenAICompatibleModel:
    """OpenAI Chat Completions adapter for OpenAI and compatible gateways.

    The same adapter handles hosted OpenAI models and open-source servers that
    implement the Chat Completions contract.  The provider flag controls the
    small set of capability differences without changing the extraction API.
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        model: str = "gpt-4o-mini",
        base_url: Optional[str] = None,
        provider: str = "openai",
        requires_api_key: Optional[bool] = None,
    ):
        self.api_key = api_key or os.environ.get("OPENAI_API_KEY")
        self.model = model
        self.name = model
        self.provider = normalize_model_provider(provider, model)
        self.base_url = (base_url or os.environ.get("OPENAI_BASE_URL") or "https://api.openai.com/v1").rstrip("/")
        self.requires_api_key = self.provider == "openai" if requires_api_key is None else bool(requires_api_key)

    def request_payload(self, document_ir: DocumentIR, schema: Dict[str, Any], prompt: Dict[str, Any]) -> Dict[str, Any]:
        caps = validate_model_settings(self.provider, self.model, prompt)
        # JSON object mode is supported by most OpenAI-compatible local
        # servers. Native OpenAI can opt into Structured Outputs explicitly.
        response_format = {"type": "json_object"}
        if self.provider == "openai" and prompt.get("structured_outputs"):
            response_format = {
                "type": "json_schema",
                "json_schema": {"name": "extraction", "strict": True, "schema": strict_response_schema(response_schema(schema, include_evidence=visual_source(document_ir)))},
            }
        message: Dict[str, Any] = {
            "model": self.model,
            "response_format": response_format,
            "messages": [
                {"role": "system", "content": prompt.get("system") or DEFAULT_SYSTEM_PROMPT},
                {"role": "user", "content": source_content(document_ir, extraction_text(schema, prompt, document_ir), self.provider)},
            ],
        }
        if not caps["sampling"]:
            # Reasoning models use the completion-token budget and may reject
            # sampling parameters such as temperature.
            message["max_completion_tokens"] = int(prompt.get("max_tokens", 4096))
        else:
            message["temperature"] = float(prompt.get("temperature", 0))
            message["max_tokens"] = int(prompt.get("max_tokens", 4096))
            if "top_p" in prompt:
                message["top_p"] = prompt["top_p"]
        if prompt.get("reasoning_effort"):
            message["reasoning_effort"] = prompt["reasoning_effort"]
        if prompt.get("verbosity"):
            message["verbosity"] = prompt["verbosity"]
        return message

    def run(self, document_ir: DocumentIR, schema: Dict[str, Any], prompt: Dict[str, Any]) -> ModelResult:
        if self.requires_api_key and not self.api_key:
            raise RuntimeError("{} model request failed or credentials are missing. Check the selected provider and backend credentials; no fallback model was used.".format(self.provider))
        message = self.request_payload(document_ir, schema, prompt)
        request = urllib.request.Request(
            self.base_url + "/chat/completions",
            data=json.dumps(message).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                **({"Authorization": "Bearer {}".format(self.api_key)} if self.api_key else {}),
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                payload = json.loads(response.read().decode("utf-8"))
            text = payload["choices"][0]["message"]["content"]
            if isinstance(text, list):
                text = "".join(item.get("text", "") for item in text if isinstance(item, dict))
            parsed = model_output(_parse_json_response(text), schema, document_ir)
            usage = payload.get("usage", {})
            return ModelResult(
                output=parsed,
                raw_response=payload,
                usage={"input_tokens": usage.get("prompt_tokens", 0), "output_tokens": usage.get("completion_tokens", 0)},
                warnings=[],
            )
        except (urllib.error.URLError, TimeoutError, ValueError, KeyError, IndexError) as error:
            raise RuntimeError("{} model request failed or credentials are missing. Check the selected provider and backend credentials; no fallback model was used.".format(self.provider))


class GeminiModel:
    """Google Gemini generateContent adapter."""

    def __init__(self, api_key: Optional[str] = None, model: str = "gemini-1.5-pro"):
        self.api_key = api_key or os.environ.get("GOOGLE_API_KEY") or os.environ.get("GEMINI_API_KEY")
        self.model = model
        self.name = model
        self.provider = "gemini"

    def request_payload(self, document_ir: DocumentIR, schema: Dict[str, Any], prompt: Dict[str, Any]) -> Dict[str, Any]:
        caps = validate_model_settings(self.provider, self.model, prompt)
        return {
            "systemInstruction": {"parts": [{"text": prompt.get("system") or DEFAULT_SYSTEM_PROMPT}]},
            "contents": [{"role": "user", "parts": source_content(document_ir, extraction_text(schema, prompt, document_ir), "gemini")}],
            "generationConfig": {
                "temperature": float(prompt.get("temperature", 0)),
                "maxOutputTokens": int(prompt.get("max_tokens", 4096)),
                "responseMimeType": "application/json",
                **({"topP": prompt["top_p"]} if "top_p" in prompt else {}),
                **({"thinkingConfig": {"thinkingLevel": prompt["reasoning_effort"].upper()}} if prompt.get("reasoning_effort") else {}),
                **({"thinkingConfig": {"thinkingBudget": prompt["thinking_budget"]}} if "thinking_budget" in prompt else {}),
                **({"responseJsonSchema": response_schema(schema, include_evidence=visual_source(document_ir))} if prompt.get("structured_outputs") else {}),
            },
        }

    def run(self, document_ir: DocumentIR, schema: Dict[str, Any], prompt: Dict[str, Any]) -> ModelResult:
        if not self.api_key:
            raise RuntimeError("{} model request failed or credentials are missing. Check the selected provider and backend credentials; no fallback model was used.".format(self.provider))
        endpoint = "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}".format(self.model, self.api_key)
        message = self.request_payload(document_ir, schema, prompt)
        request = urllib.request.Request(
            endpoint,
            data=json.dumps(message).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                payload = json.loads(response.read().decode("utf-8"))
            text = "".join(part.get("text", "") for part in payload["candidates"][0]["content"]["parts"])
            parsed = model_output(_parse_json_response(text), schema, document_ir)
            usage = payload.get("usageMetadata", {})
            return ModelResult(
                output=parsed,
                raw_response=payload,
                usage={"input_tokens": usage.get("promptTokenCount", 0), "output_tokens": usage.get("candidatesTokenCount", 0)},
                warnings=[],
            )
        except (urllib.error.URLError, TimeoutError, ValueError, KeyError, IndexError) as error:
            raise RuntimeError("{} model request failed or credentials are missing. Check the selected provider and backend credentials; no fallback model was used.".format(self.provider))


def create_model_adapter(config: Optional[Dict[str, Any]] = None):
    """Build the LLM adapter selected by a processor version.

    Provider selection is explicit for new configs.  Legacy versions that only
    stored a model name are normalized by ``normalize_model_config``.
    """
    normalized = normalize_model_config(config)
    provider = normalize_model_provider(normalized.get("provider"), normalized.get("name", ""))
    model_name = str(normalized.get("name") or "")
    credential_ref = str(normalized.get("credential_ref") or "").strip()

    def credential(defaults: List[str]) -> Optional[str]:
        if credential_ref:
            return os.environ.get(credential_ref)
        direct = normalized.get("api_key")
        if isinstance(direct, str) and direct:
            return direct
        return next((os.environ.get(key) for key in defaults if os.environ.get(key)), None)

    if provider == "local":
        return DeterministicInvoiceModel()
    if provider == "anthropic":
        return AnthropicModel(api_key=credential(["ANTHROPIC_API_KEY"]), model=model_name or "claude-3-5-sonnet-20241022")
    if provider == "gemini":
        return GeminiModel(api_key=credential(["GOOGLE_API_KEY", "GEMINI_API_KEY"]), model=model_name or "gemini-2.5-flash")
    if provider == "openai":
        return OpenAICompatibleModel(
            api_key=credential(["OPENAI_API_KEY"]),
            model=model_name or "gpt-4o-mini",
            base_url=normalized.get("base_url") or normalized.get("endpoint"),
            provider="openai",
            requires_api_key=True,
        )

    # Ollama, vLLM, LM Studio, OpenRouter, Together, Groq, Mistral, and
    # DeepSeek all expose an OpenAI-compatible chat surface.  A local gateway
    # is allowed to run without a key; hosted gateways can still use the
    # configured credential_ref or OPENAI_API_KEY.
    compatible_defaults = {
        "ollama": "http://127.0.0.1:11434/v1",
        "vllm": "http://127.0.0.1:8000/v1",
        "lm-studio": "http://127.0.0.1:1234/v1",
        "openrouter": "https://openrouter.ai/api/v1",
        "together": "https://api.together.xyz/v1",
        "groq": "https://api.groq.com/openai/v1",
        "mistral": "https://api.mistral.ai/v1",
        "deepseek": "https://api.deepseek.com/v1",
    }
    compatible_endpoint_env = {
        "openai-compatible": "OPENAI_COMPATIBLE_BASE_URL",
        "ollama": "OLLAMA_BASE_URL",
        "vllm": "VLLM_BASE_URL",
        "lm-studio": "LM_STUDIO_BASE_URL",
    }
    compatible_credential_env = {
        "openai-compatible": ["OPENAI_COMPATIBLE_API_KEY", "OPENAI_API_KEY"],
        "ollama": ["OLLAMA_API_KEY"],
        "vllm": ["VLLM_API_KEY", "OPENAI_API_KEY"],
        "lm-studio": ["LM_STUDIO_API_KEY"],
        "openrouter": ["OPENROUTER_API_KEY", "OPENAI_API_KEY"],
        "together": ["TOGETHER_API_KEY", "OPENAI_API_KEY"],
        "groq": ["GROQ_API_KEY", "OPENAI_API_KEY"],
        "mistral": ["MISTRAL_API_KEY", "OPENAI_API_KEY"],
        "deepseek": ["DEEPSEEK_API_KEY", "OPENAI_API_KEY"],
    }
    base_url = normalized.get("base_url") or normalized.get("endpoint") or os.environ.get(compatible_endpoint_env.get(provider, "")) or compatible_defaults.get(provider)
    return OpenAICompatibleModel(
        api_key=credential(compatible_credential_env.get(provider, ["OPENAI_API_KEY", "OPENAI_COMPATIBLE_API_KEY"])),
        model=model_name or "llama3.2",
        base_url=base_url,
        provider=provider,
        requires_api_key=provider not in {"ollama", "vllm", "lm-studio"} and not bool(base_url and provider in {"openai-compatible"}),
    )


def _parse_json_response(text: str) -> Dict[str, Any]:
    cleaned = text.strip()
    fence = chr(96) * 3
    if cleaned.startswith(fence):
        cleaned = re.sub(r"^" + fence + r"(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r"\s*" + fence + r"$", "", cleaned)
    value = json.loads(cleaned)
    if not isinstance(value, dict):
        raise ValueError("Model response must be a JSON object")
    return value
