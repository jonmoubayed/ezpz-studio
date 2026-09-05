# ezpz studio — standalone redesign

A new React + TypeScript frontend for a locally hosted, model-agnostic document extraction workbench. This is a separate Git repository, dependency tree, and build. It does not import or copy any UI from the original ezpz frontend.

## Run

Requires Node.js 20.19+ or 22.12+.

```sh
npm ci
npm start
```

Open **http://127.0.0.1:5180**. Studio connects to the local backend automatically and restores your selected processor, working configuration, source, and review run. `npm start` starts the backend from `../ezpz-studio` when needed, then launches Vite. An already-running backend is reused and left running when Studio stops. Install the backend Python requirements first (see below).

To run only the frontend, use `npm run dev`. To explore illustrative fixtures without a backend, open **http://127.0.0.1:5180/?demo=1** or choose **Explore demo** on the offline screen.

```sh
npm run build
npm run preview
```

The preview also serves on port 5180; stop the dev server before using it.

## Connect the existing local backend

In the original `ezpz-studio` repository, install its Python requirements and run:

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m backend.server --root . --host 127.0.0.1 --port 4173
```

Studio connects automatically. **Settings → Refresh connection** reloads workspace data; an unavailable API shows an explicit reconnect screen. Requests to `/v1` are proxied to `http://127.0.0.1:4173`. To change that address, copy `.env.example` to `.env`, edit `EZPZ_API_URL`, and restart the frontend server. Provider credentials remain in the backend configuration; never place them in frontend environment variables.

`npm start` uses the backend’s `.venv/bin/python` if present, otherwise `python3`. Set `EZPZ_PYTHON` to a different virtualenv interpreter, `EZPZ_BACKEND_REPO` to another backend checkout, or `EZPZ_STUDIO_PORT` to change the frontend port. These settings can live in this repo’s ignored `.env`. The backend currently needs Python 3.9–3.12 because its upload handler uses `cgi`.

The frontend does not require an Extend account, Extend API, or Extend extraction model. Extend supplies the open-source document UI only. Fonts and the PDF engine WASM are served locally; the install script copies the pinned WASM package into `public/vendor/`.

## Included flows

| Area | What works |
| --- | --- |
| Overview | Workspace metrics, benchmark accuracy history, review count, recent experiments |
| Playground | Source selection, PDF/image/text viewing, field citations, confidence, structured JSON export, configuration editing, extraction previews, ground-truth editing |
| Datasets | Source library, dataset creation from selected documents, membership inspection, manifest export |
| Evaluations | Search, dataset filtering, sorting, two-run comparisons, immutable configuration snapshots, run export, benchmark execution |
| Hill climbing | Choose a fixed benchmark and baseline, edit a candidate hypothesis/configuration, run the candidate, compare results |
| Review queue | Source-grounded field review, typed corrections, reviewer notes, acceptance, ambiguity flags, feedback export |
| Settings | Local API connection, arbitrary model IDs, provider and parser selection, custom compatible endpoint, configuration export |

The UI adapts to mobile with a collapsible navigation panel, stacked document/review surfaces, and contained horizontal scrolling for data tables. Dialogs use Radix focus management. Navigation and quick search support keyboard use (`⌘K` / `Ctrl+K`).

## Demo versus live data

- Demo documents and historical scores are illustrative fixtures, not measured model benchmarks.
- Running a demo experiment adds an explicitly labeled fixture result with a fixed score. It does not call a model or imply the hypothesis improved accuracy.
- Demo configuration, runs, and feedback persist in browser storage. Demo uploads, ground-truth edits, and new datasets last for the current session. **Settings → Reset demo** restores the initial fixtures.
- Normal URLs start in live mode. Demo mode is explicit in the URL (`?demo=1`), and demo configuration is stored separately from live processor working copies. Switching back to live restores your backend workspace. An unavailable backend never silently falls back to fixtures.
- Live uploads, annotations, runs, and review decisions persist in the original backend database. Existing frontend and backend source files remain separate.
- Extraction previews have no reviewable immutable run. Open a scored run in Evaluations and choose **Review fields**, or select a saved run directly in **Review queue**. Feedback is loaded from the backend and remains scoped to that run, document, and field.
- Live provider warnings are displayed. The backend can fall back to compatibility parsing or its invoice-specific deterministic model when optional dependencies or credentials are absent. Install its requirements for PDF text parsing, and use a configured model for general extraction.
- Hill climbing is a manual experiment loop in this version, not an autonomous optimization scheduler. Compare runs from the same dataset. A repeated dataset ID does not itself guarantee unchanged membership or ground truth; retain a fixed benchmark while comparing.
- PDF, image, and text/CSV preview are included. DOCX/XLSX-specific viewers are not installed in this experiment.

## Extend UI provenance

Installed directly from the official [Extend UI registry](https://www.extend.ai/ui), using the `new-york` style:

- `@extend/pdf-viewer` — PDF rendering, zoom, page navigation, search, download, and overlays.
- `@extend/file-upload` and `@extend/file-thumbnail` — document upload and file representations.
- `@extend/bounding-box-citations` — its `HumanReviewHighlight` implementation is extracted into a focused module so optional table/diff editors are not bundled.

Registry icon placeholders were resolved to Lucide icons. The shared PDF engine was changed from a CDN URL to a locally served WASM asset. Unused registry editor dependencies were removed. The shell, screens, state, charts, API adapter, and styling were authored fresh for this redesign. Upstream licensing is preserved in [EXTEND-LICENSE.md](EXTEND-LICENSE.md). Font and PDF engine licenses are included in `licenses/`.

## Backend compatibility fix

The connected browser test found that `/v1/datasets/:id/manifest` returned null ground truth even for annotated documents. The local backend now reads each document’s latest annotation when exporting. The fix and its Python regression test are also captured in `patches/backend-manifest-ground-truth.patch` for applying once to another backend checkout.

## Verification

```sh
npm test
npm run test:integration
npx playwright install chromium
npm run test:e2e
npm run build
```

Unit checks protect structured JSON values, nulls, unknown ground truth, zero-valued metrics, source coordinates, and provider-neutral configuration. The integration test launches the original Python backend with a temporary database and blob directory, performs upload/extract/annotate/dataset/run/review operations, and cleans up afterward. It uses the local deterministic adapter and makes no external model calls.

The integration runner expects the original backend in `../ezpz-studio`. Override `EZPZ_BACKEND_REPO` or `EZPZ_TEST_PYTHON` if needed. It never uses the original database or `.env` file.

The React integration test mounts the real store in StrictMode and checks live startup, processor/draft restoration, extraction, saved review data, reloads, and demo isolation. The headless Chromium test builds the app, starts a disposable backend and Vite proxy, then exercises processor/schema editing, side-by-side extraction, annotations, datasets, grouped evaluations, reviewer corrections, iteration comparison, PDF viewing, and offline recovery. Screenshots are saved under ignored `test-results/`. Tests use the local deterministic adapter; hosted model providers are not called.

## Source layout

- `src/App.tsx` — new navigation shell and global dialogs
- `src/pages.tsx` — overview, datasets, evaluations, hill climbing, settings
- `src/workbench.tsx` — extraction and reviewer surfaces
- `src/store.tsx` — mode-aware workspace state and actions
- `src/api.ts` — adapter for the existing `/v1` API
- `src/domain.ts` — data types, sample fixtures, formatting
- `src/styles.css` — new visual system and responsive layouts
- `src/components/extend/` — upstream Extend building blocks
- `scripts/` — local vendor assets, sample generation, isolated integration runner

No cloud deployment, authentication service, or hosted model is required to run the frontend.

## Processors, schemas, and evaluation iterations

- **Processors** is the reusable extraction library. Create an arbitrary custom schema or start from invoice, 1099, receipt, or contract fields. Duplicate any processor, edit its metadata, save versions, load previous versions into a working copy, and test it in Playground.
- **Configure** opens a split workspace with the source document on the left and Configure / Results tabs on the right, matching Playground’s shared processor selector, configuration bar, and document viewer. Run extraction switches to Results in place; the viewer and schema draft stay mounted. Results include field citations, JSON export, and a notice if settings have changed since the run. Choose or upload a source without leaving the processor editor. Collapsible model settings leave more space for the schema. The actual Extend UI Schema Builder provides nested object/array tables, editable enum descriptions, drag reordering, and a synchronized JSON view. Direct JSON editing is also available. The adapter retains required fields and constraints through renames and moves; advanced schemas that the visual table cannot represent stay in the JSON editor.
- **Evaluations** groups iterations by the backend evaluation group, with a selectable baseline, accuracy trend, score deltas, model/parser details, latency, and cost. Compare 2–4 runs with saved prompt and schema snapshots. Inspect a run on a full results page with document navigation, failure hotspots, expected/actual values, and source citations in Extend's viewer.
- Demo processors and versions persist in browser local storage. Live processors and immutable versions use `/v1/processors` and its draft/publish endpoints; evaluation groups and experiments use `/v1/eval-groups`. Saving a version stores it in the local backend; it does not deploy an external service. Earlier run snapshots remain unchanged.
- Demo evaluation fields and metrics are explicitly illustrative. Live inspection uses the selected run's own extraction/evaluation records, including missing fields and unscored values.

Schema Builder source: `https://www.extend.ai/ui/r/styles/new-york/schema-builder.json` (license in `EXTEND-LICENSE.md`). Local adaptations replace registry icon placeholders, add accessible input names, and allow the JSON view to display the full schema with preserved constraints. New primitives are shadcn Tabs and Collapsible.

`npm test` covers schema round trips, nested moves, validation, evaluation grouping, and missing/null/zero field values. `npm run test:integration` additionally verifies processor metadata/version persistence, group membership, immutable evaluation snapshots, and repeated runs against a saved configuration using a disposable local backend.

## Expected values and source inspection

Playground and processor configuration use equal-width document and editor/result panes on desktop. Schema fields and enum values have delete controls, and description inputs wrap and grow with their content.

Extraction fields show **Result** and **Expected** together. The **Expected** tab edits document ground truth and can add that document to an existing or new evaluation dataset. Saving ground truth affects future evaluations; previously scored runs retain their saved expectations. Explicit null, false, and zero values remain distinct from unannotated fields.

Source overlays use the backend’s normalized coordinates and retain multiple citations per field. Older absolute coordinates are converted using parser page dimensions. Fields without grounding evidence show no citation; selecting a cited field focuses its first source area.

## Model-reported confidence

New LLM extractions request `{ "value": ..., "confidence": 0.83 }` at each extraction leaf. Nested objects retain their structure; arrays receive one score for the whole array. Scores must be finite numbers from 0 to 1. Missing, malformed, and out-of-range scores remain null; the previous 75% fallback is removed.

Badges distinguish **Model**, **Rule-based**, and **Sample** scores. Model confidence is an LLM self-assessment, not calibrated correctness or measured eval accuracy. Historical scores without source metadata show **Not provided**; run extraction again to obtain a new score. Historical runs remain unchanged, and the extraction cache version changes with the response contract.

The backend changes and regression tests are captured in `patches/backend-llm-confidence.patch`. Apply this patch to another backend checkout before using the new confidence badges. Tests mock provider HTTP responses and verify the request contract, nested values, zero and missing confidence, persisted provenance, cache behavior, and unchanged local extraction flows without spending hosted model credits.

Structured response schemas follow [OpenAI’s strict schema requirements](https://developers.openai.com/api/docs/guides/structured-outputs) and [Gemini’s JSON Schema response format](https://ai.google.dev/api/generate-content#generationconfig).
