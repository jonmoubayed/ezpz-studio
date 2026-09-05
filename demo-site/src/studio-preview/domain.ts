export type Page =
  | "Overview"
  | "Playground"
  | "Configuration"
  | "Processors"
  | "Datasets"
  | "Evaluations"
  | "Hill climbing"
  | "Review queue"
  | "Settings";
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export function displayValue(value: JsonValue): string {
  return value === null
    ? "null"
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);
}
export type Field = {
  key: string;
  value: JsonValue;
  expected: JsonValue;
  confidence: number;
  status?: string;
  area?: { left: number; top: number; width: number; height: number };
  page?: number;
};
export type Document = {
  id: string;
  name: string;
  src: string;
  type: string;
  pages: number;
  status: string;
  fields: Field[];
  sample?: boolean;
  runId?: string;
  warnings?: string[];
};
export type EvalGroup = {
  id: string;
  name: string;
  datasetId: string;
  description?: string;
};
export type Run = {
  groupId?: string;
  groupName?: string;
  experimentId?: string;
  config?: Config;
  id: string;
  name: string;
  model: string;
  provider: string;
  score: number | null;
  cost: number;
  latency: number;
  documents: number;
  status: string;
  date: string;
  datasetId: string;
  dataset: string;
  version: number;
};
export type Dataset = {
  id: string;
  name: string;
  description: string;
  count: number;
  members?: string[];
};
export type Config = {
  provider: string;
  model: string;
  parser: string;
  prompt: string;
  schema: string;
  baseUrl: string;
};
export const defaultConfig: Config = {
  provider: "local",
  model: "deterministic-local",
  parser: "native",
  prompt:
    "Extract all invoice fields faithfully from the source document. Preserve the currency and distinguish the subtotal, tax, and amount due. Return null when a value is not present. Cite the source for every field.",
  schema: JSON.stringify(
    {
      type: "object",
      properties: {
        invoice_number: { type: "string" },
        vendor: { type: "string" },
        invoice_date: { type: "string" },
        due_date: { type: "string" },
        subtotal: { type: "number" },
        tax: { type: "number" },
        total: { type: "number" },
      },
      required: ["invoice_number", "vendor", "total"],
    },
    null,
    2,
  ),
  baseUrl: "http://localhost:11434",
};
export const vendors = [
  "Northstar Design Co.",
  "Acme Software Inc.",
  "Linear Supply Co.",
  "Meridian Studio",
  "Atlas Office Goods",
  "Forma Creative",
];
export const sampleDocuments: Document[] = vendors.map((vendor, i) => ({
  id: `sample-${i}`,
  name: `${["northstar", "acme", "linear", "meridian", "atlas", "forma"][i]}_invoice_00${i + 1}.pdf`,
  src: `/studio/samples/invoice-${i}.pdf`,
  type: "application/pdf",
  pages: 1,
  status: i === 1 || i === 4 ? "Needs review" : "Extracted",
  sample: true,
  runId: "demo-8",
  fields: [
    {
      key: "invoice_number",
      value: `INV-2026-00${i + 1}`,
      expected: `INV-2026-00${i + 1}`,
      confidence: 0.99,
      area: { left: 65, top: 14, width: 25, height: 3 },
    },
    {
      key: "vendor",
      value: vendor,
      expected: vendor,
      confidence: 0.99,
      area: { left: 9, top: 9, width: 50, height: 4 },
    },
    {
      key: "invoice_date",
      value: "2026-09-01",
      expected: "2026-09-01",
      confidence: 0.98,
      area: { left: 65, top: 21, width: 25, height: 3 },
    },
    {
      key: "due_date",
      value: "2026-09-30",
      expected: "2026-09-30",
      confidence: 0.97,
      area: { left: 65, top: 27, width: 25, height: 3 },
    },
    {
      key: "subtotal",
      value: 2400 + i * 180,
      expected: 2400 + i * 180,
      confidence: 0.99,
      area: { left: 68, top: 64, width: 23, height: 3 },
    },
    {
      key: "tax",
      value: i === 1 ? 180 : (2400 + i * 180) * 0.08,
      expected: (2400 + i * 180) * 0.08,
      confidence: i === 1 ? 0.72 : 0.99,
      area: { left: 68, top: 68, width: 23, height: 3 },
    },
    {
      key: "total",
      value: Number(((2400 + i * 180) * 1.08).toFixed(2)),
      expected: Number(((2400 + i * 180) * 1.08).toFixed(2)),
      confidence: i === 4 ? 0.78 : 0.99,
      area: { left: 65, top: 73, width: 27, height: 5 },
    },
  ],
}));
export const sampleRuns: Run[] = [
  {
    id: "demo-8",
    name: "Currency-aware extraction",
    model: "GPT-4.1",
    provider: "OpenAI",
    score: 0.976,
    cost: 0.018,
    latency: 2.4,
    documents: 6,
    status: "Completed",
    date: "2026-09-04T14:42:00",
    datasetId: "invoices",
    dataset: "Invoices · benchmark",
    version: 8,
  },
  {
    id: "demo-7",
    name: "Schema-guided reasoning",
    model: "Claude Sonnet 4",
    provider: "Anthropic",
    score: 0.958,
    cost: 0.022,
    latency: 3.1,
    documents: 6,
    status: "Completed",
    date: "2026-09-04T14:30:00",
    datasetId: "invoices",
    dataset: "Invoices · benchmark",
    version: 7,
  },
  {
    id: "demo-6",
    name: "Improved table grounding",
    model: "Gemini 2.5 Flash",
    provider: "Google",
    score: 0.941,
    cost: 0.006,
    latency: 1.8,
    documents: 6,
    status: "Completed",
    date: "2026-09-04T13:12:00",
    datasetId: "invoices",
    dataset: "Invoices · benchmark",
    version: 6,
  },
  {
    id: "demo-5",
    name: "Explicit null handling",
    model: "GPT-4.1",
    provider: "OpenAI",
    score: 0.923,
    cost: 0.018,
    latency: 2.2,
    documents: 6,
    status: "Completed",
    date: "2026-09-03T16:42:00",
    datasetId: "invoices",
    dataset: "Invoices · benchmark",
    version: 5,
  },
  {
    id: "demo-4",
    name: "Local model baseline",
    model: "Qwen 3 · 8B",
    provider: "Ollama",
    score: 0.887,
    cost: 0,
    latency: 4.6,
    documents: 6,
    status: "Completed",
    date: "2026-09-03T12:24:00",
    datasetId: "invoices",
    dataset: "Invoices · benchmark",
    version: 4,
  },
  {
    id: "demo-3",
    name: "Baseline extraction",
    model: "GPT-4.1",
    provider: "OpenAI",
    score: 0.861,
    cost: 0.016,
    latency: 2.1,
    documents: 6,
    status: "Completed",
    date: "2026-09-02T09:00:00",
    datasetId: "invoices",
    dataset: "Invoices · benchmark",
    version: 3,
  },
];
export const sampleGroups: EvalGroup[] = [
  {
    id: "invoice-extraction",
    name: "Invoice extraction",
    datasetId: "invoices",
    description:
      "Improve invoice extraction across models and prompt iterations.",
  },
];
// Explicit demo configuration snapshots; live runs always use backend snapshots.
for (const run of sampleRuns) {
  run.groupId = "invoice-extraction";
  run.groupName = "Invoice extraction";
  run.experimentId = run.id;
  run.config = {
    ...defaultConfig,
    model: run.model,
    provider: run.provider,
    prompt: `${defaultConfig.prompt}\nIteration focus: ${run.name}.`,
  };
}
export const sampleDatasets: Dataset[] = [
  {
    id: "invoices",
    name: "Invoices · benchmark",
    description:
      "A shared benchmark for every model and prompt. Six invoices with field-level ground truth.",
    count: 6,
  },
];
export function pct(value: number | null) {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}
export function readStored<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) || "null") ?? fallback;
  } catch {
    return fallback;
  }
}
export function downloadJson(name: string, value: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export type Processor = {
  id: string;
  name: string;
  description: string;
  config: Config;
  version: number;
  versionId?: string;
  updatedAt: string;
  versions: { id: string; version: number; config: Config; date: string }[];
};
export const processorStarters: {
  id: string;
  name: string;
  description: string;
  config: Config;
}[] = [
  {
    id: "blank",
    name: "Custom extractor",
    description: "Start with an empty schema. Define any document and output.",
    config: {
      ...defaultConfig,
      prompt:
        "Extract the requested fields faithfully. Return null when a value is absent.",
      schema: JSON.stringify({ type: "object", properties: {} }, null, 2),
    },
  },
  {
    id: "invoice",
    name: "Invoice extraction",
    description: "Invoice details, vendor, dates, and amounts.",
    config: defaultConfig,
  },
  ...[
    {
      id: "1099",
      name: "1099 extraction",
      description: "Payer, recipient, form type, and reported amounts.",
      fields: {
        form_type: "string",
        tax_year: "integer",
        payer_name: "string",
        payer_tin: "string",
        recipient_name: "string",
        recipient_tin: "string",
        nonemployee_compensation: "number",
        federal_tax_withheld: "number",
      },
    },
    {
      id: "receipt",
      name: "Receipt extraction",
      description: "Merchant, purchase date, line items, and totals.",
      fields: {
        merchant: "string",
        purchase_date: "string",
        currency: "string",
        subtotal: "number",
        tax: "number",
        total: "number",
        payment_method: "string",
      },
    },
    {
      id: "contract",
      name: "Contract extraction",
      description: "Parties, dates, obligations, and termination terms.",
      fields: {
        contract_title: "string",
        effective_date: "string",
        expiration_date: "string",
        governing_law: "string",
        payment_terms: "string",
        termination_clause: "string",
      },
    },
  ].map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    config: {
      ...defaultConfig,
      prompt: `Extract ${t.name.replace(" extraction", "")} fields from the document. Preserve exact names and amounts; use ISO dates. Return null for values not present.`,
      schema: JSON.stringify(
        {
          type: "object",
          properties: Object.fromEntries(
            Object.entries(t.fields).map(([key, type]) => [key, { type }]),
          ),
        },
        null,
        2,
      ),
    },
  })),
];
export const sampleProcessors: Processor[] = processorStarters
  .filter((t) => t.id !== "blank")
  .map((t) => ({
    id: `demo-processor-${t.id}`,
    name: t.name,
    description: t.description,
    config: structuredClone(t.config),
    version: 1,
    versionId: `demo-version-${t.id}`,
    updatedAt: "2026-09-04T09:00:00",
    versions: [
      {
        id: `demo-version-${t.id}`,
        version: 1,
        config: structuredClone(t.config),
        date: "2026-09-04T09:00:00",
      },
    ],
  }));
