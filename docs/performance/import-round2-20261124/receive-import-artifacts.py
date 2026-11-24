#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Receive authenticated artifact references and retain only public metadata."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import zipfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--references-json", required=True)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent)
    args = parser.parse_args()
    for reference in json.loads(args.references_json):
        metadata = reference["metadata"]
        match = re.fullmatch(r"import-crossover-([a-z0-9-]+)-(screen|qualification)-([a-z]+)-(\d+)-(\d+)", metadata["name"])
        if match is None:
            raise RuntimeError("Unrecognized study artifact name")
        label, stage, dictionary, _, _ = match.groups()
        archive = args.root / "browser/original-artifacts" / f"{label}-{stage}-{dictionary}.zip"
        output = (args.root / "browser" / stage / f"{label}-{dictionary}").resolve()
        if archive.exists() or output.exists():
            raise RuntimeError(f"Refusing to replace retained artifact {metadata['id']}")
        archive.parent.mkdir(parents=True, exist_ok=True)
        result = subprocess.run(["curl", "--fail", "--location", "--silent", "--show-error", "--max-time", "60",
                                 reference["downloadUrl"], "--output", str(archive)], capture_output=True)
        if result.returncode != 0:
            raise RuntimeError(f"Artifact download failed: {metadata['id']}")
        with archive.open("rb") as stream:
            digest = "sha256:" + hashlib.file_digest(stream, "sha256").hexdigest()
        if archive.stat().st_size != metadata["size_in_bytes"] or digest != metadata["digest"]:
            raise RuntimeError(f"Artifact integrity differs: {metadata['id']}")
        with zipfile.ZipFile(archive) as bundle:
            if len(bundle.namelist()) != len(set(bundle.namelist())) or bundle.testzip() is not None:
                raise RuntimeError(f"Invalid ZIP content: {metadata['id']}")
            for entry in bundle.infolist():
                target = (output / entry.filename).resolve()
                if not target.is_relative_to(output) or ((entry.external_attr >> 16) & 0o170000) == 0o120000:
                    raise RuntimeError(f"Unsafe ZIP entry: {metadata['id']}")
            output.mkdir(parents=True)
            bundle.extractall(output)
        receipt = {**metadata, "localArchive": str(archive.relative_to(args.root)),
                   "localExtracted": str(output.relative_to(args.root.resolve()))}
        path = args.root / "browser/artifact-metadata" / f"{metadata['id']}.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(receipt, indent=2) + "\n")
        state = json.loads((output / "state.json").read_text())
        print(json.dumps({"artifact": metadata["id"], "path": str(output), "status": state["status"]}))


if __name__ == "__main__":
    main()
