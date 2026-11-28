#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Profile the frozen current baseline with separate ordinary and traced imports.

The ordinary observation binds the complete current semantic/storage receipt.
The separate browser-wide trace is diagnostic, never a candidate timing result.
Historical semantic helpers are used unchanged with baseline-derived SAH bounds.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import zipfile

BASELINE = "9e10d3b3fcf66d344ab31bc42c9b522fa5215da2"
DICTIONARIES = ("jmdict", "jitendex", "vndb")
NODE_VERSION = "v22.22.0"
PLAYWRIGHT_VERSION = "1.63.0"
SHA = re.compile(r"[a-f0-9]{40}")
SQLITE_FILE = re.compile(r"manabitan/sqlite-sahpool-v1/\.opaque/[a-z0-9]+")
PROVENANCE_PATHS = (
    "package-lock.json", "test/perf/dictionaries.lock.json",
    "dev/perf/benchmark-support.js", "dev/perf/dictionary-fixtures.js",
    "dev/perf/import-benchmark.js", "test/chromium/import-flags-ab-benchmark.js",
    "test/chromium/extension-two-dictionary-import.e2e.js", "test/e2e/import-timing.js",
    "ext/js/pages/settings/dictionary-import-controller.js",
    "builds/manabitan-chrome-dev.zip", "builds/manabitan-chrome.zip",
)
HELPER_PATHS = (
    "dev/perf/import-qualification-20261125-a7f7.py",
    "dev/perf/import-memory-20261125-a7f7/chromium_memory.py",
    "dev/perf/import-memory-20261125-a7f7/protocol.py",
    "dev/perf/import-memory-20261125-a7f7/audit_memory.py",
    "dev/perf/import-memory-20261125-a7f7/qualification_receipts.py",
)


def config():
    return {
        "baseline": BASELINE, "mode": "profile",
        "nodeVersion": NODE_VERSION, "playwrightVersion": PLAYWRIGHT_VERSION,
        "importFlags": None,
        "matrix": {"include": [
            {"dictionary": dictionary, "initialOrder": "AB"}
            for dictionary in DICTIONARIES
        ]},
    }

def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n")


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def package_entries(path):
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ValueError("Duplicate package member")
        return {item.filename: hashlib.sha256(archive.read(item)).hexdigest()
                for item in archive.infolist() if not item.is_dir()}


def baseline_sah_units(storage):
    """Derive the prospective bound from baseline only, before candidate work.

    The unchanged verifier then checks complete paths, inventory, totals and
    raw-report binding with this exact bound. Candidate cannot select or widen it.
    """
    if not isinstance(storage, dict) or not isinstance(storage.get("files"), list):
        raise ValueError("Baseline lacks a storage inventory")
    files = storage["files"]
    if any(not isinstance(item, dict) or not isinstance(item.get("path"), str) for item in files):
        raise ValueError("Malformed baseline storage entry")
    paths = [item["path"] for item in files]
    if len(paths) != len(set(paths)):
        raise ValueError("Duplicate baseline storage path")
    sizes = [item.get("bytes") for item in files if SQLITE_FILE.fullmatch(item["path"])]
    if any(type(size) is not int or size < 0 for size in sizes):
        raise ValueError("Invalid baseline SAH size")
    if len(sizes) != 8 or sizes.count(4096) != 7:
        raise ValueError("Expected eight baseline SAH files with seven empty files")
    active = [size for size in sizes if size != 4096]
    if len(active) != 1 or active[0] <= 4096 or active[0] % 4096 or active[0] > 2 ** 53 - 1:
        raise ValueError("Expected one aligned baseline SAH allocation")
    return active[0] // 4096


def clean_env():
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(("MANABITAN_E2E_", "MANABITAN_CHROMIUM_"))}
    env["MANABITAN_E2E_STRICT_RUNTIME"] = "1"
    env["MANABITAN_CHROMIUM_ALLOW_HEADED_FALLBACK"] = "0"
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    return env


def run(command, root, output, env):
    started = time.time()
    with output.open("wb") as log:
        result = subprocess.run(command, cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT)
    write_json(output.with_suffix(output.suffix + ".command.json"), {
        "command": [str(value) for value in command], "cwd": str(root),
        "startedAtEpochSeconds": started, "finishedAtEpochSeconds": time.time(),
        "exitCode": result.returncode,
    })
    if result.returncode:
        raise RuntimeError(f"Command failed ({result.returncode}); retained log: {output}")


def git(root, *args):
    return subprocess.check_output(["git", *args], cwd=root, text=True).strip()


def source_identity(root):
    archive = root / "builds/manabitan-chrome.zip"
    return {
        "sha": git(root, "rev-parse", "HEAD"),
        "tree": git(root, "rev-parse", "HEAD^{tree}"),
        "packageSha256": digest(archive), "packageEntries": package_entries(archive),
        "sourceHashes": {name: digest(root / name) if (root / name).is_file() else None
                         for name in PROVENANCE_PATHS},
    }


def require_clean(root):
    status = git(root, "status", "--porcelain", "--untracked-files=normal")
    if status:
        raise RuntimeError(f"Unexpected changes in frozen product source:\n{status}")


def benchmark_command(dictionary, output, trace=False):
    command = ["node", "dev/perf/import-benchmark.js", dictionary, "--runs", "1",
               "--no-build", "--build-target", "chrome", "--media-check", "sample",
               "--output", str(output)]
    if trace:
        command.append("--trace")
    return command


def acquire(args):
    if sys.flags.optimize:
        raise ValueError("Optimized Python execution is not allowed for qualification")
    sys.dont_write_bytecode = True
    plan = config()
    root = args.root.resolve()
    output = args.evidence.resolve()
    output.mkdir(parents=True, exist_ok=False)
    env = clean_env()
    status = {"status": "running", "plan": plan, "dictionary": args.dictionary,
              "initialOrder": args.initial_order, "toolingSha": args.tooling_sha}
    write_json(output / "status.json", status)
    try:
        if SHA.fullmatch(args.tooling_sha) is None:
            raise ValueError("Tooling must have an exact commit identity")
        frozen_driver = subprocess.check_output([
            "git", "show", f"{args.tooling_sha}:dev/perf/import-qualification-511a8.py",
        ], cwd=root)
        if Path(__file__).read_bytes() != frozen_driver:
            raise ValueError("Executed driver differs from declared tooling commit")
        if git(root, "rev-parse", "HEAD") != BASELINE:
            raise ValueError("Product checkout does not match frozen baseline")
        if args.initial_order != "AB":
            raise ValueError("Profile acquisition has one host per dictionary")
        require_clean(root)
        node_version = subprocess.check_output(["node", "--version"], text=True).strip()
        if node_version != NODE_VERSION:
            raise ValueError(f"Expected Node {NODE_VERSION}, observed {node_version}")
        playwright = json.loads((root / "node_modules/playwright/package.json").read_text())["version"]
        browser_path = Path(subprocess.check_output([
            "node", "--input-type=module", "-e",
            "import {chromium} from 'playwright'; process.stdout.write(chromium.executablePath())",
        ], cwd=root, text=True))
        browser_text = subprocess.check_output([str(browser_path), "--version"], text=True).strip()
        browser_version = re.search(r"\d+(?:\.\d+){3}", browser_text).group()
        browser_lock = json.loads((root / "node_modules/playwright-core/browsers.json").read_text())
        pinned_browser = next(item for item in browser_lock["browsers"] if item["name"] == "chromium")
        if playwright != PLAYWRIGHT_VERSION or browser_version != pinned_browser["browserVersion"]:
            raise ValueError("Browser/Playwright does not match pinned dependency")
        write_json(output / "runtime.json", {
            "nodeVersion": node_version, "playwrightVersion": playwright,
            "browserVersion": browser_version, "browserVersionOutput": browser_text,
            "browserSha256": digest(browser_path), "browserLock": pinned_browser,
            "packageLockSha256": digest(root / "package-lock.json"),
            "dictionaryLockSha256": digest(root / "test/perf/dictionaries.lock.json"),
            "driverSha256": digest(Path(__file__)),
            "helpers": {name: digest(root / name) for name in HELPER_PATHS},
        })
        source_dir = output / "measurement-source"
        source_dir.mkdir()
        for name in set(HELPER_PATHS) | {path for path in PROVENANCE_PATHS if not path.startswith("builds/")}:
            target = source_dir / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((root / name).read_bytes())
        (source_dir / "import-qualification-511a8.py").write_bytes(Path(__file__).read_bytes())
        sys.path.insert(0, str(root / "dev/perf/import-memory-20261125-a7f7"))
        from qualification_receipts import validate_import_summary
        fixture = json.loads((root / "test/perf/dictionaries.lock.json").read_text())["dictionaries"][args.dictionary]
        run(["node", "dev/perf/prepare-dictionaries.js", args.dictionary], root, output / "fixtures.log", env)
        for name, command in (
            ("libs", ["npm", "run", "build:libs"]),
            ("license", ["npm", "run", "license-report:html"]),
            ("build", ["npm", "run", "build", "--", "--target", "chrome"]),
        ):
            run(command, root, output / f"{name}.log", env)
        require_clean(root)
        identity = source_identity(root)
        write_json(output / "baseline-source.json", identity)

        # One declared baseline-only policy observation, excluded from all cohort
        # statistics. Candidate never selects allocation or equality expectations.
        policy_output = output / "baseline-policy"
        policy_output.mkdir()
        run(benchmark_command(args.dictionary, policy_output), root, policy_output / "run.log", env)
        summary = json.loads((policy_output / "summary.json").read_text())
        report = json.loads((policy_output / "run-1.json").read_text())
        units = baseline_sah_units(report["benchmark"]["validation"]["storage"]) if args.dictionary == "vndb" else None
        bounds = (units, units) if units is not None else None
        reference = validate_import_summary(
            summary, report, dictionary=args.dictionary, fixture=fixture,
            source_sha=BASELINE, package_sha256=identity["packageSha256"],
            browser_version=browser_version, import_flags=None,
            source_hashes=identity["sourceHashes"], source_dirty=False,
            media_check="sample", vndb_sah_allocation_units=bounds,
        )
        write_json(policy_output / "canonical-receipt.json", reference)
        write_json(output / "prospective-policy.json", {
            "baseline": BASELINE, "fixture": fixture,
            "baselinePackageSha256": identity["packageSha256"],
            "policyRawReportSha256": digest(policy_output / "run-1.json"),
            "policySummarySha256": digest(policy_output / "summary.json"),
            "vndbSahUnits": bounds,
            "origin": "One source-verified baseline-only observation before candidate work",
            "comparison": "Exact normalized per-file storage and semantic equality; no allocation waiver",
            "timingUse": "Excluded from the predeclared comparison schedule and statistics",
        })
        # Capture the diagnostic separately after validating the ordinary import.
        trace_root = root
        diagnostic = output / "diagnostic"
        diagnostic.mkdir()
        before = source_identity(trace_root)
        require_clean(trace_root)
        write_json(diagnostic / "source.json", before)
        run(benchmark_command(args.dictionary, diagnostic, trace=True), trace_root, diagnostic / "run.log", env)
        trace_summary = json.loads((diagnostic / "summary.json").read_text())
        if (trace_summary.get("authoritativeTiming") is not False or trace_summary.get("traceEnabled") is not True or
                trace_summary.get("dictionary") != args.dictionary or trace_summary.get("gitSha") != before["sha"] or
                trace_summary.get("browserVersion") != browser_version or len(trace_summary.get("runs", [])) != 1 or
                trace_summary["runs"][0].get("packageSha256") != before["packageSha256"]):
            raise ValueError("Invalid separate diagnostic identity")
        trace_file = diagnostic / "run-1.trace.json"
        if not trace_file.is_file() or trace_file.stat().st_size == 0:
            raise ValueError("Missing browser-wide diagnostic trace")
        require_clean(trace_root)
        if source_identity(trace_root) != before:
            raise ValueError("Diagnostic changed source/package identities")
        status["status"] = "baseline-profile-complete"
        status["timingInterpretation"] = "Diagnostic timings excluded; passing checks alone does not establish speedup"
    except Exception as error:
        status.update(status="failed", error={"type": type(error).__name__, "message": str(error)})
        raise
    finally:
        write_json(output / "status.json", status)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="action", required=True)
    subparsers.add_parser("plan")
    acquire_parser = subparsers.add_parser("run")
    acquire_parser.add_argument("--root", type=Path, required=True)
    acquire_parser.add_argument("--evidence", type=Path, required=True)
    acquire_parser.add_argument("--dictionary", choices=DICTIONARIES, required=True)
    acquire_parser.add_argument("--initial-order", choices=("AB", "BA"), required=True)
    acquire_parser.add_argument("--tooling-sha", required=True)
    args = parser.parse_args()
    if args.action == "plan":
        plan = config()
        print(f"baseline={plan['baseline']}")
        print(f"mode={plan['mode']}")
        print("matrix=" + json.dumps(plan["matrix"], separators=(",", ":")))
    else:
        acquire(args)


if __name__ == "__main__":
    main()
