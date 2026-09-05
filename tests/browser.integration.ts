import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
const base = process.env.STUDIO_BROWSER_URL;
if (!base) throw new Error("Use npm run test:e2e for an isolated workspace.");
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
  await page
    .getByRole("button", { name: "Save ground truth", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByText("Local API connected", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Edit ground truth", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Expected values", exact: true }),
  ).toContainText("80");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await nav("Datasets");
  await page.getByRole("button", { name: "New dataset", exact: true }).click();
  await page.getByLabel("Dataset name").fill("Browser invoice benchmark");
  await page
    .getByRole("checkbox", { name: "browser-invoice.txt", exact: true })
    .check();
  await page
    .getByRole("button", { name: "Create dataset", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await nav("Evaluations");
  await page
    .getByRole("button", { name: "New evaluation", exact: true })
    .click();
  await select("Evaluation group", "Create a new group…");
  await page.getByLabel("Group name").fill("Browser invoice iterations");
  await page
    .getByLabel("Experiment name", { exact: true })
    .fill("Browser baseline");
  await select("Benchmark dataset", "Browser invoice benchmark (1 documents)");
  await select("Processor configuration", "Browser invoice extraction · v2");
  await page
    .getByRole("button", { name: "Run evaluation", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const run = (await api("/runs")).runs.find(
    (r: any) => r.metadata?.name === "Browser baseline",
  );
  assert.equal(run.metrics.field_accuracy, 0.5);
  await page
    .getByRole("button", { name: "Browser baseline", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Browser baseline", exact: true }),
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
    page.getByRole("heading", { name: "Evaluations", exact: true }),
  ).toBeVisible();
  const candidate = (await api("/runs")).runs.find(
    (r: any) => r.metadata?.name === "Browser candidate",
  );
  assert.equal(candidate.processor_version.processor_id, processor.id);
  assert.equal(candidate.eval_group_id, run.eval_group_id);
  assert.notEqual(candidate.processor_version.id, run.processor_version.id);
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
  assert.deepEqual(errors, []);
  console.log(
    "PASS: Chromium UI through Vite proxy: processor/schema save, upload, side-by-side extraction, ground-truth reload, dataset creation, grouped evaluation, correction persistence, hill-climbing iterations, comparisons, annotated manifests, PDF rendering, and offline/reconnect.",
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
