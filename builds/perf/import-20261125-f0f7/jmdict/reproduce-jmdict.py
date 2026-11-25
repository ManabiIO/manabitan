#!/usr/bin/env python3
"""Reparameterize the preserved executed JMdict replay without editing it."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", required=True, type=Path)
    parser.add_argument("--candidate", required=True, type=Path)
    parser.add_argument("--cache", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--workers", default="2,3,5")
    parser.add_argument("--node", default="node")
    args = parser.parse_args()
    if not re.fullmatch(r"[1-9][0-9]*(,[1-9][0-9]*)*", args.workers):
        parser.error("--workers must be comma-separated positive integers")

    baseline = args.baseline.resolve(strict=True)
    candidate = args.candidate.resolve(strict=True)
    cache = args.cache.resolve(strict=True)
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    source_path = Path(__file__).resolve().with_name("executed-eager-archive.mjs")
    manifest_path = source_path.with_name("source-and-evidence-hashes.json")
    manifest = json.loads(manifest_path.read_text())
    source = source_path.read_text()
    digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
    if digest(source_path) != manifest["filesSha256"][source_path.name]:
        raise RuntimeError("Preserved executed runner SHA256 does not match")
    relative_source = Path("ext/js/dictionary/term-record-opfs-store.js")
    for path, key in [(baseline / relative_source, "baselineSourceSha256"),
                      (candidate / relative_source, "candidateSourceSha256")]:
        if digest(path) != manifest[key]:
            raise RuntimeError(f"Source SHA256 does not match recorded evidence: {path}")

    for name, path in [("baseRoot", baseline), ("candidateRoot", candidate), ("outputRoot", output)]:
        replacement = f"const {name} = {json.dumps(str(path))}"
        source, count = re.subn(rf"^const {name} = .*$", lambda _: replacement, source, flags=re.MULTILINE)
        if count != 1:
            raise RuntimeError(f"Expected exactly one {name} root declaration")
    archive_path = "`${baseRoot}/builds/e2e-dictionary-cache/${spec.cacheFile}`"
    if source.count(archive_path) != 1:
        raise RuntimeError("Expected exactly one fixture-cache path")
    source = source.replace(archive_path, f"{json.dumps(str(cache))} + '/' + spec.cacheFile")
    generated = output / "portable-jmdict-replay.mjs"
    generated.write_text(source)
    command = [args.node, str(generated), "jmdict", args.workers]
    print(json.dumps({"command": command, "generatedRunnerSha256": digest(generated)}), flush=True)
    completed = subprocess.run(command, check=False)
    raise SystemExit(completed.returncode)


if __name__ == "__main__":
    main()
