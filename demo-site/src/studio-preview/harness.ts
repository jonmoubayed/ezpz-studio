export type BlockKind = "sequence" | "extract" | "parse" | "validate" | "gate" | "cascade" | "consensus" | "parallel" | "repair" | "pages" | "return";
export type HarnessConnection = { id: string; source: string; target: string; condition: "always" | "accepted" | "unresolved" };
export type HarnessBlock = {
  id: string; kind: BlockKind; label?: string;
  routing?: { edges: HarnessConnection[] };
  model?: { provider?: string; name?: string; base_url?: string };
  prompt?: Record<string, unknown>;
  parser?: { name: string };
  fields?: string[]; critical_fields?: string[];
  threshold?: number; missing_confidence?: "escalate" | "ignore";
  scope?: "document" | "unresolved";
  quorum?: number; attempts?: number; always_verify?: boolean;
  normalization?: { case_insensitive?: boolean; numeric_strings?: boolean; tolerance?: number };
  field_policies?: Record<string, { row_key?: string; tolerance?: number }>;
  row_keys?: Record<string, string>;
  rules?: { sum: string[]; equals: string; tolerance?: number }[];
  steps?: HarnessBlock[]; tiers?: HarnessBlock[]; branches?: HarnessBlock[];
  pass?: HarnessBlock; fail?: HarnessBlock; body?: HarnessBlock;
};
export type HarnessConfig = {
  name: string; version?: number | string; input?: "parsed" | "document";
  flow?: HarnessBlock; limits?: { max_calls: number; concurrency: number };
  [key: string]: unknown;
};
export const blockNames: Record<BlockKind, string> = {
  sequence: "Sequence", extract: "Extract", parse: "Parse / OCR", validate: "Validate",
  gate: "Acceptance gate", cascade: "Tiered extraction", consensus: "Majority vote",
  parallel: "Parallel field specialists", repair: "Verify / repair", pages: "For each page", return: "Return result",
};
export function newBlock(kind: BlockKind): HarnessBlock {
  const base: HarnessBlock = { id: crypto.randomUUID(), kind };
  if (kind === "sequence") base.steps = [newBlock("extract")];
  if (kind === "cascade") Object.assign(base, { threshold: .85, scope: "document", tiers: [newBlock("extract"), newBlock("extract")] });
  if (kind === "consensus" || kind === "parallel") base.branches = Array.from({ length: kind === "consensus" ? 3 : 2 }, () => newBlock("extract"));
  if (kind === "gate") Object.assign(base, { threshold: .85, pass: newBlock("return"), fail: newBlock("extract") });
  if (kind === "repair") Object.assign(base, { body: newBlock("extract"), attempts: 1, always_verify: true });
  if (kind === "pages") base.body = newBlock("extract");
  return base;
}
export const recipes = [
  { id: "direct", name: "LLM only", detail: "Send the original document to the model." },
  { id: "parsed", name: "Parse and extract", detail: "Extract from parser text and layout." },
  { id: "cascade", name: "Tiered extraction", detail: "Escalate when acceptance checks fail." },
  { id: "consensus", name: "Majority vote", detail: "Run three voters and resolve field agreement." },
  { id: "verify", name: "Extract and verify", detail: "Check a candidate against its source." },
  { id: "pages", name: "Per-page extraction", detail: "Extract each page and merge results." },
];
export function harnessRecipe(id: string): HarnessConfig {
  const kind: BlockKind = ({ cascade: "cascade", consensus: "consensus", pages: "pages" } as Record<string, BlockKind>)[id] || "extract";
  const steps = [newBlock(kind)];
  if (id === "verify") steps.push(newBlock("repair"));
  steps.push(newBlock("validate"));
  return { name: "workflow", version: 1, input: id === "direct" ? "document" : "parsed", limits: { max_calls: 30, concurrency: 3 }, flow: { id: crypto.randomUUID(), kind: "sequence", steps } };
}
export function children(block: HarnessBlock): [string, HarnessBlock[]][] {
  return ["steps", "tiers", "branches", "pass", "fail", "body"].flatMap(key => {
    const value = block[key as keyof HarnessBlock];
    return value ? [[key, Array.isArray(value) ? value : [value]] as [string, HarnessBlock[]]] : [];
  });
}
export function transformBlock(root: HarnessBlock, id: string, edit: (b: HarnessBlock) => HarnessBlock): HarnessBlock {
  if (root.id === id) return edit(root);
  const result = { ...root };
  for (const [key, list] of children(root)) {
    const updated = list.map(b => transformBlock(b, id, edit));
    Object.assign(result, { [key]: ["pass", "fail", "body"].includes(key) ? updated[0] : updated });
  }
  return result;
}
export function findBlock(root: HarnessBlock | undefined, id: string): HarnessBlock | undefined {
  if (!root) return;
  if (root.id === id) return root;
  for (const [, list] of children(root)) for (const child of list) {
    const result = findBlock(child, id); if (result) return result;
  }
}
export function schemaPaths(schema: string): string[] {
  try {
    const walk = (s: any, prefix: string): string[] => s.type === "object"
      ? Object.entries(s.properties || {}).flatMap(([key, child]) => walk(child, prefix ? `${prefix}.${key}` : key)) : [prefix];
    return walk(JSON.parse(schema), "").filter(Boolean);
  } catch { return []; }
}
export function harnessError(spec: HarnessConfig | undefined): string {
  if (!spec || spec.name !== "workflow") return "";
  if (spec.version !== 1 || !spec.flow) return "Choose a valid version 1 extraction flow.";
  if (spec.input !== undefined && !["parsed", "document"].includes(spec.input)) return "Choose parsed text or original document input.";
  for (const [key, defaultValue, maximum] of [["max_calls", 30, 1000], ["concurrency", 3, 16]] as const) {
    const value = spec.limits?.[key] ?? defaultValue;
    if (!Number.isInteger(value) || value < 1 || value > maximum) return `${key === "max_calls" ? "Maximum calls" : "Concurrency"} must be between 1 and ${maximum}.`;
  }
  const ids = new Set<string>();
  let error = "";
  const walk = (b: HarnessBlock, depth: number) => {
    if (!b || !blockNames[b.kind] || !b.id || ids.has(b.id)) { error = "Blocks need supported types and unique IDs."; return; }
    ids.add(b.id);
    if (b.model && (!b.model.provider || !b.model.name?.trim())) error = "Choose a provider and model ID for every model override.";
    if (b.kind === "repair" && (!Number.isInteger(b.attempts ?? 1) || (b.attempts ?? 1) < 1 || (b.attempts ?? 1) > 5)) error = "Repair attempts must be between 1 and 5.";
    if (depth > 12 || ids.size > 100) { error = "Use at most 100 blocks and 12 nesting levels."; return; }
    if (b.threshold !== undefined && (!Number.isFinite(b.threshold) || b.threshold < 0 || b.threshold > 1)) error = "Confidence thresholds must be between 0 and 1.";
    const count = b.branches?.length || 0;
    if (b.kind === "consensus" && b.quorum !== undefined && (!Number.isInteger(b.quorum) || b.quorum <= count / 2 || b.quorum > count)) error = "Quorum must be a strict majority of configured voters.";
    if (b.routing) error = routingError(b) || error;
    for (const [, list] of children(b)) for (const child of list) walk(child, depth + 1);
  };
  walk(spec.flow, 0);
  return error;
}

/** Allow incomplete drafts on the canvas, but prevent running broken connections. */
export function routingError(block: HarnessBlock): string {
  if (!block.routing) return "";
  const list = children(block).flatMap(([, items]) => items);
  if (!list.length || !Array.isArray(block.routing.edges)) return "Connections require a flow containing steps.";
  if (block.routing.edges.length > 500) return "Use at most 500 connections per flow.";
  const known = new Set(["boundary:input", ...list.map(b => `block:${b.id}`), "boundary:output"]);
  const incoming = new Map([...known].map(id => [id, new Set<string>()]));
  const ids = new Set<string>(), signatures = new Set<string>();
  for (const edge of block.routing.edges) {
    if (!edge || typeof edge.id !== "string" || !edge.id || ids.has(edge.id)) return "Connections need unique IDs.";
    ids.add(edge.id);
    if (!known.has(edge.source) || !known.has(edge.target)) return "A connection references a missing step.";
    if (edge.source === edge.target || edge.source === "boundary:output" || edge.target === "boundary:input") return "Connections must lead from input toward output.";
    if (!["always", "accepted", "unresolved"].includes(edge.condition)) return "Choose a connection condition.";
    const signature = JSON.stringify([edge.source, edge.target, edge.condition]);
    if (signatures.has(signature)) return "Duplicate connection.";
    signatures.add(signature);
    incoming.get(edge.target)!.add(edge.source);
  }
  const visited = new Set<string>(), reachable = new Set(["boundary:input"]);
  while (visited.size < known.size) {
    const layer = [...known].filter(id => !visited.has(id) && [...incoming.get(id)!].every(from => visited.has(from)));
    if (!layer.length) return "Connections contain a cycle. Use a bounded repair block to repeat work.";
    for (const id of layer) {
      visited.add(id);
      if ([...incoming.get(id)!].some(from => reachable.has(from))) reachable.add(id);
    }
  }
  return reachable.has("boundary:output") ? "" : "Connect input to output before running this flow.";
}
