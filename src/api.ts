import type { Config, Dataset, Document, Field, Run } from "./domain";
export async function request(path: string, options: RequestInit = {}) {
  const response = await fetch(`/v1${path}`, {
    ...options,
    headers:
      options.body instanceof FormData
        ? options.headers
        : { "Content-Type": "application/json", ...options.headers },
    signal: options.signal ?? AbortSignal.timeout(180000),
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      "The local API did not return JSON. Start the ezpz Python server and check EZPZ_API_URL.",
    );
  }
  if (!response.ok)
    throw new Error(
      data.error?.message ||
        data.error ||
        `Request failed (${response.status})`,
    );
  return data;
}
const post = (path: string, body: unknown) =>
  request(path, { method: "POST", body: JSON.stringify(body) });
export const configPayload = (c: Config) => ({
  schema: JSON.parse(c.schema),
  prompt: { extraction: c.prompt },
  parser: { name: c.parser, version: "1" },
  model: {
    provider: c.provider,
    name: c.model,
    ...(c.provider === "ollama" || c.provider === "openai-compatible"
      ? { base_url: c.baseUrl }
      : {}),
  },
  harness: { name: "direct", version: "1" },
});
// Backend response shapes are normalized here; views never import the original frontend.
export function normalizeRun(r: any): Run {
  return {
    id: r.id,
    name:
      r.metadata?.name ||
      r.eval_experiment?.name ||
      r.processor_version?.prompt?.name ||
      `Run ${r.id.slice(-8)}`,
    model: r.processor_version?.model?.name || "Unknown",
    provider: r.processor_version?.model?.provider || "local",
    score: r.metrics?.field_accuracy ?? null,
    cost: r.metrics?.cost_usd ?? 0,
    latency: (r.metrics?.average_latency_ms ?? 0) / 1000,
    documents: r.extraction_count ?? r.extractions?.length ?? 0,
    status: r.status === "completed" ? "Completed" : r.status,
    date: r.created_at,
    datasetId: r.dataset_id || "",
    dataset: r.dataset?.name || "Single document",
    version: r.processor_version?.version ?? 1,
  };
}
export function normalizeDocument(d: any): Document {
  return {
    id: d.id,
    name: d.filename || d.name,
    src: `/v1/documents/${d.id}/source`,
    type: d.content_type || d.mime_type || "application/pdf",
    pages: d.page_count || 1,
    status: "Ready",
    fields: [],
  };
}
export function extractionFields(e: any, groundTruth?: any): Field[] {
  return Object.entries(e?.result?.fields || {}).map(
    ([key, v]: [string, any]) => {
      const evidence = v.evidence?.[0];
      const page = e?.parser_ir?.pages?.find(
        (p: any) => p.page === evidence?.page,
      );
      const bbox = evidence?.bbox;
      return {
        key,
        value: v.value ?? null,
        expected: groundTruth?.value?.[key] ?? null,
        confidence: v.confidence ?? 0,
        page: evidence?.page || 1,
        ...(bbox?.length === 4 && page?.width && page?.height
          ? {
              area: {
                left: (bbox[0] / page.width) * 100,
                top: (bbox[1] / page.height) * 100,
                width: ((bbox[2] - bbox[0]) / page.width) * 100,
                height: ((bbox[3] - bbox[1]) / page.height) * 100,
              },
            }
          : {}),
      };
    },
  );
}
export async function loadWorkspace() {
  const [d, s, r, p] = await Promise.all([
    request("/documents"),
    request("/datasets"),
    request("/runs"),
    request("/processors"),
  ]);
  return {
    documents: d.documents.map(normalizeDocument) as Document[],
    datasets: s.datasets.map((x: any) => ({
      id: x.id,
      name: x.name,
      description: x.description || "",
      count: x.document_count ?? 0,
    })) as Dataset[],
    runs: r.runs.map(normalizeRun) as Run[],
    processors: p.processors,
  };
}
export async function uploadDocument(file: File) {
  const form = new FormData();
  form.append("file", file);
  return normalizeDocument(
    (await request("/documents", { method: "POST", body: form })).document,
  );
}
export async function inspectDocument(d: Document) {
  const data = await request(`/documents/${d.id}`);
  return {
    ...d,
    fields: extractionFields(data.extraction, data.ground_truth),
    runId: data.extraction?.run_id,
    warnings: data.extraction?.warnings || [],
  };
}
export async function previewDocument(
  d: Document,
  c: Config,
  processor: string,
) {
  return request(`/processors/${encodeURIComponent(processor)}/draft/preview`, {
    method: "POST",
    body: JSON.stringify({ document_id: d.id, config: configPayload(c) }),
  });
}
export async function newProcessor(name: string, c: Config) {
  return (await post("/processors", { name, config: configPayload(c) }))
    .processor;
}
export async function runBenchmark(datasetId: string, c: Config, name: string) {
  const processor = await newProcessor(`${name}-${Date.now()}`, c);
  const result = await post("/runs", {
    dataset_id: datasetId,
    processor: processor.id,
    version: 1,
    metadata: { name },
  });
  return result.run ? normalizeRun(result.run) : null;
}
export async function saveFeedback(
  runId: string,
  documentId: string,
  field: string,
  status: string,
  value: unknown,
  note: string,
) {
  return post(`/runs/${runId}/reviews`, {
    document_id: documentId,
    field_path: field,
    status,
    corrected_value: value,
    note,
    reviewer: "local",
  });
}
export async function createDataset(name: string, documentIds: string[]) {
  const { dataset } = await post("/datasets", {
    name,
    description: "Created in the redesigned studio",
  });
  for (const document_id of documentIds)
    await post(`/datasets/${dataset.id}/documents`, { document_id });
  return dataset;
}
