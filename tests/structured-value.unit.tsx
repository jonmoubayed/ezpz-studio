import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { StructuredValue, isObjectArray } from "../src/structured-value";
const rows = [
  {
    description: "A long description",
    quantity: 0,
    approved: false,
    optional: null,
  },
  { description: "Second item", price: "7,50", nested: { sku: "abc" } },
];
const doc = new JSDOM(
  renderToStaticMarkup(
    <StructuredValue value={rows} label="line_items result" />,
  ),
).window.document;
assert.deepEqual(
  [...doc.querySelectorAll("thead th")].map((el) => el.textContent),
  ["#", "description", "quantity", "approved", "optional", "price", "nested"],
);
assert.equal(doc.querySelectorAll("tbody tr").length, 2);
assert.equal(
  doc.querySelectorAll("tbody tr")[0].querySelectorAll("td")[1].textContent,
  "0",
);
assert.equal(
  doc.querySelectorAll("tbody tr")[0].querySelectorAll("td")[2].textContent,
  "false",
);
assert.equal(
  doc.querySelectorAll("tbody tr")[0].querySelectorAll("td")[3].textContent,
  "null",
);
assert.equal(doc.querySelectorAll('[aria-label="Missing value"]').length, 5);
assert.ok(doc.body.textContent?.includes("7,50"));
assert.ok(doc.body.textContent?.includes('{"sku":"abc"}'));
assert.equal(
  doc.querySelector("table")?.getAttribute("aria-label"),
  "line_items result",
);
assert.equal(isObjectArray([null]), false);
assert.equal(isObjectArray([1, "two"]), false);
assert.ok(
  renderToStaticMarkup(<StructuredValue value={[]} label="Empty" />).includes(
    "No items",
  ),
);
assert.ok(
  !renderToStaticMarkup(
    <StructuredValue value={[1, 2]} label="Scalars" />,
  ).includes("<table"),
);
console.log(
  "PASS: object-array tables, heterogeneous columns, zero/false/null, missing cells, nested values, empty arrays, and scalar-array fallback.",
);
