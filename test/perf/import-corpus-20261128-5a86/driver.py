#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Prepare frozen source worktrees and run one bounded correctness replay."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
RELATIVE = "test/perf/import-corpus-20261128-5a86"
STUDY_FILES = ("replay.mjs", "upstream-replay.mjs.txt", "plan.json.txt", "provenance.json.txt",
               "adaptation.patch.txt", "verify.py", "driver.py", "README.md")
WORKFLOW = ".github/workflows/import-corpus-proof-5a86.yml"


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def git(*args, cwd=ROOT):
    return subprocess.check_output(["git", *args], cwd=cwd, text=True).strip()


def check():
    plan = json.loads((HERE / "plan.json.txt").read_text())
    provenance = json.loads((HERE / "provenance.json.txt").read_text())
    expected = {f"{RELATIVE}/{name}" for name in STUDY_FILES} | {WORKFLOW}
    changed = set(git("diff", "--name-only", plan["baseline"], "HEAD").splitlines())
    if changed != expected:
        raise ValueError(f"Study must change only the declared correctness tooling: {sorted(changed)}")
    if git("status", "--porcelain"):
        raise ValueError("Study checkout is dirty")
    bindings = {"plan.json.txt": "planSha256", "replay.mjs": "adaptedSha256",
                "adaptation.patch.txt": "patchSha256", "verify.py": "verifierSha256", "driver.py": "driverSha256"}
    for filename, key in bindings.items():
        if sha256((HERE / filename).read_bytes()) != provenance[key]:
            raise ValueError(f"Changed proof input: {filename}")
    if sha256((HERE / "upstream-replay.mjs.txt").read_bytes()) != provenance["upstream"]["sha256"]:
        raise ValueError("Upstream probe bytes changed")
    if sha256((ROOT / WORKFLOW).read_bytes()) != provenance["workflowSha256"]:
        raise ValueError("Workflow changed")
    if sha256((ROOT / "test/perf/dictionaries.lock.json").read_bytes()) != plan["fixtureLockSha256"]:
        raise ValueError("Fixture lock changed")
    for arm, source in plan["sources"].items():
        if git("rev-parse", source["commit"] + "^{tree}") != source["tree"]:
            raise ValueError(f"Unexpected source tree: {arm}")
    print("PROOF_INPUTS " + json.dumps({"studyCommit": git("rev-parse", "HEAD"), "plan": plan,
                                       "provenance": provenance}, sort_keys=True), flush=True)
    return plan


def run(dictionary, evidence):
    plan = check()
    if dictionary not in plan["dictionaries"]:
        raise ValueError("Unknown dictionary")
    evidence.mkdir(parents=True, exist_ok=False)
    code = evidence / "study-code"
    code.mkdir()
    for name in STUDY_FILES:
        shutil.copyfile(HERE / name, code / name)
    shutil.copyfile(ROOT / WORKFLOW, code / "workflow.yml")
    receipt = {"studyCommit": git("rev-parse", "HEAD"), "dictionary": dictionary,
               "plan": plan, "status": "preparing", "retries": 0, "startedUnixSeconds": time.time()}

    def save():
        (evidence / "invocation.json").write_text(json.dumps(receipt, indent=2) + "\n")

    def command(arguments, log, cwd=ROOT):
        with log.open("wb") as output:
            process = subprocess.run(arguments, cwd=cwd, stdout=output, stderr=subprocess.STDOUT)
        if process.returncode:
            receipt["failedCommand"] = arguments
            receipt["exitCode"] = process.returncode
            receipt["signal"] = -process.returncode if process.returncode < 0 else None
            save()
            raise RuntimeError(f"Command failed ({process.returncode}); preserved {log}")

    save()
    try:
        source_parent = evidence.with_name(evidence.name + "-sources")
        source_parent.mkdir(exist_ok=False)
        roots = {}
        for arm, source in plan["sources"].items():
            target = source_parent / arm
            command(["git", "worktree", "add", "--detach", str(target), source["commit"]], evidence / f"worktree-{arm}.log")
            shutil.copytree(ROOT / "node_modules", target / "node_modules", copy_function=os.link, symlinks=True)
            command(["npm", "run", "build:libs"], evidence / f"libraries-{arm}.log", target)
            if git("status", "--porcelain", cwd=target):
                raise ValueError(f"Source changed while preparing {arm}")
            roots[arm] = target
        arguments = ["node", "--expose-gc", str(HERE / "replay.mjs"),
                     "--baseline-root", str(roots["baseline"]), "--mask-root", str(roots["mask"]),
                     "--suffix-root", str(roots["suffix"]), "--parser-workers", "3",
                     "--cache-dir", str(ROOT / "builds/e2e-dictionary-cache"),
                     "--out", str(evidence / "report.json"), dictionary]
        receipt.update(status="running", command=arguments)
        save()
        command(arguments, evidence / "replay.log")
        receipt.update(status="complete", exitCode=0, endedUnixSeconds=time.time())
        save()
        print((evidence / "replay.log").read_text(), flush=True)
        return 0
    except BaseException as error:
        receipt.update(status="failed", endedUnixSeconds=time.time(),
                       error={"type": type(error).__name__, "message": str(error)})
        save()
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("check", "run"))
    parser.add_argument("--dictionary", choices=("jmdict", "jitendex", "vndb"))
    parser.add_argument("--evidence", type=Path)
    args = parser.parse_args()
    if args.mode == "check":
        check()
    else:
        if args.dictionary is None or args.evidence is None:
            parser.error("run requires --dictionary and --evidence")
        sys.exit(run(args.dictionary, args.evidence.resolve()))
