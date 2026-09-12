# Harnesses and resumable evaluations

A processor's **Harness** tab defines how it extracts data. The saved processor version includes the complete harness, along with its schema, prompt, parser, and model settings.

Start with a recipe, then select individual blocks to edit them. Recipes cover direct document extraction, parsed extraction, tiered extraction, majority vote, verification and repair, and per-page extraction. Blocks can be nested: for example, start with a cheap model, then send unresolved fields to a three-model vote. **Flow overview** shows the composition without the settings panel; **JSON** supports editing and importing the same configuration. The React Flow canvas supports dragging nodes, pan/zoom, a minimap, and automatic layout. Select a node to edit its settings; choose **Open flow** to edit nested tiers, branches, or repair steps, and use the breadcrumb to return to the main flow. Dropdowns use Studio’s shared field selector.

Select any arrow, including a dotted conditional arrow, to edit its source, destination, and condition in the settings panel. Drag either of its visible endpoint circles onto another handle to reconnect it. Choose **Delete connection**, or select the arrow and press Delete/Backspace, to remove it. **Undo** restores the previous connections. All flow types support these controls.

Bottom handles continue **Always**. Right handles continue when the current fields are **Accepted**; left handles continue when they are **Unresolved**. Conditions use the containing flow’s confidence and validation settings. Drawing another arrow adds a route; reconnecting an arrow replaces that route. The first connection edit saves an explicit `routing.edges` list in the processor version. Subsequent execution follows those edges, including inside tiers, votes, gates, repair attempts, and per-page processing. Older harnesses retain their original behavior until edited.

Add steps, tiers, or branches from the toolbar. In a flow with explicit connections, connect new nodes to include them in execution. Independent activated branches run concurrently; a join waits for its predecessors and merges their fields, marking conflicts unresolved. A majority-vote output counts each connected source once and keeps the quorum of the configured voter set. Disconnected voters abstain. Disconnected steps do not execute. Cycles, invalid endpoints, and a missing path from input to output prevent running or saving a version; incomplete working copies remain locally editable. Use a bounded repair block for repetition.

Node positions are remembered locally and do not change the saved execution configuration or invalidate checkpoints.

## Blocks and policies

| Block | Behavior |
| --- | --- |
| Sequence | Runs its child blocks in order. |
| Parse | Converts the source to document text and layout using the selected parser. |
| Extract | Runs the default model or a per-block provider/model override, with optional field scopes and prompt settings. |
| Validate / Gate | Checks the JSON schema, confidence, critical fields, and optional arithmetic rules; a gate chooses its pass or fail branch. |
| Tiered extraction | Tries successive tiers until the acceptance policy passes; escalation can cover the whole document or only unresolved fields. |
| Majority vote | Runs independent branches and selects values that meet a strict majority of the configured voters. |
| Parallel | Combines branches with disjoint field responsibilities; conflicting outputs remain unresolved. |
| Verify / Repair | Gives a model the source, the current candidate, and validation feedback, with a bounded number of repair attempts. |
| Per page | Runs a block against each parsed page and merges outputs; conflicting scalar values remain unresolved. |
| Return | Records the current acceptance checks. |

Document input bypasses parsing until an explicit Parse block. PDF/image input requires an adapter and model that support that format. The deterministic development adapter accepts text, not raw PDFs or images. Parsed input runs the configured parser before the flow.

Confidence thresholds operate on each model's reported confidence; missing confidence escalates by default. This is not a calibrated probability of correctness. Voting agreement is recorded separately and does not replace model confidence. Missing or invalid voter results abstain; the denominator remains the configured number of voters. Table voting requires an explicit row key, and page-table merging rejects missing or conflicting keys. Numeric tolerance and string normalization can be configured per field.

The limits control logical model steps per document and concurrent provider calls. An interrupted request may need another attempt, so the step limit is not a monetary cap. Repair attempts are bounded; arbitrary graph cycles are not supported. Existing legacy and custom harness configurations remain intact until explicitly replaced with a recipe.

Inspect **Execution steps** after a preview or evaluation to see model calls, gate decisions, candidates, usage, and provenance. An interrupted evaluation also exposes its saved operation attempts. Code export includes the saved harness and uses the local runtime.

## Close the laptop and continue later

Dataset evaluations run in the local backend, independently of the browser. Completed documents and completed parser/model steps are persisted to disk using SQLite and LangGraph checkpoints.

1. Start an evaluation. You can close the browser while the backend continues.
2. Optionally select **Pause** before closing your laptop. The current provider call is allowed to finish and save; the worker stops before its next operation.
3. While the laptop sleeps, local computation is suspended. On wake, a still-running process can continue. If its network request failed, the run becomes **Interrupted**.
4. Reopen Studio and select **Resume evaluation**. If the backend stopped, restart it first; startup recognizes unfinished runs. Resume keeps the same run, frozen document membership, source hashes, ground truth, and processor version.

Completed work is reused. An external request interrupted before its response was saved can be repeated and charged again by its provider; Studio records this ambiguity. A restart never automatically launches new paid work. **Cancel** stops remaining work at the next operation boundary and preserves results already recorded.

Keep the workspace data directory (or Docker data volume). It contains the source files, application database, `harness-state` checkpoints/artifacts, and `evaluation-state` ownership locks. Back up the complete directory with the service stopped. Checkpoints refer to the original configuration and source: missing/changed source files or an incompatible execution-engine version prevent unsafe continuation. Older runs without a frozen benchmark cannot resume.

This is same-machine recovery; computation does not continue while the laptop is asleep. It does not require a remote worker, hosted LangGraph service, or device synchronization.

## Verification

Run `.venv/bin/python -m unittest backend.tests.test_resumable_harness` and `npm run test:harness` after installing dependencies. Coverage includes process termination during a later document's model call, checkpoint reuse in cascades and parallel voters, frozen benchmark recovery, field scopes, repair feedback, voting, logical call limits, and browser pause/reload/resume. Physical laptop sleep is not automated by these tests.

## MCP clients

Codex, Claude and other MCP clients can discover recipes, validate and save harness
candidates, inspect execution traces, and pause/resume/cancel evaluations. See
[MCP harness workflows](mcp.md#harness-workflows) for the tools and connection setup.


### Bounding boxes without a parser

Choose **Original document · no parser** as the flow's document input and use an
Extract step with a PDF/image-capable model. The existing provider adapters send
the original file directly. No OCR, layout parser, or text matching is needed to
produce the boxes.

For PDF and image input, each extraction leaf returns `value`, `confidence`, and
`evidence: [{"page": 1, "bbox": [0.1, 0.2, 0.4, 0.3], "text": "visible source"}]`.
Pages are physical, 1-based page numbers; boxes use normalized `[left, top, right,
bottom]` coordinates with a top-left origin. Nested fields and array fields can
cite several regions or pages. Plain text input keeps the existing value and
confidence contract because it has no visual coordinates.

Malformed, non-finite, out-of-range, reversed, and empty boxes are discarded, as
are page numbers outside the known document page count. Null values have no
visual evidence. The backend marks accepted boxes with `bbox_source: "model"`;
the viewer shows dashed boxes and labels them as model estimates. This validates
the shape of a box, not its spatial accuracy. If a model cannot locate a value,
it should return an empty evidence array.
