# Configuration

[← Back to the README](../README.md)

## Frontend and launcher

Copy `.env.example` to `.env` only if a local `.env` does not already exist. The file is ignored by Git. Restart the frontend after changing it.

| Variable | Default | Purpose |
| --- | --- | --- |
| `EZPZ_API_URL` | `http://127.0.0.1:4173` | Backend target for the Vite `/v1` proxy |
| `EZPZ_BACKEND_REPO` | Sibling `../ezpz-studio` | Backend checkout used by `npm start` |
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

The backend loads its own project-root `.env`; shell environment values take precedence. Add only the credentials you need and restart that backend process. The frontend `.env` is not the provider credential store.

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

Inspect result warnings: unavailable credentials or optional tooling, and some provider errors, can invoke compatibility parsing or the invoice-oriented deterministic fallback. A successful response alone does not prove the requested provider processed the document.

## Persistence and annotations

Backend defaults are `.ezpz/ezpz.db` for SQLite and `.ezpz/blobs` for source artifacts. Backend `EZPZ_DATABASE_URL` and `EZPZ_BLOB_ROOT` override those paths. `EZPZ_SEED_DEMO=false` is the default.

Expected values are document annotations shared by datasets containing that document. Saving an annotation changes the ground truth used by future evaluations. Saved runs retain their evaluated expectations. The Expected tab verifies both dataset membership and the annotation through the dataset manifest before reporting a successful add.

Browser drafts are separate from backend versions. Save a processor version before relying on a database backup to preserve a configuration. Clearing browser storage does not delete backend documents or runs.

## Backend compatibility

This frontend uses the existing `/v1` API. Two backend changes are also preserved as patches for older checkouts:

- [`backend-manifest-ground-truth.patch`](../patches/backend-manifest-ground-truth.patch): dataset manifests include current document ground truth.
- [`backend-llm-confidence.patch`](../patches/backend-llm-confidence.patch): request, validate, and persist model-reported confidence and its provenance.

Current matching backend checkouts may already contain these changes. From a clean backend checkout, check a patch before applying it:

```bash
git apply --check ../ezpz-studio-redesign/patches/backend-manifest-ground-truth.patch
git apply ../ezpz-studio-redesign/patches/backend-manifest-ground-truth.patch
```

Use the same check/apply sequence for the confidence patch if needed. If a check fails, inspect the backend implementation and patch: the change may already be present or need a manual merge. Do not force-apply patches or overwrite local work.

Run backend tests afterward:

```bash
.venv/bin/python -m unittest discover -s backend/tests
```
