# Source development and merge-to-production deployment

## Develop without a wheel

Use Python 3.12 and Node.js 24 (`nvm use`). From the repository root:

```sh
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements.lock
npm ci
.venv/bin/python scripts/dev.py
```

Open **http://127.0.0.1:5180/**. Edit `src/` for the live frontend and
`backend/` for the API. Vite hot reloads frontend edits; Python changes and the
workspace's `.env`/`ezpz.yaml` restart the API. Ctrl+C stops both services. A
Python startup error stays visible in the terminal; saving a correction retries
startup. No wheel, installation, Docker build, or redeployment is involved.
Repeat dependency installation only when dependency files change.

The default workspace matches the installed wheel's persistent workspace,
including `EZPZ_WORKSPACE` if set. To use this checkout's existing data/config,
pass `--root .`; to keep development data separate, pass
`--root ./.local-test/dev-workspace`. The selected workspace is printed at
startup. Pass the same explicit root you previously used with the wheel when
you want to continue working with that data.

Stop any other Studio using ports 4173 or 5180 before starting. `--port 4174`
changes the API port and updates Vite's proxy automatically; the frontend stays
on 5180, which the API permits for local Settings requests. API restarts interrupt
in-flight work, so finish long evaluations before editing backend code.

On Windows, use `py -3.12 -m venv .venv` and replace `.venv/bin/python` with
`.venv\Scripts\python.exe`. The same development supervisor handles Ctrl+C and
backend reloads.

`npm run dev` still runs the frontend only, and `npm start` remains available for
its existing launcher/configuration overrides. Use `scripts/dev.py` when you
want automatic backend reloads.

## Checks and builds

| Purpose | Command |
| --- | --- |
| Backend | `.venv/bin/python -m unittest discover -s backend/tests` |
| Frontend | `npm test` |
| Source development lifecycle | `.venv/bin/python scripts/test-dev.py` (macOS/Linux; free port 5180) |
| Browser flow | `EZPZ_TEST_PYTHON=.venv/bin/python npm run test:e2e` |
| Wheel/source archive | Install Python `build`, then `.venv/bin/python scripts/build-package.py` |
| Wheel install/reinstall | `.venv/bin/python scripts/test-install.py release/<wheel>.whl` |

Release assets are staged under `backend/studio/`; wheels and source archives go
in `release/`. They are not needed for daily development and are not committed.
CI retains existing browser, container, architecture, and clean-install checks.

Portable Docker bundles pin their Compose file to the exact image included in
the archive. Both launchers disable registry pulls; the source checkout's
`EZPZ_IMAGE` override does not replace a bundle's image. Installer checks verify
the configured image and the running container's image ID before checking readiness.

The public demo lives in `demo-site/`. Its build refreshes the demo from the
live `src/` tree automatically. To preview and validate it:

```sh
cd demo-site
pnpm install --frozen-lockfile
pnpm build
pnpm test:demo
pnpm check:deploy
pnpm preview
```

`check:deploy` is a Wrangler dry run and does not publish. The lockfile pins
Wrangler, and pnpm explicitly permits its esbuild/workerd installation scripts.

## Deployment after merging

The main CI workflow calls the static-demo workflow on every PR, merge queue
candidate, default-branch push, and manual CI run. The demo build publishes a
`cloudflare-site-<commit>` artifact only after its checks and Wrangler dry run
pass. The verified wheel also waits for these site checks.

Only a **push to the default branch** can run `Deploy merged site to Cloudflare`.
It waits for all verification and clean-install jobs, then downloads and deploys
that exact site's artifact. It does not rebuild the site during deployment.
PRs, merge queue candidates, and manual builds never publish to Cloudflare.
Deployments are serialized, and superseded commits are skipped to prevent a
rerun of an old commit from rolling production back. Failed checks leave the
previous production version in place.

## One-time GitHub and Cloudflare settings

1. Create the GitHub environment `cloudflare-production`, restricted to `main`.
   Add `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` as environment secrets
   (repository secrets also work). Use Cloudflare's **Edit Cloudflare Workers**
   token template scoped to the target account. For automatic post-merge deploys,
   leave required reviewers disabled on this environment.
2. Require pull requests and successful checks on `main` through a repository
   ruleset. This prevents direct pushes from becoming an alternate deployment
   trigger. The existing CI push filter targets `main`; update it if renaming the
   default branch.
3. Confirm `demo-site/wrangler.jsonc` names the existing Worker serving the domain
   (`ezpz-studio`). The configuration uses **Workers static assets**, publishing
   `demo-site/dist/`; it does not deploy the Python backend or a Pages project.
4. In Cloudflare **Workers & Pages → ezpz-studio → Settings → Builds**, disconnect
   the independent Git repository integration. GitHub Actions owns deployment;
   a separate Cloudflare Git build can otherwise publish before CI finishes.
   If the domain currently points to Pages, resolve that target and disable its
   automatic Git deployments before enabling this Workers deployment.
5. Merge the PR, then check **Actions → Build and verify Studio**. Deployment must
   run after verification. Wrangler reports the Worker URL; verify the landing
   page and `/studio/`. The verified-wheel download remains available if the
   Cloudflare job fails.

Missing deployment secrets produce a specific error with these setup steps.
After fixing settings, rerun the failed jobs on the latest default-branch push.
Manual workflow dispatches build/test packages but do not deploy.

References: [Cloudflare GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
and [Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/).
