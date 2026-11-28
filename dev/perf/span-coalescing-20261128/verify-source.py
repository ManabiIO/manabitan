#!/usr/bin/env python3
"""Verify the frozen candidate and unchanged baseline qualification machinery."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--baseline", required=True)
parser.add_argument("--candidate", required=True)
parser.add_argument("--output", required=True, type=Path)
args = parser.parse_args()
for revision in (args.baseline, args.candidate):
    if re.fullmatch(r"[a-f0-9]{40}", revision) is None:
        parser.error("Expected complete lowercase commit IDs")
root = Path(__file__).resolve().parents[3]
manifest = json.loads((Path(__file__).parent / "source.json").read_text())
assert args.baseline == manifest["baseline"]

def git(*command):
    return subprocess.check_output(["git", *command], cwd=root)

assert git("rev-parse", args.baseline).decode().strip() == args.baseline
assert git("rev-parse", args.candidate).decode().strip() == args.candidate
runtime_changes = git("diff", "--name-only", args.baseline, args.candidate, "--", "ext").decode().splitlines()
assert runtime_changes == ["ext/js/dictionary/term-content-block-store.js"], runtime_changes
source_hashes = {}
for name, expected in manifest["candidateFiles"].items():
    actual = hashlib.sha256(git("show", f"{args.candidate}:{name}")).hexdigest()
    assert actual == expected, name
    source_hashes[name] = actual

protocol_roots = [
    "package.json", "package-lock.json", ".github/actions/setup",
    "test/perf", "test/chromium", "test/e2e", "dev/perf",
]
changes = git("diff", "--name-status", args.baseline, args.candidate, "--", *protocol_roots).decode().splitlines()
for change in changes:
    status, name = change.split("\t")
    assert status == "A" and name.startswith("dev/perf/span-coalescing-20261128/"), change
for name, expected in manifest["unchangedFiles"].items():
    for revision in (args.baseline, args.candidate):
        assert hashlib.sha256(git("show", f"{revision}:{name}")).hexdigest() == expected, (revision, name)
for name, expected in manifest["generatedFiles"].items():
    assert hashlib.sha256((root / name).read_bytes()).hexdigest() == expected, name

proof = {
    "baseline": args.baseline,
    "candidate": args.candidate,
    "runtimeChanges": runtime_changes,
    "candidateFileHashes": source_hashes,
    "unchangedFileHashes": manifest["unchangedFiles"],
    "generatedFileHashes": manifest["generatedFiles"],
    "allExistingProtocolFilesUnchanged": True,
    "expectedPackageEntries": ["js/dictionary/term-content-block-store.js"],
    "checksPassed": True,
}
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps(proof, indent=2) + "\n")
print(json.dumps(proof, indent=2))
