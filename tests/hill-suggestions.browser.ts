import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import net from "node:net";
import { chromium, expect } from "@playwright/test";

// Every API request is intercepted; this suite never touches the workspace backend.
const listener = net.createServer();
await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
const port = (listener.address() as net.AddressInfo).port;
await new Promise<void>((resolve) => listener.close(() => resolve()));
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(port)], { stdio: "pipe" });
const ready = new Promise<void>((resolve, reject) => {
  server.stdout!.on("data", (data) => { if (String(data).includes("Local")) resolve(); });
  server.once("error", reject);
  server.once("exit", () => reject(new Error("Vite exited before starting")));
});
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
page.setDefaultTimeout(10000);
page.setDefaultNavigationTimeout(15000);
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
const version = { id: "v1", processor_id: "processor", version: 1,
  model: { provider: "local", name: "deterministic-local" }, parser: { name: "native" },
  prompt: { extraction: "Extract source-supported values." },
  schema: { type: "object", properties: { total: { type: "number" }, reference: { type: "string" } } },
};
const runs = ["Failures", "Passed", "Unscored", "Retry", "Delayed", "Mismatch", "Failed run"].map((name, i) => ({
  id: `run-${i}`, dataset_id: "benchmark", dataset: { name: "Synthetic benchmark" },
  eval_group_id: "group-a", status: name === "Failed run" ? "failed" : "completed", created_at: `2026-09-0${7-i}T10:00:00Z`,
  processor_version: version, metadata: { name }, metrics: { field_accuracy: i === 1 ? 1 : 0.5, documents: 2 },
}));
const detail = (run: typeof runs[number]) => ({ ...run,
  extractions: [0, 1].map((i) => ({ id: `ex-${i}`, document_id: `doc-${i}`,
    document: { id: `doc-${i}`, filename: `synthetic-${i}.txt`, content_type: "text/plain" },
    result: { fields: {} },
  })),
  evaluations: [0, 1].map((i) => ({ document_id: `doc-${i}`, extraction_id: `ex-${i}`, fields: {
    total: { status: run.id === "run-1" ? "correct" : run.id === "run-2" ? "unscored" : "incorrect", actual: 50, expected: i === 0 ? 0 : 40 },
    reference: { status: run.id === "run-1" ? "correct" : run.id === "run-2" ? "unscored" : i === 0 ? "missing" : "correct", actual: i ? "REF-2" : null, expected: "REF-2" },
  } })),
});
let fail = true;
let delayedRequested!: () => void;
const delayedRequest = new Promise<void>((resolve) => delayedRequested = resolve);
let releaseDelayed!: () => void;
const delay = new Promise<void>((resolve) => releaseDelayed = resolve);
await page.route("**/v1/**", async (route) => {
  const path = new URL(route.request().url()).pathname.slice(3);
  let json: any = {};
  if (path === "/hill-climbs") json = { hill_climbs: [] };
  else if (path === "/runs") json = { runs };
  else if (path === "/documents") json = { documents: [] };
  else if (path.endsWith("/source")) return route.fulfill({ contentType: "text/plain", body: "Synthetic fixture\nTotal: 0\nReference: REF-2" });
  else if (path === "/datasets") json = { datasets: [{ id: "benchmark", name: "Synthetic benchmark", document_count: 2 }, { id: "empty", name: "New dataset", document_count: 0 }] };
  else if (path === "/processors") json = { processors: [] };
  else if (path === "/eval-groups") json = { eval_groups: [{ id: "group-a", name: "Group A", dataset_id: "benchmark" }] };
  else if (path === "/adapters") json = { llm: [], parsers: [] };
  else if (path.startsWith("/runs/")) {
    const run = runs.find((r) => r.id === path.slice(6))!;
    if (run.id === "run-3" && fail) return route.fulfill({ status: 500, json: { error: "Temporary evidence failure" } });
    if (run.id === "run-4") { delayedRequested(); await delay; }
    json = { run: detail(run) };
    if (run.id === "run-5") json.run.dataset_id = "other-dataset";
  }
  return route.fulfill({ json });
});
async function select(name: string, value: string) {
  await page.getByRole("combobox", { name, exact: true }).click();
  await page.getByRole("option", { name: value, exact: true }).click();
}
try {
  await ready;
  console.log("Browser fixture server ready.");
  await mkdir(".screenshots", { recursive: true });
  await page.goto(`${base}/#Hill%20climbing`);
  await page.getByRole("tab", { name: "Manual experiment", exact: true }).click();
  await expect(page.getByText("total failed in 2 of 2 scored documents (2 incorrect).", { exact: true })).toBeVisible();
  const hypothesis = page.getByRole("textbox", { name: "Experiment hypothesis" });
  await expect(hypothesis).toHaveValue("");
  const total = page.locator(".hypothesis-card").filter({ has: page.getByRole("heading", { name: "Disambiguate total", exact: true }) });
  await total.getByRole("button", { name: "Use suggestion" }).click();
  const prompt = page.getByRole("textbox", { name: /^Extraction instructions/ });
  const firstPrompt = await prompt.inputValue();
  await total.getByRole("button", { name: "Applied to candidate" }).click();
  await expect(prompt).toHaveValue(firstPrompt);
  await page.locator(".hypothesis-card").filter({ has: page.getByRole("heading", { name: "Recover missing reference" }) }).getByRole("button", { name: "Use suggestion" }).click();
  assert(!(await prompt.inputValue()).includes('For the field "total"'), "Switching ideas must not stack experiments");
  await total.getByRole("button", { name: "Inspect 2 failed documents" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator(".hypothesis-values pre").nth(1)).toHaveText("0");
  await expect(page.locator(".hypothesis-source")).toContainText("Synthetic fixture");
  await page.screenshot({ path: ".screenshots/hill-suggestions-live-evidence.png" });
  await page.keyboard.press("Escape");
  await expect(total.getByRole("button", { name: "Inspect 2 failed documents" })).toBeFocused();
  await select("Baseline run", "Passed");
  await expect(page.getByText("No scored field failures found", { exact: true })).toBeVisible();
  await expect(hypothesis).toHaveValue("");
  await expect(prompt).toHaveValue(version.prompt.extraction);
  await select("Baseline run", "Unscored");
  await expect(page.getByText("No scored field evidence available", { exact: true })).toBeVisible();
  await select("Baseline run", "Retry");
  await expect(page.getByRole("button", { name: "Retry evidence" })).toBeVisible();
  assert.equal(await page.locator(".hypothesis-card").count(), 0);
  fail = false;
  await page.getByRole("button", { name: "Retry evidence" }).click();
  await expect(total).toBeVisible();
  await select("Baseline run", "Delayed");
  await delayedRequest;
  await expect(page.getByText("Finding patterns in evaluation results…", { exact: true })).toBeVisible();
  await select("Baseline run", "Passed");
  releaseDelayed();
  await expect(page.getByText("No scored field failures found", { exact: true })).toBeVisible();
  assert.equal(await page.locator(".hypothesis-card").count(), 0);
  await select("Baseline run", "Mismatch");
  await expect(page.getByRole("alert")).toContainText("do not match this baseline and dataset");
  await select("Baseline run", "Failed run");
  await expect(page.locator(".hypotheses")).toContainText("This baseline did not complete");
  await select("Dataset", "New dataset");
  await expect(page.getByText("Starter suggestion", { exact: true })).toBeVisible();
  await expect(page.locator(".hypotheses")).toContainText("not an observed failure");
  await select("Dataset", "Synthetic benchmark");
  await expect(total).toBeVisible();
  await page.screenshot({ path: ".screenshots/hill-suggestions-live-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.locator("aside.sidebar").evaluate((el) => el.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
  await page.locator(".hypotheses").scrollIntoViewIfNeeded();
  await page.screenshot({ path: ".screenshots/hill-suggestions-mobile.png" });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Mobile must not overflow horizontally");
  await total.getByRole("button", { name: "Inspect 2 failed documents" }).click();
  await expect(page.locator(".hypothesis-source")).toContainText("Synthetic fixture");
  await page.screenshot({ path: ".screenshots/hill-suggestions-mobile-evidence.png" });
  assert.deepEqual(errors, []);
  console.log("Hill suggestions browser: live evidence, source inspection, candidate isolation, baseline/dataset switching, retry, stale request cancellation, keyboard focus, and mobile passed.");
} finally {
  releaseDelayed();
  await browser.close();
  server.kill("SIGTERM");
}
