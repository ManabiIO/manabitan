#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Assemble compact repository evidence while retaining every original ZIP."""

import argparse
import hashlib
import json
from pathlib import Path
import shutil


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    source, output = args.source.resolve(), args.output.resolve()
    if source == output or output.is_relative_to(source):
        raise RuntimeError("Evidence output must be outside the scratch evidence source")
    selected = set()
    for name in ("components", "ci", "audits", "browser/original-artifacts", "browser/artifact-metadata"):
        selected.update(path for path in (source / name).rglob("*") if path.is_file())
    for stage in ("baseline", "screen", "qualification"):
        for cohort in (source / "browser" / stage).glob("*"):
            if cohort.is_dir():
                # Every nested raw observation remains in its authenticated
                # original artifact ZIP. Duplicate only the small index files.
                selected.update(path for path in cohort.iterdir() if path.is_file())
    selected.update(path for path in source.iterdir() if path.is_file())
    output.mkdir(parents=True, exist_ok=True)
    files = []
    for path in sorted(selected):
        if path.is_symlink():
            raise RuntimeError(f"Evidence symlink is not allowed: {path}")
        relative = path.relative_to(source)
        target = output / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)
        source_digest = digest(path)
        if digest(target) != source_digest:
            raise RuntimeError(f"Copy differs: {relative}")
        files.append({"path": str(relative), "bytes": path.stat().st_size, "sha256": source_digest})
    manifest = {
        "schemaVersion": 1,
        "scope": "Every original browser artifact ZIP; selected duplicate top-level cohort receipts; complete component, CI and independent audit packets.",
        "rawObservationLocation": "browser/original-artifacts/*.zip retains every raw timing, phase, restart/readback packet and log from each completed study.",
        "excludedInputs": "Downloaded dictionary archives, node_modules, and duplicate expanded per-observation files. Source archives are identified by the pinned lock and independently verified SHA-256.",
        "payloadFiles": len(files),
        "payloadBytes": sum(item["bytes"] for item in files),
        "files": files,
    }
    (output / "MANIFEST.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"output": str(output), "payloadFiles": len(files), "payloadBytes": manifest["payloadBytes"],
                      "manifestSha256": digest(output / "MANIFEST.json")}))


if __name__ == "__main__":
    main()
