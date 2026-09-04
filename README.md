# ezpz studio — standalone redesign

A new React + TypeScript frontend for a locally hosted, model-agnostic document extraction workbench. This is a separate Git repository, dependency tree, and build. It does not import or copy any UI from the original ezpz frontend.

## Run

Requires Node.js 20.19+ or 22.12+.

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:5180**. The app starts in an explicitly labeled demo workspace. No credentials or backend are required to explore the design.

```sh
npm run build
npm run preview
```

The preview also serves on port 5180; stop the dev server before using it.

## Connect the existing local backend

In the original `ezpz-studio` repository, install its Python requirements and run:

```sh
pip install -r requirements.txt
python3 server.py
```

In this frontend, open **Settings → Connect local API**. Requests to `/v1` are proxied to `http://127.0.0.1:4173`. To change that address, copy `.env.example` to `.env`, edit `EZPZ_API_URL`, and restart the frontend server. Provider credentials remain in the backend configuration; never place them in frontend environment variables.

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
- Each page reload starts in demo mode. Reconnect in Settings to inspect the local API again.
- Live uploads, annotations, runs, and review decisions persist in the original backend database. Existing frontend and backend source files remain separate.
- Extraction previews have no reviewable immutable run. Open a scored run in Evaluations and choose **Inspect results** to review its snapshot and saved decisions.
- Live provider warnings are displayed. The backend can fall back to compatibility parsing or its invoice-specific deterministic model when optional dependencies or credentials are absent. Install its requirements for PDF text parsing, and use a configured model for general extraction.
- Hill climbing is a manual experiment loop in this version, not an autonomous optimization scheduler. Compare runs from the same dataset. A repeated dataset ID does not itself guarantee unchanged membership or ground truth; retain a fixed benchmark while comparing.
- PDF, image, and text/CSV preview are included. DOCX/XLSX-specific viewers are not installed in this experiment.

## Extend UI provenance

Installed directly from the official [Extend UI registry](https://www.extend.ai/ui), using the `new-york` style:

- `@extend/pdf-viewer` — PDF rendering, zoom, page navigation, search, download, and overlays.
- `@extend/file-upload` and `@extend/file-thumbnail` — document upload and file representations.
- `@extend/bounding-box-citations` — its `HumanReviewHighlight` implementation is extracted into a focused module so optional table/diff editors are not bundled.

Registry icon placeholders were resolved to Lucide icons. The shared PDF engine was changed from a CDN URL to a locally served WASM asset. Unused registry editor dependencies were removed. The shell, screens, state, charts, API adapter, and styling were authored fresh for this redesign. Upstream licensing is preserved in [EXTEND-LICENSE.md](EXTEND-LICENSE.md). Font and PDF engine licenses are included in `licenses/`.

## Verification

```sh
npm test
npm run test:integration
npm run build
```

Unit checks protect structured JSON values, nulls, unknown ground truth, zero-valued metrics, source coordinates, and provider-neutral configuration. The integration test launches the original Python backend with a temporary database and blob directory, performs upload/extract/annotate/dataset/run/review operations, and cleans up afterward. It uses the local deterministic adapter and makes no external model calls.

The integration runner expects the original backend in `../ezpz-studio`. Override `EZPZ_BACKEND_REPO` or `EZPZ_TEST_PYTHON` if needed. It never uses the original database or `.env` file.

Browser verification covers PDF rendering and field overlays, saved corrections, local API connection/extraction, run comparisons, and narrow-screen layout/navigation.

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
