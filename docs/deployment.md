# Deploying the beta

ezpz studio 0.1.0-beta.1 bundles the React app, Python API, SQLite storage, native PDF parsing, and English Tesseract OCR into one Docker service. No Node or Python installation is required on the host.

This beta is for one user on a trusted local machine. Compose binds to **127.0.0.1 only**. It has no application authentication. Public hosting and shared, multi-user deployment are outside this beta's scope.

## Install a prebuilt bundle

Choose the archive for your machine: **arm64** for Apple Silicon or ARM Linux; **amd64** for Intel/AMD. Install Docker with Compose and enable Linux containers.

1. Extract the archive into a folder you will keep.
2. Optionally copy `.env.example` to `.env`, then enter your provider credentials.
3. Run `./start.sh` on macOS/Linux or `./start.ps1` in Windows PowerShell.
4. Open **http://127.0.0.1:5180**.

Set `EZPZ_PORT=5186` in `.env` if port 5180 is occupied. The image is included in the archive and loaded locally; no registry login is needed. Check the accompanying SHA-256 checksum before distributing or installing a bundle.

Windows PowerShell launch support is provided, but the host-specific Windows installer has not been exercised locally. The application and lifecycle tests run against Linux containers.

## Pull a published image

After a maintainer publishes the version below to GHCR, set this in your installation folder's `.env`:

```dotenv
EZPZ_IMAGE=ghcr.io/jonmoubayed/ezpz-studio:0.1.0-beta.1
```

With `compose.yaml` in the same folder, run:

```bash
docker compose pull studio
docker compose up -d --no-build
```

The version tag supports Linux AMD64 and ARM64; Docker selects the matching image. Keep the existing Compose project name and data volume when upgrading. Source builds and the offline bundles still work separately.

A repository being public does not make its GHCR package public. After the first publication, the maintainer must open the package settings and change its visibility to public for anonymous pulls. Until then, pulling requires a GitHub login with package read access. A missing tag or private package can both appear as a denied pull.

## Build from source

From the repository root:

```bash
docker compose up -d --build
```

Optionally create `.env` from `.env.docker.example` first. The Compose file explicitly forwards provider credentials to the API; do not use frontend `VITE_*` variables for secrets.

```bash
docker compose ps
docker compose logs --tail=100 studio
docker compose down
```

Stopping or recreating the service preserves its named data volume. **`docker compose down -v` deletes the workspace.** Browser-only drafts are separate: save processor versions before switching browsers or machines.

## Model and parser setup

Configure a processor with your chosen provider, model ID, parser, prompt, and schema. Missing model credentials and provider errors produce a failed run; the application does not silently substitute the deterministic model.

For a model server running on the host, use `http://host.docker.internal:11434/v1` for Ollama, or your compatible server's port. Container `localhost` refers to the container itself. Hosted models and hosted parsers receive the document content needed for the selected operation.

The image includes the native parser and English OCR. Full Docling support requires a custom image with its optional dependencies. Optional parser failures may still use compatibility parsing and report warnings; inspect those warnings when benchmarking.

## Persistence, backup, and restore

SQLite and document blobs live together in `/data`, backed by the `studio-data` Compose volume. Keep one application instance per volume. Do not back up only the database: the source documents are separate blob files.

The following commands are for macOS/Linux. Run them from the installation folder. Save browser drafts as processor versions first. Backups contain your documents and annotations, so store them privately.

### Back up

Stop the service for a consistent database-and-blob snapshot:

```bash
mkdir -p backups
docker compose stop studio
docker compose run --rm --no-deps --user 0 --entrypoint python \
  -v "$PWD/backups:/backup" studio -c \
  "import tarfile; t=tarfile.open('/backup/workspace.tar.gz','x:gz'); t.add('/data',arcname='.'); t.close()"
docker compose start studio
```

The exclusive `x:gz` mode refuses to replace an existing backup. Move the previous archive to a dated filename before making the next backup.

### Restore into a separate workspace

Restore only a trusted archive. Using a new Compose project preserves the original volume and allows you to verify the copy before switching.

```bash
COMPOSE_PROJECT_NAME=ezpz-restored docker compose run --rm --no-deps \
  --user 0 --entrypoint python -v "$PWD/backups:/backup:ro" studio -c \
  "import pathlib, tarfile, os; root=pathlib.Path('/data'); assert not any(root.iterdir()), 'Restore requires an empty volume'; t=tarfile.open('/backup/workspace.tar.gz'); t.extractall(root,filter='data'); t.close(); [os.chown(p,10001,10001) for p in [root,*root.rglob('*')]]"
COMPOSE_PROJECT_NAME=ezpz-restored EZPZ_PORT=5186 docker compose up -d --no-build
```

Open http://127.0.0.1:5186 and verify documents, annotations, processors, and runs. The ownership step is required because the runtime runs as UID/GID 10001. Keep using `COMPOSE_PROJECT_NAME=ezpz-restored` for that restored workspace.

### Upgrades and older development workspaces

Back up before upgrading. Keep the same Compose project name and credentials when replacing an image; changing the project name selects a different volume. Load the new image, then run `docker compose up -d --no-build`. Database initialization applies supported migrations automatically. Rolling back the image alone may not reverse database changes; restore the matching pre-upgrade backup into a separate volume.

Existing two-checkout development instances are not modified by the installer. Their `.ezpz` data and local configuration remain separate. Start with a fresh beta volume unless you have verified a copy of that workspace against the beta. Older runs without benchmark snapshots remain readable but cannot be compared as identical benchmarks.

## Evaluation behavior and limits

- New evaluations bypass extraction cache and freeze document membership and ground-truth revisions at submission.
- Comparisons require completed runs with matching benchmark snapshots.
- One background evaluation runs at a time. Progress and document failures are visible.
- Cancellation takes effect between documents; an in-flight provider request must finish first.
- Runs interrupted by a service restart are marked interrupted. They do not resume automatically.
- Hill climbing is a manual experiment loop. Model confidence is self-reported and is not calibrated accuracy.
- There is no distributed queue, multi-user authorization, or automatic backup service.

## Release validation

The automated package check uses disposable volumes and synthetic documents. It exercises the browser workflow against the built image, private-file denial, restart persistence, interrupted-run recovery, stopped backup, restore, and source-document retrieval. Unit and API checks cover annotation snapshots, fresh/cache behavior, cancellation, provider failure, and a 100-document evaluation.

To reproduce from source:

```bash
npm ci
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements.lock
.venv/bin/python -m unittest discover -s backend/tests
npm test
EZPZ_TEST_PYTHON=.venv/bin/python npm run test:integration
npx playwright install chromium
docker build -t ezpz-studio:0.1.0-beta.1 .
npm run test:package
npm run release:bundle
npm run test:install
```

Bundles and checksums are written to the ignored `release/` directory. CI builds and checks ARM64 and AMD64 artifacts.

### Publish to GitHub Container Registry

Run **Publish container image** from the repository Actions tab, or push a `v`-prefixed tag matching `package.json` (for example, `v0.1.0-beta.1`). The workflow reruns both native architecture checks, then publishes those exact tested bundle images to `ghcr.io/jonmoubayed/ezpz-studio`. It requires both jobs to pass before publishing. Version tags select both architectures; `sha-<full-commit>` tags identify the source revision. The workflow does not set a `latest` tag for this beta.

The publish job uses the repository's `GITHUB_TOKEN` with `packages: write`; no personal registry token is needed. The image source label links the package to this repository. After the first successful run, set package visibility to public and verify an anonymous pull before advertising it for public deployment. Publish new releases with a new package version so existing deployments remain reproducible.
