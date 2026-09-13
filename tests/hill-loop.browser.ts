import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import * as api from "../src/api";
import { defaultConfig } from "../src/domain";

const base = process.env.STUDIO_BROWSER_URL;
const backend = process.env.STUDIO_TEST_URL;
if (!base || !backend || process.env.STUDIO_TEST_DISPOSABLE !== "1") throw new Error("Use npm run test:hill-loop with the disposable backend.");
const nativeFetch = globalThis.fetch;
globalThis.fetch = ((input: any, init: any) => nativeFetch(typeof input === "string" && input.startsWith("/v1") ? backend + input : input, init)) as typeof fetch;
assert.equal((await api.request("/documents")).documents.length, 0);
const document = await api.uploadDocument(new File(["Invoice # SYNTHETIC-1\nTotal due $50.00"], "hill-fixture.txt", { type: "text/plain" }));
await api.request(`/documents/${document.id}/ground-truth`, { method: "POST", body: JSON.stringify({ value: { total: 0 }, annotation_status: "complete" }) });
const dataset = await api.createDataset("Hill-climbing fixture", [document.id]);
// A local synthetic Chat Completions endpoint exercises both optimizer and
// extraction adapters, including full repeat evaluations, without hosted calls.
let plannerCalls = 0;
const variants = [
  "Read the final TOTAL label and exclude the subtotal when extracting total. Use the explicit labeled amount without adding line items.",
  "Use the statement balance explicitly labeled as the amount due for total. If subtotal and amount due disagree, the latter takes precedence.",
];
const mockProvider = createServer(async (request, response) => {
  if (request.method !== 'POST') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ data: [{ id: 'synthetic-extractor' }, { id: 'synthetic-planner' }] })); return; }
  let body = '';
  for await (const chunk of request) body += chunk;
  const payload = JSON.parse(body);
  let output;
  if (payload.model === 'synthetic-planner') {
    const index = plannerCalls++;
    output = { summary: { value: 'The total is confused with a different monetary role in the source.' }, concerns: { value: ['Synthetic fixture only; benchmark annotations remain unchanged.'] }, plans: { value: [{
      title: index === 0 ? 'Prefer the final total label' : 'Apply amount-due precedence',
      rationale: 'The extraction chooses a nearby amount instead of the field’s defined monetary role.',
      prediction: 'The labeled amount due should resolve the remaining total mismatch.',
      target_fields: ['total'], evidence_document_ids: [document.id],
      changes: [{ section: 'extraction', before: '', after: variants[index] }],
    }] } };
  } else {
    const text = JSON.stringify(payload.messages);
    const total = text.includes(variants[1]) ? 0 : text.includes(variants[0]) ? 40 : 50;
    output = { total: { value: total, confidence: .9 } };
  }
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }], usage: { prompt_tokens: 100, completion_tokens: 40 } }));
});
await new Promise<void>((resolve) => mockProvider.listen(0, '127.0.0.1', resolve));
const address = mockProvider.address() as { port: number };
const config = { ...defaultConfig, provider: 'openai-compatible', model: 'synthetic-extractor', baseUrl: `http://127.0.0.1:${address.port}/v1`, prompt: "Extract the total from the source.", schema: JSON.stringify({ type: "object", properties: { total: { type: "number" } } }) };
const baseline = (await api.runBenchmark(dataset.id, config, "Automatic loop baseline"))!;
assert.equal(baseline.score, 0);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
page.setDefaultTimeout(12000);
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await mkdir(".screenshots", { recursive: true });
  await page.goto(`${base}/#Hill%20climbing`);
  const panel = page.getByRole("region", { name: "Automatic hill climbing" });
  await expect(panel.getByRole("button", { name: /^Start (new )?loop$/ })).toBeEnabled();
  await expect(panel.getByLabel("Maximum candidate attempts")).toHaveValue("5");
  await expect(panel.getByLabel("Stop after no improvement")).toHaveValue("2");
  await panel.getByText('Advanced settings', { exact: true }).first().click();
  await expect(panel.getByLabel('Minimum gain (percentage points)')).toHaveValue('0.5');
  await expect(panel.getByLabel('Allowed regressed fields')).toHaveValue('2');
  await expect(panel.getByLabel('Confirmation rounds')).toHaveValue('1');
  await panel.getByLabel('Optimizer model · optional').fill('synthetic-planner');
  const response = page.waitForResponse((response) => new URL(response.url()).pathname === "/v1/hill-climbs" && response.request().method() === "POST");
  await panel.getByRole("button", { name: /^Start (new )?loop$/ }).click();
  const started = (await (await response).json()).hill_climb;
  assert.equal(started.baseline_run_id, baseline.id);
  // The backend owns progress; navigation and reload do not terminate the loop.
  await page.locator("aside").getByRole("button", { name: "Overview", exact: true }).click();
  await expect.poll(async () => (await api.request(`/hill-climbs/${started.id}`)).hill_climb.status).toBe("completed");
  const completed = (await api.request(`/hill-climbs/${started.id}`)).hill_climb;
  assert.equal(completed.iterations.length, 2);
  assert.deepEqual(completed.iterations.map((iteration: any) => iteration.status), ['rejected', 'accepted']);
  assert.notEqual(completed.best_run_id, baseline.id);
  assert.equal(completed.evaluation_count, 4);
  assert.equal(completed.iterations[1].verification_runs.length, 2);
  assert.equal(completed.iterations[1].comparisons[0].paired.net, 1);
  assert.equal(completed.planner_calls.length, 2);
  assert.equal(completed.version, 2);
  assert.equal(new Set(completed.iterations.map((i: any) => i.prompt)).size, 2);
  await page.goto(`${base}/#Hill%20climbing`);
  await expect(panel).toContainText("All scored benchmark fields passed.");
  await expect(panel.locator(".hill-loop-iteration")).toHaveCount(2);
  await panel.getByRole("button", { name: "Load best configuration" }).click();
  await expect(page.getByRole("textbox", { name: /^Extraction instructions/ })).toHaveValue(config.prompt + '\n\n' + variants[1]);
  await page.getByRole('tab', { name: 'Automatic', exact: true }).click();
  await panel.getByRole('button', { name: 'View attempt 2 details', exact: true }).click();
  const accepted = panel.locator('.hill-loop-iteration.accepted');
  await accepted.getByText('Exact prompt edits · 1 change(s)', { exact: true }).click();
  await expect(accepted.locator('.hill-prompt-diff')).toContainText(variants[1]);
  await accepted.getByText('Confirmation 1 vs fresh baseline:', { exact: false }).click();
  await expect(accepted).toContainText('1 fixed · 0 regressed');
  const evidence = accepted.locator('.hill-diagnosis');
  await evidence.locator('summary').first().click();
  await evidence.locator('.hill-cluster').first().locator('summary').first().click();
  await expect(evidence.locator('.hill-pattern').first()).toContainText('Expected');
  await page.screenshot({ path: ".screenshots/hill-loop-desktop.png", fullPage: true });
  await panel.getByRole("button", { name: "View attempt 1 details", exact: true }).click();
  await panel.getByRole("button", { name: "Inspect run", exact: true }).filter({ visible: true }).click();
  await expect(page).toHaveURL(new RegExp(`/run/${completed.iterations[0].run_id}`));
  await page.goto(`${base}/#Hill%20climbing`);
  await page.reload();
  await expect(panel.locator(".hill-loop-iteration")).toHaveCount(2);
  // Exercise the in-flight Stop UI deterministically; backend cancellation is also unit tested.
  const running = { ...completed, status: "running", reason: "Evaluating synthetic candidate", active_run_id: "synthetic-active" };
  let status = running;
  let stops = 0;
  await page.route(url => url.pathname === "/v1/hill-climbs", (route) => route.fulfill({ json: { hill_climbs: [status] } }));
  await page.route(url => url.pathname === `/v1/hill-climbs/${completed.id}/stop`, async (route) => {
    stops++;
    status = { ...running, status: "stopping", reason: "Stopping after the in-flight provider call." };
    await route.fulfill({ json: { hill_climb: status } });
  });
  await expect(panel.getByRole("button", { name: "Stop loop", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Dataset", exact: true })).toBeDisabled();
  await panel.getByRole("button", { name: "Stop loop", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(panel.getByRole("button", { name: "Stopping…", exact: true })).toBeDisabled();
  assert.equal(stops, 1);
  status = { ...completed, status: "stopped", reason: "Stopped by you." };
  await expect(panel).toContainText("Stopped by you.");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.locator("aside.sidebar").evaluate((el) => el.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: ".screenshots/hill-loop-mobile.png" });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []);
  const demo = await browser.newPage();
  await demo.goto(`${base}/?demo=1#Hill%20climbing`);
  await demo.getByRole("button", { name: "Simulate loop" }).click();
  await expect(demo.getByText("Demo complete: sample candidates tied the baseline, so the baseline was kept. No model was called.", { exact: true })).toBeVisible();
  await expect(demo.locator(".hill-loop-iteration")).toHaveCount(2);
  console.log("Hill climbing v2: local mock optimizer and extractor exercise rejected/confirmed candidates, evidence, edits, paired outcomes, persisted settings, navigation/reload, best configuration, cancellation UI, and mobile. No hosted calls.");
} finally {
  await browser.close();
  await new Promise<void>((resolve) => mockProvider.close(() => resolve()));
}
