#!/usr/bin/env python3
"""Build the live frontend and a self-contained Python wheel/source release."""

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-install", action="store_true", help="reuse installed frontend dependencies")
    parser.add_argument("--frontend-only", action="store_true", help="stage assets without building Python distributions")
    args = parser.parse_args()
    npm = shutil.which("npm")
    if not npm:
        parser.error("Node.js and npm are needed to BUILD releases; installed releases do not need them.")
    frontend = ROOT
    if not args.skip_install:
        subprocess.run([npm, "ci"], cwd=frontend, check=True)
    subprocess.run([npm, "run", "build"], cwd=frontend, check=True)
    assets = ROOT / "backend" / "studio"
    if assets.exists():
        shutil.rmtree(assets)
    shutil.copytree(frontend / "dist", assets)
    notices = assets / "licenses"
    shutil.copytree(frontend / "licenses", notices, dirs_exist_ok=True)
    shutil.copy2(frontend / "EXTEND-LICENSE.md", notices)
    shutil.copy2(frontend / "LICENSE", notices / "studio-LICENSE")
    files = {
        path.relative_to(assets).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(assets.rglob("*")) if path.is_file()
    }
    (assets / "studio-manifest.json").write_text(
        json.dumps({"application": "ezpz-live-studio", "files": files}, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Staged live Studio ({len(files)} files) in {assets}", flush=True)
    if not args.frontend_only:
        subprocess.run([sys.executable, "-m", "build", "--outdir", "release"], cwd=ROOT, check=True)


if __name__ == "__main__":
    main()
