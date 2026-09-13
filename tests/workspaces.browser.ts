import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
const root = path.resolve(import.meta.dirname, "..");
const directory = await mkdtemp(path.join(tmpdir(), "ezpz-workspaces-"));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("EZPZ_") && key !== "DATABASE_URL"));
const server = spawn("python3", ["-u", "-c", `from backend.server import make_server\nfrom pathlib import Path\ns=make_server(Path(${JSON.stringify(directory)}),port=0,static_root=Path(${JSON.stringify(path.join(root, "dist"))}))\nprint(s.server_port,flush=True)\ns.serve_forever()`], { cwd: root, env: { ...env, EZPZ_SEED_DEMO: "false" }, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "";
server.stderr.on("data", chunk => serverLog += chunk);
const port = await new Promise<string>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(serverLog || "Server did not start")), 120000);
  server.stdout.once("data", chunk => { clearTimeout(timer); resolve(String(chunk).trim()); });
  server.once("exit", () => { clearTimeout(timer); reject(new Error(serverLog)); });
});
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
const page = await context.newPage();
const errors: string[] = [];
page.on("pageerror", error => errors.push(error.message));
async function switcher() { await page.getByRole("button", { name: /^Switch workspace:/ }).click(); }
async function create(name: string) {
  await switcher();
  await page.getByLabel("Create a workspace", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Create workspace", exact: true }).click();
  await expect(page.getByRole("button", { name: `Switch workspace: ${name}`, exact: true })).toBeVisible();
}
async function choose(name: string) {
  await switcher();
  await page.locator(".workspace-choice").filter({ hasText: name }).click();
  await expect(page.getByRole("button", { name: `Switch workspace: ${name}`, exact: true })).toBeVisible();
}
try {
  await page.goto(base);
  await expect(page.getByText("Local API connected", { exact: true })).toBeVisible();
  const originalTab = await context.newPage();
  await originalTab.goto(base);
  await expect(originalTab).toHaveURL(/workspace=ws_local/);
  await page.evaluate(() => localStorage.setItem("ezpz-live-config:scratch", JSON.stringify({ prompt: "Original draft" })));
  await create("Finance");
  const workspace = new URL(page.url()).searchParams.get("workspace")!;
  assert.notEqual(workspace, "ws_local");
  for (const collection of ["documents", "datasets", "processors", "runs"]) {
    const data = await (await page.request.get(`${base}/v1/${collection}?workspace_id=${workspace}`)).json();
    assert.equal(data[collection].length, 0);
  }
  await originalTab.reload();
  await expect(originalTab.getByRole("button", { name: "Switch workspace: My workspace", exact: true })).toBeVisible();
  await originalTab.close();
  await page.locator("aside").getByRole("button", { name: "Processors", exact: true }).click();
  await page.getByRole("button", { name: "New processor", exact: true }).click();
  await page.getByLabel("Processor name", { exact: true }).fill("Finance processor");
  await page.getByRole("button", { name: "Create & customize" }).click();
  await expect(page.getByRole("heading", { name: "Finance processor", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit JSON", exact: true }).click();
  await page.getByLabel("Schema JSON", { exact: true }).fill(JSON.stringify({ type: "object", properties: { account_number: { type: "string" } } }));
  await page.getByRole("button", { name: "Apply JSON", exact: true }).click();
  await choose("My workspace");
  await page.locator("aside").getByRole("button", { name: "Processors", exact: true }).click();
  await expect(page.getByText("Finance processor", { exact: true })).toHaveCount(0);
  await choose("Finance");
  await page.locator("aside").getByRole("button", { name: "Processors", exact: true }).click();
  await expect(page.getByText("Finance processor", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit Finance processor", exact: true }).click();
  await page.getByRole("button", { name: "Edit JSON", exact: true }).click();
  await expect(page.getByLabel("Schema JSON", { exact: true })).toHaveValue(/account_number/);
  await switcher();
  await page.getByRole("button", { name: "Rename Finance", exact: true }).click();
  await page.getByLabel("Rename workspace", { exact: true }).fill("Accounts");
  await page.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(page.getByRole("button", { name: "Accounts Current workspace", exact: true })).toBeVisible();
  await page.getByLabel("Create a workspace", { exact: true }).fill("accounts");
  await page.getByRole("button", { name: "Create workspace", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("already exists");
  await page.reload();
  await expect(page.getByRole("button", { name: "Switch workspace: Accounts", exact: true })).toBeVisible();
  await switcher();
  await mkdir(path.join(root, "artifacts/workspaces"), { recursive: true });
  await page.screenshot({ path: path.join(root, "artifacts/workspaces/desktop.png") });
  await page.getByRole("dialog").press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await switcher();
  await expect(page.getByRole("dialog")).toBeVisible();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(root, "artifacts/workspaces/mobile.png") });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(`${base}/?demo=1&workspace=ws_local`);
  await create("Demo experiments");
  await page.reload();
  await expect(page.getByRole("button", { name: "Switch workspace: Demo experiments", exact: true })).toBeVisible();
  await page.goto(base);
  await expect(page.getByRole("button", { name: "Switch workspace: Accounts", exact: true })).toBeVisible();
  await page.goto(`${base}/?demo=1`);
  await expect(page.getByRole("button", { name: "Switch workspace: Demo experiments", exact: true })).toBeVisible();
  await choose("My workspace");
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log("Workspace browser checks passed: create, isolation, rename, duplicate validation, persistence, drafts, tabs, mobile, demo.");
} finally {
  await browser.close();
  server.kill("SIGTERM");
  await new Promise(resolve => server.once("exit", resolve));
  await rm(directory, { recursive: true, force: true });
}
