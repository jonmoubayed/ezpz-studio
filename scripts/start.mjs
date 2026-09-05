import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { loadEnv } from "vite";

const root = path.resolve(import.meta.dirname, "..");
const env = { ...loadEnv("development", root, ""), ...process.env };
const backend = path.resolve(
  env.EZPZ_BACKEND_REPO || root,
);
const endpoint = new URL(env.EZPZ_API_URL || "http://127.0.0.1:4173");
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  process.exitCode = code;
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
async function ready() {
  try {
    return (
      await fetch(new URL("/v1/ready", endpoint), {
        signal: AbortSignal.timeout(1000),
      })
    ).ok;
  } catch {
    return false;
  }
}
try {
  if (!(await ready())) {
    if (!["127.0.0.1", "localhost"].includes(endpoint.hostname))
      throw new Error(
        `Start the configured backend at ${endpoint.origin} before launching Studio.`,
      );
    await access(path.join(backend, "backend/server.py"));
    let python = env.EZPZ_PYTHON || "python3";
    if (!env.EZPZ_PYTHON) {
      try {
        await access(path.join(backend, ".venv/bin/python"));
        python = path.join(backend, ".venv/bin/python");
      } catch {}
    }
    const server = spawn(
      python,
      [
        "-m",
        "backend.server",
        "--root",
        backend,
        "--host",
        "127.0.0.1",
        "--port",
        endpoint.port || "4173",
      ],
      {
        cwd: backend,
        env: { ...process.env, PYTHONPATH: backend },
        stdio: "inherit",
      },
    );
    children.push(server);
    server.on("error", (error) => {
      console.error(error.message);
      stop(1);
    });
    server.on("exit", (code) => {
      if (!stopping) {
        console.error(
          "Backend stopped. Check its Python requirements and configuration.",
        );
        stop(code || 1);
      }
    });
    let connected = false;
    for (let i = 0; i < 50 && !stopping; i++) {
      if (await ready()) {
        connected = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!connected || stopping)
      throw new Error(
        "Backend did not become ready. Set EZPZ_PYTHON to your backend virtualenv Python.",
      );
  }
  console.log(`Local API ready at ${endpoint.origin}`);
  const frontend = spawn(
    process.execPath,
    [
      path.join(root, "node_modules/vite/bin/vite.js"),
      "--host",
      "127.0.0.1",
      "--port",
      env.EZPZ_STUDIO_PORT || "5180",
    ],
    {
      cwd: root,
      env: { ...process.env, EZPZ_API_URL: endpoint.origin },
      stdio: "inherit",
    },
  );
  children.push(frontend);
  frontend.on("error", (error) => {
    console.error(error.message);
    stop(1);
  });
  frontend.on("exit", (code) => stop(code || 0));
} catch (error) {
  console.error(error.message);
  stop(1);
}
