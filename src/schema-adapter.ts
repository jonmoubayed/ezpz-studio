import type {
  SchemaBuilderSchema,
  SchemaBuilderProperty,
  SchemaBuilderFieldType,
} from "./components/extend/schema-builder";

type Node = Record<string, any>;
type Metadata = { node: Node; type: SchemaBuilderFieldType; required: boolean };
export type SchemaDocument = {
  schema: SchemaBuilderSchema;
  root: Node;
  metadata: Map<string, Metadata>;
};
const scalars = ["string", "number", "integer", "boolean", "null"];
const own = (value: Node, key: string) =>
  Object.prototype.hasOwnProperty.call(value, key);

/** Convert only shapes the visual editor can represent; advanced schemas stay editable as JSON. */
export function readSchema(text: string): SchemaDocument {
  const root = JSON.parse(text);
  const metadata = new Map<string, Metadata>();
  const check = (node: Node, path: string) => {
    if (!node || typeof node !== "object" || Array.isArray(node))
      throw new Error(`${path}: use the JSON editor for boolean schemas.`);
    if (
      [
        "$ref",
        "$dynamicRef",
        "oneOf",
        "anyOf",
        "allOf",
        "not",
        "if",
        "then",
        "else",
        "prefixItems",
        "const",
      ].some((k) => own(node, k))
    )
      throw new Error(
        `${path}: this advanced schema uses rules best edited in JSON.`,
      );
    if (![...scalars, "object", "array"].includes(node.type))
      throw new Error(
        `${path}: the visual editor needs a single explicit JSON type.`,
      );
    if (
      node.enum &&
      (node.type !== "string" ||
        !Array.isArray(node.enum) ||
        node.enum.some((v: unknown) => typeof v !== "string"))
    )
      throw new Error(`${path}: non-string enums can be edited in JSON.`);
  };
  const fields = (node: Node, path: string): SchemaBuilderProperty[] => {
    if (
      node.properties !== undefined &&
      (!node.properties ||
        typeof node.properties !== "object" ||
        Array.isArray(node.properties))
    )
      throw new Error(`${path}: properties must be an object.`);
    if (
      node.required !== undefined &&
      (!Array.isArray(node.required) ||
        node.required.some((v: unknown) => typeof v !== "string"))
    )
      throw new Error(`${path}: required must contain field names.`);
    return Object.entries(node.properties ?? {}).map(([key, raw]) => {
      const n = raw as Node;
      check(n, `${path}.${key}`);
      const id = crypto.randomUUID();
      const type = n.enum ? "enum" : n.type;
      metadata.set(id, {
        node: n,
        type,
        required: node.required?.includes(key) ?? false,
      });
      const property: SchemaBuilderProperty = {
        id,
        key,
        type,
        description: n.description ?? "",
      };
      if (n.enum)
        property.enumValues = n.enum.map((value: string) => ({
          id: crypto.randomUUID(),
          value,
          description: n.enumDescriptions?.[value] ?? "",
        }));
      if (type === "object") property.properties = fields(n, `${path}.${key}`);
      if (type === "array") {
        check(n.items, `${path}.${key}[]`);
        if (["array", "null"].includes(n.items.type))
          throw new Error(
            `${path}.${key}: nested or nullable arrays can be edited in JSON.`,
          );
        property.items = { type: n.items.enum ? "enum" : n.items.type };
        if (n.items.type === "object")
          property.items.properties = fields(n.items, `${path}.${key}[]`);
        if (n.items.enum)
          property.items.enumValues = n.items.enum.map((value: string) => ({
            id: crypto.randomUUID(),
            value,
            description: n.items.enumDescriptions?.[value] ?? "",
          }));
      }
      return property;
    });
  };
  check(root, "Schema");
  if (root.type !== "object")
    throw new Error("The extraction schema must be an object.");
  return { schema: { properties: fields(root, "Schema") }, root, metadata };
}

/** Retain constraints by stable field ID, including when required fields move or are renamed. */
export function writeSchema(
  document: SchemaDocument,
  schema: SchemaBuilderSchema,
): Node {
  const object = (
    properties: SchemaBuilderProperty[],
    original: Node,
  ): Node => {
    const names = new Set<string>();
    for (const p of properties) {
      if (!p.key.trim())
        throw new Error("Give every field a name before continuing.");
      if (names.has(p.key))
        throw new Error(
          `Duplicate field name “${p.key}”. Each field in an object needs a unique name.`,
        );
      names.add(p.key);
    }
    const next: Node = {
      ...original,
      type: "object",
      properties: Object.fromEntries(properties.map((p) => [p.key, field(p)])),
    };
    // Keep requirements for externally declared/pattern properties as well.
    const external = (original.required ?? []).filter(
      (key: string) => !own(original.properties ?? {}, key),
    );
    const required = [
      ...new Set([
        ...external,
        ...properties
          .filter((p) => document.metadata.get(p.id)?.required)
          .map((p) => p.key),
      ]),
    ];
    if (required.length || own(original, "required")) next.required = required;
    else delete next.required;
    return next;
  };
  const typed = (
    type: string,
    data: {
      properties?: SchemaBuilderProperty[];
      enumValues?: { value: string; description: string }[];
    },
    original: Node,
  ): Node => {
    if (type === "object") return object(data.properties ?? [], original);
    const next: Node = { ...original, type: type === "enum" ? "string" : type };
    if (type === "enum") {
      const values = data.enumValues ?? [];
      if (
        !values.length ||
        new Set(values.map((v) => v.value)).size !== values.length
      )
        throw new Error("Enums need at least one value, with no duplicates.");
      next.enum = values.map((v) => v.value);
      const descriptions = Object.fromEntries(
        values
          .filter((v) => v.description)
          .map((v) => [v.value, v.description]),
      );
      if (Object.keys(descriptions).length)
        next.enumDescriptions = descriptions;
      else delete next.enumDescriptions;
    }
    return next;
  };
  const field = (p: SchemaBuilderProperty): Node => {
    const meta = document.metadata.get(p.id);
    const original = meta?.type === p.type ? meta.node : {};
    const result = typed(p.type, p, original);
    if (p.description) result.description = p.description;
    else delete result.description;
    if (p.type === "array") {
      const items = p.items ?? { type: "string" };
      const old = original.items ?? {};
      result.items = typed(
        items.type,
        items,
        (old.enum ? "enum" : old.type) === items.type ? old : {},
      );
    }
    return result;
  };
  return object(schema.properties, document.root);
}
