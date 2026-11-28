#!/usr/bin/env python3
"""Check exact frozen runtime sources and all release package entries."""

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import zipfile


BASELINE = "9e10d3b3fcf66d344ab31bc42c9b522fa5215da2"
MODULES = {
    "baseline": "8ae00698649c5a3e41039b13c5ffe1dff2d4e69948cba2e3c063f381250031ee",
    "candidate": "9fa76a9037b5874ecebeb59adea2e96f6603266a0dc4d12409175b1da5f697d3",
}
EXPECTED_SOURCE = {
    "ext/js/dictionary/wasm/term-bank-parser.c",
    "dev/data/dictionary-wasm/term-bank-parser.wasm",
    "dev/data/dictionary-wasm/manifest.json",
}
EXPECTED_PACKAGE = {
    "js/dictionary/wasm/term-bank-parser.c",
    "lib/term-bank-parser.wasm",
}


def digest(value):
    return hashlib.sha256(value).hexdigest()


def git(root, *args):
    return subprocess.check_output(["git", *args], cwd=root, text=True).strip()


def identity(root, arm):
    assert not git(root, "status", "--porcelain", "--untracked-files=no"), "Tracked source changed during build"
    package = root / "builds/manabitan-chrome.zip"
    with zipfile.ZipFile(package) as archive:
        names = [entry.filename for entry in archive.infolist() if not entry.is_dir()]
        assert len(names) == len(set(names)), "Duplicate release package entries"
        entries = {name: digest(archive.read(name)) for name in sorted(names)}
    module = root / "ext/lib/term-bank-parser.wasm"
    assert digest(module.read_bytes()) == MODULES[arm], "Unexpected native module"
    assert entries["lib/term-bank-parser.wasm"] == MODULES[arm], "Packaged native module differs"
    assert entries["js/dictionary/wasm/term-bank-parser.c"] == digest((root / "ext/js/dictionary/wasm/term-bank-parser.c").read_bytes())
    return {
        "commit": git(root, "rev-parse", "HEAD"),
        "tree": git(root, "rev-parse", "HEAD^{tree}"),
        "packageSha256": digest(package.read_bytes()),
        "packageBytes": package.stat().st_size,
        "entries": entries,
        "nativeModuleBytes": module.stat().st_size,
        "sources": {
            name: digest((root / name).read_bytes())
            for name in sorted(EXPECTED_SOURCE | {"package-lock.json", "test/perf/dictionaries.lock.json"})
        },
    }


baseline, candidate, output = map(Path, sys.argv[1:])
assert git(baseline, "rev-parse", "HEAD") == BASELINE
registration_path = candidate / "dev/perf/whole-glossary-prefix-followup-20261128/registration.json"
registration = json.loads(registration_path.read_text())
assert registration["baselineCommit"] == BASELINE == os.environ["BASELINE_COMMIT"]
assert registration["candidateCommit"] == os.environ["CANDIDATE_COMMIT"]
assert git(candidate, "rev-parse", registration["candidateCommit"] + "^{tree}") == registration["candidateTree"]
assert not git(candidate, "diff", "--name-only", registration["candidateCommit"], "HEAD", "--", "ext", "dev/data/dictionary-wasm"), "Research source differs from frozen runtime"
for filename, expected in registration["sourceSha256"].items():
    assert digest((candidate / filename).read_bytes()) == expected, f"Frozen source changed: {filename}"
for filename, expected in registration["harnessSha256"].items():
    assert digest((candidate / filename).read_bytes()) == expected, f"Registered harness changed: {filename}"
assert digest((candidate / ".github/workflows/whole-glossary-recent-first-screen-beb5.yml").read_bytes()) == registration["workflowSha256"]
assert registration["pairsPerGroup"] == 6 and registration["sameCodePairsPerGroup"] == 6
assert registration["disabledPairs"] == 3 and registration["disabledGroups"] == 1
assert registration["parserWorkers"] == 3 and registration["allGroups"] is True
changes = set(git(candidate, "diff", "--name-only", BASELINE, "HEAD", "--", "ext", "dev/data/dictionary-wasm").splitlines())
assert changes == EXPECTED_SOURCE, f"Unexpected runtime source changes: {sorted(changes)}"
arms = {"baseline": identity(baseline, "baseline"), "candidate": identity(candidate, "candidate")}
a = arms["baseline"]["entries"]
b = arms["candidate"]["entries"]
assert set(a) == set(b), "Release package membership changed"
changed = {name for name in a if a[name] != b[name]}
assert changed == EXPECTED_PACKAGE, f"Unexpected packaged changes: {sorted(changed)}"
for name in ("package-lock.json", "test/perf/dictionaries.lock.json"):
    assert arms["baseline"]["sources"][name] == arms["candidate"]["sources"][name]
harness = candidate / "dev/perf/whole-glossary-prefix-followup-20261128"
report = {
    "complete": True,
    "registration": registration,
    "registrationSha256": digest(registration_path.read_bytes()),
    "arms": arms,
    "changedProductSources": sorted(changes),
    "changedPackageEntries": sorted(changed),
    "harness": {path.name: digest(path.read_bytes()) for path in sorted(harness.iterdir()) if path.is_file()},
    "workflowSha256": digest((candidate / ".github/workflows/whole-glossary-recent-first-screen-beb5.yml").read_bytes()),
}
output.write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps({"complete": True, "changedPackageEntries": sorted(changed), "moduleHashes": MODULES}))
