import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { extractionValues } from '../src/extraction-output';
import { defaultConfig } from '../src/domain';
import { configPayload } from '../src/api';

// All API traffic is intercepted in an isolated browser; no real extraction runs.
const flat = process.env.EXTRACTION_FIXTURE
  ? JSON.parse(await readFile(process.env.EXTRACTION_FIXTURE, 'utf8'))
  : {'vendor.value': 'Example Corp.', 'vendor.status': 'extracted', 'vendor.location': 'Page 1', 'vendor.excerpt': 'Agreement with Example Corp.', 'endDate.value': '', 'endDate.status': 'not_found', 'endDate.location': '', 'endDate.excerpt': ''};
const output = extractionValues(Object.entries(flat).map(([key, value]) => ({key, value: value as any})));
const extraction = { result: { fields: Object.fromEntries(Object.entries(flat).map(([key, value]) => [key, {value, evidence: []}])) }};
const document = { id: 'object-fixture', filename: 'Contract.txt', content_type: 'text/plain', page_count: 1 };
const processor = {id: 'objects', name: 'Contract extraction', versions: [{id: 'version-1', version: 1, ...configPayload(defaultConfig)}]};
const browser = await chromium.launch({headless: true});
const context = await browser.newContext({viewport: {width: 1512, height: 1000}, permissions: ['clipboard-read', 'clipboard-write']});
const page = await context.newPage();
page.setDefaultTimeout(10000);
const errors: string[] = [];
page.on('pageerror', e => errors.push(e.message));
await page.route('**/v1/**', async route => {
  const path = new URL(route.request().url()).pathname.slice(3);
  if (path.endsWith('/source')) return route.fulfill({contentType: 'text/plain', body: 'Contract source fixture'});
  const payloads: Record<string, unknown> = {
    '/ready': {ready: true}, '/documents': {documents: [document]}, '/datasets': {datasets: []},
    '/runs': {runs: []}, '/processors': {processors: [processor]}, '/eval-groups': {eval_groups: []},
    '/workspace/revision': {revision: 1}, '/adapters': {adapters: {llm: [{id: 'local', label: 'Local deterministic'}], parsers: [{id: 'native', label: 'Native text'}], harnesses: []}}, '/documents/object-fixture': {document, extraction},
    '/documents/object-fixture/ground-truth': {ground_truth: null}, '/processors/objects': {processor},
    '/processors/objects/draft/preview': {extraction},
  };
  if (!(path in payloads)) { errors.push(`Unexpected API request: ${path}`); return route.fulfill({status: 404, json: {error: 'Unexpected test endpoint'}}); }
  return route.fulfill({json: payloads[path]});
});
try {
  await page.goto(`${process.env.STUDIO_BROWSER_URL || 'http://127.0.0.1:5180'}/#Playground`);
  const vendor = page.locator('.extraction-object').filter({has: page.locator('summary[aria-label="vendor object"]')});
  await expect(vendor).toBeVisible();
  await expect(vendor.locator('.field-card')).toHaveCount(4);
  await expect(page.locator('.field-list > .extraction-object')).toHaveCount(Object.keys(output).length);
  await page.getByRole('button', {name: 'Inspect source for vendor.value', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Inspect source for vendor.value', exact: true})).toHaveAttribute('aria-pressed', 'true');
  await vendor.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(vendor.locator('.field-card').first()).toBeHidden();
  await page.keyboard.press('Enter');
  await expect(vendor.locator('.field-card').first()).toBeVisible();
  assert.ok((await vendor.boundingBox())!.height > 200, 'Object group must not shrink inside the scrolling list');
  await mkdir('.screenshots', {recursive: true});
  await page.screenshot({animations: 'disabled', path: '.screenshots/extraction-objects-desktop.png'});
  await page.getByRole('button', {name: 'JSON', exact: true}).click();
  assert.deepEqual(JSON.parse(await page.locator('.extraction-json').innerText()), output);
  await page.getByRole('button', {name: 'Copy extraction JSON'}).click();
  assert.deepEqual(JSON.parse(await page.evaluate(() => navigator.clipboard.readText())), output);
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', {name: 'Export extraction JSON'}).click();
  const download = await downloadEvent;
  assert.deepEqual(JSON.parse(await readFile((await download.path())!, 'utf8')), output);
  await page.setViewportSize({width: 390, height: 844});
  await page.getByRole('button', {name: /^Fields/}).click();
  await vendor.scrollIntoViewIfNeeded();
  await page.screenshot({animations: 'disabled', path: '.screenshots/extraction-objects-mobile.png'});
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.setViewportSize({width: 1512, height: 1000});
  await page.getByRole('button', {name: 'Configure', exact: true}).click();
  await page.getByRole('button', {name: 'Run extraction', exact: true}).click();
  await expect(page.locator('.processor-preview-fields > .extraction-object')).toHaveCount(Object.keys(output).length);
  await expect(page.getByRole('button', {name: 'Inspect source for vendor.value', exact: true})).toBeVisible();
  await page.getByRole('tab', {name: 'JSON', exact: true}).click();
  assert.deepEqual(JSON.parse(await page.locator('.processor-preview .json-output').innerText()), output);
  const previewDownloadEvent = page.waitForEvent('download');
  await page.getByRole('button', {name: 'Export JSON', exact: true}).click();
  const previewDownload = await previewDownloadEvent;
  assert.deepEqual(JSON.parse(await readFile((await previewDownload.path())!, 'utf8')), output);
  assert.deepEqual(errors, []);
  console.log(`PASS: ${Object.keys(output).length} object groups, source selection, keyboard collapse, nested JSON, clipboard, both exports, preview, and mobile overflow.`);
} catch (error) {
  console.error(errors);
  await page.screenshot({animations: 'disabled', path: '.screenshots/extraction-objects-failure.png'});
  throw error;
} finally {
  await browser.close();
}
