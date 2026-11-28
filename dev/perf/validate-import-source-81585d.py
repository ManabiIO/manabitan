#!/usr/bin/env python3
"""Frozen source validation with explicit command statuses; no performance data."""

import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import time
import zipfile


ROOT = Path.cwd()
OUTPUT = ROOT / "builds/qualification-validation"


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True).strip()


def context():
    plan = json.loads((OUTPUT / "validation-plan.json").read_text())
    selected = (OUTPUT / "candidate-name.txt").read_text().strip()
    protocol = json.loads((OUTPUT / "protocol.json").read_text())
    return plan, selected, protocol["candidates"][selected]


def identity():
    plan, selected, candidate = context()
    actual = {"commit": git("rev-parse", "HEAD"), "tree": git("rev-parse", "HEAD^{tree}")}
    if actual != plan["sources"][selected]:
        raise RuntimeError(f"Frozen source identity mismatch: {actual}")
    changes = git("diff", "--name-only", plan["base"], "HEAD").splitlines()
    if sorted(changes) != sorted(candidate["sourceDelta"]):
        raise RuntimeError("Source delta differs from the approved candidate")
    for name, expected in plan["preservedTimingInputs"].items():
        if sha256(OUTPUT / name) != expected:
            raise RuntimeError(f"Frozen timing input changed: {name}")
    paths = sorted(set(candidate["sourceDelta"] + [
        "package.json", "package-lock.json", "test/perf/dictionaries.lock.json",
        ".github/actions/setup/action.yml", "dev/data/dictionary-wasm/manifest.json",
    ]))
    write_json(OUTPUT / "source-identity.json", {
        "candidate": selected, **actual, "approvedSourceDelta": changes,
        "inputSha256": {name: sha256(ROOT / name) for name in paths},
        "validationRunnerSha256": sha256(Path(__file__)),
        "validationWorkflowSha256": sha256(OUTPUT / "executed-workflow.yml"),
        "validationPlanSha256": sha256(OUTPUT / "validation-plan.json"),
    })
    if git("status", "--porcelain"):
        raise RuntimeError("Source checkout is dirty before validation setup")


def run_gate(name, command):
    plan, _, _ = context()
    if command != plan["gates"].get(name):
        raise RuntimeError(f"Command differs from frozen validation gate: {name}")
    receipt = {"name": name, "command": command, "startedAtEpochSeconds": time.time(),
               "status": "started", "returnCode": None}
    receipt_path = OUTPUT / f"gate-{name}.json"
    write_json(receipt_path, receipt)
    try:
        with (OUTPUT / f"{name}.log").open("wb") as log:
            process = subprocess.Popen(command, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            assert process.stdout is not None
            for line in iter(process.stdout.readline, b""):
                log.write(line)
                log.flush()
                sys.stdout.buffer.write(line)
                sys.stdout.buffer.flush()
            status = process.wait()
        receipt.update({"status": "success" if status == 0 else "failure", "returnCode": status})
    except Exception as error:
        receipt.update({"status": "failure", "error": {"type": type(error).__name__, "message": str(error)}})
    finally:
        receipt["completedAtEpochSeconds"] = time.time()
        write_json(receipt_path, receipt)
    code = receipt["returnCode"]
    return code if isinstance(code, int) and code >= 0 else 1


def package():
    plan, _, candidate = context()
    packager = OUTPUT / "timing-runner.py"
    if sha256(packager) != plan["preservedTimingInputs"]["timing-runner.py"]:
        raise RuntimeError("Package builder source differs from frozen acquisition")
    spec = importlib.util.spec_from_file_location("qualification_packager", packager)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    subprocess.run(["node", "--input-type=module", "-e", module.PACKAGER, str(ROOT)], cwd=ROOT, check=True)
    path = ROOT / "builds/manabitan-chrome.zip"
    with zipfile.ZipFile(path) as archive:
        names = [entry.filename for entry in archive.infolist() if not entry.is_dir()]
        if len(names) != len(set(names)):
            raise RuntimeError("Duplicate package member")
        members = {name: hashlib.sha256(archive.read(name)).hexdigest() for name in sorted(names)}
    for name, expected in candidate["packagedSha256"].items():
        if members.get(name) != expected:
            raise RuntimeError(f"Reviewed packaged member differs: {name}")
    write_json(OUTPUT / "package-members.json", members)
    write_json(OUTPUT / "package-identity.json", {
        "sourceCommit": git("rev-parse", "HEAD"), "sourceTree": git("rev-parse", "HEAD^{tree}"),
        "packageSha256": sha256(path), "memberCount": len(members),
        "reviewedChangedMemberSha256": candidate["packagedSha256"],
        "reviewedChangedMembersMatch": True,
        "completeBaselineDeltaGate": "Independent stage-2 package preflight remains required",
    })


def runtime():
    plan, _, _ = context()
    version = subprocess.check_output(["node", "--version"], cwd=ROOT, text=True).strip()
    if version != plan["nodeVersion"]:
        raise RuntimeError(f"Frozen Node runtime differs: {version}")
    write_json(OUTPUT / "runtime-identity.json", {
        "node": version,
        "npm": subprocess.check_output(["npm", "--version"], cwd=ROOT, text=True).strip(),
        "python": sys.version,
    })


def conclude():
    plan, selected, _ = context()
    receipts = {}
    failures = []
    for name, command in plan["gates"].items():
        path = OUTPUT / f"gate-{name}.json"
        if not path.is_file():
            failures.append({"gate": name, "reason": "missing command receipt"})
            continue
        receipt = json.loads(path.read_text())
        receipts[name] = receipt
        if receipt.get("command") != command or receipt.get("status") != "success" or receipt.get("returnCode") != 0:
            failures.append({"gate": name, "reason": "command mismatch, nonzero exit, or incomplete execution"})
    status = git("status", "--porcelain")
    (OUTPUT / "source-status.txt").write_text(status + ("\n" if status else ""))
    actual = {"commit": git("rev-parse", "HEAD"), "tree": git("rev-parse", "HEAD^{tree}")}
    if actual != plan["sources"][selected] or status:
        failures.append({"gate": "source-cleanup", "reason": "source identity or clean checkout changed"})
    write_json(OUTPUT / "validation-result.json", {
        "candidate": selected, "source": actual, "sourceClean": not status,
        "requiredGateCount": len(plan["gates"]), "recordedGateCount": len(receipts),
        "gates": receipts, "failures": failures, "passesRequiredSourceValidation": not failures,
        "performanceAcquisitionChanged": False,
    })
    return 1 if failures else 0


if __name__ == "__main__":
    mode = sys.argv[1]
    if mode == "identity":
        identity()
    elif mode == "run":
        sys.exit(run_gate(sys.argv[2], sys.argv[3:]))
    elif mode == "package":
        package()
    elif mode == "runtime":
        runtime()
    elif mode == "conclude":
        sys.exit(conclude())
    else:
        raise ValueError(f"Unknown mode: {mode}")
