import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React, { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { StudioProvider, useStudio } from "../src/store";
import { defaultConfig } from "../src/domain";
import * as api from "../src/api";
const base = process.env.STUDIO_TEST_URL;
if (!base) throw new Error("Run through npm run test:integration");
const dom = new JSDOM('<div id="root"></div>', { url: `${base}/#Processors` });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  location: dom.window.location,
  history: dom.window.history,
  localStorage: dom.window.localStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.scrollTo = () => {};
const nativeFetch = globalThis.fetch;
globalThis.fetch = ((input: any, init: any) =>
  nativeFetch(
    typeof input === "string" && input.startsWith("/v1") ? base + input : input,
    init,
  )) as typeof fetch;
let store: ReturnType<typeof useStudio>;
function Probe() {
  store = useStudio();
  return null;
}
let root = createRoot(document.getElementById("root")!);
async function mount() {
  await act(async () => {
    root.render(
      <StrictMode>
        <StudioProvider>
          <Probe />
        </StudioProvider>
      </StrictMode>,
    );
  });
}
async function settle(check: () => boolean, name: string) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  }
  throw new Error(`Timed out: ${name}; ${store!.message}`);
}
await mount();
await settle(
  () => store!.connection === "ready" && !store!.busy,
  "automatic connection",
);
assert.equal(store!.mode, "live");
assert.ok(store!.adapters?.llm.length);
assert.ok(!store!.documents.some((d) => d.sample));
const config = {
  ...defaultConfig,
  schema: JSON.stringify({
    type: "object",
    properties: {
      invoice_number: { type: "string" },
      total: { type: "number" },
    },
  }),
};
await act(async () => {
  assert.equal(
    await store!.createProcessor(
      "Store test invoices",
      "State integration",
      config,
    ),
    true,
  );
});
const processorId = store!.activeProcessorId;
await act(async () => {
  await store!.upload([
    new File(
      ["Invoice # INV-2026-101\nTotal due $75.00"],
      "store-invoice.txt",
      { type: "text/plain" },
    ),
  ]);
});
const documentId = store!.selectedId;
await settle(() => store!.selected?.id === documentId, "selected document");
// Let the processor-scoped document request finish before extracting.
await act(async () => {
  await new Promise((r) => setTimeout(r, 100));
});
await act(async () => {
  const doc = await store!.extract();
  assert.equal(doc?.fields.find((f) => f.key === "total")?.value, 75);
});
assert.equal(
  store!.selected?.runId,
  undefined,
  "preview must not become a reviewable run",
);
await api.request(`/documents/${documentId}/ground-truth`, {
  method: "POST",
  body: JSON.stringify({
    value: { invoice_number: "INV-2026-101", total: 80 },
    annotation_status: "complete",
  }),
});
const dataset = await api.createDataset("Store quality", [documentId]);
await act(async () => {
  await store!.refresh();
});
await act(async () => {
  assert.equal(
    await store!.benchmark("Store baseline", dataset.id, config, {
      name: "Store iterations",
      processorId,
    }),
    true,
  );
});
const run = store!.runs.find((r) => r.name === "Store baseline")!;
assert.ok(run?.id);
await act(async () => {
  assert.equal(await store!.loadReviewRun(run.id), true);
});
const doc = store!.reviewDocuments.find((d) => d.id === documentId)!;
assert.equal(doc.fields.find((f) => f.key === "total")?.status, "incorrect");
assert.equal(doc.fields.find((f) => f.key === "total")?.expected, 80);
await act(async () => {
  assert.equal(
    await store!.review(
      doc,
      "total",
      "corrected",
      80,
      "Verified against source",
    ),
    true,
  );
});
await act(async () => {
  store!.updateConfig({ ...config, prompt: "Unsaved local processor draft" });
});
await act(async () => {
  root.unmount();
});
root = createRoot(document.getElementById("root")!);
await mount();
await settle(
  () => store!.connection === "ready" && !store!.busy,
  "restore after reload",
);
assert.equal(store!.activeProcessorId, processorId);
assert.equal(store!.selectedId, documentId);
assert.equal(store!.config.prompt, "Unsaved local processor draft");
assert.equal(store!.reviewRunId, run.id);
assert.equal(store!.reviews.find((r) => r.field === "total")?.value, 80);
assert.equal(
  store!.reviews.find((r) => r.field === "total")?.note,
  "Verified against source",
);
await act(async () => {
  store!.demo();
});
assert.equal(store!.mode, "demo");
assert.notEqual(store!.config.prompt, "Unsaved local processor draft");
assert.equal(new URLSearchParams(location.search).get("demo"), "1");
await act(async () => {
  await store!.connect();
});
assert.equal(store!.config.prompt, "Unsaved local processor draft");
assert.equal(store!.mode, "live");
assert.equal(new URLSearchParams(location.search).has("demo"), false);
await act(async () => {
  root.unmount();
});
console.log(
  "PASS: React StrictMode startup, real uploads/previews/benchmarks, run-scoped review data, saved feedback reload, processor/draft restore, and demo/live separation.",
);
