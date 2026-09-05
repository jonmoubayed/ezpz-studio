// Exercise a source-free installer in an isolated Compose project.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
const version = JSON.parse(await readFile("package.json", "utf8")).version;
const image = process.env.EZPZ_TEST_IMAGE || `ezpz-studio:${version}`;
const directory = await mkdtemp(path.join(tmpdir(), "ezpz-installer-"));
const env = {...process.env, COMPOSE_PROJECT_NAME: `ezpz-installer-test-${process.pid}`, EZPZ_PORT: "0"};
delete env.EZPZ_IMAGE;
async function command(cmd, args, cwd = process.cwd()) {
  const child = spawn(cmd, args, {cwd, env, stdio: ["ignore", "pipe", "pipe"]});
  let out = "", error = "";
  child.stdout.on("data", b => out += b);
  child.stderr.on("data", b => error += b);
  const code = await new Promise((resolve, reject) => {
    child.on("exit", resolve);
    child.on("error", reject);
  });
  if (code !== 0) throw new Error(`${cmd} failed: ${error}`);
  return out.trim();
}
let installation;
try {
  const architecture = await command("docker", ["image", "inspect", image, "--format", "{{.Architecture}}"]);
  const basename = `ezpz-studio-${version}-${architecture}`;
  const archive = path.resolve("release", basename + ".tar.gz");
  const expected = (await readFile(archive + ".sha256", "utf8")).split(" ")[0];
  const actual = createHash("sha256").update(await readFile(archive)).digest("hex");
  if (actual !== expected) throw new Error("Release checksum mismatch");
  await command("tar", ["-xzf", archive, "-C", directory]);
  installation = path.join(directory, basename);
  await command("sh", ["start.sh"], installation);
  const port = (await command("docker", ["compose", "port", "studio", "4173"], installation)).split(":").at(-1);
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(base + "/v1/ready");
      await response.arrayBuffer();
      if (response.ok) {ready = true; break;}
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!ready) throw new Error("Installed service did not become ready");
  if (!(await (await fetch(base)).text()).includes('<div id="root">')) throw new Error("Installed frontend missing");
  const documents = await (await fetch(base + "/v1/documents")).json();
  if (documents.documents.length !== 0) throw new Error("Fresh installer contains documents");
  console.log(`PASS: ${architecture} archive checksum, extraction, start.sh, Compose startup, and empty workspace.`);
} finally {
  if (installation) await command("docker", ["compose", "down", "--volumes"], installation);
  await rm(directory, {recursive: true, force: true});
}
