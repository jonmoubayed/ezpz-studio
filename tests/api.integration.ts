import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { defaultConfig } from "../src/domain";
import * as api from "../src/api";
const nativeFetch = globalThis.fetch;
const base = process.env.STUDIO_TEST_URL;
if (!base)
  throw new Error("Use npm run test:integration to start an isolated backend.");
globalThis.fetch = ((input: any, init: any) =>
  nativeFetch(
    typeof input === "string" && input.startsWith("/v1") ? base + input : input,
    init,
  )) as typeof fetch;
// Run only against the disposable backend started by scripts/test-api.sh.
const health = await api.request("/health");
assert.equal(health.ok, true);
const config = {
  ...defaultConfig,
  schema: JSON.stringify({
    type: "object",
    properties: {
      invoice_number: { type: "string" },
      total: { type: "number" },
    },
    required: ["invoice_number", "total"],
  }),
};
const pdfUpload = await api.uploadDocument(
  new File(
    [await readFile("public/samples/invoice-0.pdf")],
    "integration-invoice.pdf",
    { type: "application/pdf" },
  ),
);
assert.ok(pdfUpload.id);
assert.equal(pdfUpload.type, "application/pdf");
const upload = await api.uploadDocument(
  new File(
    ["Invoice # INV-2026-001\nTotal due $2592.00\n"],
    "integration-invoice.txt",
    { type: "text/plain" },
  ),
);
const processor = await api.newProcessor(
  `integration-preview-${Date.now()}`,
  config,
);
const preview = await api.previewDocument(upload, config, processor.name);
assert.equal(preview.preview, true);
const fields = api.extractionFields(preview);
assert.equal(fields.length, 2);
assert.equal(fields.find((f) => f.key === "total")?.value, 2592);
assert.ok(
  fields.every((f) => f.expected === null),
  "Missing ground truth must remain unknown",
);
await api.request(`/documents/${upload.id}/ground-truth`, {
  method: "POST",
  body: JSON.stringify({
    value: {
      invoice_number: "INV-2026-001",
      vendor: "Northstar Design Co.",
      invoice_date: "2026-09-01",
      due_date: "2026-09-30",
      subtotal: 2400,
      tax: 192,
      total: 2592,
    },
    annotation_status: "complete",
    author: "integration-test",
  }),
});
const dataset = await api.createDataset(`Integration benchmark ${Date.now()}`, [
  upload.id,
]);
assert.ok(dataset.id);
const run = await api.runBenchmark(dataset.id, config, "Integration candidate");
assert.ok(run);
assert.equal(run.name, "Integration candidate");
assert.equal(run.datasetId, dataset.id);
assert.equal(run.documents, 1);
assert.ok(run.score !== null);
// Repeating a hypothesis creates a new immutable run/configuration, not a name collision.
const repeated = await api.runBenchmark(
  dataset.id,
  config,
  "Integration candidate",
);
assert.ok(repeated);
assert.notEqual(run.id, repeated.id);
await api.saveFeedback(
  run.id,
  upload.id,
  "total",
  "accepted",
  2592,
  "Confirmed from source",
);
const reviews = await api.request(`/runs/${run.id}/reviews`);
assert.equal(reviews.review_decisions[0].status, "accepted");
const data = await api.loadWorkspace();
assert.ok(data.documents.some((d) => d.id === upload.id));
assert.ok(data.datasets.some((d) => d.id === dataset.id && d.count === 1));
assert.ok(data.runs.some((r) => r.id === run.id));
console.log(
  "PASS: PDF upload, local text extraction, missing ground truth, annotation, dataset membership, benchmark, repeated hypothesis, run normalization, and persisted feedback.",
);
// Grouped processor iterations keep the same process and immutable configuration versions.
const originalVersion = processor.versions[0].id;
const firstGrouped = await api.runBenchmark(
  dataset.id,
  config,
  "Processor baseline",
  { name: "Invoice quality", processorId: processor.id },
);
assert.ok(firstGrouped?.groupId);
const revised = {
  ...config,
  prompt: config.prompt + " Preserve exact decimal amounts.",
};
const newVersion = await api.saveProcessorVersion(processor.id, revised, {
  name: processor.name,
  description: "Reusable invoice extractor",
});
assert.notEqual(newVersion.id, originalVersion);
const persisted = api.normalizeProcessor(
  (await api.request(`/processors/${processor.id}`)).processor,
);
assert.equal(persisted.description, "Reusable invoice extractor");
assert.equal(persisted.config.prompt, revised.prompt);
assert.ok(persisted.versions.length >= 2);
const candidate = await api.runBenchmark(
  dataset.id,
  revised,
  "Amount precision",
  { id: firstGrouped!.groupId, processorId: processor.id },
);
assert.equal(candidate?.groupId, firstGrouped?.groupId);
assert.notEqual(candidate?.experimentId, firstGrouped?.experimentId);
const rerun = await api.runBenchmark(
  dataset.id,
  revised,
  "Amount precision rerun",
  { id: firstGrouped!.groupId, processorId: processor.id },
);
assert.equal(
  rerun?.experimentId,
  candidate?.experimentId,
  "Same saved configuration reuses its experiment",
);
const baselineSnapshot = (await api.request(`/runs/${firstGrouped!.id}`)).run
  .processor_version;
assert.equal(
  baselineSnapshot.prompt.extraction,
  config.prompt,
  "Updating processor preserves baseline snapshot",
);
console.log(
  "PASS: saved processor metadata, version history, evaluation grouping, iteration snapshots, and repeated runs per configuration.",
);
