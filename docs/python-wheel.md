# Python wheel builds

Develop the React app in `src/` and the Python service in `backend/`. The
**Build and verify Studio** workflow builds both from the same commit, bundles
the frontend into the Python wheel, and checks that the installed app works
outside the checkout. Existing Docker builds and their checks continue to run.

## After merging

1. Merge the pull request into the repository's default branch.
2. Open **Actions → Build and verify Studio → the successful run**.
3. Click **Download verified build** in the run summary, or download the
   `ezpz-wheel-<commit>` artifact under **Artifacts**.
4. Extract the download and run the exact command in the summary:

   ```sh
   uvx --from "./ezpz_evals-<version>-py3-none-any.whl" ezpz studio
   ```

Replace `<version>` with the downloaded filename. The app starts the local API
and opens Studio in your browser. Stop it with Ctrl+C. Restart with the same
command to reopen your saved workspace. Python and package dependencies are
managed by uv; Node.js and Docker are not runtime requirements. OCR adapters
that invoke Tesseract still require Tesseract on the host.

Pull requests also build and test a wheel. Their `studio-candidate-<commit>`
artifacts are diagnostic builds; the final `ezpz-wheel-<commit>` artifact appears
only after the default-branch build passes every check. CI installs the same wheel
on Linux, macOS, and Windows with Python 3.12 and 3.14. Verified artifacts are kept
for 90 days, subject to the repository's retention policy. Use **Run workflow** on
the default branch for a manual rebuild.

CI adds the commit to the version, such as `0.1.0b1+g0123456789ab`, without
committing a version change back to the repository. Each download includes the
wheel, source archive, `BUILD.json` with the full commit and run URL, and
`SHA256SUMS`. Different commits produce distinct wheel versions. This workflow
uses Actions artifacts; it does not publish packages to PyPI.

## Local build

With Node.js/npm and Python available:

```sh
python -m pip install build
python scripts/build-package.py
python scripts/test-install.py release/ezpz_evals-0.1.0b1-py3-none-any.whl
```

The build runs `npm ci` and `npm run build`, stages the current `dist/` and license
notices under `backend/studio/`, and builds a wheel and source archive in
`release/`. Generated bundles are ignored by Git. `--skip-install` reuses installed
npm dependencies; `--frontend-only` stages the UI before installing the project
from source with pip. Python packaging rejects missing or modified staged assets
so a backend-only wheel cannot accidentally be shipped. Source archives contain
the built assets and can be turned into wheels without Node.js.

The smoke test creates a disposable virtual environment, installs the exact wheel,
verifies every bundled asset, uploads a synthetic document, saves annotations,
runs a deterministic evaluation, and verifies the data after reinstalling.
Its runtime PATH contains neither Node nor Docker, and no paid model is called.

## Persistent workspace

Installed commands store data outside Python's installation directory:

- macOS: `~/Library/Application Support/ezpz`
- Windows: `%LOCALAPPDATA%/ezpz`
- Linux: `$XDG_DATA_HOME/ezpz`, or `~/.local/share/ezpz`

Use `EZPZ_WORKSPACE` or `--root /path/to/workspace` to select another folder.
Source-checkout commands retain the existing checkout-root default. To open that
same data with an installed wheel, pass the checkout path explicitly with
`--root`. The frontend assets are served separately from the workspace.

Docker volumes remain managed by Docker. Installing a wheel does not copy or
move data between a Docker volume and a host workspace.

## Combined Studio 0.1.4

Studio 0.1.5 also separates structured extraction evidence from reference answers.
Unannotated `excerpt` and `location` leaves appear as expandable source evidence,
while raw JSON exports retain every leaf. Reviewed null answers display as
“Not found in source,” and unresolved reference conflicts have a distinct label.

The release builds the canonical `src/` frontend and `backend/` together. It includes
workspace switching, provider-key settings, the focused Hill climbing screen,
automatic optimization, the visual Harness editor, saved execution traces,
pause/resume, and the Notice custom harness adapter. Run `python scripts/build-package.py`
from this checkout; the CI wheel is built by the same script. Changes made in a
separate local checkout must be committed here before GitHub can package them.

Installed-wheel checks verify the workspace, credentials, hill-climbing and harness
APIs, the bundled Notice adapter, all asset checksums, and persistence after reinstall.
Browser checks exercise Settings, workspace isolation, Hill climbing, and Harness flows.

Studio and built-in harnesses run without Node. Notice's production adapter calls
its existing TypeScript provider and therefore requires the configured Notice checkout
and Node on the machine running evaluations. Its provider and schema hashes are
checked before execution. It uses the current workspace's saved OpenAI key.
