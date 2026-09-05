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
await act(async () => {
  location.hash = "#Evaluations/group/example/experiment/example";
});
await settle(
  () => store!.page === "Evaluations",
  "evaluation deep link navigation",
);
await act(async () => {
  location.hash = "#Processors";
});
await settle(() => store!.page === "Processors", "browser hash navigation");
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
let createdGroupId = "";
await act(async () => {
  const group = await store!.createEvaluationGroup(
    "Separate group",
    dataset.id,
    "Track improvements",
  );
  createdGroupId = group.id;
});
assert.ok(
  store!.evalGroups.some(
    (g) => g.id === createdGroupId && g.experiments?.length === 0,
  ),
  "Creating a group does not require creating a run",
);

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
// Save expected values and attach this source to an eval dataset without rerunning a model.
const expected = {
  invoice_number: "INV-2026-101",
  total: 0,
  approved: false,
  optional: null,
  items: [{ price: 25 }],
};
await act(async () => {
  assert.equal(
    (
      await store!.saveExpectedValues(store!.selected!, expected, {
        name: "Expected values benchmark",
      })
    ).ok,
    true,
  );
});
const savedDataset = store!.datasets.find(
  (d) => d.name === "Expected values benchmark",
)!;
assert.equal(savedDataset.count, 1);
await act(async () => {
  assert.equal(
    (
      await store!.saveExpectedValues(store!.selected!, expected, {
        id: savedDataset.id,
      })
    ).ok,
    true,
  );
});
assert.equal(
  store!.datasets.find((d) => d.id === savedDataset.id)?.count,
  1,
  "Adding twice must not duplicate membership",
);
const manifest = (await api.request(`/datasets/${savedDataset.id}/manifest`))
  .manifest;
assert.deepEqual(manifest.documents[0].ground_truth, expected);
await act(async () => {
  await store!.connect();
});
await settle(
  () => store!.selected?.groundTruth?.total === 0,
  "restored ground truth",
);
assert.equal(store!.selected?.groundTruth?.total, 0);
await act(async () => {
  const result = await store!.extract();
  assert.equal(result?.fields.find((f) => f.key === "total")?.expected, 0);
  assert.equal(
    result?.fields.find((f) => f.key === "total")?.hasExpected,
    true,
  );
});
const originalRun = (await api.request(`/runs/${run.id}`)).run;
assert.equal(
  originalRun.evaluations[0].fields.total.expected,
  80,
  "Updating ground truth must preserve prior evaluation snapshots",
);
console.log(
  "PASS: expected values saved with dataset membership, duplicate protection, manifest round trip, preview comparisons, and unchanged historical evaluations.",
);
// Re-adding a member preserves its evaluation split/tags and reports an update.
await api.request(`/datasets/${savedDataset.id}/documents`, {
  method: "PATCH",
  body: JSON.stringify({
    document_id: documentId,
    split: "test",
    tags: ["regression"],
  }),
});
await act(async () => {
  const result = await store!.saveExpectedValues(store!.selected!, expected, {
    id: savedDataset.id,
  });
  assert.equal(result.ok, true);
  assert.equal(result.alreadyMember, true);
  assert.equal(result.dataset?.count, 1);
});
const preserved = (await api.request(`/datasets/${savedDataset.id}`))
  .documents[0];
assert.equal(preserved.split, "test");
assert.deepEqual(preserved.tags, ["regression"]);
// Exercise a real created dataset followed by a failed membership write.
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: any, init: any) => {
  if (
    typeof input === "string" &&
    /\/datasets\/[^/]+\/documents$/.test(input) &&
    init?.method === "POST"
  )
    return Promise.resolve(
      new Response(JSON.stringify({ error: "Simulated membership failure" }), {
        status: 503,
      }),
    );
  return realFetch(input, init);
}) as typeof fetch;
let partial: Awaited<ReturnType<typeof store.saveExpectedValues>>;
try {
  await act(async () => {
    partial = await store!.saveExpectedValues(store!.selected!, expected, {
      name: "Retry benchmark",
    });
  });
} finally {
  globalThis.fetch = realFetch;
}
assert.equal(partial!.ok, false);
assert.equal(partial!.groundTruthSaved, true);
assert.ok(partial!.dataset?.id);
assert.match(partial!.error!, /Ground truth was saved/);
assert.match(partial!.error!, /Simulated membership failure/);
await act(async () => {
  const result = await store!.saveExpectedValues(store!.selected!, expected, {
    id: partial!.dataset!.id,
  });
  assert.equal(result.ok, true);
  assert.equal(result.dataset?.count, 1);
});
const retryDatasets = (await api.request("/datasets")).datasets.filter(
  (d: any) => d.name === "Retry benchmark",
);
assert.equal(
  retryDatasets.length,
  1,
  "Retry must reuse the already created dataset",
);
const retried = (
  await api.request(`/datasets/${partial!.dataset!.id}/manifest`)
).manifest;
assert.deepEqual(retried.documents[0].ground_truth, expected);
// A success response without the requested membership is never reported as success.
globalThis.fetch = ((input: any, init: any) => {
  if (
    typeof input === "string" &&
    input.endsWith(`/datasets/${savedDataset.id}/manifest`)
  )
    return Promise.resolve(
      new Response(JSON.stringify({ manifest: { documents: [] } }), {
        status: 200,
      }),
    );
  return realFetch(input, init);
}) as typeof fetch;
try {
  await act(async () => {
    const result = await store!.saveExpectedValues(store!.selected!, expected, {
      id: savedDataset.id,
    });
    assert.equal(result.ok, false);
    assert.match(result.error!, /Could not verify/);
  });
} finally {
  globalThis.fetch = realFetch;
}
console.log(
  "PASS: dataset writes verified against persisted ground truth, existing split/tags preserved, partial failure exposed, and retry creates no duplicate dataset.",
);
await act(async () => {
  root.unmount();
});
console.log(
  "PASS: React StrictMode startup, real uploads/previews/benchmarks, run-scoped review data, saved feedback reload, processor/draft restore, and demo/live separation.",
);
