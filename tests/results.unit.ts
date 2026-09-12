import assert from "node:assert/strict";
import { extractionFields } from "../src/api";
import {
  equalValues,
  expectedValue,
  extractionCitations,
  withExpectedValues,
} from "../src/result-model";
import { sampleDocuments } from "../src/domain";
const extraction = {
  parser_ir: { pages: [{ page: 1, width: 612, height: 792 }] },
  result: {
    fields: {
      total: {
        value: 25,
        confidence: 0.97,
        evidence: [{ page: 1, bbox: [0.1, 0.2, 0.4, 0.3] }],
      },
    },
  },
};
const field = extractionFields(extraction, { value: { total: 0 } })[0];
const quotedFields = extractionFields({ result: { fields: {
  "months.value": { value: "12", evidence: [] },
  "months.excerpt": { value: "In each of the first twelve months" },
  "months.location": { value: "Page 2, Section 2.3" },
  "other.value": { value: "days" },
} } });
assert.equal(quotedFields[0].sourceExcerpt, "In each of the first twelve months");
assert.equal(quotedFields[0].sourceLocation, "Page 2, Section 2.3");
assert.equal(quotedFields[0].area, undefined, "Excerpts must not fabricate geometry");
assert.equal(quotedFields[3].sourceExcerpt, undefined, "Do not borrow evidence from another field");
assert.equal(field.area?.left, 10);
assert.equal(field.area?.top, 20);
assert.ok(Math.abs(field.area!.width - 30) < 1e-8);
assert.ok(Math.abs(field.area!.height - 10) < 1e-8);
assert.equal(field.expected, 0);
assert.equal(field.hasExpected, true);
assert.equal(
  extractionFields(extraction, { value: { total: null } })[0].hasExpected,
  true,
);
assert.equal(extractionFields(extraction, { value: {} })[0].hasExpected, false);
const citations = extractionCitations({}, [
  { page: 1, bbox: [0, 0, 0, 1] },
  { page: 2, bbox: [0.2, 0.3, 0.4, 0.5] },
  { page: 3, bbox: [0, 0, 1, 1] },
  { page: 3, bbox: [0, 0, 1, 1] },
  { page: 1, bbox: [NaN, 0, 1, 1] },
]);
assert.deepEqual(extractionCitations({}, null as any), []);
assert.deepEqual(
  extractionCitations({}, [{ page: 0, bbox: [0, 0, 1, 1] }]),
  [],
);
assert.equal(citations.length, 2);
assert.equal(citations[0].page, 2);
assert.equal(citations[1].area.width, 100);
assert.deepEqual(expectedValue({ approved: false }, "approved"), {
  hasExpected: true,
  expected: false,
});
assert.deepEqual(expectedValue({ items: [{ price: 0 }] }, "items[0].price"), {
  hasExpected: true,
  expected: 0,
});
assert.equal(expectedValue({}, "__proto__").hasExpected, false);
assert.ok(equalValues({ x: 1, y: [null, false] }, { y: [null, false], x: 1 }));
assert.ok(!equalValues("1", 1));
assert.ok(!equalValues(null, false));
assert.ok(!equalValues([1, 2], [2, 1]));
const updated = withExpectedValues(sampleDocuments[0], { total: null });
assert.equal(updated.fields.find((f) => f.key === "total")?.hasExpected, true);
assert.equal(
  updated.fields.find((f) => f.key === "vendor")?.hasExpected,
  false,
);
console.log(
  "PASS: normalized and absolute coordinates, multi-page evidence, degenerate boxes, absent vs explicit null/zero/false ground truth, nested paths, and exact typed comparisons.",
);

const modelBoxes = extractionCitations({parser_ir: {pages: []}}, [
  {page: 2, bbox: [.1, .2, .4, .3], metadata: {bbox_source: "model"}},
]);
assert.equal(modelBoxes[0].source, "model");
assert.equal(modelBoxes[0].page, 2);
assert.equal(modelBoxes[0].area.left, 10);
assert.equal(modelBoxes[0].area.top, 20);
assert.equal(extractionCitations({}, [{page: 1, bbox: [0, 0, 1, 1]}])[0].source, undefined);

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { HumanReviewHighlight } = await import("../src/components/extend/human-review-highlight");
const estimatedMarkup = renderToStaticMarkup(createElement(HumanReviewHighlight, {location: modelBoxes[0]}));
assert.match(estimatedMarkup, /Model-estimated source box on page 2/);
assert.match(estimatedMarkup, /border-style:dashed/);
assert.match(estimatedMarkup, /left:10%/);
const groundedMarkup = renderToStaticMarkup(createElement(HumanReviewHighlight, {location: {page: 1, area: modelBoxes[0].area}}));
assert.match(groundedMarkup, /Source citation on page 1/);
assert.match(groundedMarkup, /border-style:solid/);
