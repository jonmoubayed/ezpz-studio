# Contributing to ezpz studio

Thanks for helping make document extraction easier to inspect and improve. Small, focused contributions are welcome, including documentation, accessibility, bug fixes, and tests.

## Before you start

Follow the [README setup](README.md#quick-start). This repository contains the React frontend and the Python backend, including parsing, model adapters, scoring, SQLite persistence, and the HTTP API.

For a substantial feature or an API contract change, open an issue explaining the problem and proposed behavior before investing in a large patch. Include the repository and commit you are testing when reporting an integration problem.

## Development workflow

1. Create a branch for one coherent change.
2. Reproduce the problem with a synthetic document or a small fixture.
3. Make the change using the existing styles and shared controls.
4. Run the checks relevant to the change; include what you verified in the pull request.
5. Update user-facing documentation when setup, behavior, or limitations change.

Do not include real customer documents, API keys, `.env` files, database files, or local work directories in commits, screenshots, or issue attachments.

## Checks

From this repository:

```bash
npm test
npm run build
EZPZ_TEST_PYTHON=.venv/bin/python npm run test:integration
```

Integration tests start a disposable backend with temporary storage. They do not use the live workspace database or make hosted model calls. Set `EZPZ_BACKEND_REPO` in the shell if your backend is elsewhere.

For UI changes, also check the actual flow in a browser at desktop and narrow widths. Verify keyboard focus, readable labels, empty/error states, and long or nested extraction values. For evaluation changes, check group boundaries, repeated runs within one experiment, deep links, and the extracted-versus-expected inspector.

The browser suite is an active gate:

```bash
.venv/bin/python -m unittest discover -s backend/tests
npx playwright install chromium
EZPZ_TEST_PYTHON=.venv/bin/python npm run test:e2e
docker build -t ezpz-studio:0.1.0-beta.1 .
npm run test:package
```

The package check runs the complete browser flow against the built image, then verifies restart recovery and backup restoration with disposable volumes. Never point the browser integration test at a real workspace. CI checks both ARM64 and AMD64 containers; hosted model quality needs separate, explicitly configured testing.

## Source map

| Path | Responsibility |
| --- | --- |
| `src/App.tsx` | App shell, navigation, shared dialogs |
| `src/configuration.tsx` | Processor configuration workspace |
| `src/processors.tsx` | Reusable processor library |
| `src/workbench.tsx` | Playground, source viewer, review surfaces |
| `src/evaluations.tsx` | Group, experiment, comparison, and run pages |
| `src/evaluation-model.ts` | Evaluation hierarchy, route helpers, result normalization |
| `src/expected-values.tsx` | Expected-value editing and dataset actions |
| `src/structured-value.tsx` | Structured results and object-array tables |
| `src/pages.tsx` | Overview, datasets, new experiments, hill climbing, settings |
| `src/api.ts` | `/v1` request layer and backend response adapters |
| `src/store.tsx` | Workspace state, actions, and demo/live separation |
| `src/domain.ts` | Shared types and explicit demo fixtures |
| `src/components/extend/` | Extend UI components and local adaptations |
| `src/styles.css` | Studio styling and responsive layouts |
| `tests/` | Unit, API, store, and browser checks |
| `backend/` | HTTP API, persistence, parsing, extraction, evaluation, and Python tests |
| `scripts/test-package.mjs` | Disposable container lifecycle and browser checks |
| `patches/` | Historical compatibility patches; not needed by this checkout |

## Implementation expectations

- Keep the studio model-agnostic. Put provider-specific request logic in backend adapters.
- Preserve structured values, explicit `null`/`false`/`0`, and the distinction between missing annotations and expected values.
- Preserve saved-run snapshots and the boundaries between groups, experiments, and runs.
- Label demo data and fallback behavior. Do not fabricate scores or source citations.
- Use the shared select, dialog, schema, and viewer components, including their accessible names and focus behavior.
- Preserve third-party license notices when updating vendored components.

## Bug reports and pull requests

A useful bug report includes the relevant commit, operating system, Node/Python versions, selected model and parser, reproduction steps, expected behavior, and actual behavior. Provide redacted logs and a synthetic reproducer when possible.

A useful pull request explains the user-visible problem, the resulting behavior, and how it was tested. Add before/after screenshots for visual changes. State any backend changes or compatibility requirements.

Avoid posting credentials or private documents in public issues. For a security-sensitive report, use the repository's private reporting channel if one is enabled; otherwise request a private contact without disclosing exploit details publicly.

## License

Original contributions are made under the project's [MIT License](LICENSE). Third-party files retain their upstream notices and terms. Ensure you have the right to contribute any code, documents, or assets you submit.
