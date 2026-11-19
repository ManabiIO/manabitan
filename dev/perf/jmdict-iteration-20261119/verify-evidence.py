#!/usr/bin/env python3
"""Independently verify the portable JMdict qualification receipt and arithmetic.

This checks retained evidence, not the original browser or expired CI artifacts.
Run with Python 3; no third-party packages or network access are needed.
"""

import argparse
import gzip
import hashlib
import json
import math
from pathlib import Path
import statistics


BASELINE = "d829f5b6e6a75ee8859d38d537d224ec33c4930e"
FIXTURE_ROWS = {"jmdict": 526942, "jmnedict": 667942, "jitendex": 435448}
WORKFLOW = ".github/workflows/jmdict-qualification-20261119.yml"
OBSERVED_SHARED_INPUTS = (
    "package-lock.json", "test/perf/dictionaries.lock.json", "dev/perf/benchmark-support.js",
    "dev/perf/dictionary-fixtures.js", "dev/perf/import-benchmark.js",
    "test/chromium/extension-two-dictionary-import.e2e.js",
)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(value):
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    return hashlib.sha256(encoded).hexdigest()


def close(actual, expected, label):
    require(math.isfinite(actual) and math.isclose(actual, expected, rel_tol=0, abs_tol=1e-8), label)


def verify(evidence, allow_pending=False):
    require(evidence["schemaVersion"] == 1, "Unexpected receipt schema")
    require(evidence["repository"] == "ManabiIO/manabitan", "Unexpected repository")
    require(evidence["baselineProductSha"] == BASELINE, "Unexpected baseline")
    require(allow_pending or not evidence["pendingCohorts"], "Unfinished cohorts")
    for name in (
        "sourceManifests", "sharedInputManifests", "runtimeSnapshots", "benchmarkConfigurations",
        "hostSnapshots", "validationSnapshots", "productionExperimentSnapshots",
    ):
        for key, value in evidence[name].items():
            require(digest(value) == key, f"Invalid {name} hash: {key}")

    manifests = {}

    def expand_manifest(key, ancestors=()):
        if key in manifests:
            return manifests[key]
        require(key not in ancestors, "Cyclic package manifest")
        item = evidence["packageEntryManifests"][key]
        if "entries" in item:
            entries = item["entries"].copy()
        else:
            entries = expand_manifest(item["baseManifest"], (*ancestors, key)).copy()
            for name in item["removedEntries"]:
                del entries[name]
            entries.update(item["changedEntries"])
        require(digest(entries) == key, f"Invalid package entry manifest: {key}")
        manifests[key] = entries
        return entries

    for key in evidence["packageEntryManifests"]:
        expand_manifest(key)

    sources = {item["sha"]: item for item in evidence["qualifierSourceMetadata"]}
    runs = {item["id"]: item for item in evidence["runMetadata"]}
    seen = set()
    baseline_manifests = set()
    candidate_manifests = {}
    content_digests = {name: set() for name in FIXTURE_ROWS}
    shared_inputs = set()
    production_snapshots = set()
    observation_count = 0
    pair_count = 0

    for cohort in evidence["cohorts"]:
        name, dictionary = cohort["cohort"], cohort["dictionary"]
        context = f"{name}/{dictionary}"
        require((name, dictionary) not in seen, f"Duplicate cohort: {context}")
        seen.add((name, dictionary))
        require(not cohort["errors"], f"Invalid cohort: {context}")
        planned = evidence["plannedRuns"][name]
        order = planned.get("order", evidence["method"]["initialOrder"])
        require(len(order) % 2 == 0 and len(set(order)) == len(order), f"Invalid plan: {context}")
        require(
            all(set(order[i:i + 2]) == {f"A{i // 2 + 1}", f"B{i // 2 + 1}"} for i in range(0, len(order), 2)),
            f"Nonadjacent or misnumbered pairs: {context}",
        )
        receipt = cohort["cohortReceipt"]
        require(receipt["planned"] == receipt["attempted"] == order, f"Changed order: {context}")
        require(receipt["completeSuccessfulCohort"] and not receipt["failures"], f"Incomplete: {context}")
        require(receipt["pairing"] == [order[i:i + 2] for i in range(0, len(order), 2)], f"Pair order: {context}")
        require(receipt["traceExcludedFromTiming"] is True, f"Timed trace: {context}")
        identity = cohort["identity"]
        require(identity["A"]["gitSha"] == BASELINE, f"Baseline source: {context}")
        require(identity["B"]["gitSha"] == planned["qualifier"], f"Qualifier source: {context}")
        require(identity["candidateProductSourceSha"] == planned["source"], f"Product source: {context}")
        require(sources[planned["qualifier"]]["parents"] == [planned["source"]], f"Qualifier parent: {context}")
        require(cohort["qualifierChangedFiles"] == [f"diff --git a/{WORKFLOW} b/{WORKFLOW}"], f"Qualifier scope: {context}")
        run = runs[planned["run"]]
        require(cohort["runId"] == planned["run"] and run["head_sha"] == planned["qualifier"], f"Run identity: {context}")
        require(run["status"] == "completed" and run["conclusion"] == "success", f"Run failed: {context}")
        require(cohort["artifact"]["workflow_run"]["head_sha"] == planned["qualifier"], f"Artifact source: {context}")
        require(cohort["fixture"] == evidence["fixtures"][dictionary], f"Fixture mismatch: {context}")
        require(cohort["fixture"]["termRows"] == FIXTURE_ROWS[dictionary], f"Fixture rows: {context}")
        require(cohort["browserVersions"] == ["153.0.8010.12"], f"Browser changed: {context}")
        measurement_inputs = evidence["sharedInputManifests"][cohort["sharedInputs"]]
        pinned_archives = {
            name: {key: fixture[key] for key in ("sha256", "sizeBytes")}
            for name, fixture in evidence["fixtures"].items()
        }
        lock_hash = measurement_inputs["test/perf/dictionaries.lock.json"]
        for arm in (identity["A"], identity["B"]):
            require(arm["archives"] == pinned_archives, f"Archive identity: {context}")
            require(arm["dictionaryLockSha256"] == lock_hash, f"Fixture lock identity: {context}")

        entries_a = expand_manifest(cohort["packageEntries"]["A"])
        entries_b = expand_manifest(cohort["packageEntries"]["B"])
        changed = sorted(key for key in entries_a.keys() | entries_b.keys() if entries_a.get(key) != entries_b.get(key))
        require(changed == identity["changedPackageEntries"], f"Package delta: {context}")
        require(identity["packageEntriesEqual"] == (entries_a == entries_b), f"Package equality: {context}")
        if planned["source"] == BASELINE:
            require(entries_a == entries_b and identity["sameSourceControl"], f"Changed control: {context}")
        baseline_manifests.add(cohort["packageEntries"]["A"])
        candidate_manifests.setdefault(planned["source"], set()).add(cohort["packageEntries"]["B"])
        shared_inputs.add(cohort["sharedInputs"])
        production_snapshots.update(digest(value) for value in cohort["productionSnapshots"])

        require([row["label"] for row in cohort["observations"]] == order, f"Missing observations: {context}")
        values = {}
        for row in cohort["observations"]:
            label = row["label"]
            arm = identity[label[0]]
            require(not row["errors"] and all(value == 0 for value in row["status"].values()), f"Failed observation: {context}/{label}")
            require(row["rawReportStatus"] == "success" and row["skippedVerification"] is False, f"Skipped check: {context}/{label}")
            require(row["packageSha256"] == arm["packageSha256"], f"Observed package: {context}/{label}")
            source = evidence["sourceManifests"][row["sourceManifest"]]
            require(source["gitSha"] == arm["gitSha"] and source["dirty"] is False, f"Observed source: {context}/{label}")
            require(source["sha256"]["builds/manabitan-chrome.zip"] == row["packageSha256"], f"Built package: {context}/{label}")
            require(all(path in source["sha256"] for path in OBSERVED_SHARED_INPUTS), f"Missing measurement inputs: {context}/{label}")
            for path, expected_hash in measurement_inputs.items():
                if path in source["sha256"]:
                    require(source["sha256"][path] == expected_hash, f"Measurement input {path}: {context}/{label}")
            require(source["sha256"]["test/perf/dictionaries.lock.json"] == lock_hash, f"Observed fixture lock: {context}/{label}")
            require(row["browserVersion"] == "153.0.8010.12", f"Observed browser: {context}/{label}")
            runtime = evidence["runtimeSnapshots"][row["runtimeSnapshot"]]
            require(row["opfsMode"] == runtime["openStorageMode"] == "opfs-sahpool", f"Storage mode: {context}/{label}")
            require(runtime["opfsSahpoolInstallResult"] == "installed", f"Storage unavailable: {context}/{label}")
            import_checks = row["importChecks"]
            require(import_checks["hasResult"] is True and import_checks["usesFallbackStorage"] is False, f"Fallback import: {context}/{label}")
            require(import_checks["errorCount"] == import_checks["addSettingsErrorCount"] == 0, f"Import errors: {context}/{label}")
            config = evidence["benchmarkConfigurations"][row["benchmarkConfiguration"]]
            require(config["importFlags"] is None and config["dictionary"] == dictionary, f"Benchmark configuration: {context}/{label}")
            for key in ("pinnedDictionaries", "productionImportDefaults", "authoritativeTiming"):
                require(config[key] is True, f"Benchmark {key}: {context}/{label}")
            for key in ("traceEnabled", "phaseProfiling", "phaseScreenshots", "processSampling"):
                require(config[key] is False, f"Benchmark {key}: {context}/{label}")
            validation = evidence["validationSnapshots"][row["validationSnapshot"]]
            fixture = cohort["fixture"]
            for checks in (validation, validation["restart"]):
                require(checks["title"] == fixture["expectedTitle"] and checks["revision"] == fixture["revision"], f"Persisted dictionary: {context}/{label}")
                require(checks["termRows"] == FIXTURE_ROWS[dictionary] and checks["contentReadable"] and checks["probeCount"] == 12, f"Content verification: {context}/{label}")
            require(row["outputDigestSha256"] == validation["outputDigestSha256"], f"Probe digest: {context}/{label}")
            content_digests[dictionary].add(row["outputDigestSha256"])
            for key in ("hostBefore", "hostAfter"):
                host = evidence["hostSnapshots"][row[key]]
                require(host["platform"] == "linux" and host["logicalCpuCount"] == 4 and host["nodeVersion"] == "v22.22.0", f"Host changed: {context}/{label}")
            timing = row["browserTiming"]
            require(timing["trigger"] == "file-input-change" and timing["errorCount"] == 0 and timing["sequence"] > timing["sequenceBefore"], f"Timing boundary: {context}/{label}")
            elapsed = timing["completedAtMs"] - timing["startedAtMs"]
            require(elapsed > 0, f"Nonpositive time: {context}/{label}")
            close(row["totalImportMs"], elapsed, f"Raw timing: {context}/{label}")
            values[label] = elapsed

        expected_pairs = len(order) // 2
        pairs = cohort["pairedTiming"]["pairs"]
        require(len(pairs) == expected_pairs, f"Pair count: {context}")
        deltas = []
        for index, pair in enumerate(pairs, 1):
            a, b = values[f"A{index}"], values[f"B{index}"]
            delta = 100 * (b / a - 1)
            require(pair["index"] == index, f"Pair index: {context}")
            require(pair["order"] == ("AB" if order.index(f"A{index}") < order.index(f"B{index}") else "BA"), f"Pair labels: {context}")
            close(pair["A"], a, f"Baseline pair: {context}")
            close(pair["B"], b, f"Candidate pair: {context}")
            close(pair["deltaPercent"], delta, f"Pair arithmetic: {context}")
            deltas.append(delta)
        summary = cohort["pairedTiming"]
        close(summary["medianPairedDeltaPercent"], statistics.median(deltas), f"Median arithmetic: {context}")
        require(summary["fasterPairs"] == sum(delta < 0 for delta in deltas), f"Faster count: {context}")
        total_a = sum(values[f"A{i}"] for i in range(1, expected_pairs + 1))
        total_b = sum(values[f"B{i}"] for i in range(1, expected_pairs + 1))
        close(summary["equalWorkDeltaPercent"], 100 * (total_b / total_a - 1), f"Equal-work arithmetic: {context}")
        observation_count += len(order)
        pair_count += expected_pairs

    require(len(baseline_manifests) == len(shared_inputs) == len(production_snapshots) == 1, "Inputs differ between cohorts")
    require(all(len(values) == 1 for values in candidate_manifests.values()), "Candidate package contents changed")
    require(all(len(values) == 1 for values in content_digests.values()), "Sampled content digests differ")
    if not allow_pending:
        require(seen == {(name, dictionary) for name in evidence["plannedRuns"] for dictionary in FIXTURE_ROWS}, "Missing planned dictionary job")
    require(evidence["counts"]["retainedTimedObservations"] == observation_count, "Reported observation count")
    require(evidence["counts"]["computedPairs"] == pair_count, "Reported pair count")
    return {
        "purpose": "Independent portable receipt, identity, order, and arithmetic verification",
        "baseline": BASELINE,
        "dictionaryJobs": len(seen),
        "observations": observation_count,
        "pairs": pair_count,
        "pendingDictionaryJobs": len(evidence["pendingCohorts"]),
        "allRetainedChecksPassed": True,
        "limitation": "Checks retained evidence; does not re-execute imports or prove exhaustive persisted-byte equality",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("evidence", nargs="?", type=Path, default=Path(__file__).with_name("qualification-evidence.json.gz"))
    parser.add_argument("--allow-pending", action="store_true", help="Allow explicitly unfinished dictionary jobs during collection")
    args = parser.parse_args()
    raw = args.evidence.read_bytes()
    decoded = gzip.decompress(raw) if raw.startswith(b"\x1f\x8b") else raw
    report = verify(json.loads(decoded), allow_pending=args.allow_pending)
    report["evidenceSha256"] = hashlib.sha256(raw).hexdigest()
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
