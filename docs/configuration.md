# Configuration

[← Back to the README](../README.md)

## Frontend and launcher

Copy `.env.example` to `.env` only if a local `.env` does not already exist. The file is ignored by Git. Restart the frontend after changing it.

| Variable | Default | Purpose |
| --- | --- | --- |
| `EZPZ_API_URL` | `http://127.0.0.1:4173` | Backend target for the Vite `/v1` proxy |
| `EZPZ_BACKEND_REPO` | This repository | Backend checkout used by `npm start` |
| `EZPZ_PYTHON` | Backend `.venv/bin/python`, then `python3` | Python interpreter used by `npm start` |
| `EZPZ_STUDIO_PORT` | `5180` | Frontend port used by `npm start` |
| `EZPZ_TEST_PYTHON` | `python3` | Interpreter used by the integration test runner |

For example, put these in this frontend's `.env`, using your own absolute paths:

```dotenv
EZPZ_API_URL=http://127.0.0.1:4173
EZPZ_BACKEND_REPO=/path/to/ezpz-studio
EZPZ_PYTHON=/path/to/ezpz-studio/.venv/bin/python
EZPZ_STUDIO_PORT=5180
```

The test runner reads its settings from the shell environment, not the frontend `.env`:

```bash
EZPZ_BACKEND_REPO=/path/to/ezpz-studio \
EZPZ_TEST_PYTHON=/path/to/ezpz-studio/.venv/bin/python \
npm run test:integration
```

A backend configured at a non-loopback address must already be running; the launcher will not start a server on another machine.

## Start the servers separately

In the backend checkout, after installing its requirements:

```bash
.venv/bin/python -m backend.server --root . --host 127.0.0.1 --port 4173
```

In this frontend checkout:

```bash
npm run dev
```

The frontend proxies `/v1` to the API. Open `http://127.0.0.1:5180` for live mode, or append `?demo=1` for fixtures. Running `npm run build` builds only the frontend; it does not bundle the Python service.

## Models and parsers

The backend loads its own project-root `.env`; shell environment values take precedence. Add only the credentials you need and restart that backend process. For source development, the project-root `.env` also holds backend credentials. Docker uses the explicit environment variables in `compose.yaml`; see [deployment](deployment.md).

| Adapter | Backend environment | Notes |
| --- | --- | --- |
| OpenAI | `OPENAI_API_KEY` | Choose a model available to your account. |
| Anthropic | `ANTHROPIC_API_KEY` | Uses the Messages adapter. |
| Google Gemini | `GOOGLE_API_KEY` or `GEMINI_API_KEY` | Uses the generateContent adapter. |
| Ollama | Optional `OLLAMA_BASE_URL`, `OLLAMA_API_KEY` | Default compatible endpoint: `http://127.0.0.1:11434/v1`. Start your model server separately. |
| OpenAI-compatible | `OPENAI_COMPATIBLE_API_KEY` or `OPENAI_API_KEY`; optional `OPENAI_COMPATIBLE_BASE_URL` | Set the model ID and compatible endpoint in processor settings. |
| Native text | None | PDF text parsing uses installed Python dependencies; image OCR depends on available local tooling. |
| Docling | None | Optional local installation is required for its full parser. It is not installed by the base requirements. |
| LlamaParse | `LLAMA_CLOUD_API_KEY` or `LLAMA_PARSE_API_KEY` | Hosted parsing; sends the document to the configured service. |

For an existing local OpenAI-compatible model server, select **Ollama** or **OpenAI-compatible**, enter the model ID that server exposes, and set its API base URL including `/v1` where required. Both the model and parser choices determine whether a workflow stays local.

Model credentials and provider errors fail explicitly, without substituting a local model. Optional parser tooling can still invoke compatibility parsing, reported in result warnings.

## Persistence and annotations

Backend defaults are `.ezpz/ezpz.db` for SQLite and `.ezpz/blobs` for source artifacts. Backend `EZPZ_DATABASE_URL` and `EZPZ_BLOB_ROOT` override those paths. `EZPZ_SEED_DEMO=false` is the default.

Expected values are document annotations shared by datasets containing that document. Saving an annotation changes the ground truth used by future evaluations. Saved runs retain their evaluated expectations. The Expected tab verifies both dataset membership and the annotation through the dataset manifest before reporting a successful add.

Browser drafts are separate from backend versions. Save a processor version before relying on a database backup to preserve a configuration. Clearing browser storage does not delete backend documents or runs.

## Packaged deployment

The backend is included in this repository. Historical patches in `patches/` are not needed for this version.

Use [the deployment guide](deployment.md) for Docker installation, persistent volumes, backup/restore, model endpoints, upgrades, and beta limits. Source-development data defaults to `.ezpz/`; container data lives in `/data`.
