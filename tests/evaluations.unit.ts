import assert from "node:assert/strict";
import {
  groupRuns,
  groupExperiments,
  configurationChanges,
  evaluationPath,
  parseEvaluationPath,
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

const hierarchy = groupRuns(
  [
    {
      ...sampleRuns[0],
      id: "first",
      groupId: "one",
      experimentId: "exp",
      date: "2026-09-01",
    },
    {
      ...sampleRuns[0],
      id: "again",
      groupId: "one",
      experimentId: "exp",
      date: "2026-09-02",
    },
    { ...sampleRuns[0], id: "other", groupId: "two", experimentId: "another" },
  ],
  [
    {
      id: "one",
      name: "First",
      datasetId: sampleRuns[0].datasetId,
      experiments: [
        { id: "exp", name: "Saved experiment name", date: "2026-09-01" },
        { id: "empty", name: "Not run", date: "2026-09-03" },
      ],
    },
  ],
)[0];
const experiments = groupExperiments(hierarchy);
assert.equal(
  experiments.length,
  2,
  "Repeated executions do not inflate experiment count; empty experiments stay visible",
);
assert.equal(experiments[0].name, "Saved experiment name");
assert.deepEqual(
  experiments[0].runs.map((r) => r.id),
  ["first", "again"],
);
assert.equal(experiments[1].runs.length, 0);
assert.deepEqual(
  parseEvaluationPath(
    evaluationPath("group / one", "exp # two", "run ? three"),
  ),
  {
    groupId: "group / one",
    experimentId: "exp # two",
    runId: "run ? three",
    compare: false,
  },
);
assert.deepEqual(parseEvaluationPath("#Evaluations/group/%XX"), {});
assert.equal(
  parseEvaluationPath("#Evaluations/group/g/compare/a/b").compare,
  true,
);
assert.deepEqual(
  configurationChanges(
    { ...sampleRuns[0].config!, model: "changed", prompt: "changed" },
    sampleRuns[0].config,
  ),
  ["Model", "Prompt"],
);
console.log(
  "Evaluation hierarchy: repeated runs, empty experiments, group isolation, config changes, and deep links passed.",
);
