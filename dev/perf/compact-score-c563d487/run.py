#!/usr/bin/env python3
"""Finite source-bound component experiment; never retries or trims observations."""
import argparse
import hashlib
import json
import os
import pathlib
import statistics
import subprocess
import time

BASE = "9e10d3b3fcf66d344ab31bc42c9b522fa5215da2"
STORE = "ext/js/dictionary/term-record-opfs-store.js"
parser = argparse.ArgumentParser()
parser.add_argument("dictionary", choices=["jmdict", "jitendex", "vndb"])
parser.add_argument("baseline", type=pathlib.Path)
parser.add_argument("candidate", type=pathlib.Path)
parser.add_argument("inputs", type=pathlib.Path)
parser.add_argument("replicate", type=int, choices=[0, 1])
args = parser.parse_args()
for name in ["baseline", "candidate", "inputs"]:
    setattr(args, name, getattr(args, name).resolve())
here = pathlib.Path(__file__).resolve().parent
script = here / "measure.mjs"
manifest_bytes = (args.inputs / "inputs.json").read_bytes()
manifest = json.loads(manifest_bytes)
assert manifest["complete"] and manifest["dictionary"] == args.dictionary
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()

def git(root, *arguments):
    return subprocess.check_output(["git", *arguments], cwd=root, text=True).strip()

def identity(root):
    return {"root": str(root), "head": git(root, "rev-parse", "HEAD"),
            "tree": git(root, "rev-parse", "HEAD^{tree}"),
            "trackedChanges": git(root, "status", "--porcelain", "--untracked-files=no"),
            "storeSha256": sha(root / STORE),
            "wasmSha256": sha(root / "ext/lib/term-bank-parser.wasm"),
            "dependencyLockSha256": sha(root / "package-lock.json"),
            "fixtureLockSha256": sha(root / "test/perf/dictionaries.lock.json")}

baseline, candidate = identity(args.baseline), identity(args.candidate)
assert baseline == manifest["baseline"] and candidate == manifest["candidate"]
assert baseline["head"] == BASE and not baseline["trackedChanges"] and not candidate["trackedChanges"]
assert git(args.candidate, "rev-parse", "HEAD^") == BASE
assert git(args.candidate, "diff", "--name-only", BASE, candidate["head"]) == STORE
scripts = {name: sha(here / name) for name in ["common.mjs", "prepare.mjs", "measure.mjs", "run.py"]}
assert scripts["prepare.mjs"] == manifest["runnerSha256"]
assert scripts["common.mjs"] == manifest["commonSha256"]
boundaries = ["validator", "sidecar"] if args.replicate == 0 else ["sidecar", "validator"]
schedule = []
for boundary in boundaries:
    for pair in range(4):
        order = "ABCD" if (pair + args.replicate) % 2 == 0 else "DCBA"
        schedule.extend({"boundary": boundary, "pair": pair, "arm": arm} for arm in order)
plan = {"schema": 1, "dictionary": args.dictionary, "replicate": args.replicate,
        "scope": "Current-source warm component replay, not full import qualification.",
        "reviewCriterion": "Require a clear replicated enclosing-sidecar reduction beyond identical-code drift, no semantic failure or material non-target regression; otherwise withhold a PR. Validator-only gains do not satisfy this criterion. Do not pool hosts or dictionaries.",
        "schedule": schedule, "baseline": baseline, "candidate": candidate,
        "node": subprocess.check_output(["node", "--version"], text=True).strip(),
        "host": subprocess.check_output(["uname", "-a"], text=True).strip(),
        "cpu": subprocess.check_output(["lscpu"], text=True),
        "toolingHead": git(here, "rev-parse", "HEAD"), "toolingTree": git(here, "rev-parse", "HEAD^{tree}"),
        "workflowRun": os.environ.get("GITHUB_RUN_ID"), "workflowAttempt": os.environ.get("GITHUB_RUN_ATTEMPT"),
        "scripts": scripts, "manifestSha256": hashlib.sha256(manifest_bytes).hexdigest(),
        "fixtureSha256": manifest["fixture"]["sha256"], "inputSha256": manifest["inputSha256"],
        "observations": [], "complete": False}
result_path = args.inputs / "result.json"
observation_dir = args.inputs / "observations"
observation_dir.mkdir(exist_ok=False)

def save():
    result_path.write_text(json.dumps(plan, indent=2) + "\n")

def check_identity():
    assert identity(args.baseline) == baseline and identity(args.candidate) == candidate
    assert {name: sha(here / name) for name in scripts} == scripts
    assert sha(args.inputs / "inputs.json") == plan["manifestSha256"]

save()
print("SCORE_PLAN " + json.dumps({k: v for k, v in plan.items() if k != "observations"}, separators=(",", ":")), flush=True)
try:
    for step in schedule:
        check_identity()
        boundary, pair, arm = step["boundary"], step["pair"], step["arm"]
        root = args.candidate if arm == "B" else args.baseline
        expected_identity = candidate if arm == "B" else baseline
        label = boundary + "-" + str(pair) + "-" + arm
        command = ["node", "--expose-gc", "--max-old-space-size=512", str(script), str(root), str(args.inputs), boundary]
        started = time.time()
        try:
            result = subprocess.run(command, text=True, capture_output=True, timeout=600)
        except subprocess.TimeoutExpired as error:
            for suffix, output in [(".stdout.json", error.stdout), (".stderr.log", error.stderr)]:
                if isinstance(output, bytes):
                    output = output.decode("utf8", errors="replace")
                (observation_dir / (label + suffix)).write_text(output or "")
            raise
        (observation_dir / (label + ".stdout.json")).write_text(result.stdout)
        (observation_dir / (label + ".stderr.log")).write_text(result.stderr)
        if result.returncode:
            raise RuntimeError(label + ": failed with " + str(result.returncode) + ": " + result.stderr[-2000:])
        data = json.loads(result.stdout)
        assert data["complete"] and data["source"] == expected_identity
        assert data["dictionary"] == args.dictionary and data["boundary"] == boundary
        assert data["node"] == plan["node"] and data["runnerSha256"] == scripts["measure.mjs"]
        assert data["commonSha256"] == scripts["common.mjs"]
        assert data["inputSha256"] == plan["inputSha256"] and data["manifestSha256"] == plan["manifestSha256"]
        assert data["outputDigest"] == manifest["expectedValidatorDigest" if boundary == "validator" else "expectedSidecarDigest"]
        assert data["repeats"] == (32 if boundary == "validator" else 4) and data["warmups"] == 2
        assert data["rows"] == manifest["compactRows" if boundary == "validator" else "rows"]
        assert data["elapsedMs"] > 0 and data["cpuMs"] > 0
        previous = next((item["result"] for item in plan["observations"] if item["boundary"] == boundary), None)
        if previous is not None:
            for key in ["rows", "rowVisits", "runs", "repeats", "sink", "outputDigest", "fixtureShape"]:
                assert data[key] == previous[key], key
        plan["observations"].append({**step, "startedEpoch": started, "result": data})
        save()
        print("SCORE_OBSERVATION " + json.dumps({"dictionary": args.dictionary, "replicate": args.replicate, **step,
              **{key: data[key] for key in ["rows", "elapsedMs", "cpuMs", "sink", "outputDigest"]}}, separators=(",", ":")), flush=True)
    check_identity()
    summary = {}
    for boundary in boundaries:
        for metric in ["elapsedMs", "cpuMs"]:
            for comparison, first_arm, second_arm in [("candidate", "A", "B"), ("identicalControl", "C", "D")]:
                first, second = [], []
                for pair in range(4):
                    row = {item["arm"]: item["result"] for item in plan["observations"] if item["pair"] == pair and item["boundary"] == boundary}
                    first.append(row[first_arm][metric]); second.append(row[second_arm][metric])
                changes = [100 * (right / left - 1) for left, right in zip(first, second)]
                summary[boundary + "." + comparison + "." + metric] = {
                    "firstValues": first, "secondValues": second, "pairedChangesPercent": changes,
                    "medianPairedChangePercent": statistics.median(changes),
                    "equalWorkChangePercent": 100 * (sum(second) / sum(first) - 1),
                    "fasterPairs": sum(change < 0 for change in changes),
                    "minimumChangePercent": min(changes), "maximumChangePercent": max(changes),
                    "maxAbsoluteChangePercent": max(abs(change) for change in changes)}
    plan["summary"], plan["complete"] = summary, True
    save()
    print("SCORE_RESULT " + json.dumps({"dictionary": args.dictionary, "replicate": args.replicate,
          "complete": True, "scope": plan["scope"], "summary": summary}, separators=(",", ":")), flush=True)
except Exception as error:
    plan["error"] = repr(error)
    save()
    print("SCORE_FAILED " + json.dumps({"dictionary": args.dictionary, "replicate": args.replicate,
          "complete": False, "completedObservations": len(plan["observations"]), "error": repr(error)}, separators=(",", ":")), flush=True)
    raise
