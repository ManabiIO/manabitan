#!/usr/bin/env python3
"""Verify every archived file without modifying the evidence."""

import hashlib
import json
from pathlib import Path


def main():
    root = Path(__file__).resolve().parent
    manifest = json.loads((root / "manifest.json").read_text())
    expected = {entry["path"]: entry for entry in manifest["files"]}
    if len(expected) != len(manifest["files"]):
        raise SystemExit("Duplicate manifest path")
    actual = {
        path.relative_to(root).as_posix()
        for path in root.rglob("*")
        if path.is_file() and path != root / "manifest.json"
    }
    if actual != set(expected):
        raise SystemExit(
            f"File set differs: missing={sorted(set(expected) - actual)}, "
            f"unexpected={sorted(actual - set(expected))}"
        )
    total_bytes = 0
    for name, entry in sorted(expected.items()):
        data = (root / name).read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        if len(data) != entry["bytes"] or digest != entry["sha256"]:
            raise SystemExit(f"Size or SHA256 mismatch: {name}")
        total_bytes += len(data)
    print(f"Verified {len(expected)} files / {total_bytes} bytes")


if __name__ == "__main__":
    main()
