#!/usr/bin/env python3
"""Build exact sources and run the frozen JMdict screen on a separate Mac host.

This is a platform screen, not Linux evidence or memory qualification.
SPDX-License-Identifier: GPL-3.0-or-later
"""

import argparse
import hashlib
import json
import pathlib
import platform
import shutil
import subprocess
import sys
import time


ROOT = pathlib.Path(__file__).resolve().parents[3]
BASELINE = "9e10d3b3fcf66d344ab31bc42c9b522fa5215da2"
DRIVER_PATH = "dev/perf/import-macos-screen-driver-bda85f3c7e15.py"
DRIVER_SHA256 = "017e1ee5b1c5f413e84bbef9c71c385ca6bcec4998cb88fb938f8e8bbc664ac4"
LOOKAHEAD_FLAGS = {"experimentalTermContentLookahead": True}
PACKAGE_PATHS = {
    "control": [],
    "preload": ["js/dictionary/dictionary-importer.js"],
    "lookahead": [
        "js/dictionary/dictionary-database.js",
        "js/dictionary/dictionary-importer.js",
        "js/dictionary/term-bank-experiments.js",
        "js/dictionary/term-bank-wasm-parser.js",
        "js/dictionary/term-content-lookahead.js",
        "js/dictionary/term-content-ownership.js",
        "js/dictionary/term-import-metrics.js",
    ],
}
VALIDATION = {
    "lookahead": [
        ["npx", "eslint",
         "ext/js/dictionary/dictionary-database.js", "ext/js/dictionary/dictionary-importer.js",
         "ext/js/dictionary/term-bank-experiments.js", "ext/js/dictionary/term-bank-wasm-parser.js",
         "ext/js/dictionary/term-content-lookahead.js", "ext/js/dictionary/term-content-ownership.js",
         "ext/js/dictionary/term-import-metrics.js", "test/dictionary-database-content-dedup.test.js",
         "test/term-bank-wasm-parser.test.js", "types/ext/dictionary-importer.d.ts"],
        ["npm", "run", "test:ts:main"],
        ["npm", "run", "test:ts:test"],
        ["npx", "vitest", "run", "test/dictionary-database-content-dedup.test.js",
         "test/term-bank-wasm-parser.test.js", "test/term-content-ownership.test.js",
         "test/term-import-metrics.test.js", "test/term-bank-experiments.test.js",
         "test/perf-experiment-receipts.test.js", "test/perf-import-experiment-evidence.test.js",
         "--maxWorkers=2"],
        ["npm", "run", "test:build"],
        ["npm", "run", "test:unit", "--", "--maxWorkers=2", "--testTimeout=20000"],
    ],
    "preload": [
        ["npx", "eslint", "ext/js/dictionary/dictionary-importer.js",
         "test/dictionary-importer-canonical-preload.test.js"],
        ["npm", "run", "test:ts:main"],
        ["npm", "run", "test:ts:test"],
        ["npx", "vitest", "run", "test/dictionary-importer-canonical-preload.test.js",
         "test/term-content-canonical-scan.test.js", "test/dictionary-importer-row-materialization.test.js",
         "test/dictionary-importer-source-cancellation.test.js", "--maxWorkers=2"],
        ["npm", "run", "test:build"],
        ["npm", "run", "test:unit", "--", "--maxWorkers=2", "--testTimeout=20000"],
    ],
}


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def output(command, cwd):
    return subprocess.check_output(command, cwd=cwd, text=True).strip()


def run(command, cwd, log):
    print(json.dumps({"command": command, "cwd": str(cwd), "log": str(log)}), flush=True)
    with log.open("w") as stream:
        subprocess.run(command, cwd=cwd, stdout=stream, stderr=subprocess.STDOUT,
                       check=True, timeout=2400)


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", required=True, choices=("validation", "screen"))
    parser.add_argument("--cell", required=True, choices=("lookahead", "preload", "control"))
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--lookahead", required=True)
    parser.add_argument("--preload", required=True)
    parser.add_argument("--worktree-parent", required=True, type=pathlib.Path)
    parser.add_argument("--evidence", required=True, type=pathlib.Path)
    parser.add_argument("--check-plan", action="store_true")
    args = parser.parse_args()
    for name in ("baseline", "lookahead", "preload"):
        value = getattr(args, name)
        if len(value) != 40 or any(character not in "0123456789abcdef" for character in value):
            parser.error(f"{name} must be a complete lowercase frozen source SHA")
    if args.baseline != BASELINE:
        parser.error("The copied screen driver is frozen to the registered 9e10 baseline")
    if args.mode == "validation" and args.cell == "control":
        parser.error("Validation cells are the two frozen candidate revisions")
    return args


def registered_plan(args):
    candidate = {"lookahead": args.lookahead, "preload": args.preload,
                 "control": args.baseline}[args.cell]
    return {
        "platformScope": "Separate macos-15-intel exploratory screen; never pooled with Linux",
        "mode": args.mode, "cell": args.cell, "dictionary": "jmdict",
        "requiredHost": {"platform": "darwin", "arch": "x64", "node": "v22.22.0"},
        "sources": {"A": args.baseline, "B": candidate},
        "candidatePins": {"lookahead": args.lookahead, "preload": args.preload},
        "flags": {"A": None, "B": LOOKAHEAD_FLAGS if args.cell == "lookahead" else None},
        "expectedPackagePaths": PACKAGE_PATHS[args.cell],
        "driver": {"path": DRIVER_PATH, "sha256": DRIVER_SHA256,
                   "copiedFromCommit": "7e50f6db762ab5ddbeb6413782c399053cad39dc",
                   "copiedFromPath": "dev/perf/import-lookahead-bda85f3c7e15.py"},
        "screenImports": {"excludedWarmups": 2, "timedPairs": 6, "timedImports": 12,
                          "separateExhaustiveMedia": 2, "separateDiagnosticTraces": 2,
                          "totalPerScreenCell": 18},
        "memoryQualification": False,
        "validationCommands": VALIDATION.get(args.cell) if args.mode == "validation" else None,
        "worktreeParent": str(args.worktree_parent.resolve()),
        "evidence": str(args.evidence.resolve()),
    }


def checkout(sha, label, parent, evidence, fixtures):
    source = parent / label
    run(["git", "fetch", "--no-tags", "--depth=1", "origin", sha], ROOT,
        evidence / f"{label}-fetch.log")
    run(["git", "worktree", "add", "--detach", str(source), sha], ROOT,
        evidence / f"{label}-checkout.log")
    actual = output(["git", "rev-parse", "HEAD"], source)
    if actual != sha:
        raise RuntimeError(f"Wrong source for {label}: {actual}")
    for name in ("package.json", "package-lock.json", "test/perf/dictionaries.lock.json"):
        if digest(ROOT / name) != digest(source / name):
            raise RuntimeError(f"Shared dependency or fixture identity changed: {label}/{name}")
    (source / "node_modules").symlink_to((ROOT / "node_modules").resolve(strict=True), target_is_directory=True)
    (source / "builds").mkdir(exist_ok=True)
    if fixtures:
        cache = (ROOT / "builds/e2e-dictionary-cache").resolve(strict=True)
        (source / "builds/e2e-dictionary-cache").symlink_to(cache, target_is_directory=True)
    return source


def assert_clean(source):
    state = output(["git", "status", "--porcelain=v1", "--untracked-files=no"], source)
    if state:
        raise RuntimeError(f"Tracked source changed while preparing {source}: {state}")


def prepare(source, label, evidence, package):
    for name in ("build:libs", "license-report:html"):
        run(["npm", "run", name], source, evidence / f"{label}-{name.replace(':', '-')}.log")
    if package:
        run(["npm", "run", "build", "--", "--target", "chrome"], source,
            evidence / f"{label}-build-package.log")
    assert_clean(source)


def main():
    args = parse_args()
    plan = registered_plan(args)
    if args.check_plan:
        print(json.dumps(plan, indent=2, sort_keys=True))
        return
    evidence = args.evidence.resolve()
    evidence.mkdir(parents=True, exist_ok=True)
    if (evidence / "status.json").exists():
        raise RuntimeError("Evidence path already contains an attempted cohort")
    write_json(evidence / "registered-platform-plan.json", plan)
    state = {"status": "running", "startedAtUnix": time.time()}
    write_json(evidence / "status.json", state)
    try:
        if sys.platform != "darwin" or platform.machine() != "x86_64":
            raise RuntimeError("This cohort requires the separate Intel macOS runner")
        if output(["node", "--version"], ROOT) != "v22.22.0":
            raise RuntimeError("This cohort requires Node 22.22.0")
        if digest(ROOT / DRIVER_PATH) != DRIVER_SHA256:
            raise RuntimeError("Frozen screen driver bytes changed")
        write_json(evidence / "host-before.json", json.loads(output(["node", "dev/perf/host-environment.js"], ROOT)))
        parent = args.worktree_parent.resolve()
        parent.mkdir(parents=True, exist_ok=False)
        candidate_sha = plan["sources"]["B"]
        if args.mode == "validation":
            candidate = checkout(candidate_sha, "candidate", parent, evidence, False)
            prepare(candidate, "candidate", evidence, False)
            for index, command in enumerate(VALIDATION[args.cell], start=1):
                run(command, candidate, evidence / f"validation-{index:02d}.log")
            assert_clean(candidate)
            write_json(evidence / "validation-receipt.json", {
                "source": candidate_sha, "tree": output(["git", "rev-parse", "HEAD^{tree}"], candidate),
                "commands": VALIDATION[args.cell], "allPassed": True,
                "platform": "darwin", "arch": "x64", "node": "v22.22.0",
            })
        else:
            baseline = checkout(args.baseline, "baseline", parent, evidence, True)
            prepare(baseline, "baseline", evidence, True)
            candidate = baseline
            if args.cell != "control":
                candidate = checkout(candidate_sha, "candidate", parent, evidence, True)
                prepare(candidate, "candidate", evidence, True)
            packages = evidence / "packages"
            packages.mkdir()
            shutil.copyfile(baseline / "builds/manabitan-chrome.zip", packages / "A.zip")
            if candidate != baseline:
                shutil.copyfile(candidate / "builds/manabitan-chrome.zip", packages / "B.zip")
            else:
                write_json(packages / "B-is-identical-to-A.json", {"source": args.baseline,
                           "packageSha256": digest(packages / "A.zip")})
            command = ["python3", str(ROOT / DRIVER_PATH), "jmdict",
                       "--baseline-root", str(baseline), "--candidate-root", str(candidate),
                       "--output", str(evidence / "screen")]
            for path in PACKAGE_PATHS[args.cell]:
                command.extend(("--expected-package-path", path))
            if args.cell == "lookahead":
                command.extend(("--candidate-flags", json.dumps(LOOKAHEAD_FLAGS, separators=(",", ":")),
                                "--require-lookahead"))
            write_json(evidence / "screen-command.json", command)
            run(command, ROOT, evidence / "screen-runner.log")
            assert_clean(baseline)
            assert_clean(candidate)
        state["status"] = "complete"
    except Exception as error:
        state["status"] = "failed"
        state["error"] = str(error)
        raise
    finally:
        state["finishedAtUnix"] = time.time()
        write_json(evidence / "status.json", state)


if __name__ == "__main__":
    main()
