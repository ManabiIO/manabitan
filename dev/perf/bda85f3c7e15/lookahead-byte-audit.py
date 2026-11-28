#!/usr/bin/env python3
"""Four separate complete-JMdict storage-byte checks; no performance claim.

Copyright (C) 2026 Manabitan authors
SPDX-License-Identifier: GPL-3.0-or-later
"""

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import zipfile


BASE = "9e10d3b3fcf66d344ab31bc42c9b522fa5215da2"
CANDIDATE = "7e50f6db762ab5ddbeb6413782c399053cad39dc"
FIXTURE_LOCK_SHA256 = "60aa981791f3b60ca17588212aea5bd3536fb8f59288855e5accd019c6e4cf89"
PATCHED_HARNESS_SHA256 = "d07ba020462b9421097a20e88cb1031b3c2aef19bfe1de407073b6e45058c6b6"
EXPECTED_ENTRIES = sorted("js/dictionary/" + name + ".js" for name in (
    "dictionary-database", "dictionary-importer", "term-bank-experiments",
    "term-bank-wasm-parser", "term-content-lookahead", "term-content-ownership",
    "term-import-metrics",
))
SHARED_FILES = (
    "package.json", "package-lock.json", "test/perf/dictionaries.lock.json",
    "dev/perf/import-benchmark.js", "dev/perf/benchmark-support.js",
    "dev/perf/dictionary-fixtures.js", "dev/perf/host-environment.js",
    "test/chromium/extension-two-dictionary-import.e2e.js",
    "test/e2e/import-timing.js", "test/e2e/chromium-launch-options.js",
    "ext/js/core/safe-performance.js",
)


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def output(command, cwd):
    return subprocess.check_output(command, cwd=cwd, text=True).strip()


def package(root):
    path = root / "builds/manabitan-chrome.zip"
    with zipfile.ZipFile(path) as archive:
        entries = {entry.filename: hashlib.sha256(archive.read(entry)).hexdigest()
                   for entry in archive.infolist() if not entry.is_dir()}
    return {"sha256": sha256(path), "entries": entries}


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline-root", required=True, type=Path)
    parser.add_argument("--candidate-root", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    roots = {"A": args.baseline_root.resolve(), "B": args.candidate_root.resolve()}
    target = args.output.resolve()
    target.mkdir(parents=True, exist_ok=False)
    helpers = Path(__file__).resolve().parent
    plan = ["A1", "B1", "A2", "B2"]
    status = {"scope": "Separate complete custom-storage byte parity; no timing or memory inference", "status": "running", "plan": plan, "observations": []}
    write_json(target / "status.json", status)
    try:
        sources = {arm: output(["git", "rev-parse", "HEAD"], root) for arm, root in roots.items()}
        if sources != {"A": BASE, "B": CANDIDATE}:
            raise RuntimeError("Byte audit source identities changed")
        status["sources"] = sources
        for name in SHARED_FILES:
            if sha256(roots["A"] / name) != sha256(roots["B"] / name):
                raise RuntimeError("Shared verification harness/dependency changed: " + name)
        if sha256(roots["A"] / "test/perf/dictionaries.lock.json") != FIXTURE_LOCK_SHA256:
            raise RuntimeError("Fixture lock differs from the predeclared source")
        status["sharedSourceHashesBeforeInstrumentation"] = {name: sha256(roots["A"] / name) for name in SHARED_FILES}
        packages = {arm: package(root) for arm, root in roots.items()}
        names = set(packages["A"]["entries"]) | set(packages["B"]["entries"])
        changed = sorted(name for name in names if packages["A"]["entries"].get(name) != packages["B"]["entries"].get(name))
        if changed != EXPECTED_ENTRIES:
            raise RuntimeError("Unexpected packaged runtime differences: " + repr(changed))
        status["packageHashes"] = {arm: value["sha256"] for arm, value in packages.items()}
        status["packagedChanges"] = changed
        for arm in roots:
            write_json(target / ("package-entries-" + arm + ".json"), packages[arm]["entries"])
        browser_paths = {arm: Path(output([
            "node", "--input-type=module", "-e",
            "import {chromium} from '@playwright/test'; process.stdout.write(chromium.executablePath());",
        ], root)).resolve(strict=True) for arm, root in roots.items()}
        browser_hashes = {arm: sha256(path) for arm, path in browser_paths.items()}
        if browser_hashes["A"] != browser_hashes["B"]:
            raise RuntimeError("Byte-audit browser executables differ")
        status["browserHashes"] = browser_hashes
        subprocess.run([
            "python3", str(helpers / "install-storage-byte-audit.py"),
            "--baseline-root", str(roots["A"]), "--candidate-root", str(roots["B"]),
            "--output", str(target / "instrumentation"),
        ], check=True)
        for root in roots.values():
            if sha256(root / "test/chromium/extension-two-dictionary-import.e2e.js") != PATCHED_HARNESS_SHA256:
                raise RuntimeError("Byte-audit instrumentation differs from its predeclared hash")
        write_json(target / "status.json", status)
        browser_version = None
        for label in plan:
            arm = label[0]
            directory = target / label
            directory.mkdir()
            command = ["node", "dev/perf/import-benchmark.js", "jmdict", "--runs", "1", "--no-build", "--build-target", "chrome", "--media-check", "all", "--output", str(directory)]
            flags = {"experimentalTermContentLookahead": True} if arm == "B" else None
            if flags is not None:
                command.extend(["--flags", json.dumps(flags, separators=(",", ":"))])
            write_json(directory / "command.json", command)
            with (directory / "runner.log").open("w") as log:
                subprocess.run(command, cwd=roots[arm], stdout=log, stderr=subprocess.STDOUT, timeout=1200, check=True)
            summary = json.loads((directory / "summary.json").read_text())
            if summary["gitSha"] != sources[arm] or summary["importFlags"] != flags or summary["mediaCheck"] != "all" or summary["traceEnabled"] is not False:
                raise RuntimeError("Byte-audit observation differs from its registered source/configuration")
            if len(summary["runs"]) != 1 or summary["runs"][0]["packageSha256"] != packages[arm]["sha256"]:
                raise RuntimeError("Byte-audit package or import count changed")
            if browser_version is not None and summary["browserVersion"] != browser_version:
                raise RuntimeError("Browser runtime changed between byte audits")
            browser_version = summary["browserVersion"]
            status["observations"].append({"label": label, "source": sources[arm], "packageSha256": packages[arm]["sha256"], "report": str(directory / "run-1.json")})
            write_json(target / "status.json", status)
            print(label + ": complete import/restart and every custom file hashed", flush=True)
        subprocess.run([
            "python3", str(helpers / "compare-storage-byte-audits.py"),
            "--baseline", str(target / "A1/run-1.json"), "--baseline", str(target / "A2/run-1.json"),
            "--candidate", str(target / "B1/run-1.json"), "--candidate", str(target / "B2/run-1.json"),
            "--instrumentation", str(target / "instrumentation/instrumentation.json"),
            "--fixture-lock", str(roots["A"] / "test/perf/dictionaries.lock.json"),
            "--expected-baseline-package-sha256", packages["A"]["sha256"],
            "--expected-candidate-package-sha256", packages["B"]["sha256"],
            "--expected-patched-harness-sha256", PATCHED_HARNESS_SHA256,
            "--require-lookahead", "--output", str(target / "byte-parity.json"),
        ], check=True)
        for arm, root in roots.items():
            if package(root) != packages[arm] or sha256(browser_paths[arm]) != browser_hashes[arm]:
                raise RuntimeError("Package or browser changed during the byte audit")
        status["status"] = "passed"
        status["browserVersion"] = browser_version
    except Exception as error:
        status["status"] = "failed"
        status["error"] = str(error)
        raise
    finally:
        write_json(target / "status.json", status)


if __name__ == "__main__":
    main()
