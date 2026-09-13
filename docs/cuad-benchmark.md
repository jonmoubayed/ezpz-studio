# CUAD renewal extraction benchmark

Import 50 real contract PDFs and their human annotations into local Studio. The
starter processor extracts **document name, agreement date, effective date,
expiration date, renewal term, notice period to terminate renewal, and termination
for convenience**. The import creates an unrun baseline configuration; it makes
no model calls.

## Import

From the `ezpz-studio-redesign` checkout, start Studio with `npm start`. Its Python
environment needs the normal project dependencies (`python3 -m venv .venv`, then
`.venv/bin/python -m pip install -e .`). Provider credentials belong in this
checkout's ignored `.env`, as described in the deployment guide.

In another terminal:

```sh
python3 scripts/import-cuad.py --source /Users/jonmoubayed/Documents/cuad --count 50 --holdout 10 --import
```

Omit `--import` to prepare and inspect the bundle without changing Studio. Source
may point to the parent directory or directly to `CUAD_v1`. The script uses only
Python's standard library; preparation works even while Studio is stopped.
`--api` defaults to the local backend at `http://127.0.0.1:4173`. `--model` changes
the OpenAI starter model (default `gpt-4.1-mini`); it does not invoke it.

The default sample uses seed `notice-cuad-v1`, SHA-256 ordering and equal numbers
of contracts with/without annotated non-renewal notice clauses. The 10-document
holdout contains five from each group. This intentionally enriches renewal cases;
it is not a representative estimate of their prevalence across CUAD. Byte-identical
PDFs are deduplicated. Related contracts/templates can still occur across splits.

Studio gets three dataset views referencing the **same 50 documents**:

| Dataset | Documents | Purpose |
| --- | ---: | --- |
| CUAD renewals · 50 documents | 50 | Browse all PDFs and expected values |
| CUAD renewals · development | 40 | Tune prompts and compare experiments |
| CUAD renewals · holdout | 10 | Final evaluation after selecting a prompt |

Development and holdout each get a baseline experiment pinned to the published
starter processor version. No evaluations are started or scores manufactured.

Re-running with the same inputs verifies existing content and reuses documents,
memberships, ground-truth revisions, processor versions and experiments. A changed
ground truth or dataset split stops the import instead of replacing your edits.
A partial import can be resumed. A new seed/count/source annotation fingerprint
defines a different benchmark; documents that already have another benchmark's
ground truth cause a conflict, so use a separate workspace for independent sets.

## Run prompt experiments

1. Open [local Studio](http://localhost:5180/#Evaluations). Use its live API mode,
   not the illustrative demo mode. Open **CUAD renewals · development** and
   **Renewal extraction baseline**, then run the evaluation.
2. Review field-level failures and the source PDF. The processor uses local native
   PDF text parsing; changing to an OCR/other parser is also an experimental change.
3. Edit the CUAD processor prompt in **Processors**, publish a new version, and
   create another experiment in the same development evaluation group using that
   version. Run it on the same dataset, then compare runs. Studio snapshots the
   configuration and benchmark annotations for each run.
4. After choosing your prompt, create an experiment in **CUAD renewals · holdout**
   using that published version. Treat the holdout as a final check, not another
   prompt-tuning set. The imported baseline there remains available for comparison.

The existing API also supports runs: POST `/v1/runs` with
`{"eval_experiment_id": "<ID from import-result.json>", "background": true}`.
This starts billable model work using the configured provider; the importer never
sends that request. For subsequent prompt versions, create a new experiment in the
same group with the new `processor_version_id` before running it.

## Ground-truth handling and scoring

CUAD's SQuAD JSON contains **clause spans**. Its CSV contains the corresponding
**human-normalized answers**. A clause quote is not used as an expected date or
duration. Original CSV cells and all 41 SQuAD categories are preserved verbatim in
the bundle, including answer offsets and full source contexts.

- Complete dates are normalized to ISO `YYYY-MM-DD`. Two-digit years use Python's
  documented `%y` pivot: 00–68 means 2000–2068, 69–99 means 1969–1999. Original
  strings remain available for auditing.
- Missing normalized answers with no annotated clause become explicit `null`.
  A blank answer **with a clause present**, partial dates and date alternatives are
  omitted from scoring rather than converted into invented values or null targets.
- Expiration may be the literal `perpetual`. Relative or incomplete date answers
  remain in the source labels and are unscored in the single-date field.
- CUAD's Yes/No termination answer becomes a boolean; `false` is scored and is
  not treated as a missing annotation.
- Studio uses its existing field-level normalized exact-match scorer. Duration
  wording is preserved, so semantically equivalent wording (for example `12
  months` versus `1 year`) can fail strict matching. Review individual failures;
  this is not the official CUAD span-overlap metric or a semantic judge.
- Coverage reports distinguish positive, negative and unscored fields. Overall
  field accuracy includes correct negative answers; inspect positive-field failures
  too. Do not configure `required_fields` to force unknown labels into the score.
- Source span offsets refer to the SQuAD context, **not PDF page positions**. No PDF
  bounding boxes or page citations are fabricated.

Expected values live in Studio's ground-truth store. They are never prepended to
PDFs, supplied as OCR text, or included in the extraction prompt. The PDF parser
and model receive the contract only. A native parser check is useful before a
large run because extraction quality is part of this PDF benchmark.

CUAD does not label Notice's subscription prices, seats or a present-day notice
deadline. Renewal options do not uniformly imply auto-renewal. This benchmark
does not invent targets for those fields. CUAD is public and may be present in
model training data; use this subset to compare your extraction configurations,
not as a claim of performance on unseen private vendor contracts.

## Local artifacts

The importer writes to `.ezpz/imports/cuad-<fingerprint>/` (ignored by Git):

| File | Contents |
| --- | --- |
| `manifest.json` | Source hashes, selected titles, PDF hashes, splits, attribution |
| `ground-truth.jsonl` | All 41 original categories, CSV rows, contexts, and normalized renewal targets |
| `coverage.json` | Counts of scored, positive, negative, and ambiguous fields |
| `processor.json` | Reusable baseline prompt, schema, parser and model settings |
| `import-result.json` | Local document/dataset/processor/experiment IDs |

Keep this directory with your benchmark records. Original PDFs stay in the CUAD
download and are copied to Studio's existing content-addressed blob store on
import. Changing `--output` relocates the artifacts without changing selection.

Tests: `.venv/bin/python -m unittest backend.tests.test_cuad` exercises selection,
date/null handling, span validation, real local API import, idempotence, protection
of existing edits, and scorer behavior with deliberately wrong predictions.

## Attribution

Source: **Contract Understanding Atticus Dataset (CUAD), v1**, The Atticus Project
and CUAD contributors, [source repository](https://github.com/TheAtticusProject/cuad),
licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). This importer
selects a subset, creates development/holdout splits, maps seven fields and
normalizes complete dates. Original annotation values are retained for inspection.
