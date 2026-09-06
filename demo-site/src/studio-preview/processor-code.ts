import type { Config } from "./domain";

// Render readable Python literals without interpolating user text as code.
function pyLiteral(value: unknown, depth = 0): string {
  if (value === null) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value !== "object") return JSON.stringify(value);
  const indent = "    ".repeat(depth + 1);
  const closing = "    ".repeat(depth);
  if (Array.isArray(value)) return value.length
    ? `[\n${value.map(item => indent + pyLiteral(item, depth + 1)).join(",\n")}\n${closing}]` : "[]";
  const entries = Object.entries(value);
  return entries.length
    ? `{\n${entries.map(([key, item]) => `${indent}${JSON.stringify(key)}: ${pyLiteral(item, depth + 1)}`).join(",\n")}\n${closing}}` : "{}";
}

export function generateProcessorCode(config: Config) {
  const schema = JSON.parse(config.schema);
  if (!schema || schema.type !== "object" || !schema.properties ||
      typeof schema.properties !== "object" || Array.isArray(schema.properties)) {
    throw new Error("Enter an object schema with a properties object before copying code.");
  }
  const providers = ["local", "openai", "anthropic", "google", "gemini", "ollama", "openai-compatible"];
  if (!providers.includes(config.provider)) throw new Error(`Unsupported provider: ${config.provider}`);
  if (!["native", "docling", "llama-parse"].includes(config.parser)) throw new Error(`Unsupported parser: ${config.parser}`);
  if (!config.model.trim()) throw new Error("Enter a model ID before copying code.");

  const packages = new Set<string>();
  const env: string[] = [];
  const needsRepo = config.parser === "native" || config.provider === "local";
  if (config.provider !== "local" || config.parser === "llama-parse") packages.add("requests");
  if (config.parser === "docling") packages.add("docling");
  if (config.parser === "native") packages.add("pypdf");
  if (config.parser === "llama-parse") env.push("LLAMA_CLOUD_API_KEY");
  const key = { openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY", google: "GEMINI_API_KEY", gemini: "GEMINI_API_KEY" }[config.provider];
  if (key) env.push(key);
  if (config.provider === "openai-compatible") env.push("OPENAI_API_KEY (if required by your endpoint)");

  let endpoint = config.baseUrl.trim().replace(/\/+$/, "");
  if (["ollama", "openai-compatible"].includes(config.provider)) {
    if (!endpoint && config.provider === "ollama") endpoint = "http://localhost:11434";
    let url: URL;
    try { url = new URL(endpoint); } catch { throw new Error("Enter a valid HTTP or HTTPS endpoint URL."); }
    if (!["http:", "https:"].includes(url.protocol) || url.search || url.hash || url.username || url.password) {
      throw new Error("Use an HTTP or HTTPS endpoint without credentials, query parameters, or a fragment.");
    }
    if (config.provider === "ollama") endpoint = endpoint.replace(/\/v1$/, "");
    else if (!url.pathname || url.pathname === "/") endpoint += "/v1";
  }

  const setup = [
    needsRepo ? "Run from the ezpz repository root (uses its native/local adapters)." : "Save as extract.py and run with Python 3.",
    packages.size ? `Install: python -m pip install ${[...packages].join(" ")}` : "No additional Python packages required.",
    env.length ? `Set environment variables: ${env.join(", ")}.` : "No API key required.",
    "Run: python extract.py /path/to/document.pdf",
  ];
  const parts = [
    ["# Generated from the current processor configuration.", ...setup.map(line => `# ${line}`)].join("\n"),
    "import json\nimport mimetypes\nimport os\nimport sys\nfrom pathlib import Path",
    packages.has("requests") ? "import requests" : "",
    `\nSCHEMA = ${pyLiteral(schema)}\nINSTRUCTIONS = ${pyLiteral(config.prompt)}\nMODEL = ${pyLiteral(config.model)}`,
    '\nsource = Path(sys.argv[1] if len(sys.argv) > 1 else "document.pdf")',
  ];

  if (config.parser === "native") {
    parts.push(`# 1. Parse with ezpz's native text adapter (PDF, text, HTML, DOCX, XLSX).
from backend.parser import parse_document
document_ir = parse_document(
    {"id": "source", "filename": source.name,
     "mime_type": mimetypes.guess_type(source.name)[0] or "application/octet-stream"},
    source.read_bytes(), {"name": "native", "version": "1"},
)
text = "\\n".join(block.text for page in document_ir.pages for block in page.blocks if block.text)`);
  } else if (config.parser === "docling") {
    parts.push(`# 1. Parse with Docling.
from docling.document_converter import DocumentConverter
text = DocumentConverter().convert(str(source)).document.export_to_markdown()`);
  } else {
    parts.push(`# 1. Upload to LlamaParse v2 and wait for Markdown.
import time
from urllib.parse import quote
parse_url = "https://api.cloud.llamaindex.ai/api/v2/parse"
parse_headers = {"Authorization": "Bearer " + os.environ["LLAMA_CLOUD_API_KEY"]}
with source.open("rb") as file:
    response = requests.post(
        parse_url + "/upload", headers=parse_headers,
        files={"file": (source.name, file, mimetypes.guess_type(source.name)[0] or "application/octet-stream")},
        data={"configuration": json.dumps({"tier": "agentic", "version": "latest"})},
        timeout=120,
    )
response.raise_for_status()
job_id = response.json()["id"]
deadline = time.monotonic() + 120
while True:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("LlamaParse did not complete within 120 seconds")
    response = requests.get(
        parse_url + "/" + quote(job_id, safe=""), headers=parse_headers,
        params={"expand": "markdown"}, timeout=min(30, remaining),
    )
    response.raise_for_status()
    parsed = response.json()
    job = parsed.get("job", parsed)
    status = job.get("status", "PENDING").upper()
    if status == "COMPLETED":
        break
    if status in {"FAILED", "CANCELLED"}:
        raise RuntimeError(job.get("error_message") or "LlamaParse " + status)
    time.sleep(min(2, max(0, deadline - time.monotonic())))
text = "\\n\\n".join(page.get("markdown", "") for page in parsed.get("markdown", {}).get("pages", []))`);
  }
  parts.push('if not text.strip():\n    raise ValueError("The parser returned no text. Check the document or choose an OCR-capable parser.")');
  if (config.provider === "local") {
    if (config.parser !== "native") parts.push(`from backend.models import DocumentIR, DocumentPage, DocumentBlock
document_ir = DocumentIR(
    document_id="source", parser={"name": ${pyLiteral(config.parser)}},
    metadata={"filename": source.name},
    pages=[DocumentPage(page=1, width=1, height=1,
        blocks=[DocumentBlock(block_id="text", block_type="text", text=text, bbox=None)])],
)`);
    parts.push(`# 2. Run the selected local deterministic adapter.
# This is an invoice heuristic, not an LLM; arbitrary instructions/fields are not supported.
from backend.model import DeterministicInvoiceModel
result = DeterministicInvoiceModel().run(document_ir, SCHEMA, {"extraction": INSTRUCTIONS}).output`);
  } else {
    parts.push(`# 2. Extract using the selected model and output schema.
# Provider/model support for JSON Schema keywords varies.
system = "Extract only information supported by the document. Return JSON matching the schema."
message = INSTRUCTIONS + "\\n\\nOutput schema:\\n" + json.dumps(SCHEMA) + "\\n\\nDocument:\\n" + text`);
    if (config.provider === "anthropic") {
      parts.push(`response = requests.post(
    "https://api.anthropic.com/v1/messages",
    headers={"x-api-key": os.environ["ANTHROPIC_API_KEY"], "anthropic-version": "2023-06-01"},
    json={
        "model": MODEL, "max_tokens": 4096, "system": system,
        "messages": [{"role": "user", "content": message}],
        "tools": [{"name": "extract_document", "description": "Return extracted document fields", "input_schema": SCHEMA}],
        "tool_choice": {"type": "tool", "name": "extract_document"},
    }, timeout=120,
)
response.raise_for_status()
payload = response.json()
if payload.get("stop_reason") == "max_tokens":
    raise RuntimeError("Extraction was truncated; increase max_tokens")
result = next(block["input"] for block in payload["content"]
              if block["type"] == "tool_use" and block["name"] == "extract_document")`);
    } else if (["google", "gemini"].includes(config.provider)) {
      parts.push(`from urllib.parse import quote
response = requests.post(
    "https://generativelanguage.googleapis.com/v1beta/models/" + quote(MODEL, safe="") + ":generateContent",
    headers={"x-goog-api-key": os.environ["GEMINI_API_KEY"]},
    json={
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": [{"text": message}]}],
        "generationConfig": {"responseMimeType": "application/json", "responseJsonSchema": SCHEMA},
    }, timeout=120,
)
response.raise_for_status()
candidate = response.json()["candidates"][0]
if candidate.get("finishReason") != "STOP":
    raise RuntimeError("Extraction did not finish: " + str(candidate.get("finishReason")))
result = json.loads("".join(part.get("text", "") for part in candidate["content"]["parts"] if not part.get("thought")))`);
    } else if (config.provider === "ollama") {
      parts.push(`response = requests.post(
    ${pyLiteral(endpoint + "/api/chat")},
    json={"model": MODEL, "stream": False, "format": SCHEMA,
          "messages": [{"role": "system", "content": system}, {"role": "user", "content": message}]},
    timeout=120,
)
response.raise_for_status()
result = json.loads(response.json()["message"]["content"])`);
    } else {
      const native = config.provider === "openai";
      parts.push(`headers = {"Content-Type": "application/json"}
api_key = ${native ? 'os.environ["OPENAI_API_KEY"]' : 'os.environ.get("OPENAI_API_KEY", "")'}
if api_key:
    headers["Authorization"] = "Bearer " + api_key
response = requests.post(
    ${pyLiteral(native ? "https://api.openai.com/v1/chat/completions" : endpoint + "/chat/completions")},
    headers=headers,
    json={
        "model": MODEL,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": message}],
        ${native ? '"response_format": {"type": "json_schema", "json_schema": {"name": "extraction", "strict": False, "schema": SCHEMA}},' : '# JSON mode is broadly compatible; the full schema is included in the prompt.\n        "response_format": {"type": "json_object"},'}
    }, timeout=120,
)
response.raise_for_status()
choice = response.json()["choices"][0]
if choice.get("finish_reason") != "stop":
    raise RuntimeError("Extraction did not finish: " + str(choice.get("finish_reason")))
if choice["message"].get("refusal"):
    raise RuntimeError(choice["message"]["refusal"])
result = json.loads(choice["message"]["content"])`);
    }
  }
  parts.push('print(json.dumps(result, indent=2, ensure_ascii=False))');
  return { code: parts.filter(Boolean).join("\n\n") + "\n", setup };
}
