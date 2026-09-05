import assert from "node:assert/strict";
import {
  confidenceFromResponse,
  confidenceLabel,
  isLowConfidence,
} from "../src/confidence";
import { extractionFields } from "../src/api";
import type { Field } from "../src/domain";
const field = (raw: any): Field => ({
  key: "total",
  value: 25,
  expected: 25,
  ...confidenceFromResponse(raw),
});
assert.equal(confidenceLabel(field({ confidence: 0.75 })), "Not provided");
assert.equal(
  confidenceLabel({ key: "total", value: 25, expected: 25, confidence: 0.75 }),
  "Not provided",
);
for (const score of [null, undefined, "0.8", -1, 1.2, NaN, Infinity, true])
  assert.equal(
    confidenceFromResponse({
      confidence: score,
      provenance: { confidence_source: "model_reported" },
    }).confidence,
    null,
  );
assert.equal(
  confidenceLabel(
    field({
      confidence: 0,
      provenance: { confidence_source: "model_reported" },
    }),
  ),
  "Model 0%",
);
assert.equal(
  confidenceLabel(
    field({
      confidence: 0.83,
      provenance: { confidence_source: "model_reported" },
    }),
  ),
  "Model 83%",
);
assert.equal(
  confidenceLabel(
    field({ confidence: 0.97, provenance: { confidence_source: "heuristic" } }),
  ),
  "Rule-based 97%",
);
assert.equal(isLowConfidence(field({ confidence: 0.75 })), false);
assert.equal(
  isLowConfidence(
    field({
      confidence: 0.2,
      provenance: { confidence_source: "model_reported" },
    }),
  ),
  true,
);
const fields = extractionFields({
  result: {
    fields: {
      total: {
        value: 25,
        confidence: 0.83,
        provenance: { confidence_source: "model_reported" },
      },
    },
  },
});
assert.equal(fields[0].confidence, 0.83);
assert.equal(fields[0].confidenceSource, "model_reported");
console.log(
  "PASS: LLM confidence provenance, unknown historical scores, invalid scores, zero confidence, rule-based labels, and API normalization.",
);
