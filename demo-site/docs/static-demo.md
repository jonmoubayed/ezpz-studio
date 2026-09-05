# Hosting the static demo

Build with `pnpm build`, run `pnpm test:demo`, and serve or upload only `dist/`. `pnpm preview` serves this exact production output locally. The standalone studio and Python backend are separate from this public demo.

## Host configuration

- Publish directory: `dist`.
- Build command: `pnpm install --frozen-lockfile && pnpm build && pnpm test:demo`.
- Serve at the domain root. Subdirectory hosting is not currently supported by the bundled asset URLs.
- Keep the nested `studio/index.html` file and all generated assets. Navigation inside the studio uses hashes, so history rewrites are unnecessary.
- Serve `.wasm` as `application/wasm`, JavaScript as `text/javascript`, PDF as `application/pdf`, and fonts using their usual MIME types. Standard static hosts do this automatically.
- No backend routes, API proxy, functions, Python process, or provider credentials are needed.
- The optional `VITE_REPOSITORY_URL` is public and baked into the build. Do not add provider keys or other secrets to frontend environment variables.

## Demo behavior

Opening documents, changing configuration, simulating extraction/evaluations, and reviewing fields remain interactive. Sample results are illustrative. Uploaded files are opened as browser blob URLs, never transmitted. Real extraction of an uploaded file is unavailable. There is no API connection switch.

The demo uses a separate `ezpz-landing-demo-` local storage namespace. Reset demo restores its fixtures. Storage and files do not sync between visitors.

## Request boundaries

- The studio state cannot transition to live mode.
- `api.request` always rejects, with no underlying network transport.
- Both entry points install a transport guard: fetch/XHR allow only GET requests for same-origin static asset directories and same-origin blob URLs. API paths, external provider URLs, writes, sockets, event streams and beacons are blocked.
- Production HTML includes a Content Security Policy that restricts resources to the static origin and necessary browser-local resources.
- The original API-backed workbench is excluded from the public build.

Static asset downloads (including PDF, WASM, fonts and JavaScript) are expected. “No real calls” means no backend, extraction, provider or telemetry requests; it does not mean the browser loads zero files.

## Verification

Run `pnpm build && pnpm test:demo`. Serve `dist/` using an ordinary static server with no backend running. Open the demo directly at `/studio/index.html`, run a sample extraction, try an evaluation, inspect Settings, and verify that no `/v1` or external-provider requests appear in browser network activity.

`scripts/sync-studio-preview.mjs` reapplies `scripts/harden-studio-demo.mjs` after copying the standalone frontend. Hardening fails on unexpected source structure and is also mandatory before every build/dev startup, so a future sync cannot silently restore live mode. Rebuild and rerun the checks after every sync.
