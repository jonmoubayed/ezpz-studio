// Validate the exact container image with disposable volumes; never touch live data.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
const image = process.env.EZPZ_TEST_IMAGE || "ezpz-studio:0.1.0-beta.1";
const name = `ezpz-package-test-${process.pid}`;
const volume = `${name}-data`,
  restored = `${name}-restored`;
const backup = await mkdtemp(path.join(tmpdir(), "ezpz-package-backup-"));
const containers = [name, `${name}-restore`];
async function command(cmd, args, inherit = false, env = {}) {
  const child = spawn(cmd, args, {
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  let output = "";
  if (!inherit) {
    child.stdout.on("data", (b) => (output += b));
    child.stderr.on("data", (b) => (output += b));
  }
  const code = await new Promise((resolve, reject) => {
    child.on("exit", resolve);
    child.on("error", reject);
  });
  if (code !== 0)
    throw new Error(
      `${cmd} ${args.slice(0, 2).join(" ")} failed (${code}): ${output}`,
    );
  return output.trim();
}
const docker = (...args) => command("docker", args);
async function ready(base) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/v1/ready`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Packaged API did not become ready");
}
async function start(container, data) {
  await docker(
    "run",
    "-d",
    "--name",
    container,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--tmpfs",
    "/tmp:mode=1777",
    "-v",
    `${data}:/data`,
    "-p",
    "127.0.0.1::4173",
    image,
  );
  const port = (await docker("port", container, "4173/tcp")).split(":").at(-1);
  const base = `http://127.0.0.1:${port}`;
  await ready(base);
  return base;
}
async function state(base) {
  const resources = await Promise.all(
    ["documents", "datasets", "processors", "runs"].map(async (key) => [
      key,
      await (await fetch(`${base}/v1/${key}`)).json(),
    ]),
  );
  return Object.fromEntries(resources);
}
try {
  let base = await start(name, volume);
  const html = await (await fetch(base)).text();
  if (!html.includes('<div id="root">'))
    throw new Error("Image does not serve the built studio");
  for (const file of [
    "/.env",
    "/backend/server.py",
    "/requirements.lock",
    "/data/ezpz.db",
    "/%2eenv",
  ]) {
    const response = await fetch(base + file);
    if (![403, 404].includes(response.status))
      throw new Error(`Private file path was not denied: ${file}`);
  }
  for (const asset of [
    ...html.matchAll(/(?:src|href)="([^" ]+\.(?:js|css))"/g),
  ].map((m) => m[1])) {
    if (!(await fetch(new URL(asset, base))).ok)
      throw new Error(`Packaged asset missing: ${asset}`);
  }
  console.log(
    "PASS: non-root container serves the built studio; private paths are denied.",
  );
  await command(
    process.execPath,
    ["node_modules/tsx/dist/cli.mjs", "tests/browser.integration.ts"],
    true,
    { STUDIO_BROWSER_URL: base, STUDIO_TEST_DISPOSABLE: "1" },
  );
  const before = await state(base);
  const pending = await docker(
    "exec",
    name,
    "python",
    "-c",
    "from pathlib import Path; from backend.server import create_runtime; r=create_runtime(Path('/data')); p=r.database.list_processors()[0]; d=r.database.list_documents()[0]; print(r.database.create_run(p['versions'][0]['id'], 'document', document_id=d['id'])['id'])",
  );
  await docker("restart", "--time", "2", name);
  base = `http://127.0.0.1:${(await docker("port", name, "4173/tcp")).split(":").at(-1)}`;
  await ready(base);
  const after = await state(base);
  for (const key of ["documents", "datasets", "processors"]) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key]))
      throw new Error(`${key} changed after container restart`);
  }
  const interrupted = after.runs.runs.find((r) => r.id === pending);
  if (interrupted?.status !== "interrupted")
    throw new Error("Unfinished run was not recovered as interrupted");
  for (const run of before.runs.runs) {
    if (
      JSON.stringify(run) !==
      JSON.stringify(after.runs.runs.find((r) => r.id === run.id))
    )
      throw new Error("Saved run changed after restart");
  }
  console.log(
    "PASS: restart preserves documents, annotations, processors, and runs; interrupted work is identified.",
  );
  await docker("stop", "--time", "2", name);
  await docker(
    "run",
    "--rm",
    "--user",
    "0",
    "-v",
    `${volume}:/data:ro`,
    "-v",
    `${backup}:/backup`,
    "--entrypoint",
    "python",
    image,
    "-c",
    "import tarfile; t=tarfile.open('/backup/workspace.tar.gz','w:gz'); t.add('/data',arcname='.'); t.close()",
  );
  await docker("volume", "create", restored);
  await docker(
    "run",
    "--rm",
    "--user",
    "0",
    "-v",
    `${restored}:/data`,
    "-v",
    `${backup}:/backup:ro`,
    "--entrypoint",
    "python",
    image,
    "-c",
    "import tarfile, pathlib, os; t=tarfile.open('/backup/workspace.tar.gz'); t.extractall('/data',filter='data'); t.close(); [os.chown(p,10001,10001) for p in [pathlib.Path('/data'), *pathlib.Path('/data').rglob('*')]]",
  );
  const restoredBase = await start(`${name}-restore`, restored);
  if (JSON.stringify(await state(restoredBase)) !== JSON.stringify(after))
    throw new Error("Restored workspace differs from the stopped backup");
  const docs = after.documents.documents;
  for (const doc of docs) {
    if (!(await fetch(`${restoredBase}/v1/documents/${doc.id}/source`)).ok)
      throw new Error("Restored document blob is missing");
  }
  console.log(
    "PASS: stopped backup restores into a fresh volume with identical records and readable documents.",
  );
  console.log(`PASS: beta package ${image}`);
} catch (error) {
  console.error(error);
  for (const container of containers) {
    try {
      console.error(await docker("logs", "--tail", "30", container));
    } catch {}
  }
  process.exitCode = 1;
} finally {
  for (const container of containers) {
    try {
      await docker("rm", "-f", container);
    } catch {}
  }
  for (const data of [volume, restored]) {
    try {
      await docker("volume", "rm", data);
    } catch {}
  }
  await rm(backup, { recursive: true, force: true });
}
