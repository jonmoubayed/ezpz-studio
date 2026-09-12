import test from 'node:test';
import assert from 'node:assert/strict';
import { extractionValues, fieldTree } from '../src/extraction-output';

const fields = [
  { key: 'vendor.value', value: 'Example Corp.' },
  { key: 'vendor.status', value: 'extracted' },
  { key: 'vendor.location', value: 'Page 1' },
  { key: 'vendor.excerpt', value: 'Agreement with Example Corp.' },
  { key: 'endDate.value', value: '' },
  { key: 'endDate.status', value: 'not_found' },
  { key: 'endDate.location', value: '' },
  { key: 'endDate.excerpt', value: '' },
];
test('serializes canonical paths as nested objects for display, copy and export', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(extractionValues(fields))), {
    vendor: { value: 'Example Corp.', status: 'extracted', location: 'Page 1', excerpt: 'Agreement with Example Corp.' },
    endDate: { value: '', status: 'not_found', location: '', excerpt: '' },
  });
  const tree = fieldTree(fields);
  assert.deepEqual(tree.map(node => node.name), ['vendor', 'endDate']);
  assert.equal(tree[0].children[0].name, 'value');
  assert.equal(tree[0].children[0].path, 'vendor.value');
  assert.equal(tree[0].children[0].field, fields[0], 'Preserve the original field and citation metadata');
});
test('retains arrays, nested objects, empty values and scalar types without mutating fields', () => {
  const input = [
    {key: 'contract.notice.days', value: 0},
    {key: 'contract.autoRenew', value: false},
    {key: 'contract.endDate', value: null},
    {key: 'items', value: [{description: 'Item', price: 12}]},
    {key: 'metadata', value: {tags: [], extra: {}}},
  ];
  const original = structuredClone(input);
  assert.deepEqual(extractionValues(input), {contract: {notice: {days: 0}, autoRenew: false, endDate: null}, items: [{description: 'Item', price: 12}], metadata: {tags: [], extra: {}}});
  assert.deepEqual(input, original);
  assert.deepEqual(extractionValues([]), {});
});
test('groups interleaved fields in first-seen order and safely handles special property names', () => {
  const input = [{key: 'a.value', value: 1}, {key: 'b.value', value: 2}, {key: 'a.status', value: 'extracted'}, {key: '__proto__.extracted', value: true}, {key: 'constructor.value', value: 'safe'}];
  const output = extractionValues(input);
  assert.deepEqual(Object.keys(output), ['a', 'b', '__proto__', 'constructor']);
  assert.deepEqual(output.a, {value: 1, status: 'extracted'});
  assert.equal(Object.hasOwn(output, '__proto__'), true);
  assert.equal(output.__proto__.extracted, true);
  assert.equal({}.extracted, undefined);
});

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { ExtractionFields } from '../src/extraction-fields';
import { expectedValues } from '../src/result-model';

test('renders accessible object groups while retaining each full field path', () => {
  const markup = renderToStaticMarkup(<ExtractionFields fields={fields} renderField={(field, name) => <button aria-label={`Inspect source for ${field.key}`}>{name}</button>} />);
  const doc = new JSDOM(markup).window.document;
  assert.equal(doc.querySelectorAll('details[open]').length, 2);
  assert.equal(doc.querySelector('summary')?.getAttribute('aria-label'), 'vendor object');
  assert.equal(doc.querySelectorAll('button').length, fields.length);
  assert.equal(doc.querySelector('button')?.textContent, 'value');
  assert.equal(doc.querySelector('button')?.getAttribute('aria-label'), 'Inspect source for vendor.value');
});
test('fallback expected JSON uses the same nested shape and excludes unannotated leaves', () => {
  const doc = { fields: [
    {key: 'vendor.value', expected: null, hasExpected: true},
    {key: 'vendor.status', expected: 'not_found', hasExpected: true},
    {key: 'other.value', expected: null, hasExpected: false},
  ] };
  assert.deepEqual(expectedValues(doc as any), {vendor: {value: null, status: 'not_found'}});
});
