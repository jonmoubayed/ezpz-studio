import assert from "node:assert/strict";
import {
  groupRuns,
  evaluationDocuments,
  failed,
  scoreDelta,
} from "../src/evaluation-model";
import { sampleRuns, sampleDocuments } from "../src/domain";
const groups = groupRuns(
  [
    { ...sampleRuns[0], id: "a", groupId: "g1" },
    { ...sampleRuns[0], id: "b", groupId: "g2" },
  ],
  [],
);
assert.equal(
  groups.length,
  2,
  "Separate processes on the same dataset must not merge",
);
const docs = evaluationDocuments(
  {
    id: "run",
    extractions: [
      {
        id: "ex",
        document_id: "sample-0",
        result: { fields: { total: { value: 100, confidence: 0.99 } } },
      },
    ],
    evaluations: [
      {
        document_id: "sample-0",
        extraction_id: "ex",
        fields: {
          total: { status: "incorrect", actual: 100, expected: 0 },
          missing: { status: "missing", actual: null, expected: "INV-1" },
          nullable: { status: "correct", actual: null, expected: null },
        },
      },
    ],
  },
  sampleDocuments,
);
assert.equal(docs.length, 1);
assert.equal(
  docs[0].fields.length,
  3,
  "Include failed fields absent from the extraction",
);
assert.equal(docs[0].fields.find((f) => f.key === "total")?.expected, 0);
assert.equal(docs[0].fields.filter(failed).length, 2);
assert.equal(
  docs[0].fields.find((f) => f.key === "nullable")?.status,
  "correct",
);
assert.equal(
  evaluationDocuments(
    {
      extractions: [
        {
          document_id: "sample-0",
          result: { fields: { total: { value: 10 } } },
        },
      ],
    },
    sampleDocuments,
  )[0].fields[0].status,
  "unscored",
);
assert.equal(scoreDelta(0.95, 0.9), "+5.0 pts");
assert.equal(scoreDelta(null, 0.9), "—");
console.log(
  "Evaluation model: group boundaries, missing fields, null/zero ground truth, unscored results, and deltas passed.",
);
