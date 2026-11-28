#!/usr/bin/env python3
"""Reconstruct and verify the archived research evidence; never extract or execute it."""
import argparse
import hashlib
import json
from pathlib import Path
import tarfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
here = Path(__file__).resolve().parent
receipt = json.loads((here / "archive-receipt.json").read_text())
parts = json.loads((here / "archive-parts.json").read_text())
manifest_bytes = (here / "ARCHIVE-MANIFEST.json").read_bytes()
if hashlib.sha256(manifest_bytes).hexdigest() != receipt["manifestSha256"]:
    raise SystemExit("Manifest hash mismatch")
manifest = json.loads(manifest_bytes)
expected = {item["path"]: item for item in manifest["files"]}
if len(expected) != receipt["fileCount"] or len(expected) != len(manifest["files"]):
    raise SystemExit("Manifest contains duplicate or missing paths")
args.output.parent.mkdir(parents=True, exist_ok=True)
temporary = args.output.with_name(args.output.name + ".partial")
total_hash = hashlib.sha256()
total_size = 0
with temporary.open("xb") as target:
    for part in parts["parts"]:
        path = here / part["name"]
        digest = hashlib.sha256()
        size = 0
        with path.open("rb") as source:
            while block := source.read(1024 * 1024):
                target.write(block)
                digest.update(block)
                total_hash.update(block)
                size += len(block)
                total_size += len(block)
        if size != part["bytes"] or digest.hexdigest() != part["sha256"]:
            raise SystemExit(f"Part verification failed: {part['name']}")
if total_size != receipt["bytes"] or total_hash.hexdigest() != receipt["sha256"]:
    raise SystemExit("Archive hash or size mismatch")
seen = set()
raw_bytes = 0
embedded_manifest_seen = False
with tarfile.open(temporary, "r:gz") as archive:
    for member in archive:
        if member.name == "ARCHIVE-MANIFEST.json":
            source = archive.extractfile(member) if member.isfile() else None
            if embedded_manifest_seen or source is None or source.read() != manifest_bytes:
                raise SystemExit("Embedded manifest mismatch")
            embedded_manifest_seen = True
            continue
        if not member.isfile() or member.name not in expected or member.name in seen:
            raise SystemExit(f"Unexpected archive member: {member.name}")
        item = expected[member.name]
        if member.size != item["bytes"]:
            raise SystemExit(f"Size mismatch: {member.name}")
        source = archive.extractfile(member)
        if source is None or hashlib.file_digest(source, "sha256").hexdigest() != item["sha256"]:
            raise SystemExit(f"Member hash mismatch: {member.name}")
        seen.add(member.name)
        raw_bytes += member.size
if not embedded_manifest_seen or seen != set(expected) or raw_bytes != receipt["rawBytes"]:
    raise SystemExit("Archive inventory mismatch")
if args.output.exists():
    raise SystemExit(f"Refusing to replace existing output: {args.output}; verified bytes remain at {temporary}")
temporary.rename(args.output)
print(json.dumps({"archive": str(args.output), "bytes": total_size, "sha256": total_hash.hexdigest(), "files": len(seen), "rawBytes": raw_bytes}, indent=2))

