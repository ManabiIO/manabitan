#!/usr/bin/env python3
"""Verify the reconstructed record-field source without importing product code."""

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess

BASELINE = "dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16"
PRODUCT = "5545e5c26daaaa13af18a4f6f94e762b3856446c"
PRODUCT_TREE = "9bb3a0dcbf22e9b2d55c15f21bb5444fc64e00a9"
KIT = "dev/perf/native-record-fields-recovery-20261128-1c413"
ROOT = Path(__file__).resolve().parents[3]
SOURCE_PATH = KIT + "/source.json"
RECOVERY_PATH = KIT + "/recovery.json"
WORKFLOW_PATH = ".github/workflows/native-record-fields-correctness-1c413.yml"


def require(value, message):
    if not value:
        raise RuntimeError(message)


def pairs(items):
    result = {}
    for key, value in items:
        require(key not in result, "Duplicate JSON key: " + key)
        result[key] = value
    return result


def read_json(data):
    def reject(value):
        raise ValueError("Non-finite JSON value: " + value)
    return json.loads(data, object_pairs_hook=pairs, parse_constant=reject)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def git(*arguments):
    return subprocess.check_output(["git", *arguments], cwd=ROOT)


def canonical(path):
    require(isinstance(path, str) and path and "\\" not in path and "\x00" not in path,
            "Invalid source path")
    parsed = PurePosixPath(path)
    require(not parsed.is_absolute() and str(parsed) == path and
            all(part not in ("", ".", "..") for part in parsed.parts),
            "Non-canonical source path: " + path)
    return path


def tracked(path, candidate):
    canonical(path)
    entries = git("ls-tree", "-z", candidate, "--", path).split(b"\0")
    require(len(entries) == 2 and entries[1] == b"", "Expected one tracked file: " + path)
    header, name = entries[0].split(b"\t", 1)
    mode, kind, blob = header.decode().split()
    require(name.decode() == path and mode in ("100644", "100755") and kind == "blob",
            "Unexpected source mode/type: " + path)
    data = git("cat-file", "blob", blob)
    local = ROOT / path
    require(stat.S_ISREG(local.lstat().st_mode) and not local.is_symlink(),
            "Expected regular working file: " + path)
    require(local.read_bytes() == data, "Working source differs from Git: " + path)
    return data, {"gitBlob": blob, "sha256": digest(data), "bytes": len(data), "mode": mode}


def verify(candidate, generated):
    require(re.fullmatch(r"[0-9a-f]{40}", candidate) is not None,
            "Use a full candidate commit SHA")
    require(git("rev-parse", "HEAD").decode().strip() == candidate,
            "The requested candidate is not checked out")
    ancestry = git("rev-list", "--parents", "-n", "1", candidate).decode().split()
    require(ancestry == [candidate, PRODUCT], "Correctness kit must have the exact product commit as sole parent")
    product_ancestry = git("rev-list", "--parents", "-n", "1", PRODUCT).decode().split()
    require(product_ancestry == [PRODUCT, BASELINE], "Product commit must have the exact baseline as sole parent")
    require(git("rev-parse", PRODUCT + "^{tree}").decode().strip() == PRODUCT_TREE,
            "The reviewed product tree changed")
    working_changed = set(git("diff", "--name-only", "HEAD", "--").decode().splitlines())
    generated_documents = {"ext/legal-npm.html"} if generated else set()
    require(working_changed <= generated_documents,
            "Tracked working source differs from the committed candidate: " + repr(sorted(working_changed)))
    source_bytes, source_identity = tracked(SOURCE_PATH, candidate)
    source = read_json(source_bytes)
    require(source["schema"] == 1 and source["baseline"] == BASELINE and source["productCommit"] == PRODUCT,
            "Unknown source manifest or baseline")
    require(source["kind"] == "reconstructed-production-correctness-only" and
            source["nodeVersion"] == "22.22.0", "Unexpected validation policy")
    files = source["files"]
    require(isinstance(files, dict) and SOURCE_PATH not in files and
            RECOVERY_PATH in files and WORKFLOW_PATH in files and
            KIT + "/verify-source.py" in files, "Incomplete source manifest")
    expected_paths = set(files) | {SOURCE_PATH}
    changed = set(git("diff", "--name-only", "--no-renames", BASELINE, candidate).decode().splitlines())
    require(changed == expected_paths, "Unexpected changed paths: " + repr(sorted(changed)))
    identities = {SOURCE_PATH: source_identity}
    for path, expected in sorted(files.items()):
        data, identity = tracked(path, candidate)
        require(set(expected) == {"sha256", "bytes", "gitBlob", "mode"},
                "Unexpected file binding fields: " + path)
        require(identity == expected, "Frozen file identity changed: " + path)
        identities[path] = identity
    recovery = read_json((ROOT / RECOVERY_PATH).read_bytes())
    require(recovery["baseline"] == BASELINE and recovery["productCommit"] == PRODUCT and
            recovery["kind"] == "new-unmeasured-production-reconstruction",
            "Recovery provenance is missing")
    product = recovery["productFiles"]
    require(len(product) == 13 and len({item["path"] for item in product}) == 13,
            "Unexpected reconstructed product boundary")
    for item in product:
        expected = {"gitBlob": item["blob"], "sha256": item["sha256"],
                    "bytes": item["bytes"], "mode": item["mode"]}
        require(identities.get(item["path"]) == expected,
                "Reconstructed product binding differs: " + item["path"])
    product_paths = {item["path"] for item in product}
    require(set(git("diff", "--name-only", "--no-renames", BASELINE, PRODUCT).decode().splitlines()) == product_paths,
            "Product commit contains an unrelated change")
    for path in product_paths:
        require(git("rev-parse", PRODUCT + ":" + path).decode().strip() == identities[path]["gitBlob"],
                "The correctness commit modified reviewed product source: " + path)
    research = expected_paths - product_paths
    require(set(git("diff", "--name-only", "--no-renames", PRODUCT, candidate).decode().splitlines()) == research,
            "Correctness commit changed something outside its isolated kit")
    require(all(path == WORKFLOW_PATH or path.startswith(KIT + "/") for path in research),
            "Research files escaped the isolated correctness kit")
    source_digest = digest("".join(path + "\0" + identities[path]["sha256"] + "\n"
                                   for path in sorted(files)).encode())
    require(source_digest == source["digest"], "Source manifest aggregate differs")
    protected = [
        "dev/bin/build-dictionary-wasm.js", "dev/perf/prepare-dictionaries.js", "package.json", "package-lock.json",
        ".github/actions/setup/action.yml", "test/perf/dictionaries.lock.json",
        "dev/perf/import-qualification-20261125-a7f7.py",
        "test/chromium/extension-two-dictionary-import.e2e.js", "test/e2e/import-timing.js",
        "dev/data/dictionary-wasm/term-bank-parser.wasm",
        "dev/data/dictionary-wasm/term-content-canonical-scan-v1.wasm",
    ]
    protected.extend(git("ls-tree", "-r", "--name-only", BASELINE,
                         "dev/perf/import-memory-20261125-a7f7").decode().splitlines())
    protected_identities = {}
    for path in sorted(set(protected)):
        data, identity = tracked(path, candidate)
        require(data == git("show", BASELINE + ":" + path) and
                git("ls-tree", "-z", candidate, "--", path) == git("ls-tree", "-z", BASELINE, "--", path),
                "Protected baseline bytes, Git mode or blob changed: " + path)
        protected_identities[path] = identity
    generated_identities = {}
    if generated:
        require(subprocess.check_output(["node", "--version"], cwd=ROOT).decode().strip() == "v22.22.0",
                "Unexpected Node runtime")
        native = read_json((ROOT / "dev/data/dictionary-wasm/manifest.json").read_bytes())
        require([item["name"] for item in native["targets"]] ==
                ["term-content-canonical-scan-v1.wasm", "term-bank-parser.wasm", "term-record-fields.wasm"],
                "Unexpected native asset inventory")
        for item in native["targets"]:
            path = "ext/lib/" + item["name"]
            local = ROOT / path
            require(stat.S_ISREG(local.lstat().st_mode) and not local.is_symlink(),
                    "Generated asset must be a regular file: " + path)
            data = local.read_bytes()
            require(digest(data) == item["sha256"] and
                    data == (ROOT / "dev/data/dictionary-wasm" / item["name"]).read_bytes(),
                    "Generated native asset changed: " + path)
            generated_identities[path] = {"bytes": len(data), "sha256": digest(data)}
    return {
        "passed": True, "kind": "source-only-validation", "baseline": BASELINE,
        "candidate": candidate, "parent": ancestry[1], "productCommit": PRODUCT, "productParent": BASELINE,
        "tree": git("rev-parse", "HEAD^{tree}").decode().strip(),
        "sourceDigest": source_digest, "changedPaths": sorted(changed),
        "sources": identities, "protected": protected_identities,
        "generatedAssets": generated_identities,
        "setupGeneratedDocuments": {
            path: {"sha256": digest((ROOT / path).read_bytes()),
                   "committedSha256": digest(git("show", candidate + ":" + path))}
            for path in sorted(working_changed)
        },
        "timingAcquired": False, "productExecution": False,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--generated", action="store_true")
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    require(not args.output.exists(), "Refusing to replace a source receipt")
    try:
        receipt = verify(args.candidate, args.generated)
    except Exception as error:
        receipt = {"passed": False, "kind": "source-only-validation",
                   "candidate": args.candidate, "error": repr(error),
                   "timingAcquired": False, "productExecution": False}
        args.output.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
        raise
    args.output.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    print(json.dumps(receipt, sort_keys=True))


if __name__ == "__main__":
    main()
