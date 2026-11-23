#!/usr/bin/env python3
"""Compare exact import revisions with the same pinned browser harness."""

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import statistics
import subprocess
import time
import zipfile


ROOT = Path(__file__).resolve().parents[3]
OVERLAY = (
    "test/perf/dictionaries.lock.json",
    "dev/perf/dictionary-fixtures.js",
    "dev/perf/benchmark-support.js",
    "dev/perf/import-benchmark.js",
    "test/chromium/extension-two-dictionary-import.e2e.js",
)


def run(args, cwd=ROOT, output=None):
    if output is None:
        subprocess.run(args, cwd=cwd, check=True)
        return
    with output.open("w") as stream:
        subprocess.run(args, cwd=cwd, stdout=stream, stderr=subprocess.STDOUT, check=True)


def text(args, cwd=ROOT):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def main():
    dictionary = os.environ["PERF_DICTIONARY"]
    baseline = os.environ["PERF_BASELINE_SHA"]
    candidate = os.environ["PERF_CANDIDATE_SHA"]
    if baseline == candidate:
        raise ValueError("Candidate and baseline must be distinct revisions")
    if dictionary not in ("jmdict", "jitendex", "vndb"):
        raise ValueError("Unexpected dictionary")
    for commit in (baseline, candidate):
        if len(commit) != 40 or any(c not in "0123456789abcdef" for c in commit):
            raise ValueError("Expected immutable source SHA")
        run(["git", "cat-file", "-e", commit + "^{commit}"])

    evidence = ROOT / "builds" / "import-memory-study" / dictionary
    evidence.mkdir(parents=True, exist_ok=False)
    stage = Path(os.environ["RUNNER_TEMP"]) / ("import-memory-71149a-" + dictionary)
    stage.mkdir(exist_ok=False)
    schedule = [("warmup", 0, "A"), ("warmup", 0, "B")]
    for pair in range(2):
        schedule += [("control-before", pair, "A"), ("control-before", pair, "A")]
    for pair in range(6):
        schedule += [("candidate", pair, arm) for arm in ("AB" if pair % 2 == 0 else "BA")]
    for pair in range(2):
        schedule += [("control-after", pair, "A"), ("control-after", pair, "A")]

    identities = {
        "baseline": baseline,
        "candidate": candidate,
        "harness": text(["git", "rev-parse", "HEAD"]),
        "node": text(["node", "--version"]),
        "dictionary": dictionary,
        "schedule": schedule,
        "overlaidHarnessFiles": {name: digest(ROOT / name) for name in OVERLAY},
        "boundary": "file-input change to post-UI import completion; restart/readback outside timing",
        "scope": "Linux Chromium; fixed six-pair screen with four identical-package control pairs; no process-memory claim",
    }
    save(evidence / "plan.json", identities)
    # Download only this optional dictionary in addition to the standard three
    # required by the existing browser harness. Both arms share verified bytes.
    run(["node", "--input-type=module", "-e", (
        "import {ensurePinnedDictionaryCache,ensureFixtureFile,loadDictionaryFixtures} "
        "from './dev/perf/dictionary-fixtures.js'; "
        "const dir='builds/e2e-dictionary-cache'; await ensurePinnedDictionaryCache(dir); "
        "const f=(await loadDictionaryFixtures())[process.argv[1]]; "
        "await ensureFixtureFile(f,dir+'/'+f.cacheFile)"
    ), dictionary], output=evidence / "fixtures.log")

    roots = {}
    packages = {}
    for arm, sha in (("A", baseline), ("B", candidate)):
        root = stage / arm
        run(["git", "worktree", "add", "--detach", str(root), sha])
        if (root / "package-lock.json").read_bytes() != (ROOT / "package-lock.json").read_bytes():
            raise ValueError("Dependency locks differ")
        for name in OVERLAY:
            shutil.copyfile(ROOT / name, root / name)
        (root / "node_modules").symlink_to(ROOT / "node_modules", target_is_directory=True)
        (root / "builds").mkdir(exist_ok=True)
        (root / "builds" / "e2e-dictionary-cache").symlink_to(
            ROOT / "builds" / "e2e-dictionary-cache", target_is_directory=True
        )
        run(["npm", "run", "build:libs"], root, evidence / (arm + "-libs.log"))
        run(["npm", "run", "build", "--", "--target", "chrome"], root, evidence / (arm + "-build.log"))
        package = root / "builds" / "manabitan-chrome.zip"
        packages[arm] = digest(package)
        with zipfile.ZipFile(package) as archive:
            members = {name: hashlib.sha256(archive.read(name)).hexdigest()
                       for name in archive.namelist() if not name.endswith("/")}
        save(evidence / (arm + "-package-entries.json"), members)
        save(evidence / (arm + "-identity.json"), {
            "sha": sha, "packageSha256": packages[arm],
            "statusWithHarnessOverlay": text(["git", "status", "--porcelain"], root),
            "sourceDiff": text(["git", "diff", "--stat"], root),
        })
        roots[arm] = root

    observations = []
    for index, (kind, pair, arm) in enumerate(schedule):
        output = evidence / (f"{index:02d}-{kind}-{pair}-{arm}")
        output.mkdir()
        save(output / "host-before.json", {"time": time.time(), "loadAverage": os.getloadavg()})
        print(f"{dictionary} {index + 1}/{len(schedule)} {kind} pair={pair} arm={arm}", flush=True)
        run(["node", "dev/perf/import-benchmark.js", dictionary, "--runs", "1", "--no-build",
             "--build-target", "chrome", "--output", str(output)], roots[arm], output / "run.log")
        summary = json.loads((output / "summary.json").read_text())
        result = summary["runs"][0]
        if summary["gitSha"] != (baseline if arm == "A" else candidate):
            raise ValueError("Wrong source revision in observation")
        if result["packageSha256"] != packages[arm] or not summary["authoritativeTiming"]:
            raise ValueError("Wrong package or timing mode in observation")
        observations.append({"index": index, "kind": kind, "pair": pair, "arm": arm,
                             "totalImportMs": result["totalImportMs"], "validation": result["validation"],
                             "packageSha256": result["packageSha256"]})
        save(evidence / "observations.json", observations)
        save(output / "host-after.json", {"time": time.time(), "loadAverage": os.getloadavg()})

    validations = [item["validation"] for item in observations]
    output_digests = {item["outputDigestSha256"] for item in validations}
    if len(output_digests) != 1 or any(re.fullmatch(r"[0-9a-f]{64}", value) is None for value in output_digests):
        raise ValueError("Sampled content changed between import arms")
    results = {}
    for kind in ("candidate", "control-before", "control-after"):
        pairs = []
        selected = [item for item in observations if item["kind"] == kind]
        for pair in sorted({item["pair"] for item in selected}):
            two = [item for item in selected if item["pair"] == pair]
            if kind == "candidate":
                a = next(item["totalImportMs"] for item in two if item["arm"] == "A")
                b = next(item["totalImportMs"] for item in two if item["arm"] == "B")
            else:
                a, b = [item["totalImportMs"] for item in two]
            pairs.append({"pair": pair, "baselineMs": a, "comparisonMs": b, "changePercent": 100 * (b / a - 1)})
        results[kind] = {"pairs": pairs, "medianChangePercent": statistics.median(item["changePercent"] for item in pairs),
                         "fasterPairs": sum(item["comparisonMs"] < item["baselineMs"] for item in pairs)}
    save(evidence / "results.json", results)
    print(json.dumps(results, indent=2), flush=True)


if __name__ == "__main__":
    main()
