import assert from "node:assert/strict";
import { readSchema, writeSchema } from "../src/schema-adapter";
const original = {
  type: "object",
  additionalProperties: false,
  required: ["id", "lines"],
  properties: {
    id: { type: "string", minLength: 2, description: "Invoice ID" },
    lines: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["amount"],
        properties: {
          amount: { type: "number", minimum: 0 },
          status: {
            type: "string",
            enum: ["paid", "pending"],
            enumDescriptions: { paid: "Settled" },
          },
        },
      },
    },
    total: { type: "number", minimum: 0 },
  },
};
const doc = readSchema(JSON.stringify(original));
assert.deepEqual(
  writeSchema(doc, doc.schema),
  original,
  "round trip retains nested constraints and required fields",
);
const next = structuredClone(doc.schema);
next.properties[0].key = "invoice_id";
next.properties.reverse();
assert.deepEqual(writeSchema(doc, next).required, ["lines", "invoice_id"]);
const nested = next.properties.find((p) => p.key === "lines")!.items!
  .properties!;
const amount = nested.shift()!;
next.properties.push(amount);
const moved = writeSchema(doc, next);
assert(moved.required.includes("amount"));
assert.deepEqual(moved.properties.lines.items.required, []);
assert.equal(moved.properties.amount.minimum, 0);
next.properties = next.properties.filter((p) => p.key !== "invoice_id");
assert(!writeSchema(doc, next).required.includes("invoice_id"));
next.properties.push({ ...next.properties[0], id: "duplicate" });
assert.throws(() => writeSchema(doc, next), /Duplicate/);
assert.throws(
  () =>
    readSchema(
      JSON.stringify({
        type: "object",
        properties: {
          value: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
      }),
    ),
  /advanced/,
);
assert.throws(
  () =>
    readSchema(
      JSON.stringify({
        type: "object",
        properties: { value: { type: "number", enum: [1, 2] } },
      }),
    ),
  /non-string enums/,
);
const special = readSchema(
  '{"type":"object","properties":{"__proto__":{"type":"string"},"constructor":{"type":"string"}}}',
);
assert.deepEqual(Object.keys(writeSchema(special, special.schema).properties), [
  "__proto__",
  "constructor",
]);
console.log(
  "Schema adapter: round trip, rename, reorder, nested moves, deletion, validation and special keys passed.",
);
