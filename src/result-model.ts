import type { Citation, Document, Field, JsonValue } from "./domain";

export function expectedValue(
  values: Record<string, JsonValue> | undefined,
  key: string,
) {
  if (values && Object.hasOwn(values, key))
    return { hasExpected: true, expected: values[key] };
  const parts = key.replace(/\[(\d+)\]/g, ".$1").split(".");
  let current: unknown = values;
  for (const part of parts) {
    if (
      !current ||
      typeof current !== "object" ||
      !Object.hasOwn(current, part)
    )
      return { hasExpected: false, expected: null };
    current = (current as Record<string, unknown>)[part];
  }
  return { hasExpected: true, expected: current as JsonValue };
}
export function hasExpected(field: Field) {
  return field.hasExpected ?? field.expected !== null;
}
export function expectedValues(document: Document): Record<string, JsonValue> {
  return (
    document.groundTruth ??
    Object.fromEntries(
      document.fields.filter(hasExpected).map((f) => [f.key, f.expected]),
    )
  );
}
export function withExpectedValues(
  document: Document,
  values: Record<string, JsonValue>,
): Document {
  return {
    ...document,
    groundTruth: values,
    fields: document.fields.map((f) => ({
      ...f,
      ...expectedValue(values, f.key),
    })),
  };
}
export function equalValues(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  if (
    a === null ||
    b === null ||
    typeof a !== "object" ||
    typeof b !== "object" ||
    Array.isArray(a) !== Array.isArray(b)
  )
    return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every(
      (k) => Object.hasOwn(b, k) && equalValues((a as any)[k], (b as any)[k]),
    )
  );
}

export function extractionCitations(
  extraction: any,
  evidence: any[] = [],
): Citation[] {
  const result: Citation[] = [];
  for (const item of Array.isArray(evidence) ? evidence : []) {
    if (
      !item ||
      !Array.isArray(item.bbox) ||
      item.bbox.length !== 4 ||
      !item.bbox.every(
        (v: unknown) => typeof v === "number" && Number.isFinite(v),
      )
    )
      continue;
    const pageNumber = Number(item.page ?? 1);
    if (!Number.isInteger(pageNumber) || pageNumber < 1) continue;
    const page = extraction?.parser_ir?.pages?.find(
      (p: any) => Number(p.page) === pageNumber,
    );
    let [left, top, right, bottom] = item.bbox;
    // ezpz parser IR uses normalized top-left xyxy coordinates. Retain compatibility with older absolute boxes.
    if (Math.max(left, top, right, bottom) > 1) {
      if (!(page?.width > 0 && page?.height > 0)) continue;
      left /= page.width;
      right /= page.width;
      top /= page.height;
      bottom /= page.height;
    }
    [left, top, right, bottom] = [left, top, right, bottom].map((v) =>
      Math.max(0, Math.min(1, v)),
    );
    if (right <= left || bottom <= top) continue;
    const citation = {
      page: pageNumber,
      area: {
        left: left * 100,
        top: top * 100,
        width: (right - left) * 100,
        height: (bottom - top) * 100,
      },
    };
    if (!result.some((c) => JSON.stringify(c) === JSON.stringify(citation)))
      result.push(citation);
  }
  return result;
}
