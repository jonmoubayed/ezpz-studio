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
    groupId:
      r.eval_group?.id || r.eval_experiment?.eval_group?.id || r.eval_group_id,
    groupName: r.eval_group?.name || r.eval_experiment?.eval_group?.name,
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
  const [d, s, r, p, g] = await Promise.all([
    request("/documents"),
    request("/datasets"),
    request("/runs"),
    request("/processors"),
    request("/eval-groups"),
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
    processors: p.processors.map(normalizeProcessor),
    evalGroups: g.eval_groups.map((g: any) => ({
      id: g.id,
      name: g.name,
      datasetId: g.dataset_id,
      description: g.description,
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
  const { harness, ...editable } = configPayload(config);
  // Preserve harness, normalization, and provider-specific options that are not exposed in this editor.
  const { draft } = await request(
    `/processors/${encodeURIComponent(id)}/draft`,
  );
  const merged = {
    ...editable,
    parser: {
      ...(draft.parser?.name === config.parser ? draft.parser : {}),
      ...editable.parser,
    },
    model: {
      ...(draft.model?.provider === config.provider ? draft.model : {}),
      ...editable.model,
    },
    prompt: { ...draft.prompt, ...editable.prompt },
  };
  if (!["ollama", "openai-compatible"].includes(config.provider))
    delete merged.model.base_url;
  await request(`/processors/${encodeURIComponent(id)}/draft`, {
    method: "PATCH",
    body: JSON.stringify({ config: merged }),
  });
  return (await post(`/processors/${encodeURIComponent(id)}/draft/publish`, {}))
    .version;
}
