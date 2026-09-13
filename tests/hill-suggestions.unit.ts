import assert from "node:assert/strict";
import { applySuggestion, starterSuggestions, suggestExperiments } from "../src/hill-suggestions";
import { evaluationDocuments } from "../src/evaluation-model";
import { defaultConfig, sampleDocuments, sampleRuns, type Document } from "../src/domain";

const run = { ...sampleRuns[0], id: "baseline", config: defaultConfig };
const docs = evaluationDocuments({
  id: run.id,
  evaluations: [
    { document_id: "a", fields: {
      total: { status: "incorrect", actual: 90, expected: 0 },
      enabled: { status: "hallucinated", actual: true, expected: false },
      date: { status: "missing", actual: null, expected: "2026-01-01" },
      nullable: { status: "correct", actual: null, expected: null },
      unscored: { status: "unscored", actual: "Unknown" },
    } },
    { document_id: "b", fields: {
      total: { status: "incorrect", actual: 35, expected: 30 },
      enabled: { status: "correct", actual: false, expected: false },
      date: { status: "correct", actual: "2026-01-02", expected: "2026-01-02" },
    } },
    { document_id: "c", fields: {
      total: { status: "unscored", actual: 35 },
    } },
  ],
}, []);
const ideas = suggestExperiments(run, docs);
assert.equal(ideas[0].field, "total");
assert.match(ideas[0].observation, /2 of 2 scored documents/);
assert.equal(ideas[0].evidence[0].field.expected, 0);
assert.equal(ideas.find((i) => i.field === "enabled")!.evidence[0].field.expected, false);
assert.equal(ideas.find((i) => i.field === "enabled")!.kind, "Grounding");
assert.match(ideas.find((i) => i.field === "date")!.title, /Recover missing/);
assert(!ideas.some((i) => i.field === "nullable" || i.field === "unscored"));
assert.deepEqual(suggestExperiments(run, docs.map((d) => ({ ...d, runId: "other-run" }))), []);
assert.equal(suggestExperiments(run, [...docs, docs[0]])[0].evidence.length, 2);
assert.deepEqual(suggestExperiments(run, []), []);
assert.deepEqual(suggestExperiments(run, docs.map((d) => ({ ...d,
  fields: d.fields.map((f) => ({ ...f, status: "correct" })),
}))), []);

const structured: Document = { ...sampleDocuments[0], runId: run.id, fields: [
  { key: "items", value: [], expected: [{ quantity: 0, enabled: false }], confidence: null, status: "incorrect" },
] };
assert.equal(suggestExperiments(run, [structured])[0].kind, "Structured extraction");
structured.fields[0].status = "validation_failed";
assert.equal(suggestExperiments(run, [structured])[0].kind, "Schema compliance");

const before = structuredClone(defaultConfig);
const next = applySuggestion(defaultConfig, ideas[0]);
assert.equal(next.prompt.split(ideas[0].prompt).length - 1, 1);
assert.deepEqual(applySuggestion(next, ideas[0]), next, "Repeated application must not duplicate instructions");
assert.deepEqual(defaultConfig, before, "Saved baseline must remain immutable");
assert.equal(next.model, before.model);
assert.equal(next.schema, before.schema);
assert(!next.prompt.includes("2026-01-01"), "Expected values must not leak into the candidate prompt");
assert(!applySuggestion(defaultConfig, ideas[1]).prompt.includes(ideas[0].prompt), "Switching ideas starts from the baseline");
assert(starterSuggestions(defaultConfig)[0].starter);
assert.match(starterSuggestions(defaultConfig)[0].title, /invoice_number/);
assert.equal(starterSuggestions({ ...defaultConfig, schema: "invalid" })[0].title, "Require source-supported values");
console.log("Hill suggestions: failure ranking, run isolation, scored denominators, structured/null/false/zero values, starter state, and immutable candidates passed.");
