import type { Config, Document, Field, Run } from "./domain";
import { failed } from "./evaluation-model";

export type Suggestion = {
  id: string;
  title: string;
  kind: string;
  observation: string;
  rationale: string;
  prompt: string;
  field: string;
  evidence: { document: Document; field: Field }[];
  scoredDocuments: number;
  starter?: boolean;
};

function schemaProperties(config: Config): Record<string, any> {
  try {
    return JSON.parse(config.schema)?.properties || {};
  } catch {
    return {};
  }
}

// Recommendations are deterministic hypotheses derived from scored fields.
// Expected values and document contents are evidence, never prompt instructions.
export function suggestExperiments(run: Run, documents: Document[]): Suggestion[] {
  const fields = new Map<string, { scored: Set<string>; evidence: Suggestion["evidence"] }>();
  for (const document of documents) {
    if (document.runId !== run.id) continue;
    for (const field of document.fields) {
      if (field.status !== "correct" && !failed(field)) continue;
      const bucket = fields.get(field.key) || { scored: new Set<string>(), evidence: [] };
      // Counts are documents, not repeated rows or extraction attempts.
      if (bucket.scored.has(document.id)) continue;
      bucket.scored.add(document.id);
      if (failed(field)) bucket.evidence.push({ document, field });
      fields.set(field.key, bucket);
    }
  }
  const properties = run.config ? schemaProperties(run.config) : {};
  return [...fields].filter(([, value]) => value.evidence.length).map(([key, value]) => {
    const counts = new Map<string, number>();
    for (const { field } of value.evidence)
      counts.set(field.status!, (counts.get(field.status!) || 0) + 1);
    const dominant = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
    const quoted = JSON.stringify(key);
    const structured = properties[key]?.type === "array" || properties[key]?.type === "object" ||
      value.evidence.some(({ field }) => field.expected !== null && typeof field.expected === "object");
    let title = `Disambiguate ${key}`;
    let kind = "Prompt refinement";
    let rationale = "An explicit field-to-source check may reduce selection and transcription errors.";
    let prompt = `For the field ${quoted}, locate the matching source label and verify its value in context. Distinguish it from nearby or similarly named fields. Preserve the source value and follow the schema's required format.`;
    if (dominant === "missing") {
      title = `Recover missing ${key}`;
      rationale = "A targeted search across the document may recover values missed on the first pass.";
      prompt = `Before leaving ${quoted} empty, search all pages, tables, headers, and footnotes for an explicit value matching this field. Return only source-supported values; if absent, use the schema's allowed missing-value representation.`;
    } else if (dominant === "hallucinated") {
      title = `Ground ${key} in the source`;
      kind = "Grounding";
      rationale = "Requiring explicit source support may reduce values produced where the benchmark expects none.";
      prompt = `For ${quoted}, require explicit evidence in this document. Do not infer a value from context, other documents, or defaults. When evidence is absent, use the schema's allowed missing-value representation.`;
    } else if (dominant === "validation_failed") {
      title = `Check the format of ${key}`;
      kind = "Schema compliance";
      rationale = "Checking this field against its schema before returning it may reduce validation failures.";
      prompt = `Before returning ${quoted}, check its type, required structure, allowed values, and format against the schema. Preserve numbers, booleans, arrays, and objects as their declared JSON types without inventing a replacement value.`;
    } else if (structured) {
      title = `Verify the structure of ${key}`;
      kind = "Structured extraction";
      rationale = "Checking entries individually may reduce omissions, extra entries, and mismatched values.";
      prompt = `For ${quoted}, verify each entry and nested value against the source. Preserve the schema's structure and the source ordering; check for omitted or duplicated entries. Do not infer missing cells or properties.`;
    }
    const breakdown = [...counts].map(([status, count]) => `${count} ${status.replaceAll("_", " ")}`).join(", ");
    return {
      id: `${run.id}:${key}`, title, kind, rationale, prompt, field: key,
      observation: `${key} failed in ${value.evidence.length} of ${value.scored.size} scored documents (${breakdown}).`,
      evidence: value.evidence, scoredDocuments: value.scored.size,
    };
  }).sort((a, b) => b.evidence.length - a.evidence.length ||
    b.evidence.length / b.scoredDocuments - a.evidence.length / a.scoredDocuments ||
    a.field.localeCompare(b.field)).slice(0, 3);
}

export function starterSuggestions(config: Config): Suggestion[] {
  const keys = Object.keys(schemaProperties(config));
  const field = keys[0];
  return [{
    id: "starter:source-check", starter: true,
    title: field ? `Define source checks for ${field}` : "Require source-supported values",
    kind: "Starter suggestion", field: field || "", evidence: [], scoredDocuments: 0,
    observation: "No evaluation results yet. This is a starting point, not an observed failure.",
    rationale: "Run an annotated benchmark to discover which fields actually need attention.",
    prompt: `Verify ${field ? `the field ${JSON.stringify(field)}` : "each extracted field"} against explicit evidence in the document. Follow the schema and use its allowed missing-value representation when evidence is absent.`,
  }];
}

export function applySuggestion(config: Config, suggestion: Suggestion): Config {
  return { ...config, prompt: config.prompt.includes(suggestion.prompt)
    ? config.prompt : `${config.prompt.trimEnd()}\n\n${suggestion.prompt}`.trimStart() };
}
