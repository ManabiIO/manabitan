#!/usr/bin/env python3
"""Qualify isolated import changes with two fixed counterbalanced replications."""

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

from chromium_memory import run_with_sampling


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
    candidate_name = os.environ["PERF_CANDIDATE"]
    replication = int(os.environ["PERF_REPLICATION"])
    if replication not in (1, 2):
        raise ValueError("Unexpected replication")
    specification = json.loads((Path(__file__).parent / "candidates.json").read_text())[candidate_name]
    baseline = specification["baseline"]
    candidate = specification["candidate"]
    if baseline == candidate:
        raise ValueError("Candidate and baseline must be distinct revisions")
    if dictionary not in ("jmdict", "jitendex", "vndb"):
        raise ValueError("Unexpected dictionary")
    for commit in (baseline, candidate):
        if len(commit) != 40 or any(c not in "0123456789abcdef" for c in commit):
            raise ValueError("Expected immutable source SHA")
        run(["git", "cat-file", "-e", commit + "^{commit}"])

    evidence = ROOT / "builds" / "import-combined-study" / candidate_name / dictionary / str(replication)
    evidence.mkdir(parents=True, exist_ok=False)
    stage = Path(os.environ["RUNNER_TEMP"]) / ("import-combined-71149b-" + candidate_name + "-" + dictionary + "-" + str(replication))
    stage.mkdir(exist_ok=False)
    schedule = [("warmup", 0, arm) for arm in ("AB" if replication == 1 else "BA")]
    for pair in range(2):
        schedule += [("control-before", pair, "A"), ("control-before", pair, "A")]
    for pair in range(8):
        order = "AB" if (pair + replication) % 2 == 1 else "BA"
        schedule += [("candidate", pair, arm) for arm in order]
    for pair in range(2):
        schedule += [("control-after", pair, "A"), ("control-after", pair, "A")]

    identities = {
        "baseline": baseline,
        "candidate": candidate,
        "harness": text(["git", "rev-parse", "HEAD"]),
        "node": text(["node", "--version"]),
        "dictionary": dictionary,
        "candidateName": candidate_name,
        "replication": replication,
        "specification": specification,
        "schedule": schedule,
        "overlaidHarnessFiles": {name: digest(ROOT / name) for name in OVERLAY},
        "boundary": "file-input change to post-UI import completion; restart/readback outside timing",
        "scope": "Combined interaction qualification for frozen PRs 809, 810 and 811 on PR 801; Linux Chromium; two predetermined independent eight-pair replications, reversed initial order, four baseline control pairs each; full semantic and restart checks outside timing; no external memory sampling for the combined candidate",
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
    package_members = {}
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
        package_members[arm] = members
        save(evidence / (arm + "-package-entries.json"), members)
        save(evidence / (arm + "-identity.json"), {
            "sha": sha, "packageSha256": packages[arm],
            "statusWithHarnessOverlay": text(["git", "status", "--porcelain"], root),
            "sourceDiff": text(["git", "diff", "--stat"], root),
        })
        roots[arm] = root

    differing_members = sorted(name for name in set(package_members["A"]) | set(package_members["B"])
                               if package_members["A"].get(name) != package_members["B"].get(name))
    if differing_members != sorted(specification["expectedPackageDifferences"]):
        raise ValueError("Unexpected packaged source differences: " + repr(differing_members))
    save(evidence / "package-differences.json", differing_members)

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
    # Raw previews read physical reference storage, so their readable count is
    # a derived layout diagnostic. Verify the derivation for every observation.
    for validation in validations:
        for term in validation["physicalProbes"]:
            for probe in term["probes"]:
                rows = probe["rowSample"]
                if probe["rowSampleCount"] != len(rows):
                    raise ValueError("Physical probe sample count does not match rows")
                previews = [row["rawContentPreview"] for row in rows]
                if any(value is not None and not isinstance(value, str) for value in previews):
                    raise ValueError("Invalid raw preview type")
                readable = sum(isinstance(value, str) and len(value) > 0 and
                               value not in ("<read-null>", "<read-failed>") for value in previews)
                if probe["readablePreviewRowCount"] != readable:
                    raise ValueError("Physical preview counter does not match encoded reference previews")
    output_digests = {item["outputDigestSha256"] for item in validations}
    semantic_digests = {item["semanticDigestSha256"] for item in validations}
    if len(semantic_digests) != 1 or any(re.fullmatch(r"[0-9a-f]{64}", value) is None for value in semantic_digests):
        raise ValueError("Complete semantic probe results changed between import arms")
    physical_digests = {}
    physical_probes = {}
    for arm in ("A", "B"):
        selected = [item["validation"] for item in observations if item["arm"] == arm]
        physical_digests[arm] = sorted({item["outputDigestSha256"] for item in selected})
        if len(physical_digests[arm]) != 1:
            raise ValueError("Physical probe layout changed within the same package")
        physical_probes[arm] = selected[0]["physicalProbes"]
    def differences(a, b, location=""):
        if type(a) is not type(b):
            return [{"path": location, "baseline": a, "candidate": b}]
        if isinstance(a, dict):
            if a.keys() != b.keys():
                return [{"path": location, "baseline": a, "candidate": b}]
            return [item for key in a for item in differences(a[key], b[key], location + "/" + key)]
        if isinstance(a, list):
            if len(a) != len(b):
                return [{"path": location, "baseline": a, "candidate": b}]
            return [item for index, (x, y) in enumerate(zip(a, b))
                    for item in differences(x, y, location + "/" + str(index))]
        return [] if a == b else [{"path": location, "baseline": a, "candidate": b}]
    layout_changes = differences(physical_probes["A"], physical_probes["B"])
    save(evidence / "layout-differences.json", {"physicalDigests": physical_digests,
         "semanticDigests": sorted(semantic_digests), "differences": layout_changes})
    if any(item["path"].rsplit("/", 1)[-1] not in ("rawEntryContentOffset", "rawContentPreview", "readablePreviewRowCount")
           for item in layout_changes):
        raise ValueError("Physical probes differ beyond reference locations, encoded reference bytes and their verified preview counter")
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

    # Memory diagnostics deliberately run after every uninstrumented timing
    # observation. Their elapsed times are excluded from the timing results.
    if candidate_name == "owned-shared":
        memory_observations = []
        for index, arm in enumerate("ABBA" if replication == 1 else "BAAB"):
            output = evidence / (f"memory-{index:02d}-{arm}")
            output.mkdir()
            memory = run_with_sampling(
                ["node", "dev/perf/import-benchmark.js", dictionary, "--runs", "1", "--no-build",
                 "--build-target", "chrome", "--output", str(output)],
                roots[arm], output / "run.log", output / "chromium-memory.json",
            )
            summary = json.loads((output / "summary.json").read_text())
            result = summary["runs"][0]
            if (summary["gitSha"] != (baseline if arm == "A" else candidate) or
                    result["packageSha256"] != packages[arm] or
                    result["validation"]["outputDigestSha256"] not in physical_digests[arm] or
                    result["validation"]["semanticDigestSha256"] not in semantic_digests):
                raise ValueError("Memory diagnostic source, package or content changed")
            memory_observations.append({"index": index, "arm": arm, **memory})
            save(evidence / "memory-observations.json", memory_observations)


if __name__ == "__main__":
    main()
