# ezpz studio static demo

A minimal landing page and interactive, browser-only demo of [ezpz studio](https://github.com/jonmoubayed/ezpz-studio).

The working studio lives at the repository root. This folder is a separate frontend project with its own dependencies and build output.

## Run locally

Use Node.js 24 and pnpm 11.17.0, then run from this folder:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

## Build and host

```sh
pnpm build
pnpm test:demo
pnpm preview
```

Configure the static host's project root as `demo-site`, its build command as `pnpm install --frozen-lockfile && pnpm build && pnpm test:demo`, and its publish directory as `dist` (or `demo-site/dist` relative to the repository root).

Serve the output at the domain root, with `studio/index.html` retained. No backend, Python process, API keys, functions, or proxy is required. This directory's location in the repository does not mean it can be served under a `/demo-site/` URL prefix; asset URLs currently require a domain root.

## Cloudflare Workers

Connect this repository's `main` branch and set the root directory to `demo-site`.

- Build command: `pnpm install --frozen-lockfile && pnpm build && pnpm test:demo`
- Deploy command: `npx wrangler deploy`
- Build variables: `NODE_VERSION=24` and `PNPM_VERSION=11.17.0`

The committed `wrangler.jsonc` sets the Worker name to `ezpz-studio`, the compatibility date to `2026-09-03`, and the static assets directory to `dist`. No Worker script or backend is deployed. Cloudflare handles HTML index routes; unknown paths return 404.

Remove old `--name ezpz-demo` arguments from the dashboard's deploy command. Deploy the latest commit after saving the settings, rather than retrying an older commit without this configuration.

## What the demo does

- Sample extraction, evaluation scores, and review data are simulated.
- Selected documents are displayed using browser-local blob URLs; their contents are not uploaded.
- Provider/API transports, writes, sockets, and telemetry beacons are disabled.
- Settings are isolated in local browser storage. Reset demo restores fixtures.
- The full working studio remains separate and can make real calls when configured.

See [hosting and isolation details](docs/static-demo.md). GitHub links default to the parent repository; `VITE_REPOSITORY_URL` can override that public URL.

## Refresh the studio snapshot

```sh
node scripts/sync-studio-preview.mjs
pnpm build
pnpm test:demo
```

The sync source defaults to the parent repository. Source refresh reapplies the demo restrictions and selected logo. Unexpected source changes fail with an error for review.
