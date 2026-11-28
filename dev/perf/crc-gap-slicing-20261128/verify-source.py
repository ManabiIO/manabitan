#!/usr/bin/env python3
"""Record the frozen CRC-gap source boundary without acquiring observations."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

BASELINE = "9e10d3b3fcf66d344ab31bc42c9b522fa5215da2"
FROZEN_HASHES = {
    "dev/data/dictionary-wasm/manifest.json": "453d6b36b68f3c1b539ee2cb43fa476211d81a0315b90849b9b89edabc5347e8",
    "dev/data/dictionary-wasm/term-bank-parser.wasm": "b362d9b0106c28e9cb495d66c650463c771e165cb8ebadc4a66adda973466fd9",
    "dev/perf/crc-gap-slicing-20261128/audit-crc.py": "fd83a3f0fa7aad901bd48e3c5e4270ae70a11e3e644103db6bd58179d45d73d9",
    "dev/perf/crc-gap-slicing-20261128/test-audit-crc.py": "81eb9a61b5600663dc0dd4f5ab6c75c1773c05079ee5e627f3aad1d4c8478519",
    "ext/js/dictionary/wasm/term-bank-parser.c": "eea3064cf869d880115dcd42055293784874c9d5092e962d4fea52284fe93a47",
    "test/term-bank-crc.test.js": "507452151ecf4a6a0767d04e0aff41f7edb6f9a328f278c27209b8002c55d706",
    "test/term-bank-source-crc-reuse.test.js": "467dbd5e03dd3be3cb18b244b9f72c540ec1c6fc425d28cf3a22d677dcf9ca5d",
}
CHANGED_PATHS = {
    ".github/workflows/import-crc-gap-slicing-1c413.yml",
    "dev/data/dictionary-wasm/manifest.json",
    "dev/data/dictionary-wasm/term-bank-parser.wasm",
    "dev/perf/crc-gap-slicing-20261128/PLAN.md",
    "dev/perf/crc-gap-slicing-20261128/audit-crc.py",
    "dev/perf/crc-gap-slicing-20261128/test-audit-crc.py",
    "dev/perf/crc-gap-slicing-20261128/verify-source.py",
    "ext/js/dictionary/wasm/term-bank-parser.c",
    "test/term-bank-crc.test.js",
    "test/term-bank-source-crc-reuse.test.js",
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
            raise RuntimeError(f"The frozen native source, asset, focused test or CRC audit changed: {path}")
    protected = [
        "dev/perf/import-qualification-20261125-a7f7.py",
        "test/perf/dictionaries.lock.json",
        "test/chromium/extension-two-dictionary-import.e2e.js",
        "test/e2e/import-timing.js",
        "dev/dictionary-wasm.js",
        "dev/bin/build-dictionary-wasm.js",
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
        "expectedPackageEntries": ["js/dictionary/wasm/term-bank-parser.c", "lib/term-bank-parser.wasm"],
        "sources": sources,
        "unchangedObserverHashes": protected_hashes,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    print(json.dumps(receipt, sort_keys=True))


if __name__ == "__main__":
    main()
