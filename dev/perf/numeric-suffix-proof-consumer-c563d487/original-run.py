#!/usr/bin/env python3
"""A finite component screen with interleaved adjacent identical-code pairs."""
import argparse
import hashlib
import json
import pathlib
import statistics
import subprocess
import sys
import time

parser = argparse.ArgumentParser()
parser.add_argument("dictionary", choices=["jmdict", "jitendex", "vndb"])
parser.add_argument("baseline", type=pathlib.Path)
parser.add_argument("candidate", type=pathlib.Path)
parser.add_argument("cache", type=pathlib.Path)
parser.add_argument("output", type=pathlib.Path)
args = parser.parse_args()
for name in ["baseline", "candidate", "cache", "output"]:
    setattr(args, name, getattr(args, name).resolve())
args.output.mkdir(parents=True, exist_ok=True)
here = pathlib.Path(__file__).resolve().parent
tooling = here.parents[2]
script = here / "screen.mjs"
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()

def git(root, *arguments):
    return subprocess.check_output(["git", *arguments], cwd=root, text=True).strip()

def identity(root):
    return {"root": str(root), "head": git(root, "rev-parse", "HEAD"),
            "tree": git(root, "rev-parse", "HEAD^{tree}"),
            "trackedChanges": git(root, "status", "--porcelain", "--untracked-files=no"),
            "cSha256": sha(root / "ext/js/dictionary/wasm/term-bank-parser.c"),
            "wasmSha256": sha(root / "ext/lib/term-bank-parser.wasm"),
            "manifestSha256": sha(root / "dev/data/dictionary-wasm/manifest.json"),
            "dependencyLockSha256": sha(root / "package-lock.json")}

baseline_identity, candidate_identity = identity(args.baseline), identity(args.candidate)
if baseline_identity["head"] != "9e10d3b3fcf66d344ab31bc42c9b522fa5215da2" or candidate_identity["head"] != baseline_identity["head"]:
    raise RuntimeError("Experiment source base differs from frozen plan")
if baseline_identity["trackedChanges"]:
    raise RuntimeError("Baseline source is dirty")
if baseline_identity["dependencyLockSha256"] != candidate_identity["dependencyLockSha256"]:
    raise RuntimeError("Dependency locks differ")
schedule = []
for pair in range(4):
    order = "ABCD" if pair % 2 == 0 else "DCBA"
    schedule.extend({"pair": pair, "arm": arm} for arm in order)
plan = {"schema": 1, "dictionary": args.dictionary,
        "variant": "Full-row suffix proof admitted by prior full-content reuse and equal scores/sequences on the two prior rows",
        "preflightCorrection": {"originalToolingHead": "5009ad71fec32e83d738adb9bf7610db75095faf", "originalRun": 46104620899,
            "reason": "The original synthetic single-bank cases did not select the default fused route. This independent cohort appends an empty bank only to those synthetic cases and asserts the public fused-attempt profile. Candidate patch, timed inputs, flags, grouping and 48-observation schedule are unchanged."},
        "optionsScope": "Production-default component options; VNDB explicitly enables experimentalNativeEscapedKeys for its component route",
        "scope": "Numeric-admission suffix experiment; exploratory component screen, not full browser/import/release qualification. B is rebuilt from a reviewed source patch; candidate tracked generated changes are intentional and recorded.",
        "timing": "Native compressed inflation, CRC, strict parse and completed lookup; independent two-pass warmup in every fresh Node process; complete output digest outside timing",
        "schedule": schedule, "baseline": baseline_identity, "candidate": candidate_identity,
        "node": subprocess.check_output(["node", "--version"], text=True).strip(),
        "browser": None, "host": subprocess.check_output(["uname", "-a"], text=True).strip(),
        "runnerSha256": sha(pathlib.Path(__file__)), "screenSha256": sha(script),
        "patchSha256": sha(here / "candidate.patch"), "fixtureLockSha256": sha(tooling / "test/perf/dictionaries.lock.json"),
        "toolingHead": git(tooling, "rev-parse", "HEAD"), "observations": [], "complete": False}
report_path = args.output / "result.json"

def save():
    report_path.write_text(json.dumps(plan, indent=2) + "\n")

save()
print("SUFFIX_NUMERIC_PLAN " + json.dumps({k: v for k, v in plan.items() if k != "observations"}, separators=(",", ":")), flush=True)

def run_observation(label, root, diagnostic=False):
    if identity(args.baseline) != baseline_identity or identity(args.candidate) != candidate_identity:
        raise RuntimeError("Source identity changed during acquisition")
    command = ["node", "--expose-gc", "--max-old-space-size=512", str(script), args.dictionary,
               "--source-root", str(root), "--cache-dir", str(args.cache)]
    if diagnostic:
        command.extend(["--diagnostic-wasm", str(args.output / "diagnostic.wasm")])
    started = time.time()
    result = subprocess.run(command, text=True, capture_output=True, timeout=600)
    (args.output / f"{label}.stdout.json").write_text(result.stdout)
    (args.output / f"{label}.stderr.log").write_text(result.stderr)
    if result.returncode != 0:
        raise RuntimeError(f"{label}: child failed code={result.returncode}, stderr={result.stderr[-2000:]}")
    data = json.loads(result.stdout)
    expected_identity = candidate_identity if root == args.candidate else baseline_identity
    if data["sourceRoot"] != str(root) or data["gitHead"] != expected_identity["head"]:
        raise RuntimeError(f"{label}: wrong source identity")
    if data["dictionary"] != args.dictionary or data["validateGlossaryTypes"] is not True:
        raise RuntimeError(f"{label}: wrong workload")
    if data["node"] != plan["node"] or data["runnerSha256"] != plan["screenSha256"]:
        raise RuntimeError(f"{label}: runtime or runner changed")
    if not diagnostic and data["wasmSha256"] != expected_identity["wasmSha256"]:
        raise RuntimeError(f"{label}: wrong compiled source")
    if diagnostic and data["wasmSha256"] != sha(args.output / "diagnostic.wasm"):
        raise RuntimeError(f"{label}: wrong diagnostic binary")
    data["observationStartedEpoch"] = started
    return data

try:
    for step in schedule:
        arm, pair = step["arm"], step["pair"]
        source = args.candidate if arm == "B" else args.baseline
        data = run_observation(f"pair-{pair}-{arm}", source)
        if plan["observations"]:
            first = plan["observations"][0]["result"]
            for key in ["rows", "digest", "indexBytes", "archiveSha256", "lockSha256", "flags", "filesPerGroup"]:
                if data[key] != first[key]:
                    raise RuntimeError(f"{arm} pair{pair}: complete-output/workload mismatch: {key}")
        plan["observations"].append({**step, "result": data})
        save()
        print("SUFFIX_NUMERIC_OBSERVATION " + json.dumps({"dictionary": args.dictionary, **step,
              **{k: data[k] for k in ["rows", "digest", "elapsedMs", "cpuMs", "inflateMs", "inflateCpuMs", "parseMs", "lookupMs", "nativeParseMs", "fusedAttempts", "fusedFallbacks", "maxWasmHeapBytes"]}}, separators=(",", ":")), flush=True)
    summary = {}
    for metric in ["elapsedMs", "cpuMs", "parseMs", "nativeParseMs", "lookupMs"]:
        for comparison, first_arm, second_arm in [("candidate", "A", "B"), ("identicalControl", "C", "D")]:
            first_values, second_values = [], []
            for pair in range(4):
                row = {item["arm"]: item["result"] for item in plan["observations"] if item["pair"] == pair}
                first_values.append(row[first_arm][metric])
                second_values.append(row[second_arm][metric])
            changes = [100 * (second / first - 1) for first, second in zip(first_values, second_values)]
            summary[f"{comparison}.{metric}"] = {"pairedChangesPercent": changes,
                "medianPairedChangePercent": statistics.median(changes),
                "equalWorkChangePercent": 100 * (sum(second_values) / sum(first_values) - 1),
                "fasterPairs": sum(change < 0 for change in changes)}
    diagnostic = run_observation("diagnostic", args.candidate, diagnostic=True)
    first = plan["observations"][0]["result"]
    for key in ["rows", "digest", "indexBytes", "archiveSha256", "lockSha256", "flags"]:
        if diagnostic[key] != first[key]:
            raise RuntimeError(f"Instrumented diagnostic changed complete output: {key}")
    if diagnostic["diagnostic"] is None:
        raise RuntimeError("Instrumented counters did not execute")
    counts = diagnostic["diagnostic"]
    if not (counts["numericRejected"] <= counts["eligibleStreakRows"] and
            counts["attempts"] <= counts["eligibleStreakRows"] - counts["numericRejected"] and
            counts["boundedRanges"] <= counts["attempts"] and
            counts["hits"] + counts["tailRejected"] + counts["fullRejected"] == counts["boundedRanges"]):
        raise RuntimeError("Instrumented admission/proof counters do not reconcile")
    plan["summary"], plan["diagnostic"], plan["complete"] = summary, diagnostic, True
    save()
    print("SUFFIX_NUMERIC_RESULT " + json.dumps({"dictionary": args.dictionary, "complete": True,
          "scope": plan["scope"], "summary": summary,
          "mechanicalCounts": diagnostic["diagnostic"], "rows": first["rows"], "digest": first["digest"]}, separators=(",", ":")), flush=True)
except Exception as error:
    plan["error"] = str(error)
    save()
    print("SUFFIX_NUMERIC_FAILED " + json.dumps({"dictionary": args.dictionary, "complete": False,
          "completedObservations": len(plan["observations"]), "error": str(error)}, separators=(",", ":")), flush=True)
    raise
