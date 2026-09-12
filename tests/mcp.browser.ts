import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";

const base = process.env.STUDIO_BROWSER_URL;
if (!base || process.env.STUDIO_TEST_DISPOSABLE !== "1")
  throw new Error("Use npm run test:mcp:browser with its disposable API.");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(15000);
const errors: string[] = [];
page.on("pageerror", error => errors.push(error.message));
async function get(path: string) {
  const response = await page.request.get(`${base}/v1${path}`);
  assert.ok(response.ok(), await response.text());
  return response.json();
}
async function post(path: string, data: unknown) {
  const response = await page.request.post(`${base}/v1${path}`, { data });
  assert.ok(response.ok(), await response.text());
  return response.json();
}
async function nav(name: string) {
  await page.locator("aside").getByRole("button", { name, exact: true }).click();
}
try {
  await page.goto(`${base}/#Datasets`);
  await expect(page.getByText("Local API connected", { exact: true })).toBeVisible();
  const { dataset } = await post("/datasets", { name: "MCP browser benchmark" });
  // This write happens outside the page, just as it does through MCP.
  await expect(page.getByText(dataset.name, { exact: true })).toBeVisible();
  const response = await page.request.post(`${base}/v1/documents`, {
    multipart: { file: { name: "agent-invoice.txt", mimeType: "text/plain", buffer: Buffer.from("Invoice Number: INV-101\nTotal: $12.50") }, metadata: JSON.stringify({ author: "mcp:browser-test" }) },
  });
  assert.ok(response.ok());
  const { document } = await response.json();
  await post(`/datasets/${dataset.id}/documents`, { document_id: document.id });
  await post(`/documents/${document.id}/ground-truth`, { value: { total: 12.5 }, expected_revision: 0, annotation_status: "unverified", author: "mcp:browser-test" });
  await page.goto(`${base}/?document=${document.id}#Playground`);
  await page.getByRole("button", { name: "Expected", exact: true }).click();
  await expect(page.getByText(/Unverified annotations from mcp:browser-test/)).toBeVisible();
  const editor = page.getByRole("textbox", { name: "Expected values", exact: true });
  await expect(editor).toHaveValue(/12.5/);
  await editor.fill('{"total": 13}');
  await post(`/documents/${document.id}/ground-truth`, { value: { total: 20 }, expected_revision: 1, annotation_status: "unverified", author: "mcp:other-agent" });
  await expect(page.getByText(/Expected values changed in another session. Your edits are preserved/)).toBeVisible();
  await expect(editor).toHaveValue('{"total": 13}');
  await page.getByRole("button", { name: "Save ground truth", exact: true }).click();
  await expect(page.getByRole("alert").getByText(/Ground truth could not be saved.*changed in another session/)).toBeVisible();
  assert.equal((await get(`/documents/${document.id}/ground-truth`)).ground_truth.value.total, 20);
  await page.getByRole("button", { name: "Reload saved values", exact: true }).click();
  await expect(editor).toHaveValue(/20/);
  await page.getByRole("button", { name: "Save ground truth", exact: true }).click();
  await expect(page.getByText(/Ground truth saved for agent-invoice.txt/)).toBeVisible();
  assert.equal((await get(`/documents/${document.id}/ground-truth`)).ground_truth.annotation_status, "complete");

  const schema = { type: "object", properties: { total: { type: "number" } } };
  const { processor } = await post("/processors", { name: "Agent collaboration", config: { schema, parser: { name: "native" }, model: { provider: "local", name: "deterministic-local" } }, author: "mcp:browser-test" });
  await nav("Processors");
  await page.getByRole("button", { name: /Agent collaboration Custom document extraction/ }).click();
  await page.getByRole("button", { name: "Edit JSON", exact: true }).click();
  await page.getByLabel("Schema JSON").fill(JSON.stringify({ ...schema, properties: { ...schema.properties, localChange: { type: "string" } } }));
  await page.getByRole("button", { name: "Apply JSON", exact: true }).click();
  await post(`/processors/${processor.id}/versions`, { config: { prompt: { extraction: "Agent candidate instructions" } }, expected_version: 1, author: "mcp:browser-test", status: "draft" });
  await expect(page.getByText(/latest saved version 2/)).toBeVisible();
  await page.getByRole("button", { name: "Save version", exact: true }).click();
  await expect(page.getByText(/Processor changed in another session/)).toBeVisible();
  assert.equal((await get(`/processors/${processor.id}`)).processor.versions[0].version, 2);
  await page.getByRole("button", { name: "Edit JSON", exact: true }).click();
  await expect(page.getByLabel("Schema JSON")).toHaveValue(/localChange/);

  const { job } = await post("/agent/jobs", { dataset_id: dataset.id, processor: processor.id, version: 2, request_key: "browser-evaluation", author: "mcp:browser-test" });
  await expect.poll(async () => (await get(`/agent/jobs/${job.id}`)).job.status).toBe("completed");
  const runId = (await get(`/agent/jobs/${job.id}`)).job.result.run_id;
  await nav("Evaluations");
  await expect(page.getByRole("button", { name: new RegExp(dataset.name) }).or(page.getByText(dataset.name, { exact: true })).first()).toBeVisible();
  await page.goto(`${base}/?run=${runId}#Evaluations`);
  await expect(page).toHaveURL(new RegExp(`/run/${runId}`));
  await expect(page.getByText("Run not found", { exact: true })).toHaveCount(0);
  await expect(page.locator(".evaluation-trail")).toBeVisible();
  await mkdir(".screenshots", { recursive: true });
  await page.screenshot({ path: ".screenshots/mcp-run-review.png", fullPage: true });
  assert.deepEqual(errors, []);
  console.log("PASS: external workspace refresh, annotation provenance, preserved edits and conflicts, candidate versions, background evaluation and result deep links.");
} finally {
  await browser.close();
}
