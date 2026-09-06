import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
const base = process.env.STUDIO_BROWSER_URL;
if (!base || process.env.STUDIO_TEST_DISPOSABLE !== "1")
  throw new Error("Use the isolated test:e2e or test:package runner.");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1512, height: 1000 } });
page.setDefaultTimeout(10000);
page.setDefaultNavigationTimeout(15000);
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
const api = async (path: string) =>
  (await page.request.get(`${base}/v1${path}`)).json();
async function select(name: string, label: string) {
  await page.getByRole("combobox", { name, exact: true }).click();
  await page.getByRole("option", { name: label, exact: true }).click();
}
async function nav(name: string) {
  await page
    .locator("aside")
    .getByRole("button", { name, exact: true })
    .click();
}
const schema = {
  type: "object",
  properties: { invoice_number: { type: "string" }, total: { type: "number" } },
  required: ["invoice_number", "total"],
};
try {
  assert.equal(
    (await api("/documents")).documents.length,
    0,
    "Browser tests require an empty disposable workspace",
  );
  await page.goto(`${base}/#Processors`);
  await expect(
    page.getByText("Local API connected", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "New processor", exact: true })
    .click();
  await page
    .getByLabel("Processor name", { exact: true })
    .fill("Browser invoice extraction");
  await page
    .getByPlaceholder("What documents does this processor handle?")
    .fill("Browser-tested processor");
  await page.getByRole("button", { name: "Create & customize" }).click();
  await expect(
    page.getByRole("heading", {
      name: "Browser invoice extraction",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Edit JSON", exact: true }).click();
  await page.getByLabel("Schema JSON").fill(JSON.stringify(schema));
  await page.getByRole("button", { name: "Apply JSON", exact: true }).click();
  await page
    .getByRole("heading", { name: "Extraction settings", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Model provider", exact: true }),
  ).toContainText("Local deterministic");
  await expect(
    page.getByRole("combobox", { name: "Document parser", exact: true }),
  ).toContainText("Native text");
  // Model checks use mocked provider responses; extraction stays deterministic.
  let catalogChecks = 0;
  await page.route("**/v1/model-catalog?*", async route => {
    catalogChecks++;
    await route.fulfill({ json: catalogChecks === 3 ? {
      source: "built-in", fetched_at: new Date().toISOString(),
      warnings: ["Provider returned HTTP 401 while listing models."],
      models: [{ id: "gpt-6-astra", name: "gpt-6-astra" }],
    } : {
      source: "provider", fetched_at: new Date().toISOString(), warnings: [],
      models: [{ id: "gpt-6-astra", name: "gpt-6-astra" },
        ...(catalogChecks > 1 ? [{ id: "future-model", name: "Future model" }] : [])],
    } });
  });
  await select("Model provider", "OpenAI");
  await expect(page.getByRole("status").filter({ hasText: "1 models available" })).toBeVisible();
  await page.getByLabel("Model ID", { exact: true }).fill("my-pinned-model");
  await page.getByRole("button", { name: "Check for new models" }).click();
  await expect(page.getByRole("status").filter({ hasText: "2 models available" })).toBeVisible();
  await expect(page.getByLabel("Model ID", { exact: true })).toHaveValue("my-pinned-model");
  await select("Available models", "Future model");
  await expect(page.getByLabel("Model ID", { exact: true })).toHaveValue("future-model");
  await page.getByRole("button", { name: "Check for new models" }).click();
  await expect(page.getByRole("status").filter({ hasText: "HTTP 401" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Available models" })).toContainText("Future model");
  await page.getByRole("combobox", { name: "Available models" }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Model ID", { exact: true })).toBeFocused();
  await mkdir(".screenshots", { recursive: true });
  await page.screenshot({ path: ".screenshots/model-picker-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".model-picker").screenshot({ path: ".screenshots/model-picker-mobile.png", animations: "disabled" });
  assert.ok(await page.locator(".model-picker").evaluate(element => element.getBoundingClientRect().width > 250));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.setViewportSize({ width: 1512, height: 1000 });
  await select("Model provider", "Local deterministic");
  await page.unroute("**/v1/model-catalog?*");
  await page
    .getByLabel("Extraction instructions")
    .fill("Extract invoice number and total. Preserve numbers.");
  await page.getByRole("button", { name: /Save.*version/i }).click();
  await expect(
    page.getByText(/Saved Browser invoice extraction · version 2/),
  ).toBeVisible();
  const processor = (await api("/processors")).processors.find(
    (p: any) => p.name === "Browser invoice extraction",
  );
  assert.equal(processor.versions[0].schema.properties.total.type, "number");
  await nav("Datasets");
  await page
    .getByRole("button", { name: "Add documents", exact: true })
    .first()
    .click();
  await page.locator('input[type="file"]').setInputFiles({
    name: "browser-invoice.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Invoice # INV-2026-500\nTotal due $75.00\n"),
  });
  await expect(
    page.getByRole("button", { name: "Run extraction", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Configure", exact: true }).click();
  await page
    .getByRole("button", { name: "Run extraction", exact: true })
    .click();
  await expect(page.getByRole("tab", { name: /Results/ })).toHaveAttribute(
    "data-state",
    "active",
  );
  await expect(
    page.getByRole("region", {
      name: "Processor source document",
      exact: true,
    }),
  ).toContainText("INV-2026-500");
  await expect(page.locator(".processor-workspace-editor")).toContainText("75");
  await mkdir("test-results", { recursive: true });
  await page.screenshot({
    path: "test-results/live-processor-results.png",
    fullPage: true,
  });
  await nav("Playground");
  await page
    .getByRole("button", { name: "Edit ground truth", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Expected values", exact: true })
    .fill(JSON.stringify({ invoice_number: "INV-2026-500", total: 80 }));
  await select("Expected values dataset", "Create a new dataset…");
  await page
    .getByPlaceholder("e.g. Invoice regression cases")
    .fill("Browser invoice benchmark");
  await page
    .getByRole("button", { name: "Add document & ground truth", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Browser invoice benchmark" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("Local API connected", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Edit ground truth", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Expected values", exact: true }),
  ).toHaveValue(/80/);
  await page.getByRole("dialog").getByRole("button", {name:"Close",exact:true}).click();
  await nav("Evaluations");
  await page.getByRole("button", { name: "New group", exact: true }).click();
  await page
    .getByLabel("Group name", { exact: true })
    .fill("Browser invoice iterations");
  await page.getByRole("button", { name: "Create group", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Browser invoice iterations",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "New experiment", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("combobox", { name: "Evaluation group", exact: true }),
  ).toBeDisabled();
  await page
    .getByLabel("Experiment name", { exact: true })
    .fill("Browser baseline");
  await select("Processor configuration", "Browser invoice extraction · v2");
  await page
    .getByRole("button", { name: "Run evaluation", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect
    .poll(
      async () =>
        (await api("/runs")).runs.find(
          (r: any) => r.metadata?.name === "Browser baseline",
        )?.status,
    )
    .toBe("completed");
  const run = (await api("/runs")).runs.find(
    (r: any) => r.metadata?.name === "Browser baseline",
  );
  assert.equal(run.metrics.field_accuracy, 0.5);
  await page
    .getByRole("link", { name: "Browser baseline", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Browser baseline", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: `Run ${run.id.slice(-8)}`, exact: false })
    .click();
  await expect(
    page.getByRole("heading", { name: `Run ${run.id.slice(-8)}`, exact: true }),
  ).toBeVisible();
  await expect(page.locator(".evaluation-results-page")).toContainText("total");
  await page
    .getByRole("button", { name: "Review fields", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "total", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Reviewed value", { exact: true }).fill("80");
  await page
    .getByLabel("Reviewer note", { exact: false })
    .fill("Browser review confirmed against source");
  await page
    .getByRole("button", { name: "Save correction", exact: true })
    .click();
  await expect(
    page.getByText("1 decisions saved", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("1 decisions saved", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "All fields", exact: true }).click();
  await page.getByRole("button", { name: "Skip for now", exact: true }).click();
  await expect(page.getByLabel("Reviewed value", { exact: true })).toHaveValue(
    "80",
  );
  await expect(page.getByLabel("Reviewer note", { exact: false })).toHaveValue(
    "Browser review confirmed against source",
  );
  const decisions = await api(`/runs/${run.id}/reviews`);
  assert.equal(decisions.review_decisions[0].corrected_value, 80);
  await page.screenshot({
    path: "test-results/live-review.png",
    fullPage: true,
  });
  await nav("Hill climbing");
  await expect(
    page.getByRole("combobox", { name: "Baseline run", exact: true }),
  ).toContainText("Browser baseline");
  await page.getByLabel("Experiment hypothesis").fill("Browser candidate");
  await page
    .getByLabel("Extraction instructions")
    .fill("Extract exact invoice number and total. Retain decimal precision.");
  await page
    .getByRole("button", { name: "Run candidate on benchmark", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Evaluation groups", exact: true }),
  ).toBeVisible();
  await expect
    .poll(
      async () =>
        (await api("/runs")).runs.find(
          (r: any) => r.metadata?.name === "Browser candidate",
        )?.status,
    )
    .toBe("completed");
  const candidate = (await api("/runs")).runs.find(
    (r: any) => r.metadata?.name === "Browser candidate",
  );
  assert.equal(candidate.processor_version.processor_id, processor.id);
  assert.equal(candidate.eval_group_id, run.eval_group_id);
  assert.notEqual(candidate.processor_version.id, run.processor_version.id);
  await page
    .getByRole("link", {
      name: /Browser invoice iterations Browser invoice benchmark/,
    })
    .click();
  await page
    .getByRole("checkbox", { name: "Compare Browser baseline", exact: true })
    .check();
  await page
    .getByRole("checkbox", { name: "Compare Browser candidate", exact: true })
    .check();
  await page.getByRole("button", { name: "Compare (2)", exact: true }).click();
  await expect(page.locator(".eval-comparison")).toContainText(
    "Retain decimal precision.",
  );
  await expect(page.locator(".eval-comparison")).toContainText("0.0 pts");
  await page.screenshot({
    path: "test-results/live-comparison.png",
    fullPage: true,
  });
  await nav("Datasets");
  await page
    .getByRole("button", { name: /Browser invoice benchmark.*1 documents/ })
    .click();
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export manifest", exact: true })
    .click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  let manifestText = "";
  for await (const chunk of stream!) manifestText += chunk;
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.documents[0].ground_truth.total, 80);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Add documents", exact: true })
    .first()
    .click();
  await page
    .locator('input[type="file"]')
    .setInputFiles("public/samples/invoice-0.pdf");
  await expect(page.locator(".actual-pdf-viewer img").first()).toBeVisible({
    timeout: 20000,
  });
  await expect
    .poll(() =>
      page
        .locator(".actual-pdf-viewer img")
        .first()
        .evaluate(
          (img: HTMLImageElement) => img.complete && img.naturalWidth > 0,
        ),
    )
    .toBe(true);
  await expect(page.locator(".source-pane")).toContainText("invoice-0.pdf");
  await page.screenshot({ path: "test-results/live-pdf.png", fullPage: true });
  // Offline startup must expose retry, never silently substitute sample data.
  await page.route("**/v1/ready", (route) => route.abort());
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Your local backend is unavailable" }),
  ).toBeVisible();
  await expect(
    page.getByRole("banner").getByText("API offline", { exact: true }),
  ).toBeVisible();
  await page.unroute("**/v1/ready");
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect(
    page.getByText("Local API connected", { exact: true }),
  ).toBeVisible();

  // Persist generation controls without calling a hosted model.
  await page.route("**/v1/model-catalog?*", route => route.fulfill({ json: {
    source: "built-in", fetched_at: new Date().toISOString(), warnings: ["Test catalog"], models: [],
  } }));
  await nav("Processors");
  await page.getByRole("button", { name: "New processor", exact: true }).click();
  await page.getByLabel("Processor name", { exact: true }).fill("Model settings test");
  await page.getByRole("button", { name: "Create & customize" }).click();
  await page.getByRole("heading", { name: "Extraction settings", exact: true }).click();
  await select("Model provider", "OpenAI");
  await page.getByLabel("Model ID", { exact: true }).fill("gpt-5.6-terra");
  await select("Reasoning effort", "High");
  await page.getByLabel("Output token limit", { exact: true }).fill("8192");
  await select("Response verbosity", "Low");
  await select("Output format", "Strict JSON schema");
  await page.getByLabel("System instructions", { exact: true }).fill("Extract carefully.");
  await expect(page.getByLabel("Temperature", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: /Save.*version/i }).click();
  await expect(page.getByText(/Saved Model settings test · version 2/)).toBeVisible();
  let settingsProcessor = (await api("/processors")).processors.find((p: any) => p.name === "Model settings test");
  assert.equal(settingsProcessor.versions[0].prompt.reasoning_effort, "high");
  assert.equal(settingsProcessor.versions[0].prompt.max_tokens, 8192);
  assert.equal(settingsProcessor.versions[0].prompt.structured_outputs, true);
  await page.reload();
  await page.getByRole("heading", { name: "Extraction settings", exact: true }).click();
  await expect(page.getByLabel("Reasoning effort", { exact: true })).toContainText("High");
  await expect(page.getByLabel("Output token limit", { exact: true })).toHaveValue("8192");
  await page.locator(".model-settings").screenshot({ path: "test-results/model-settings-desktop.png", animations: "disabled" });
  await page.getByRole("combobox", { name: "Reasoning effort", exact: true }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("option", { name: "High", exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/dropdown-desktop.png", animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("combobox", { name: "Reasoning effort", exact: true })).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".model-settings").screenshot({ path: "test-results/model-settings-mobile.png", animations: "disabled" });
  await page.getByRole("combobox", { name: "Reasoning effort", exact: true }).click();
  await expect(page.getByRole("option", { name: "Provider default", exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/dropdown-mobile.png", animations: "disabled" });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1512, height: 1000 });
  await page.getByRole("button", { name: "Reset model settings" }).click();
  await page.getByRole("button", { name: /Save.*version/i }).click();
  await expect(page.getByText(/Saved Model settings test · version 3/)).toBeVisible();
  settingsProcessor = (await api("/processors")).processors.find((p: any) => p.name === "Model settings test");
  assert.equal(settingsProcessor.versions[0].prompt.reasoning_effort, undefined);
  assert.equal(settingsProcessor.versions[1].prompt.reasoning_effort, "high");
  await select("Model provider", "Anthropic");
  await select("Reasoning effort", "Max");
  await expect(page.getByLabel("Temperature", { exact: true })).toHaveCount(0);
  await select("Model provider", "Google Gemini");
  await expect(page.getByLabel("Reasoning effort", { exact: true })).toContainText("Provider default");
  await select("Reasoning effort", "Low");
  await page.getByLabel("Output token limit", { exact: true }).fill("0");
  await expect(page.getByRole("alert").filter({ hasText: "Output token limit must" })).toBeVisible();
  await page.unroute("**/v1/model-catalog?*");
  assert.deepEqual(errors, []);
  console.log(
    "PASS: Browser through the served application: processor/schema save, upload, side-by-side extraction, ground-truth reload, dataset creation, grouped evaluation, correction persistence, hill-climbing iterations, comparisons, annotated manifests, PDF rendering, and offline/reconnect.",
  );
} catch (error) {
  await mkdir("test-results", { recursive: true });
  await page.screenshot({
    path: "test-results/browser-failure.png",
    fullPage: true,
  });
  console.error((await page.locator("main").innerText()).slice(-6500));
  throw error;
} finally {
  await browser.close();
}
