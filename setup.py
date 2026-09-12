"""Refuse to ship a backend-only or incomplete Studio release."""

import hashlib
import json
import shutil
from pathlib import Path

from setuptools import setup
from setuptools.command.build_py import build_py
from setuptools.command.sdist import sdist


def check_studio():
    root = Path(__file__).resolve().parent / "backend" / "studio"
    try:
        manifest = json.loads((root / "studio-manifest.json").read_text(encoding="utf-8"))
        if manifest["application"] != "ezpz-live-studio" or "index.html" not in manifest["files"]:
            raise ValueError("Not a live Studio build")
        for name, checksum in manifest["files"].items():
            if hashlib.sha256((root / name).read_bytes()).hexdigest() != checksum:
                raise ValueError(f"Asset checksum mismatch: {name}")
    except (OSError, ValueError, KeyError) as error:
        raise RuntimeError(
            "A built live Studio is required. Run: python scripts/build-package.py --frontend-only. "
            "For installation without Node.js, use a release wheel or source distribution."
        ) from error


class StudioBuild(build_py):
    def run(self):
        check_studio()
        # setuptools otherwise retains chunks removed by a newer frontend build.
        previous_assets = Path(self.build_lib) / "backend" / "studio"
        if previous_assets.exists():
            shutil.rmtree(previous_assets)
        super().run()


class StudioSdist(sdist):
    def run(self):
        check_studio()
        super().run()


setup(cmdclass={"build_py": StudioBuild, "sdist": StudioSdist})
