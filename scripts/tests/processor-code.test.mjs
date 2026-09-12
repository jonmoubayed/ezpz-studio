import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { generateProcessorCode } from '../../src/processor-code.ts'

const schema = { type: 'object', properties: {
  vendor: { type: 'string', description: 'Quotes " and \' and \\n; café 🦙' },
  items: { type: 'array', items: { type: 'object', properties: { amount: { type: ['number', 'null'] } }, required: [] } },
}, required: ['vendor'], additionalProperties: false }
const base = { provider: 'openai', model: 'gpt-4.1', parser: 'native', baseUrl: 'http://localhost:11434',
  prompt: 'Extract "vendor".\nKeep \\ paths and café 🦙. Triple quotes: """ and \'\'\'.', schema: JSON.stringify(schema) }

// Execute the actual exported Python against fake provider responses. Native
// parsing and the deterministic model use the real repository implementations.
const harness = String.raw`
import contextlib, io, json, os, sys, tempfile, types
from pathlib import Path
case = json.load(sys.stdin)
calls = []
import urllib.request
def direct_request(request, **kwargs):
    calls.append({"url": request.full_url, "json": json.loads(request.data)})
    text = json.dumps({"vendor": {"value": "Acme", "confidence": .9}})
    body = {"choices": [{"message": {"content": text}}], "content": [{"type": "text", "text": text}],
            "candidates": [{"content": {"parts": [{"text": text}]}}]}
    return io.BytesIO(json.dumps(body).encode())
urllib.request.urlopen = direct_request
class Response:
    def __init__(self, body): self.body = body
    def raise_for_status(self): pass
    def json(self): return self.body
def post(url, **kwargs):
    calls.append({"url": url, "json": kwargs.get("json")})
    if url.endswith("/upload"): return Response({"id": "job-1"})
    if "/messages" in url: return Response({"stop_reason": "tool_use", "content": [{"type": "tool_use", "name": "extract_document", "input": {"vendor": "Acme"}}]})
    if ":generateContent" in url: return Response({"candidates": [{"finishReason": "STOP", "content": {"parts": [{"text": '{"vendor":"Acme"}'}]}}]})
    if "/api/chat" in url: return Response({"message": {"content": '{"vendor":"Acme"}'}})
    return Response({"choices": [{"finish_reason": "stop", "message": {"content": '{"vendor":"Acme"}'}}]})
def get(url, **kwargs):
    calls.append({"url": url, "params": kwargs.get("params")})
    return Response({"job": {"status": case.get("parseStatus", "COMPLETED")}, "markdown": {"pages": [{"markdown": "Vendor: Acme\nInvoice: INV-123\nTotal: $12.00"}]}})
sys.modules["requests"] = types.SimpleNamespace(post=post, get=get)
class Converter:
    def convert(self, path): return types.SimpleNamespace(document=types.SimpleNamespace(export_to_markdown=lambda: "Vendor: Acme\nInvoice: INV-123\nTotal: $12.00"))
sys.modules["docling"] = types.ModuleType("docling")
sys.modules["docling.document_converter"] = types.SimpleNamespace(DocumentConverter=Converter)
for key in ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "LLAMA_CLOUD_API_KEY"]: os.environ[key] = "test-placeholder"
with tempfile.TemporaryDirectory() as folder:
    source = Path(folder) / "invoice.txt"
    source.write_text("Vendor: Acme\nInvoice: INV-123\nTotal: $12.00")
    sys.argv = ["extract.py", str(source)]
    scope = {}
    with contextlib.redirect_stdout(io.StringIO()): exec(compile(case["code"], "extract.py", "exec"), scope)
    print(json.dumps({"schema": scope["SCHEMA"], "prompt": scope["INSTRUCTIONS"], "calls": calls, "result": scope["result"]}))
`
function run(config, extra = {}) {
  const snippet = generateProcessorCode(config)
  return spawnSync('python3', ['-c', harness], {
    cwd: new URL('../..', import.meta.url), input: JSON.stringify({code: snippet.code, ...extra}), encoding: 'utf8',
  })
}
for (const parser of ['native', 'docling', 'llama-parse']) {
  for (const provider of ['local', 'openai', 'anthropic', 'google', 'ollama', 'openai-compatible']) {
    test(`generated Python executes: ${parser} → ${provider}`, () => {
      const execution = run({...base, parser, provider})
      assert.equal(execution.status, 0, execution.stderr)
      const result = JSON.parse(execution.stdout)
      assert.deepEqual(result.schema, schema)
      assert.equal(result.prompt, base.prompt)
      const call = result.calls.find(call => call.json)
      if (provider === 'local') { assert.equal(call, undefined); return }
      if (provider !== 'google') assert.equal(call.json.model, base.model)
      if (provider === 'openai') assert.deepEqual(call.json.response_format.json_schema.schema, schema)
      if (provider === 'anthropic') assert.deepEqual(call.json.tools[0].input_schema, schema)
      if (provider === 'google') assert.deepEqual(call.json.generationConfig.responseJsonSchema, schema)
      if (provider === 'ollama') { assert.deepEqual(call.json.format, schema); assert.equal(call.url, 'http://localhost:11434/api/chat') }
      if (provider === 'openai-compatible') {
        assert.equal(call.url, 'http://localhost:11434/v1/chat/completions')
        assert.equal(call.json.response_format.type, 'json_object')
        assert.match(call.json.messages[1].content, /Output schema:/)
      }
    })
  }
}
test('keeps gateway paths and normalizes an Ollama /v1 URL', () => {
  for (const [provider, baseUrl, expected] of [
    ['openai-compatible', 'https://gateway.example/api/v1/', 'https://gateway.example/api/v1/chat/completions'],
    ['ollama', 'http://localhost:11434/v1/', 'http://localhost:11434/api/chat'],
  ]) {
    const result = run({...base, provider, baseUrl})
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).calls[0].url, expected)
  }
})
test('rejects invalid configuration without producing misleading code', () => {
  for (const patch of [{schema: '{'}, {schema: '[]'}, {model: ''}, {parser: 'unknown'}, {provider: 'unknown'},
    {provider: 'openai-compatible', baseUrl: ''}, {provider: 'ollama', baseUrl: 'ftp://localhost'},
    {provider: 'ollama', baseUrl: 'https://secret:password@example.com'},
  ]) assert.throws(() => generateProcessorCode({...base, ...patch}))
})
test('LlamaParse failure stops before the LLM call', () => {
  const result = run({...base, parser: 'llama-parse'}, {parseStatus: 'FAILED'})
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /LlamaParse FAILED/)
})

for (const provider of ['openai', 'anthropic', 'google', 'ollama', 'openai-compatible']) {
  test(`generated original-document Python executes without a parser: ${provider}`, () => {
    const execution = run({...base, parser: 'none', provider});
    assert.equal(execution.status, 0, execution.stderr);
    const result = JSON.parse(execution.stdout);
    assert.equal(result.calls.length, 1);
    assert.equal(result.result.vendor.value, 'Acme');
    assert.equal(result.result.vendor.confidence, .9);
    assert.deepEqual(result.schema, schema);
    assert.equal(result.prompt, base.prompt);
    assert.doesNotMatch(result.calls[0].url, /llamaindex/);
  });
}
