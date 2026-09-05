import type { Field } from "./domain";

export function confidenceFromResponse(
  field: any,
): Pick<Field, "confidence" | "confidenceSource"> {
  const source = field?.provenance?.confidence_source;
  const score = field?.confidence;
  if (
    (source === "model_reported" || source === "heuristic") &&
    typeof score === "number" &&
    Number.isFinite(score) &&
    score >= 0 &&
    score <= 1
  )
    return { confidence: score, confidenceSource: source };
  // Historical scores lack provenance and may be the old hardcoded 0.75 fallback.
  return { confidence: null, confidenceSource: undefined };
}
export function hasConfidence(field: Field): boolean {
  return (
    ["model_reported", "heuristic", "sample"].includes(
      field.confidenceSource || "",
    ) &&
    typeof field.confidence === "number" &&
    Number.isFinite(field.confidence) &&
    field.confidence >= 0 &&
    field.confidence <= 1
  );
}
export function isLowConfidence(field: Field): boolean {
  return hasConfidence(field) && field.confidence! < 0.9;
}
export function confidenceLabel(field: Field): string {
  if (!hasConfidence(field)) return "Not provided";
  const source =
    field.confidenceSource === "model_reported"
      ? "Model"
      : field.confidenceSource === "heuristic"
        ? "Rule-based"
        : "Sample";
  return `${source} ${Math.round(field.confidence! * 100)}%`;
}
export function confidenceDescription(field: Field): string {
  if (!hasConfidence(field))
    return "Confidence not provided or not verifiable in this saved result. Run extraction again to request model-reported confidence.";
  if (field.confidenceSource === "model_reported")
    return "Model-reported confidence: a self-assessment from the LLM response, not calibrated accuracy or a ground-truth evaluation score.";
  if (field.confidenceSource === "heuristic")
    return "Fixed heuristic from the local deterministic adapter. This is not LLM-reported confidence.";
  return "Illustrative confidence from a demo fixture.";
}
