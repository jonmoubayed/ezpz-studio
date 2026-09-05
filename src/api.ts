import { confidenceFromResponse } from "./confidence";
import { expectedValue, extractionCitations } from "./result-model";
import type {
  Config,
  Dataset,
  Document,
  EvalGroup,
  Field,
  Run,
} from "./domain";
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
    benchmarkFingerprint: r.metadata?.benchmark_snapshot?.fingerprint,
    cacheHits: r.metrics?.cache_hits,
    completedDocuments: r.metrics?.completed,
    failedDocuments: r.metrics?.failed,
    error: r.error_text,
    groupId:
      r.eval_group?.id || r.eval_experiment?.eval_group?.id || r.eval_group_id,
    groupName: r.eval_group?.name || r.eval_experiment?.eval_group?.name,
    processorId: r.processor_version?.processor_id,
    experimentId: r.eval_experiment_id || r.eval_experiment?.id,
    config: r.processor_version
      ? {
          provider: r.processor_version.model?.provider || "local",
          model: r.processor_version.model?.name || "",
          parser: r.processor_version.parser?.name || "",
          prompt: r.processor_version.prompt?.extraction || "",
          schema: JSON.stringify(r.processor_version.schema ?? {}, null, 2),
          baseUrl: r.processor_version.model?.base_url || "",
        }
      : undefined,
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
    documents:
      r.metrics?.documents ?? r.extraction_count ?? r.extractions?.length ?? 0,
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
      const citations = extractionCitations(e, v?.evidence);
      return {
        key,
        value: v?.value ?? null,
        ...expectedValue(groundTruth?.value, key),
        ...confidenceFromResponse(v),
        citations,
        page: citations[0]?.page || 1,
        ...(citations[0] ? { area: citations[0].area } : {}),
      };
    },
  );
}
export type AdapterCatalog = {
  llm: {
    id: string;
    label: string;
    models: string[];
    default_endpoint?: string;
    kind: string;
  }[];
  parsers: { id: string; label: string }[];
};
export async function loadWorkspace(signal = AbortSignal.timeout(15000)) {
  const [d, s, r, p, g, a] = await Promise.all([
    request("/documents", { signal }),
    request("/datasets", { signal }),
    request("/runs", { signal }),
    request("/processors", { signal }),
    request("/eval-groups", { signal }),
    request("/adapters", { signal }),
  ]);
  return {
    adapters: (a.adapters || a) as AdapterCatalog,
    documents: d.documents.map(normalizeDocument) as Document[],
    datasets: s.datasets.map((x: any) => ({
      id: x.id,
      name: x.name,
      description: x.description || "",
      count: x.document_count ?? 0,
    })) as Dataset[],
    runs: r.runs.map(normalizeRun) as Run[],
    processors: p.processors.map(
      normalizeProcessor,
    ) as import("./domain").Processor[],
    evalGroups: g.eval_groups.map((g: any) => ({
      id: g.id,
      name: g.name,
      datasetId: g.dataset_id,
      description: g.description,
      experiments: (g.experiments || []).map((e: any) => ({
        id: e.id,
        name: e.name,
        description: e.description,
        date: e.created_at,
        config: e.processor_version
          ? versionConfig(e.processor_version)
          : undefined,
      })),
    })) as EvalGroup[],
  };
}
export async function uploadDocument(file: File) {
  const form = new FormData();
  form.append("file", file);
  return normalizeDocument(
    (await request("/documents", { method: "POST", body: form })).document,
  );
}
export async function inspectDocument(
  d: Document,
  processorId?: string,
  signal?: AbortSignal,
) {
  const data = await request(
    `/documents/${d.id}${processorId ? `?processor=${encodeURIComponent(processorId)}` : ""}`,
    { signal },
  );
  return {
    ...d,
    fields: extractionFields(data.extraction, data.ground_truth),
    groundTruth: data.ground_truth?.value || {},
    runId: data.extraction?.run_id,
    warnings: data.extraction?.warnings || [],
  };
}
export async function previewDocument(
  d: Document,
  c: Config,
  processor: string,
) {
  const saved = (await request(`/processors/${encodeURIComponent(processor)}`))
    .processor;
  const latest = [...saved.versions].sort((a, b) => b.version - a.version)[0];
  return request(`/processors/${encodeURIComponent(processor)}/draft/preview`, {
    method: "POST",
    body: JSON.stringify({
      document_id: d.id,
      config: mergeEditableConfig(latest, c),
    }),
  });
}
export async function newProcessor(name: string, c: Config, description = "") {
  return (
    await post("/processors", { name, description, config: configPayload(c) })
  ).processor;
}
export async function runBenchmark(
  datasetId: string,
  c: Config,
  name: string,
  group?: { id?: string; name?: string; processorId?: string },
  background = false,
) {
  let groupId = group?.id;
  if (!groupId && !group?.name) {
    const existing = await request("/eval-groups");
    groupId = existing.eval_groups.find(
      (g: any) => g.dataset_id === datasetId,
    )?.id;
  }
  if (!groupId)
    groupId = (
      await post("/eval-groups", {
        name: group?.name || `${name} · iterations`,
        dataset_id: datasetId,
      })
    ).eval_group.id;
  let processor = group?.processorId
    ? (await request(`/processors/${encodeURIComponent(group.processorId)}`))
        .processor
    : await newProcessor(`${name}-${Date.now()}`, c);
  let version = processor.versions[0];
  if (
    JSON.stringify(configPayload(versionConfig(version))) !==
    JSON.stringify(configPayload(c))
  )
    version = await saveProcessorVersion(processor.id, c);
  const { experiments } = await request(`/eval-groups/${groupId}/experiments`);
  let experiment = experiments.find(
    (e: any) => e.processor_version_id === version.id,
  );
  if (!experiment) {
    let experimentName = name;
    let suffix = 2;
    while (experiments.some((e: any) => e.name === experimentName))
      experimentName = `${name} · ${suffix++}`;
    experiment = (
      await post(`/eval-groups/${groupId}/experiments`, {
        name: experimentName,
        processor_version_id: version.id,
      })
    ).eval_experiment;
  }
  const result = await post("/runs", {
    eval_experiment_id: experiment.id,
    dataset_id: datasetId,
    metadata: { name },
    force_refresh: true,
    background,
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

export function versionConfig(v: any): Config {
  return {
    provider: v.model?.provider || "local",
    model: v.model?.name || "",
    parser: v.parser?.name || "native",
    prompt: v.prompt?.extraction || "",
    schema: JSON.stringify(
      v.schema ?? { type: "object", properties: {} },
      null,
      2,
    ),
    baseUrl: v.model?.base_url || "",
  };
}
export function normalizeProcessor(p: any): import("./domain").Processor {
  const versions = (p.versions ?? [])
    .map((v: any) => ({
      id: v.id,
      version: v.version,
      config: versionConfig(v),
      date: v.created_at,
    }))
    .sort((a: any, b: any) => b.version - a.version);
  return {
    id: p.id,
    name: p.name,
    description: p.description || "",
    config: versions[0]?.config ?? versionConfig({}),
    version: versions[0]?.version ?? 1,
    versionId: versions[0]?.id,
    updatedAt: versions[0]?.date || p.created_at,
    versions,
  };
}
export async function saveProcessorVersion(
  id: string,
  config: Config,
  details?: { name: string; description: string },
) {
  if (details)
    await request(`/processors/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(details),
    });
  const { draft } = await request(
    `/processors/${encodeURIComponent(id)}/draft`,
  );
  const merged = mergeEditableConfig(draft, config);
  await request(`/processors/${encodeURIComponent(id)}/draft`, {
    method: "PATCH",
    body: JSON.stringify({ config: merged }),
  });
  return (await post(`/processors/${encodeURIComponent(id)}/draft/publish`, {}))
    .version;
}

// Merge the controls exposed in Studio without discarding backend-only options.
export function mergeEditableConfig(base: any, config: Config) {
  const editable = configPayload(config);
  const merged = {
    ...editable,
    harness: base?.harness || editable.harness,
    ...(base?.normalization ? { normalization: base.normalization } : {}),
    parser: {
      ...(base?.parser?.name === config.parser ? base.parser : {}),
      ...editable.parser,
    },
    model: {
      ...(base?.model?.provider === config.provider ? base.model : {}),
      ...editable.model,
    },
    prompt: { ...base?.prompt, ...editable.prompt },
  };
  if (!["ollama", "openai-compatible"].includes(config.provider))
    delete merged.model.base_url;
  return merged;
}

export async function saveGroundTruth(
  documentId: string,
  value: Record<string, import("./domain").JsonValue>,
) {
  return post(`/documents/${encodeURIComponent(documentId)}/ground-truth`, {
    value,
    annotation_status: "complete",
    author: "local",
  });
}
export async function addDatasetDocument(
  datasetId: string,
  documentId: string,
) {
  return post(`/datasets/${encodeURIComponent(datasetId)}/documents`, {
    document_id: documentId,
  });
}
