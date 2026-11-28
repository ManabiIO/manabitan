#!/usr/bin/env python3
"""Verify a fixed GitHub artifact, then retain qualification inputs without unpacking product ZIPs."""

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import zipfile


parser = argparse.ArgumentParser()
parser.add_argument("--artifact", required=True, type=Path)
parser.add_argument("--expected-sha256", required=True)
parser.add_argument("--expected-bytes", required=True, type=int)
parser.add_argument("--artifact-id", required=True, type=int)
parser.add_argument("--cell", required=True, choices=["jmdict-AB", "jmdict-BA", "jitendex-AB", "vndb-AB"])
parser.add_argument("--output", required=True, type=Path)
args = parser.parse_args()
digest = hashlib.sha256()
with args.artifact.open("rb") as stream:
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        digest.update(chunk)
assert args.artifact.stat().st_size == args.expected_bytes and digest.hexdigest() == args.expected_sha256
args.output.mkdir(parents=True, exist_ok=False)
rows, seen = [], set()
with zipfile.ZipFile(args.artifact) as archive:
    for member in archive.infolist():
        path = PurePosixPath(member.filename)
        assert str(path) == member.filename.rstrip("/") and str(path) != "."
        assert not path.is_absolute() and ".." not in path.parts and "\\" not in member.filename
        assert str(path) not in seen
        seen.add(str(path))
        mode = (member.external_attr >> 16) & 0o170000
        assert mode in (0, 0o040000, 0o100000)
        if member.is_dir():
            assert mode in (0, 0o040000) and member.file_size == 0
            continue
        assert mode != 0o040000 and member.file_size <= 64 * 1024 * 1024
        retained = not member.filename.endswith(".html") and not member.filename.endswith(".trace.json")
        target = args.output / member.filename
        if retained:
            target.parent.mkdir(parents=True, exist_ok=True)
        output = target.open("xb") if retained else None
        hashed, count = hashlib.sha256(), 0
        try:
            with archive.open(member) as source:
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    hashed.update(chunk)
                    count += len(chunk)
                    if output:
                        output.write(chunk)
        finally:
            if output:
                output.close()
        assert count == member.file_size
        rows.append({"path": member.filename, "bytes": count, "sha256": hashed.hexdigest(), "retained": retained,
                     "boundary": "Product ZIP retained as ZIP only" if member.filename.endswith(".zip") else "Exact input bytes" if retained else "Preserved only in source artifact; excluded from ordinary timing analysis"})
manifest = {"schemaVersion": 1, "complete": True, "cell": args.cell, "artifactId": args.artifact_id,
            "runId": 46103918280, "headSha": "f65f4ef97ebf2f37a5b1b79ca7733d7b362ec963",
            "artifact": {"path": str(args.artifact), "bytes": args.expected_bytes, "sha256": digest.hexdigest()},
            "extractorSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "files": rows, "retainedBytes": sum(row["bytes"] for row in rows if row["retained"])}
(args.output / "extraction-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
print(json.dumps({"complete": True, "cell": args.cell, "members": len(rows), "retainedBytes": manifest["retainedBytes"]}))
