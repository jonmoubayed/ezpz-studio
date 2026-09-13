import type { JsonValue } from "./domain";

export type OutputField = { key: string; value: JsonValue };
export type FieldNode<T> = {
  name: string;
  path: string;
  field?: T;
  children: FieldNode<T>[];
};

// Quoted passages and page locations accompany an answer; they aren't extra
// unanswered questions. Keep explicitly annotated evidence leaves reviewable.
export function answerFields<T extends { key: string; hasExpected?: boolean; expected?: unknown }>(fields: T[]): T[] {
  const keys = new Set(fields.map((field) => field.key));
  return fields.filter((field) => {
    if (!/\.(excerpt|location)$/.test(field.key)) return true;
    const parent = field.key.slice(0, field.key.lastIndexOf("."));
    const annotated = field.hasExpected ?? (Object.hasOwn(field, "expected") && field.expected !== null);
    return annotated || !["value", "status", "excerpt", "location"].every((name) => keys.has(`${parent}.${name}`));
  });
}

// Canonical results use dotted paths for evidence and scoring. Reconstruct the
// object hierarchy only at the presentation boundary; arrays remain intact.
export function fieldTree<T extends { key: string }>(fields: T[]): FieldNode<T>[] {
  const roots: FieldNode<T>[] = [];
  for (const field of fields) {
    let children = roots;
    const parts = field.key.split(".");
    parts.forEach((name, index) => {
      let node = children.find((item) => item.name === name);
      if (!node) {
        node = { name, path: parts.slice(0, index + 1).join("."), children: [] };
        children.push(node);
      }
      if (index === parts.length - 1) node.field = field;
      children = node.children;
    });
  }
  return roots;
}

export function extractionValues(fields: OutputField[]): Record<string, JsonValue> {
  function values(nodes: FieldNode<OutputField>[]): Record<string, JsonValue> {
    // fromEntries creates own properties, including keys such as __proto__.
    return Object.fromEntries(nodes.map((node) => [
      node.name,
      node.children.length ? values(node.children) : node.field!.value,
    ]));
  }
  return values(fieldTree(fields));
}
