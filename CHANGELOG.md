# Changelog

## 0.1.0-beta.1

First self-contained, single-user local beta.

- Bundle the studio, Python API, native PDF parser, and English OCR in one Docker service with persistent storage.
- Produce portable ARM64 and AMD64 image bundles, launch scripts, and SHA-256 checksums.
- Restrict static serving to built assets; reject hidden paths, symlink escapes, untrusted hosts, and browser origins.
- Report model failures explicitly without substituting deterministic extraction.
- Freeze benchmark documents, annotation revisions, and processor versions at evaluation submission; use fresh extraction by default.
- Run evaluations in the background with progress, document errors, cancellation, and interrupted-run recovery.
- Require matching benchmark snapshots and completed runs for comparisons.
- Fix an intermittent schema JSON rendering crash.
- Validate the browser workflow, restart persistence, backup restoration, and a 100-document synthetic benchmark.

The beta retains the Extend schema builder, side-by-side document workspace, reusable processors, expected-value editing, evaluation groups and experiments, field-level review, and manual hill climbing.

See [deployment and beta limits](docs/deployment.md) before installing or upgrading. Public multi-user hosting, authentication, distributed queues, and automatic job resumption are not included.
