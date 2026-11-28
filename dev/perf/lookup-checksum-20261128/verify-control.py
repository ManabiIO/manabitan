#!/usr/bin/env python3
"""Prove the asset-only control is inert and the candidate keeps its assets frozen."""

import argparse
import hashlib
import json
import pathlib
import subprocess

ASSET_PATHS = {
    "dev/bin/audit-release-packages.js",
    "dev/data/dictionary-wasm/manifest.json",
    "dev/data/dictionary-wasm/term-record-checksum.wasm",
    "dev/dictionary-wasm.js",
    "eslint.config.js",
    "ext/js/dictionary/term-record-checksum.js",
    "ext/js/dictionary/wasm/term-record-checksum.c",
    "test/dictionary-wasm-build.test.js",
}
RUNTIME_PATHS = {
    "ext/js/dictionary/term-record-opfs-store.js",
    "ext/js/dictionary/dictionary-database.js",
}


def git(*arguments):
    return subprocess.check_output(["git", *arguments])


def source(revision, path):
    return git("show", f"{revision}:{path}")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def verify(original, control, candidate):
    parents = git("show", "-s", "--format=%P", control).decode().strip().split()
    if parents != [original]:
        raise ValueError("Asset-only A must have the original baseline as its sole parent")
    changed = set(git("diff", "--name-only", original, control).decode().splitlines())
    if changed != ASSET_PATHS:
        raise ValueError(f"Unexpected asset-control changes: {sorted(changed)}")
    for path in RUNTIME_PATHS:
        if source(original, path) != source(control, path):
            raise ValueError(f"The control changed existing runtime code: {path}")
    original_runtime = set(git("ls-tree", "-r", "--name-only", original, "ext").decode().splitlines())
    # Every pre-existing packaged source/manifest is byte-identical. The only
    # new JS module has no import edge from any pre-existing source file.
    if original_runtime.intersection(changed):
        raise ValueError("The control changed pre-existing extension files")
    references = []
    for path in sorted(original_runtime):
        if path.endswith((".js", ".html", ".json")) and b"term-record-checksum" in source(control, path):
            references.append(path)
    if references:
        raise ValueError(f"The inactive module is reachable from old runtime source: {references}")
    for path in ASSET_PATHS:
        if source(control, path) != source(candidate, path):
            raise ValueError(f"A frozen asset changed between A and B: {path}")
    runtime_changes = set(git("diff", "--name-only", control, candidate, "ext").decode().splitlines())
    if runtime_changes != RUNTIME_PATHS:
        raise ValueError(f"Unexpected candidate runtime changes: {sorted(runtime_changes)}")
    subprocess.run(["git", "merge-base", "--is-ancestor", control, candidate], check=True)
    manifest = json.loads(source(control, "dev/data/dictionary-wasm/manifest.json"))
    previous = json.loads(source(original, "dev/data/dictionary-wasm/manifest.json"))
    targets = {target["name"]: target for target in manifest["targets"]}
    old_targets = {target["name"]: target for target in previous["targets"]}
    if set(targets) != set(old_targets).union({"term-record-checksum.wasm"}):
        raise ValueError("Unexpected native target set")
    for name, target in old_targets.items():
        if targets[name] != target:
            raise ValueError(f"Existing native target changed: {name}")
    native_paths = sorted(path for path in git("ls-tree", "-r", "--name-only", control,
                                               "ext/js/dictionary/wasm").decode().splitlines()
                          if path.lower().endswith((".c", ".h")))
    native_identity = digest("".join(f"{path}\0{digest(source(control, path))}\n"
                                    for path in native_paths).encode())
    if len(native_paths) != 15 or manifest["sourceFileCount"] != 15 or manifest["sourceDigest"] != native_identity:
        raise ValueError("Native source count/digest does not bind all fifteen inputs")
    for name, target in targets.items():
        data = source(control, f"dev/data/dictionary-wasm/{name}")
        if digest(data) != target["sha256"] or not data.startswith(b"\0asm\1\0\0\0"):
            raise ValueError(f"Invalid recorded native artifact: {name}")
    return {
        "originalBaseline": original,
        "assetOnlyControl": control,
        "candidate": candidate,
        "controlTree": git("rev-parse", f"{control}^{{tree}}").decode().strip(),
        "candidateTree": git("rev-parse", f"{candidate}^{{tree}}").decode().strip(),
        "existingExtensionFilesUnchanged": True,
        "newHelperReferencesFromExistingRuntime": references,
        "runtimeChanges": sorted(runtime_changes),
        "expectedPackageChanges": [path.removeprefix("ext/") for path in sorted(runtime_changes)],
        "nativeSourceCount": len(native_paths),
        "nativeSourceDigest": native_identity,
        "assets": {path: digest(source(control, path)) for path in sorted(ASSET_PATHS)},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--original", required=True)
    parser.add_argument("--control", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    args = parser.parse_args()
    result = verify(args.original, args.control, args.candidate)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
