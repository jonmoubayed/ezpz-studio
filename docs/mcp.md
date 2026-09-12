# Use ezpz alongside Codex, Claude, and other MCP clients

The local MCP server connects an agent to the same running HTTP API as Studio.
It can import documents and annotations, inspect saved configurations, create
candidate versions, run benchmarks, compare results, and open a result in Studio.
The agent does not open a second database or receive your model-provider keys.

## Install and connect

Use Python 3.12. From the backend checkout you intend to use:

```sh
python3.12 -m venv .venv
.venv/bin/python -m pip install '.[mcp]'
```

Rerun the install command after updating this checkout. Start the backend and standalone Studio as usual. Restart an already-running
backend after installing this change so the collaboration endpoints and database
migrations are available. The standalone `ezpz-studio-redesign` checkout now
includes its own backend; its `npm start` uses that backend by default. Point
`EZPZ_BACKEND_REPO` at a different checkout only when intentional.

The examples below use placeholders: replace `/absolute/path/ezpz-studio` with
your backend checkout and `/absolute/path/imports` with the folder whose files
you want agents to import. Use absolute paths, including for the executable.

### Codex

```sh
codex mcp add ezpz -- /absolute/path/ezpz-studio/.venv/bin/ezpz-mcp \
  --api-url http://127.0.0.1:4173 \
  --studio-url http://127.0.0.1:5180 \
  --import-root /absolute/path/imports \
  --author codex
```

Or merge this entry into your Codex MCP configuration:

```toml
[mcp_servers.ezpz]
command = "/absolute/path/ezpz-studio/.venv/bin/ezpz-mcp"
args = ["--api-url", "http://127.0.0.1:4173", "--studio-url", "http://127.0.0.1:5180", "--import-root", "/absolute/path/imports", "--author", "codex"]
tool_timeout_sec = 300
```

The longer timeout accommodates batched uploads; evaluations return a job ID
immediately. See the [official Codex MCP configuration documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

### Claude Code

```sh
claude mcp add --transport stdio ezpz -- /absolute/path/ezpz-studio/.venv/bin/ezpz-mcp \
  --api-url http://127.0.0.1:4173 \
  --studio-url http://127.0.0.1:5180 \
  --import-root /absolute/path/imports \
  --author claude
```

See [Claude Code's local STDIO server documentation](https://code.claude.com/docs/en/mcp#option-3-add-a-local-stdio-server).
For clients using an `mcpServers` JSON configuration, merge an equivalent entry:

```json
{
  "mcpServers": {
    "ezpz": {
      "command": "/absolute/path/ezpz-studio/.venv/bin/ezpz-mcp",
      "args": ["--api-url", "http://127.0.0.1:4173", "--studio-url", "http://127.0.0.1:5180", "--import-root", "/absolute/path/imports", "--author", "claude"]
    }
  }
}
```

No client settings are modified by installing the Python package. The MCP
process speaks STDIO; it does not host a publicly reachable MCP endpoint.
The API and Studio origins must be loopback HTTP URLs. The API must be running
on the same machine as the MCP process. This is a local, single-user integration;
remote hosting and multi-user authentication are outside its scope.

## First workflow

Ask your agent:

> Check the ezpz workspace, preview importing the invoices folder and labels.csv,
> map InvoiceNumber to invoice_number and Total to total. Import them into a new
> dataset called September invoices. These labels are human-verified. Run version
> 1 of my invoice processor, inspect failures and warnings, and open the results
> in Studio. Save any suggested prompt change as a separate candidate and compare
> it against the baseline on the same benchmark.

The expected tool sequence is:

1. `workspace_status`, `list_items`, `get_processor` to discover the workspace.
2. `import_documents` with `dry_run=true` to validate files, mappings and duplicates.
3. Repeat with `dry_run=false` and inspect each file's status and the error count.
4. `start_evaluation` with an explicit saved version and a unique `request_key`.
5. `get_job` every few seconds until completed, failed or interrupted.
6. `get_run` for metrics, failures and warnings, then `open_in_studio` to review.
7. `save_processor_candidate`, evaluate its returned version, then `compare_runs`.

Use `get_document` to inspect annotation revisions and `save_expected_values` to
make an intentional correction. `get_dataset` pages through dataset membership.
`studio_link` returns a link without opening the browser.

## Harness workflows

Harness tools require the harness-enabled backend in `ezpz-studio-redesign`.
The MCP adapter can run from either checkout; it always talks to `--api-url`.
After updating, reinstall the MCP package and reconnect your MCP client to refresh
its tool list. Restart the backend to load the new endpoints. `workspace_status`
reports `harnesses`, `run_steps`, and `resumable_evaluations` in `capabilities`
when this support is active. Older backends still support the original tools.

| Tool | Purpose |
| --- | --- |
| `list_harnesses` | Get six editable recipes, supported blocks, routing syntax and policy guidance. |
| `validate_harness` | Check a complete workflow against a processor's JSON Schema without saving or running models. |
| `save_harness_candidate` | Append a validated workflow to a new processor version while preserving other configuration and the shared editor draft. |
| `get_run_steps` | Page through calls, gates, validation, votes, usage and saved operation attempts; optionally filter by document ID. |
| `control_evaluation` | Pause, resume or cancel an existing dataset evaluation. |

Harnesses are part of processor versions, not separate saved entities. Use
`get_processor` to inspect them. Recipes include LLM only, parse and extract,
tiered extraction, majority vote, extract and verify, and per-page extraction.
Blocks inherit the processor's model unless an explicit provider/model override
is supplied. Validation checks structure and schema paths; it does not verify
provider credentials or guarantee model compatibility with the input format.

Example request to your agent:

> Read my invoice processor and its harness. Create a tiered extraction candidate
> that escalates unresolved fields below 0.9 confidence. Preserve my schema and
> prompt, validate the flow, and compare the new version with the baseline on the
> same dataset. Inspect the execution steps to explain which documents escalated.

The expected sequence is `get_processor` → `list_harnesses` → `validate_harness`
→ `save_harness_candidate` → `start_evaluation` → `get_job` → `get_run_steps`
→ `compare_runs`. Supply the latest `expected_version` when saving; a stale
version or invalid flow fails without adding a version. Supply the complete
harness, including existing connections. To change the schema or model at the
same time, use `save_processor_candidate` with those sections and the harness.
On the harness-enabled backend, both candidate tools validate workflows against
the resulting saved schema.

`get_job` exposes the run ID while extraction is in progress. Use that ID with
`control_evaluation(action="pause")`, and poll `get_run` until it is paused.
Resume a paused/interrupted evaluation with `action="resume"`; this keeps the
same run, frozen benchmark, and completed calls. An unsaved provider response
may require a repeated request and charge. Pause/cancel finish at an operation
boundary and retain saved results. Completed/cancelled runs cannot resume.
After an uncertain resume, read the run status before trying again. `get_job`
tracks resumed runs even when Studio resumes them or the MCP client reconnects.
A failed submission or benchmark-consistency check remains visible as an error.

The API exposes `GET /v1/harnesses`, `POST /v1/harnesses/validate`, the existing
processor candidate endpoint, `GET /v1/runs/{id}/steps`, and
`POST /v1/runs/{id}/{pause|resume|cancel}`. No model calls happen in the MCP process.

## Import format

Files and directories resolve relative to `--import-root`; absolute paths are
also accepted inside that root. Resolved symlinks cannot escape it. Folder imports
recurse through supported document types. Each call accepts up to 200 documents,
each slightly under 25 MiB to leave room for the multipart request envelope.
Larger collections can be imported in batches into the same dataset ID.

Example directory:

```text
imports/
  invoices/
    first.pdf
    second.pdf
  labels.csv
```

CSV filenames are relative to **import-root**, including directory names:

```csv
filename,InvoiceNumber,Total,Approved
invoices/first.pdf,INV-101,12.5,false
invoices/second.pdf,INV-102,0,true
```

```json
{
  "paths": ["invoices"],
  "dataset_name": "September invoices",
  "annotations_file": "labels.csv",
  "column_mapping": {
    "InvoiceNumber": "invoice_number",
    "Total": "total",
    "Approved": "approved"
  },
  "verified": true,
  "dry_run": true
}
```

Mapping values may use dotted object paths, such as `vendor.name`. CSV cells
parse as JSON when valid: `0`, `false`, `null`, arrays and objects keep their
types. Plain text stays text. To force a numeric-looking value to stay a string,
encode a JSON string inside the CSV cell. Blank cells are unannotated; use `null`
for an explicitly null expected value. Duplicate filenames, overlapping field
mappings, malformed rows and unmatched annotation filenames fail preflight.

Alternatively, JSON annotations map each relative filename to its expected-value
object:

```json
{
  "invoices/first.pdf": {"invoice_number": "INV-101", "total": 12.5},
  "invoices/second.pdf": {"invoice_number": "INV-102", "total": 0}
}
```

File content hashes identify duplicates. Imports reuse existing documents and
membership, preserve existing annotations, and preserve a member's split/tags.
An import is not a single transaction: if an upload fails, completed files remain
saved and the response lists each failure. Retrying the same unchanged files and
dataset is safe. To replace an existing annotation, use `save_expected_values`
with its current revision instead of reimporting it.

## Working alongside Studio

The live standalone Studio checks the database revision every two seconds while
visible and on window focus. New documents, datasets, versions and runs appear
without a reload. The static demo is unaffected.

Your configuration and expected-value editor contents remain local while you
edit. Saves include the version/revision originally loaded. An external change
causes a conflict instead of overwriting that change. Load the latest processor
version, or use **Reload saved values**, to reconcile deliberately.

Agent candidates append immutable draft versions without touching the shared
processor draft. The agent must name the candidate version explicitly when
evaluating it. Candidates are not automatically published. Annotations carry
an author such as `mcp:codex`; candidate versions and runs also retain attribution.

Generated annotations default to **unverified**, are labeled in Studio, and are
excluded from evaluation scores. Set `verified=true` only for annotations already
verified by the user; reviewing them against the source and saving ground truth
in Studio makes them eligible for future evaluations. Historical scores retain
their original expectations.

Evaluation jobs live in the API process and persist their status in SQLite.
Disconnecting or restarting an MCP client does not cancel them. Reuse the exact
`request_key` and arguments after an uncertain submission to avoid duplicate
runs. Reusing a key with different arguments is an error. An API restart marks
unfinished jobs interrupted; inspect the saved run. On a harness-enabled backend,
resume that run to reuse completed work instead of submitting a new job.
The API runs at most two agent jobs at a time and accepts up to eight unfinished
jobs. A benchmark edited during a job is reported as a failure even if extraction
results were saved; rerun before comparing. Comparisons reject incompatible
benchmark snapshots.

Model execution still uses the backend's configured providers, including hosted
models and parsers. Read the run's warnings and per-document failures before
concluding a particular provider succeeded.

## Verify

```sh
.venv/bin/ezpz-mcp --help
.venv/bin/python -m unittest backend.tests.test_mcp
.venv/bin/python -m unittest discover -s backend/tests
```

The MCP tests start a disposable API and actual STDIO subprocess, import CSV and
JSON annotations, exercise evaluation and candidate comparison, reconnect, and
check conflict handling and path restrictions. They use the deterministic local
adapter and temporary storage. Install the MCP extra to run them; without it,
the optional MCP tests are skipped.

In the standalone Studio checkout, `.venv/bin/python -m unittest backend.tests.test_mcp_harnesses`
checks harness discovery and validation over STDIO, candidate conflicts, paginated
traces, reconnect/pause/resume/cancel, and interrupted provider attempts.

In the standalone Studio checkout, `npm run test:mcp:browser` runs the external-change, conflict, annotation-review, and result-link flow in a disposable browser workspace. Set `EZPZ_TEST_PYTHON` to the Python environment containing the backend dependencies.

Implementation uses the [official MCP Python SDK](https://py.sdk.modelcontextprotocol.io/).
