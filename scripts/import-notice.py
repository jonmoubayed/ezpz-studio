#!/usr/bin/env python3
"""Build/import Notice's curated 50 real + 10 authored document benchmark."""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend.notice_benchmark import prepare
from backend.notice_import import import_notice
from backend.cuad_import import LocalStudio


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--notice-root", type=Path, default=ROOT.parent / "Notice")
    parser.add_argument("--output", type=Path, default=ROOT / ".ezpz/imports/notice-v1")
    parser.add_argument("--api", default="http://127.0.0.1:4173")
    parser.add_argument("--model", default="gpt-4.1-mini")
    parser.add_argument("--import", dest="load", action="store_true")
    args = parser.parse_args()
    bundle = prepare(args.source, args.notice_root, args.output, args.model)
    print("Prepared Notice: 50 real vendor contracts + 10 authored regression cases.", flush=True)
    if args.load:
        result = import_notice(LocalStudio(args.api), bundle, args.output)
        print("Uploaded: {}; new annotation revisions: {}. No model runs started.".format(result["uploaded"], result["new_ground_truth_revisions"]))
        print("http://localhost:5180/#Evaluations/group/" + result["experiments"]["dev"]["group_id"])


if __name__ == "__main__":
    main()
