# Luna-only contract extraction

`notice-luna.json` is a portable configuration exported from the Notice processor's Luna-only candidate. It contains the 17-field schema, source-grounded instructions, model, parser, and complete harness; it contains no document results, credentials, local paths, or workspace IDs.

The workflow sends the original document to `gpt-5.6-luna`, then validates the result. It has one extraction block and a limit of one logical model call per document. There are no fallback models. Validation keeps the 0.85 confidence threshold and marks missing confidence unresolved; it does not call another model. Provider retries are not a monetary spending cap.

This configuration requires the workflow-capable ezpz runtime and MCP tools (`harnesses` capability); the legacy runtime in this repository's base revision does not execute workflow configurations. It is an exported configuration, not a change to the application's default processor.

With that runtime, read the destination processor using `get_processor`, validate the file's `harness` against its `schema` using `validate_harness`, then pass the file contents as `config` to `save_processor_candidate` with the destination processor ID and its latest `expected_version`. This appends an immutable draft candidate. It does not publish or run it, and preserves editor drafts. Evaluate the returned version explicitly when ready; running it uses the configured provider credentials and can incur charges.
