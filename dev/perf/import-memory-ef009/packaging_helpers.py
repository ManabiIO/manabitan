"""Unchanged package and semantic helpers from measurement-882.

Copyright (C) 2026 Manabitan authors
SPDX-License-Identifier: GPL-3.0-or-later

Only ROOT is relocated for this standalone memory scaffold. Provenance records
exact source-block hashes, including each arm's own native/manifest restoration.
"""

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import zipfile


ROOT = Path(__file__).resolve().parents[3]


PACKAGER = r"""
import fs from 'node:fs'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
const root = process.argv[1]
const {build, getBuildPlan} = await import(pathToFileURL(path.join(root, 'dev/bin/build.js')))
const {ManifestUtil} = await import(pathToFileURL(path.join(root, 'dev/manifest-util.js')))
const {copyDictionaryWasm} = await import(pathToFileURL(path.join(root, 'dev/dictionary-wasm.js')))
copyDictionaryWasm(path.join(root, 'ext/lib'), root)
const manifest = path.join(root, 'ext/manifest.json')
const original = fs.existsSync(manifest) ? fs.readFileSync(manifest) : null
const util = new ManifestUtil()
const plan = getBuildPlan(['--target', 'chrome'], util)
try {
    await build(path.join(root, 'builds'), path.join(root, 'ext'), util,
        plan.variantNames, manifest, false, false, plan.yomitanVersion)
} finally {
    if (original === null) { fs.rmSync(manifest, {force: true}) } else { fs.writeFileSync(manifest, original) }
}
"""


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def command(args, cwd=ROOT, log=None, check=True, timeout=1800):
    if log is None:
        result = subprocess.run(args, cwd=cwd, check=False, capture_output=True,
                                text=True, timeout=timeout)
        if check and result.returncode:
            raise RuntimeError(f"Command failed: {args}\n{result.stdout}\n{result.stderr}")
        return result
    with log.open("w") as output:
        result = subprocess.run(args, cwd=cwd, check=False, stdout=output,
                                stderr=subprocess.STDOUT, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError(f"Command failed: {args}; see {log}")
    return result


def package_members(path):
    with zipfile.ZipFile(path) as archive:
        names = [entry.filename for entry in archive.infolist() if not entry.is_dir()]
        if len(names) != len(set(names)):
            raise RuntimeError("Duplicate package members")
        return {name: hashlib.sha256(archive.read(name)).hexdigest() for name in sorted(names)}


def semantic_receipt(report):
    if report["status"] != "success" or report["skippedVerification"] is not False:
        raise RuntimeError("Import failed or skipped verification")
    validation = report["benchmark"]["validation"]
    if validation["contentReadable"] is not True or validation["restart"]["contentReadable"] is not True:
        raise RuntimeError("Content is not readable before and after restart")
    observations = validation["lookup"]["observations"]
    by_term = {}
    for row in observations:
        identity = {key: row[key] for key in ["term", "sha256", "results", "originalTextLength", "hasExactHeadwordMatch"]}
        if row["term"] in by_term and by_term[row["term"]] != identity:
            raise RuntimeError("Public lookup result changes across passes")
        by_term[row["term"]] = identity
    if len(by_term) != 12 or len(observations) != 72:
        raise RuntimeError("Missing complete lookup cohort")
    return {
        "title": validation["title"], "revision": validation["revision"],
        "termRows": validation["termRows"], "contentReadable": validation["contentReadable"],
        "probeTerms": sorted(validation["probeTerms"]),
        "publicResults": [by_term[key] for key in sorted(by_term)],
        "restart": validation["restart"], "media": validation["media"],
    }


def prepare_arm(name, commit, output, fixture_cache):
    arm = ROOT.parent / f"qualification-{os.environ.get('GITHUB_RUN_ID', 'local')}-{name}"
    if arm.exists():
        raise RuntimeError(f"Refusing to reuse an existing arm: {arm}")
    command(["git", "worktree", "add", "--detach", str(arm), commit])
    # Libraries are generated exactly once by the workflow setup. Never invoke
    # the build CLI here: it would regenerate esbuild output with other paths.
    shutil.copytree(ROOT / "ext/lib", arm / "ext/lib", dirs_exist_ok=True)
    shutil.copyfile(ROOT / "ext/legal-npm.html", arm / "ext/legal-npm.html")
    (arm / "node_modules").symlink_to(ROOT / "node_modules", target_is_directory=True)
    (arm / "builds").mkdir(exist_ok=True)
    (arm / "builds/e2e-dictionary-cache").symlink_to(fixture_cache, target_is_directory=True)
    # Restore this arm's own validated native modules after sharing libraries.
    command(["node", "--input-type=module", "-e", PACKAGER, str(arm)], cwd=arm,
            log=output / f"package-{name}.log")
    package = arm / "builds/manabitan-chrome.zip"
    shutil.copyfile(package, output / f"package-{name}.zip")
    members = package_members(package)
    write_json(output / f"package-{name}-members.json", members)
    receipt = {
        "sourceCommit": command(["git", "rev-parse", "HEAD"], cwd=arm).stdout.strip(),
        "sourceTree": command(["git", "rev-parse", "HEAD^{tree}"], cwd=arm).stdout.strip(),
        "packageSha256": sha256(package), "memberCount": len(members),
        "harnessSha256": {name: sha256(arm / name) for name in [
            "package-lock.json", "test/perf/dictionaries.lock.json",
            "dev/perf/benchmark-support.js", "dev/perf/dictionary-fixtures.js",
            "dev/perf/import-benchmark.js", "test/e2e/import-timing.js",
            "test/chromium/extension-two-dictionary-import.e2e.js",
        ]},
        "generatedLibrariesShared": True,
        "nativeModulesRestoredFromOwnManifest": True,
    }
    write_json(output / f"package-{name}-receipt.json", receipt)
    return arm, receipt, members
