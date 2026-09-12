import type { JsonValue } from "./domain";

export type OutputField = { key: string; value: JsonValue };
export type FieldNode<T> = {
  name: string;
  path: string;
  field?: T;
  children: FieldNode<T>[];
};

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
