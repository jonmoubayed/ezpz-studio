import type { Document, EvalGroup, Field, Run } from "./domain";
import { sampleDocuments } from "./domain";
import { extractionFields, normalizeDocument } from "./api";
export const failed = (f: Field) =>
  ["incorrect", "missing", "hallucinated", "validation_failed"].includes(
    f.status ?? "",
  );
export function groupRuns(runs: Run[], groups: EvalGroup[]) {
  const map = new Map(groups.map((g) => [g.id, { ...g, runs: [] as Run[] }]));
  for (const r of runs) {
    const id = r.groupId || `ungrouped:${r.datasetId || r.id}`;
    if (!map.has(id))
      map.set(id, {
        id,
        name: r.groupName || `Ungrouped · ${r.dataset}`,
        datasetId: r.datasetId,
        runs: [],
      });
    map.get(id)!.runs.push(r);
  }
  return [...map.values()].map((g) => ({
    ...g,
    runs: g.runs.sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
    ),
  }));
}
export function evaluationDocuments(
  raw: any,
  documents: Document[],
): Document[] {
  const evaluations = raw.evaluations ?? [];
  const extractions = raw.extractions ?? [];
  const ids = new Set<string>([
    ...extractions.map((e: any) => e.document_id),
    ...evaluations.map((e: any) => e.document_id),
  ]);
  return [...ids].map((id) => {
    const ex = extractions.find((e: any) => e.document_id === id);
    const ev = evaluations.find((e: any) =>
      ex ? e.extraction_id === ex.id : e.document_id === id,
    );
    const doc =
      documents.find((d) => d.id === id) ||
      normalizeDocument(ex?.document ?? { id, filename: id });
    const predictions = extractionFields(ex);
    const keys = new Set([
      ...predictions.map((f) => f.key),
      ...Object.keys(ev?.fields ?? {}),
    ]);
    const fields = [...keys].map((key) => {
      const prediction = predictions.find((f) => f.key === key);
      const score = ev?.fields?.[key];
      return {
        ...(prediction ?? {
          key,
          value: null,
          expected: null,
          confidence: null,
        }),
        value:
          score && Object.hasOwn(score, "actual")
            ? score.actual
            : (prediction?.value ?? null),
        expected: score?.expected ?? null,
        hasExpected:
          !!score &&
          Object.hasOwn(score, "expected") &&
          score.status !== "unscored",
        status: score?.status || "unscored",
      } as Field;
    });
    return { ...doc, fields, runId: raw.id, warnings: ex?.warnings ?? [] };
  });
}
export function demoEvaluationDocuments(run: Run): Document[] {
  // Deliberately illustrative examples; never substitute these for API results.
  return sampleDocuments.map((d, i) => ({
    ...d,
    runId: run.id,
    fields: d.fields.map((f, j) => {
      const wrong =
        (i === 1 && f.key === "subtotal") ||
        (run.version < 7 && i === 4 && f.key === "total") ||
        (run.version < 5 && j === 0 && i === 3);
      return {
        ...f,
        value: wrong
          ? typeof f.expected === "number"
            ? f.expected + 192
            : "INV-UNKNOWN"
          : f.expected,
        status: wrong ? "incorrect" : "correct",
      };
    }),
  }));
}
export function scoreDelta(value: number | null, baseline: number | null) {
  if (value === null || baseline === null) return "—";
  const delta = (value - baseline) * 100;
  return `${delta > 0 ? "+" : ""}${delta.toFixed(1)} pts`;
}

// Experiments own a fixed configuration; repeated runs remain separate executions.
export function groupExperiments(group: ReturnType<typeof groupRuns>[number]) {
  const map = new Map(
    (group.experiments || []).map((e) => [e.id, { ...e, runs: [] as Run[] }]),
  );
  for (const run of group.runs) {
    const id = run.experimentId || `legacy:${run.id}`;
    if (!map.has(id))
      map.set(id, {
        id,
        name: run.name,
        date: run.date,
        config: run.config,
        runs: [],
      });
    map.get(id)!.runs.push(run);
  }
  return [...map.values()]
    .map((e) => ({
      ...e,
      runs: [...e.runs].sort((a, b) => a.date.localeCompare(b.date)),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}
export function configurationChanges(
  config?: Run["config"],
  baseline?: Run["config"],
) {
  if (!config || !baseline) return ["Configuration unavailable"];
  const keys = [
    ["provider", "Provider"],
    ["model", "Model"],
    ["parser", "Parser"],
    ["prompt", "Prompt"],
    ["schema", "Schema"],
    ["baseUrl", "Endpoint"],
  ] as const;
  return keys
    .filter(([key]) => config[key] !== baseline[key])
    .map(([, label]) => label);
}
export function evaluationPath(
  groupId?: string,
  experimentId?: string,
  runId?: string,
) {
  return (
    "#Evaluations" +
    (groupId ? `/group/${encodeURIComponent(groupId)}` : "") +
    (experimentId ? `/experiment/${encodeURIComponent(experimentId)}` : "") +
    (runId ? `/run/${encodeURIComponent(runId)}` : "")
  );
}
export function parseEvaluationPath(hash: string) {
  try {
    const parts = hash.split("/").map(decodeURIComponent);
    return {
      groupId: parts[1] === "group" ? parts[2] : undefined,
      experimentId: parts[3] === "experiment" ? parts[4] : undefined,
      runId: parts[5] === "run" ? parts[6] : undefined,
      compare: parts[3] === "compare",
    };
  } catch {
    return {};
  }
}
