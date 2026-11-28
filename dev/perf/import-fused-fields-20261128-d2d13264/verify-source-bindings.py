#!/usr/bin/env python3
"""Check the executable oracle fragments against their exact Git sources."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()


def extract(text, name, kind):
    if kind == "function":
        matches = list(re.finditer(r"(?:async )?function " + re.escape(name) + r"\(", text))
        assert len(matches) == 1, (name, kind, len(matches))
        start = matches[0].start()
        end = text.index("\n}", start) + 2
    elif kind == "method":
        matches = list(re.finditer(r"    (?:async )?" + re.escape(name) + r"\(", text))
        assert len(matches) == 1, (name, kind, len(matches))
        start = matches[0].start()
        end = text.index("\n    }", start) + 6
    elif kind == "constant":
        matches = list(re.finditer(r"(?m)^const " + re.escape(name) + r" = [^\n]+;", text))
        assert len(matches) == 1, (name, kind, len(matches))
        start, end = matches[0].span()
    else:
        raise ValueError(kind)
    return text[start:end]


parser = argparse.ArgumentParser()
parser.add_argument("--repo", type=Path, default=Path.cwd())
parser.add_argument("--evidence-dir", type=Path, default=Path(__file__).resolve().parent)
args = parser.parse_args()
manifest = json.loads((args.evidence_dir / "source-bindings.json").read_text())
assert manifest["format"] == "manabitan-fusion-source-bindings-v1"
for variable, key in [("BASE_SHA", "baseCommit"), ("CANDIDATE_SHA", "candidateCommit")]:
    if variable in os.environ:
        assert os.environ[variable] == manifest[key], (variable, manifest[key])
tree = subprocess.check_output(
    ["git", "rev-parse", manifest["candidateCommit"] + "^{tree}"], cwd=args.repo, text=True,
).strip()
assert tree == manifest["candidateTree"], (tree, manifest["candidateTree"])

sources = {}
for item in manifest["sources"]:
    source = subprocess.check_output(
        ["git", "show", item["ref"] + ":" + item["path"]], cwd=args.repo,
    ).decode()
    assert digest(source) == item["sha256"], (item["ref"], item["path"])
    sources[(item["ref"], item["path"])] = source
harnesses = {}
for name, expected in manifest["harnesses"].items():
    value = (args.evidence_dir / name).read_text()
    assert digest(value) == expected["sha256"], name
    harnesses[name] = value
baseline = manifest["harnesses"]["integration-baseline-harness.js.txt"]
assert baseline["sha256"] == baseline["previousSha256"]

for item in manifest["fragments"]:
    source = extract(sources[(item["sourceRef"], item["sourcePath"])], item["name"], item["kind"])
    harness = extract(harnesses[item["harness"]], item["name"], item["kind"])
    assert digest(source) == item["sha256"], (item["sourcePath"], item["name"])
    assert source == harness, (item["harness"], item["name"])

print(json.dumps({
    "complete": True,
    "candidateCommit": manifest["candidateCommit"],
    "candidateTree": tree,
    "sourceFiles": len(sources),
    "boundFragments": len(manifest["fragments"]),
    "baselineHarnessUnchanged": True,
    "scope": manifest["scope"],
}, sort_keys=True))
