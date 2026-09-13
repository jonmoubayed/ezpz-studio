#!/usr/bin/env python3
"""Prepare and optionally import a CUAD benchmark; never starts model runs."""

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.cuad import prepare_bundle, write_bundle
from backend.cuad_import import LocalStudio, import_bundle


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True, help="Directory containing CUAD_v1, or CUAD_v1 itself")
    parser.add_argument("--count", type=int, default=50)
    parser.add_argument("--holdout", type=int, default=10)
    parser.add_argument("--seed", default="notice-cuad-v1")
    parser.add_argument("--model", default="gpt-4.1-mini", help="OpenAI baseline model; configurable later in Studio")
    parser.add_argument("--api", default="http://127.0.0.1:4173")
    parser.add_argument("--output", type=Path, help="Default: .ezpz/imports/cuad-<fingerprint>")
    parser.add_argument("--import", dest="import_to_studio", action="store_true", help="Upload PDFs and labels, create datasets and baseline experiments")
    args = parser.parse_args()
    try:
        bundle = prepare_bundle(args.source, args.count, args.seed, args.holdout, args.model)
        output = args.output or ROOT / ".ezpz" / "imports" / ("cuad-" + bundle["fingerprint"][:12])
        existing = output / "manifest.json"
        if existing.exists() and json.loads(existing.read_text())["fingerprint"] != bundle["fingerprint"]:
            raise ValueError("Output contains a different benchmark; choose a new --output directory")
        write_bundle(bundle, output)
        print("Prepared {} contracts: {} development / {} holdout".format(args.count, args.count - args.holdout, args.holdout))
        print("Bundle: " + str(output))
        if args.import_to_studio:
            result = import_bundle(LocalStudio(args.api), bundle, output)
            print("Verified {} documents; {} newly uploaded. No model runs started.".format(result["verified_documents"], result["uploaded"]))
            print("Open Studio: http://localhost:5180/#Evaluations/group/" + result["experiments"]["dev"]["group_id"])
        else:
            print("Preparation only. Add --import to load this bundle into local Studio.")
    except (ValueError, KeyError, OSError, RuntimeError) as error:
        parser.exit(1, "CUAD import: {}\n".format(error))


if __name__ == "__main__":
    main()
