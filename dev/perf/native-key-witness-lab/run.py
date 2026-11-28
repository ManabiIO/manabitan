#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Prospective balanced A/B/C component screen. Every observation is retained."""
from pathlib import Path
import hashlib
import json
import math
import os
import platform
import random
import statistics
import subprocess
import sys
import time

root = Path(sys.argv[1]).resolve()
baseline = Path(sys.argv[2]).resolve()
out = Path(sys.argv[3]).resolve()
dictionary = sys.argv[4]
replica = sys.argv[5]
out.mkdir(parents=True, exist_ok=True)
runner = root / "dev/perf/native-key-witness-lab/measure.mjs"
manifest_root = out / "inputs"
wasm = {"A": out / "binaries/baseline.wasm",
        "B": out / "binaries/candidate.wasm",
        "C": out / "binaries/control.wasm"}
expected = {"A": "8ae00698649c5a3e41039b13c5ffe1dff2d4e69948cba2e3c063f381250031ee",
            "B": "a3b2e9c93668a96e067d0a948d0beff42385f38549526a30f7e82788c93234dd",
            "C": "8ae00698649c5a3e41039b13c5ffe1dff2d4e69948cba2e3c063f381250031ee"}
hash_file = lambda file: hashlib.sha256(file.read_bytes()).hexdigest()
for arm, file in wasm.items():
    if hash_file(file) != expected[arm]:
        raise ValueError("WASM identity mismatch: " + arm)
orders = ["ABC", "BCA", "CAB", "CBA", "BAC", "ACB"] * 2
if replica == "2":
    orders = [order[::-1] for order in orders[::-1]]
plan = dict(dictionary=dictionary, replica=replica, sourceRoot=str(baseline),
            node=subprocess.check_output(["node", "--version"], text=True).strip(),
            baselineSha="9e10d3b3fcf66d344ab31bc42c9b522fa5215da2",
            candidateSha=os.environ.get("GITHUB_SHA"), orders=orders,
            wasmSha256=expected, runnerSha256=hash_file(runner),
            excludedWarmupGroups=2, syntheticRepeats=4, start=time.time(),
            platform=platform.platform(), cpu=Path("/proc/cpuinfo").read_text(),
            screeningRule="Exploratory only. Require complete byte parity; primary parse+lookup thread CPU improvement at least 1%, median paired improvement, A/C equal-work drift under 1%, and no replicated unique-key penalty over 1% before considering complete-browser experiments. No complete-import claim.",
            observations=[], complete=False)
planfile = out / "plan.json"
save = lambda: planfile.write_text(json.dumps(plan, indent=2) + "\n")
save()
oracle = None
try:
    for block, order in enumerate(orders, start=1):
        for arm in order:
            output = out / ("block-%02d-%s.json" % (block, arm))
            command = ["node", "--expose-gc", "--max-old-space-size=512", str(runner),
                       dictionary, str(baseline), str(wasm[arm]), str(output),
                       str(manifest_root), "4" if dictionary.startswith("unique-") else "1"]
            start = time.time()
            process = subprocess.run(command, capture_output=True, text=True)
            record = dict(block=block, arm=arm, path=str(output), exit=process.returncode,
                          stdout=process.stdout, stderr=process.stderr,
                          processWallSeconds=time.time()-start)
            plan["observations"].append(record)
            save()
            print(process.stdout or process.stderr, flush=True)
            if process.returncode:
                raise RuntimeError("Measurement process failed: " + str(process.returncode))
            result = json.loads(output.read_text())
            if (not result["complete"] or result["wasmSha256"] != expected[arm]
                    or result["runnerSha256"] != plan["runnerSha256"]):
                raise ValueError("Result identity mismatch")
            for observation in result["observations"]:
                hashes = [(entry["rows"], entry["digest"], entry["indexBytes"], entry["mediaRows"])
                          for entry in observation["entries"]]
                if oracle is None:
                    oracle = hashes
                if hashes != oracle:
                    raise ValueError("Complete output byte oracle mismatch")
    plan["complete"] = True
finally:
    plan["end"] = time.time()
    save()

records = {}
for observation in plan["observations"]:
    result = json.loads(Path(observation["path"]).read_text())
    entries = [entry for repetition in result["observations"] for entry in repetition["entries"]]
    records[(observation["block"], observation["arm"])] = {
        metric: sum(entry[metric] for entry in entries)
        for metric in ("wallMs", "threadCpuMs", "parseWallMs", "parseThreadCpuMs")}
summary = dict(dictionary=dictionary, replica=replica, byteOracle=True,
               groups=len(oracle), rows=sum(item[0] for item in oracle), blocks=len(orders), metrics={})
for metric in ("wallMs", "threadCpuMs", "parseWallMs", "parseThreadCpuMs"):
    values = [[records[(block, arm)][metric] for arm in "ABC"] for block in range(1, len(orders)+1)]
    ratios = [b / math.sqrt(a*c) for a, b, c in values]
    controls = [c/a for a, b, c in values]
    randomizer = random.Random(20261128)
    bootstrap = []
    for _ in range(10000):
        sample = [values[randomizer.randrange(len(values))] for _ in values]
        bootstrap.append(sum(v[1] for v in sample) /
                         math.sqrt(sum(v[0] for v in sample)*sum(v[2] for v in sample)))
    bootstrap.sort()
    change = lambda ratio: 100 * (ratio - 1)
    summary["metrics"][metric] = dict(
        medianPairedPercent=change(statistics.median(ratios)),
        equalWorkPercent=change(sum(v[1] for v in values) /
                                math.sqrt(sum(v[0] for v in values)*sum(v[2] for v in values))),
        pairedBootstrap95Percent=[change(bootstrap[250]),change(bootstrap[9749])],
        candidateFasterBlocks=sum(ratio < 1 for ratio in ratios),
        identicalControlEqualWorkPercent=change(sum(v[2] for v in values)/sum(v[0] for v in values)),
        identicalControlMedianAbsolutePercent=statistics.median(abs(change(ratio)) for ratio in controls))
(out / "summary.json").write_text(json.dumps(summary, indent=2)+"\n")
print(json.dumps(summary), flush=True)
