import { versionConfig } from "../src/api";
import { settingsAfterModelChange, modelSettingsError } from "../src/model-settings";
import assert from "node:assert/strict";
import {
  configPayload,
  extractionFields,
  normalizeRun,
  mergeEditableConfig,
} from "../src/api";
import { defaultConfig } from "../src/domain";
const nested = {
  line_items: [{ description: "Consulting", amount: 250 }],
  approved: false,
};
const fields = extractionFields({
  result: {
    fields: {
      empty: { value: null, confidence: 0 },
      structured: { value: nested, confidence: 0.9 },
      cited: {
        value: 10,
        confidence: 0.99,
        evidence: [{ page: 2, bbox: [20, 40, 60, 80] }],
      },
    },
  },
  parser_ir: { pages: [{ page: 2, width: 200, height: 400 }] },
});
assert.equal(fields[0].value, null);
assert.deepEqual(fields[1].value, nested);
assert.ok(
  fields.every((f) => f.expected === null),
  "Unknown ground truth is not inferred from actual output",
);
assert.deepEqual(fields[2].area, { left: 10, top: 10, width: 20, height: 10 });
assert.equal(fields[2].page, 2);
assert.equal(
  extractionFields(
    { result: { fields: { total: { value: 1 } } } },
    { value: { total: 0 } },
  )[0].expected,
  0,
);
assert.equal(
  normalizeRun({
    id: "test",
    created_at: "2026-09-04",
    metrics: { field_accuracy: 0 },
    status: "completed",
  }).score,
  0,
);
assert.equal(
  normalizeRun({ id: "test", created_at: "2026-09-04" }).score,
  null,
);
assert.equal(
  configPayload(defaultConfig).prompt.extraction,
  defaultConfig.prompt,
);
assert.equal(
  configPayload({
    ...defaultConfig,
    provider: "openai-compatible",
    baseUrl: "http://localhost:8080/v1",
  }).model.base_url,
  "http://localhost:8080/v1",
);
assert.throws(() => configPayload({ ...defaultConfig, schema: "invalid" }));
console.log(
  "PASS: structured values, nulls, absent ground truth, zero scores/ground truth, citation coordinates, provider-neutral config, and invalid JSON.",
);

const preserved = mergeEditableConfig(
  {
    model: { provider: "local", temperature: 0.2 },
    parser: { name: "native", custom_option: true },
    prompt: { system: "Keep provenance" },
    harness: { name: "direct", version: "1", extra: true },
    normalization: { trim: true },
  },
  defaultConfig,
);
assert.equal(preserved.model.temperature, 0.2);
assert.equal(preserved.parser.custom_option, true);
assert.equal(preserved.prompt.system, "Keep provenance");
assert.equal(preserved.harness.extra, true);
assert.equal(preserved.normalization.trim, true);
assert.equal(
  mergeEditableConfig(
    { model: { provider: "anthropic", temperature: 0.7 } },
    defaultConfig,
  ).model.temperature,
  undefined,
);

const tuned = { ...defaultConfig, provider: "openai", model: "gpt-5.6-terra", modelSettings: {
  reasoning_effort: "high", max_tokens: 8192, verbosity: "low", structured_outputs: true, system: "Extract carefully.",
} };
const tunedPayload = configPayload(tuned);
assert.deepEqual(configPayload(versionConfig(tunedPayload)), tunedPayload);
assert.deepEqual(normalizeRun({ id: "test", processor_version: tunedPayload }).config?.modelSettings, tuned.modelSettings);
assert.equal(tunedPayload.prompt.reasoning_effort, "high");
assert.equal(tunedPayload.prompt.max_tokens, 8192);
const cleared = mergeEditableConfig({ ...tunedPayload, prompt: { ...tunedPayload.prompt, custom_option: "keep" } }, { ...tuned, modelSettings: {} });
assert.deepEqual(cleared.prompt, { extraction: tuned.prompt, custom_option: "keep" });
assert.equal(tunedPayload.prompt.reasoning_effort, "high", "Saved snapshots stay immutable");
assert.deepEqual(settingsAfterModelChange(tuned.modelSettings), { max_tokens: 8192, system: "Extract carefully." });
assert.equal(configPayload({ ...defaultConfig, modelSettings: { temperature: 0, structured_outputs: false } }).prompt.temperature, 0);
assert.throws(() => configPayload({ ...tuned, modelSettings: { max_tokens: 0 } }), /Output token limit/);
assert.throws(() => configPayload({ ...tuned, model: "gpt-6-astra", modelSettings: { reasoning_effort: "none" } }), /reasoning effort/);
assert.match(modelSettingsError("anthropic", "claude-haiku-4-5", { thinking_budget: 4096, max_tokens: 4096 }), /smaller/);
assert.equal(modelSettingsError("google", "gemini-2.5-flash", { thinking_budget: 0 }), "");
console.log("PASS: processor model settings round trip, reset, provider changes, zero values, validation, and saved-version isolation.");

assert.equal(normalizeRun({ id: "missing" }).cost, null);
assert.equal(normalizeRun({ id: "free", metrics: { cost_usd: 0 } }).cost, 0);
const timed = normalizeRun({ id: "timed", metrics: { average_latency_ms: 9758 },
  started_at: "2026-09-08T03:42:23.389111Z", completed_at: "2026-09-08T03:52:40.099541Z" });
assert.equal(timed.latency, 9.758);
assert.ok(Math.abs(timed.duration! - 616.710) < 0.001);
