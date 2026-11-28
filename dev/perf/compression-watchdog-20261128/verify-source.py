#!/usr/bin/env python3
"""Record the frozen watchdog source boundary without acquiring observations."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

BASELINE = "9e10d3b3fcf66d344ab31bc42c9b522fa5215da2"
RUNTIME = "ext/js/dictionary/zstd-term-content.js"
TEST = "test/zstd-term-content-watchdog.test.js"
FROZEN_HASHES = {
    RUNTIME: "a2fa0c8eb60aa4701d9ee93822654bb553309e43f8247e4be0da1879cf7e0de8",
    TEST: "49dbb06e215c094dd23acd50165656bc192a3351ccf80ef235d87eed32aaef63",
}
CHANGED_PATHS = {
    RUNTIME,
    TEST,
    ".github/workflows/import-compression-watchdog-1c413.yml",
    "dev/perf/compression-watchdog-20261128/PLAN.md",
    "dev/perf/compression-watchdog-20261128/verify-source.py",
}
ROOT = Path(__file__).resolve().parents[3]


def git(*arguments):
    return subprocess.check_output(["git", *arguments], cwd=ROOT)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.baseline != BASELINE or re.fullmatch(r"[0-9a-f]{40}", args.candidate) is None:
        parser.error("Use the exact original baseline and a full candidate commit SHA")
    candidate = git("rev-parse", "HEAD").decode().strip()
    if candidate != args.candidate:
        raise RuntimeError("The checked-out source is not the requested candidate")
    ancestry = git("rev-list", "--parents", "-n", "1", candidate).decode().split()
    if ancestry != [candidate, BASELINE]:
        raise RuntimeError("The frozen candidate must have the exact baseline as its sole parent")
    changed = set(git("diff", "--name-only", BASELINE, candidate).decode().splitlines())
    if changed != CHANGED_PATHS:
        raise RuntimeError(f"Unexpected source boundary: {sorted(changed)}")
    sources = {}
    for path in sorted(CHANGED_PATHS):
        data = git("show", f"{candidate}:{path}")
        if (ROOT / path).read_bytes() != data:
            raise RuntimeError(f"Working source changed after checkout: {path}")
        sources[path] = {
            "sha256": digest(data),
            "bytes": len(data),
            "gitBlob": git("rev-parse", f"{candidate}:{path}").decode().strip(),
        }
    for path, expected in FROZEN_HASHES.items():
        if sources[path]["sha256"] != expected:
            raise RuntimeError(f"The frozen runtime or focused tests changed: {path}")
    protected = [
        "dev/perf/import-qualification-20261125-a7f7.py",
        "test/perf/dictionaries.lock.json",
        "test/chromium/extension-two-dictionary-import.e2e.js",
        "test/e2e/import-timing.js",
    ]
    protected.extend(git("ls-tree", "-r", "--name-only", BASELINE,
                         "dev/perf/import-memory-20261125-a7f7").decode().splitlines())
    protected_hashes = {}
    for path in sorted(set(protected)):
        original = git("show", f"{BASELINE}:{path}")
        if original != git("show", f"{candidate}:{path}") or original != (ROOT / path).read_bytes():
            raise RuntimeError(f"The unchanged observer boundary changed: {path}")
        protected_hashes[path] = digest(original)
    receipt = {
        "passed": True,
        "baseline": BASELINE,
        "candidate": candidate,
        "parent": ancestry[1],
        "tree": git("rev-parse", "HEAD^{tree}").decode().strip(),
        "changedPaths": sorted(changed),
        "expectedPackageEntries": ["js/dictionary/zstd-term-content.js"],
        "sources": sources,
        "unchangedObserverHashes": protected_hashes,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    print(json.dumps(receipt, sort_keys=True))


if __name__ == "__main__":
    main()
