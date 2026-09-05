// Produce a portable, architecture-specific Docker bundle from a tested image.
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { createHash } from "node:crypto";
import path from "node:path";
const version = JSON.parse(await readFile("package.json", "utf8")).version;
const image = process.env.EZPZ_TEST_IMAGE || `ezpz-studio:${version}`;
async function command(cmd, args) {
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", (b) => (out += b));
  const code = await new Promise((resolve, reject) => {
    child.on("exit", resolve);
    child.on("error", reject);
  });
  if (code !== 0) throw new Error(`${cmd} failed (${code})`);
  return out.trim();
}
const architecture = await command("docker", [
  "image",
  "inspect",
  image,
  "--format",
  "{{.Architecture}}",
]);
if (!["arm64", "amd64"].includes(architecture))
  throw new Error(`Unsupported release architecture ${architecture}`);
const basename = `ezpz-studio-${version}-${architecture}`;
const directory = path.resolve("release", basename);
await mkdir(directory, { recursive: true });
await command("docker", [
  "image",
  "save",
  "--output",
  path.join(directory, "image.tar"),
  image,
]);
await pipeline(
  createReadStream(path.join(directory, "image.tar")),
  createGzip({ level: 6 }),
  createWriteStream(path.join(directory, "image.tar.gz")),
);
await rm(path.join(directory, "image.tar"));
const compose = (await readFile("compose.yaml", "utf8"))
  .replace("    build: .\n", "")
  .replace("ezpz-studio:" + version, image);
await writeFile(path.join(directory, "compose.yaml"), compose);
await copyFile(".env.docker.example", path.join(directory, ".env.example"));
await copyFile("LICENSE", path.join(directory, "LICENSE"));
await copyFile("docs/deployment.md", path.join(directory, "DEPLOYMENT.md"));
await writeFile(
  path.join(directory, "start.sh"),
  `#!/bin/sh\nset -eu\ncd "$(dirname "$0")"\ndocker load --input image.tar.gz\ndocker compose up -d --no-build\nprintf '\\nOpen http://127.0.0.1:5180 (or your EZPZ_PORT).\\n'\n`,
  { mode: 0o755 },
);
await writeFile(
  path.join(directory, "start.ps1"),
  `$ErrorActionPreference = "Stop"\nSet-Location $PSScriptRoot\ndocker load --input image.tar.gz\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\ndocker compose up -d --no-build\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\nWrite-Host "Open http://127.0.0.1:5180 (or your EZPZ_PORT)."\n`,
);
await writeFile(
  path.join(directory, "README.txt"),
  `ezpz studio ${version} — ${architecture}\n\nRequires Docker with Compose and Linux containers.\nApple Silicon: arm64. Intel/AMD machines: amd64.\n\n1. Extract this archive to a folder you will keep.\n2. Optionally copy .env.example to .env and configure provider keys.\n3. macOS/Linux: ./start.sh\n   Windows PowerShell: ./start.ps1\n4. Open http://127.0.0.1:5180\n\nIf port 5180 is occupied, set EZPZ_PORT in .env first.\nData lives in a Docker volume; docker compose down preserves it.\nDo not use docker compose down -v unless you intend to delete all workspace data.\n\nSingle-user local beta; no public-facing authentication is included.\nHost model servers use host.docker.internal, not container localhost.\nProvider failures are explicit. New evaluations are fresh and snapshot their benchmark.\nStop the service and back up the data volume before upgrading.\nKeep this folder's .env and compose project name when replacing the image during upgrades.\n`,
);
const archive = path.resolve("release", `${basename}.tar.gz`);
await command("tar", [
  "-czf",
  archive,
  "-C",
  path.dirname(directory),
  basename,
]);
const hash = createHash("sha256");
for await (const chunk of createReadStream(archive)) hash.update(chunk);
await writeFile(
  `${archive}.sha256`,
  `${hash.digest("hex")}  ${path.basename(archive)}\n`,
);
console.log(archive);
