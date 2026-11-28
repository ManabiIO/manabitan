#!/usr/bin/env python3
"""Fetch only the immutable VNDB archive used by the untimed copy oracle."""
import hashlib
import json
import pathlib
import sys
import urllib.request

root = pathlib.Path(sys.argv[1]).resolve()
lock_bytes = (root / "test/perf/dictionaries.lock.json").read_bytes()
assert hashlib.sha256(lock_bytes).hexdigest() == "60aa981791f3b60ca17588212aea5bd3536fb8f59288855e5accd019c6e4cf89"
spec = json.loads(lock_bytes)["dictionaries"]["vndb"]
destination = root / "builds/e2e-dictionary-cache" / spec["cacheFile"]
destination.parent.mkdir(parents=True, exist_ok=True)
if not destination.exists():
    temporary = destination.with_suffix(destination.suffix + ".partial")
    request = urllib.request.Request(spec["url"], headers={"User-Agent": "manabitan-source-bound-copy-oracle"})
    with urllib.request.urlopen(request, timeout=120) as response, temporary.open("xb") as output:
        while chunk := response.read(1024 * 1024):
            output.write(chunk)
    temporary.rename(destination)
digest = hashlib.sha256()
with destination.open("rb") as source:
    while chunk := source.read(1024 * 1024):
        digest.update(chunk)
assert destination.stat().st_size == spec["sizeBytes"]
assert digest.hexdigest() == spec["sha256"]
print(json.dumps({"fixture": "vndb", "bytes": spec["sizeBytes"], "sha256": spec["sha256"]}))
