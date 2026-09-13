# Notice benchmark

This benchmark tests **Notice's contract extraction task**. It does not test
CUAD's 41 legal clause categories. CUAD is a source of real documents and some
reusable date/notice annotations.

## What's included

| Cohort | Count | Use |
| --- | ---: | --- |
| Real vendor contracts — development | 40 | Develop prompts and inspect failures |
| Real vendor contracts — holdout | 10 | Final comparison after selecting a prompt |
| Authored fictional edge cases | 10 | Deterministic regression coverage; report separately |

The 50 real PDFs include 16 hosting, 12 maintenance, 10 outsourcing, 6 service,
4 licensing and 2 consulting documents. The broader vendor mix includes software,
data/content licenses, outsourced operations and a few physical-service contracts.
Employment agreements, financial capital-maintenance agreements, a press release
and a co-marketing agreement were excluded during source review. A few incomplete
orders and amendments remain intentionally: Notice should not invent their missing
terms. Files from the same filing-company family stay on one side of the real
development/holdout split. This does not establish full template independence.

The fictional cases cover annual subscriptions, monthly services, business-day
notice, receipt cutoffs, price increases, per-seat prices with no stated total,
manual renewal, an overriding amendment, conflicting notice periods, and missing
notice destinations/time zones. All are visibly marked as fictional test contracts.
They are text files, so Notice's text-evidence validation is exercised alongside
the real PDF path. They are not independent evidence of real-world accuracy.

## What actually runs

The Studio processor uses `backend.notice_harness:run`, which invokes the local
Notice project's `scripts/eval-bridge.ts`. That bridge calls the same
`OpenAIExtractionProvider` and `validateExtraction` used by Notice. It forwards
original PDF bytes (or original text), uses the saved Studio System prompt, and
keeps Notice's structured schema, missing/conflicting statuses and source-evidence
rules. It creates no Notice contract records and never marks terms verified.

The schema includes vendor, service start/end, explicit renewal date, auto-renewal,
notice period/unit, timezone, next-term amount, currency, billing, months, seats,
uplift, cancellation method, recipient and deadline conditions. Each field retains
Notice's `value`, `status`, `excerpt` and `location` structure. Studio's usual
confidence wrapper is bypassed; Notice doesn't generate confidence scores.

The native PDF parser supports Studio previews and evidence display; its extracted
text is not substituted for the PDF passed to Notice. Ground truths and dataset
metadata never enter the model request. This is not an end-to-end test of Notice's
upload/storage, user verification, or deadline-calculation workflow.

The processor pins hashes of the Notice provider, domain and bridge files. If
those files change, old configurations refuse to run against silently changed
code. Re-import to export a new processor snapshot. Prompt edits in Studio do not
change those files and can be compared normally. The bridge currently supports
OpenAI models because that is Notice's current production provider.

## References and honest scoring

**The real PDFs do not have complete human-reviewed Notice ground truths.** Their
references combine:

- Existing CUAD human date/notice answers, reused only when the supporting source
  fits Notice's definition. Derived expiration dates are not treated as explicit
  renewal dates, and amendment execution dates are not treated as service starts.
- Supplier-role and renewal-clause references reviewed by Codex against source
  passages, plus a small number of additional billing/currency/notice references.
  These are assistant-reviewed references, not an independent human labeling pass.
- A full-document absence review for one short hosting agreement.

Every scored positive reference is checked against text in the actual PDF.
Source excerpts, available page locations and reference provenance are preserved
in the bundle and Studio's ground-truth evidence. Fields that lack a defensible
reference are **omitted from scoring**, not labeled absent. A raw CUAD blank cell
never by itself means a Notice field is absent. Redactions remain unresolved.

For authored cases, expected facts are written alongside the source. Absence is
represented by a null expected value and `not_found` status. For a conflict or a
free-form clause whose wording can vary, some references score status only. Exact
excerpt/location strings are not scored: multiple correct quotes and locations
are possible. Notice's own text validator still rejects unsupported quotes; PDF
quotes retain the production behavior of requiring user review.

Studio reports normalized exact-match field scores on the annotated leaves only.
Inspect value and status failures separately. A supplier alias or equivalent
wording can fail exact matching; resolve these as reference/scoring issues rather
than assuming the extraction is wrong. Dates and periods should be assessed under
Notice's definitions, especially `days` versus explicitly stated calendar days.

`coverage.json` reports reference counts per field and cohort. `review-queue.json`
lists unscored real-contract fields for additional annotation. Real pricing,
timezone, seat and notice-destination coverage is much thinner than vendor and
renewal-clause coverage. Use the separate regression set for those behaviors while
building a stronger real-document reference set. These are public historical
contracts, not a representative sample of modern SaaS purchases.

## Run experiments

1. Open Studio in live mode and choose **Notice · vendor contracts · development**.
   Open **Notice baseline**, then run it. Importing alone does not call a model.
2. Inspect incorrect values/statuses alongside the PDF and reference evidence.
3. Open the **Notice · production extractor** processor. Edit its **System prompt**,
   keeping the 17-field schema and custom Notice harness. Publish a new version.
4. Create a new experiment in the same development group with that version and
   compare its run with the baseline on the unchanged benchmark.
5. Run **Notice · authored edge cases** to catch regressions. Report its results
   separately from the real-contract results.
6. After selecting a prompt, create an experiment with that version in **Notice ·
   vendor contracts · holdout** and run the final check.

Runs use the existing local backend's `OPENAI_API_KEY`. Configure model pricing
in Studio if you need cost estimates; recorded token usage comes from Notice's
provider response. No paid model evaluation is started by the importer.

## Rebuild and import

From `ezpz-studio-redesign`, with Studio started using `npm start`:

```sh
npm run import:notice -- --source /Users/jonmoubayed/Documents/cuad --notice-root /Users/jonmoubayed/Documents/ChatGPT/Notice --import
```

Omit `--import` to prepare the bundle only. The project virtualenv needs the normal
backend dependencies (`.venv/bin/python -m pip install -e .`). The Notice checkout
needs its installed Node dependencies. No source contract PDFs are modified.

Selection and reviewed reference specifications live in `benchmarks/notice/selection.json`.
Generated data lives in ignored `.ezpz/imports/notice-v1/`:

- `benchmark.json`: selected files, Notice references, prompt/schema/harness snapshot.
- `coverage.json`: per-field reference counts, separated by cohort.
- `source-labels.jsonl`: original CUAD rows, contexts and all 41 labels for provenance.
- `review-queue.json`: real-contract fields that still need reference review.
- `fixtures/`: the 10 fictional source documents.
- `import-result.json`: Studio document, dataset, processor and experiment IDs.

Re-importing the same bundle reuses documents and creates no new ground-truth
revisions. Existing user edits cause a conflict rather than being overwritten.
The first migration may replace an untouched revision-1 CUAD import with Notice
references; that prior revision remains in Studio's annotation history. Previous
CUAD experiments should remain archived because their current shared document
references now target Notice. Existing historical runs retain their snapshots.

## Attribution and validation

Real documents and original CUAD labels: Contract Understanding Atticus Dataset
(CUAD) v1, The Atticus Project and contributors,
[source](https://github.com/TheAtticusProject/cuad),
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). This benchmark selects
documents, maps a subset of reference facts, adds assistant-reviewed annotations,
and creates separate authored fictional cases.

Validation: Notice's tests cover the production export, saved-prompt bridge,
source validation and stale-schema rejection. Studio's backend tests cover direct
date evidence, ambiguous notice units, missing/conflicting reference scoring,
original-byte forwarding, code drift, cohort separation and repeat imports.
