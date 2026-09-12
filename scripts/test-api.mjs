import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
const root = await mkdtemp(path.join(tmpdir(), "ezpz-frontend-integration-"));
async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}
const port = await freePort();
const backend = path.resolve(process.env.EZPZ_BACKEND_REPO || ".");
let python = process.env.EZPZ_TEST_PYTHON || "python3";
if (!process.env.EZPZ_TEST_PYTHON) {
  const localPython = path.join(backend, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");
  try { await access(localPython); python = localPython; } catch {}
}
const server = spawn(
  python,
  ["-m", "backend.server", "--root", root, "--port", String(port)],
  {
    env: {
      ...process.env,
      PYTHONPATH: backend,
      EZPZ_DATABASE_URL: `sqlite:///${root}/test.db`,
      EZPZ_BLOB_ROOT: path.join(root, "blobs"),
      EZPZ_SEED_DEMO: "false",
    },
    stdio: ["ignore", "ignore", "pipe"],
  },
);
let serverErrors = "";
server.stderr.on("data", (d) => (serverErrors += d));
server.on("error", (e) => (serverErrors += e.message));
let preview;
async function waitFor(url) {
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch(url);
      await response.arrayBuffer();
      if (response.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Test server did not start: ${url}\n${serverErrors}`);
}
async function run(file, env = {}) {
  const test = spawn(
    path.resolve("node_modules/.bin/tsx"),
    ["--tsconfig", path.resolve("tsconfig.json"), file],
    {
      env: {
        ...process.env,
        STUDIO_TEST_URL: `http://127.0.0.1:${port}`,
        ...env,
      },
      stdio: "inherit",
    },
  );
  const result = await new Promise((resolve, reject) => {
    test.on("exit", resolve);
    test.on("error", reject);
  });
  if (result !== 0) throw new Error(`${file} failed`);
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}
try {
  await waitFor(`http://127.0.0.1:${port}/v1/ready`);
  if (process.argv.includes("--browser") || process.argv.includes("--harness") || process.argv.includes("--mcp-browser")) {
    const browserPort = await freePort();
    const browserUrl = `http://127.0.0.1:${browserPort}`;
    preview = spawn(
      process.execPath,
      [
        "node_modules/vite/bin/vite.js",
        ...(process.argv.includes("--harness") ? [] : ["preview"]),
        "--host",
        "127.0.0.1",
        "--port",
        String(browserPort),
        "--strictPort",
      ],
      {
        env: { ...process.env, EZPZ_API_URL: `http://127.0.0.1:${port}` },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    preview.stderr.on("data", (d) => (serverErrors += d));
    await waitFor(`${browserUrl}/v1/ready`);
    await run(process.argv.includes("--mcp-browser") ? "tests/mcp.browser.ts" : process.argv.includes("--harness") ? "tests/harness.browser.ts" : "tests/browser.integration.ts", {
      STUDIO_BROWSER_URL: browserUrl,
      STUDIO_TEST_DISPOSABLE: "1",
    });
  } else {
    await run("tests/api.integration.ts");
    await run("tests/store.integration.tsx");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await stop(preview);
  await stop(server);
  await rm(root, { recursive: true, force: true });
}
