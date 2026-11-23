#!/usr/bin/env python3
"""Verify one frozen import screen, retaining all timing and work evidence."""

import hashlib
import json
import math
from pathlib import Path
import re
import statistics
import sys


BASELINE_SHA = "5e1f8c12f7ff798ba407323aff675cb23b22af02"
BASELINE_WASM = "cc749c53fc32dfb28eefbd69f99868f8c303caa1a3f1354231516dfa5a6e1b0f"
ORDER = "C1 D1 D2 C2 A1 B1 B2 A2 B3 A3 A4 B4 C3 D3 D4 C4".split()
WARMUPS = ["warmup-A", "warmup-B"]
FIXTURES = {
    "jmdict": ("7681ee09f9edfef48a5e50773565da237424eb750bdb0e1e59660784ecd53e8a", 15587032, 526942),
    "jitendex": ("8364e69e7bd0881c42011e96af921a7399d7fe06e2bf4fff4da6d18affff74fc", 38698313, 435448),
    "vndb": ("da5baed5332761513dcef8d0b07ad0d9201cdd7f37831dea37e7162994ec3792", 291705969, 6648310),
}
PACKAGE_CHANGES = {
    "metadata": {
        "js/dictionary/term-bank-wasm-parser.js",
        "js/dictionary/dictionary-importer.js",
        "lib/term-bank-parser.wasm",
    },
    "records": {
        "js/dictionary/term-record-opfs-store.js",
        "js/dictionary/dictionary-database.js",
    },
}
EXPECTED_ENTRIES = {'metadata': {'js/dictionary/dictionary-importer.js': '72a0b8cd56ba941ef06c680a90572cf9423fef5f2dc7f39e9acc644918894466',
              'js/dictionary/term-bank-wasm-parser.js': '37f26cb14bf642da3e75bfc1f3b9da3a05ae6c3bbb982acb06f2cf0173454818',
              'lib/term-bank-parser.wasm': 'd5a00ed71bb1ed0bffb2f158398a3acb93d5fa968981a53e1f199856a3e42a89'},
 'records': {'js/dictionary/dictionary-database.js': '2628207ed39bc211bf4c6a9964f39372ad3f5208d5b9a781beda0c4d10720850',
             'js/dictionary/term-record-opfs-store.js': 'e0587b474874b298f6503abd97394b0fc881c4513ecad70e884e70caf8b14457'}}
EXPECTED_RECORD_ACTIVATION = {
    "jmdict": (0, 0),
    "jitendex": (0, 0),
    "vndb": (5700000, 133737),
}
OPERATIONAL_KEYS = {
    "parserParallelPeakQueuedOwnedContentBytes",
    "fastPathParserParallelPeakQueuedOwnedContentBytes",
    "termRecordLookupIndexWriteCallCount",
    "termRecordLookupIndexMaxQueuedBytes",
}
for _prefix in ("termContent", "termRecord"):
    OPERATIONAL_KEYS.update(_prefix + suffix for suffix in (
        "DrainCycleCount", "WriteCallCount", "SingleChunkWriteCount",
        "MergedWriteCount", "MergedWriteBytes", "MaxWriteBytes", "MinWriteBytes",
        "MergedGroupChunkCount", "MaxMergedGroupChunkCount", "MinMergedGroupChunkCount",
        "FlushDueToBytesCount", "FlushDueToChunkCount", "FlushFinalGroupCount",
    ))


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read_json(path):
    return json.loads(path.read_text())


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def finite(value, label, positive=False):
    require(type(value) in (int, float) and math.isfinite(value)
            and (value > 0 if positive else value >= 0), f"{label}: invalid number {value!r}")
    return value


def flatten(value, prefix=""):
    if isinstance(value, dict) and value:
        for key, child in value.items():
            yield from flatten(child, f"{prefix}.{key}" if prefix else key)
    elif isinstance(value, list) and value:
        for index, child in enumerate(value):
            yield from flatten(child, f"{prefix}[{index}]")
    else:
        yield prefix, value


def is_mechanism_key(key, kind):
    if kind == "metadata":
        return "NestedMetadataReuse" in key or key in {
            "parserMaxWasmHeapBytes", "fastPathParserMaxWasmHeapBytes",
        }
    return key in {"termRecordFieldRunEncodedRows", "termRecordFieldRunCount"}


def collect_phases(debug, kind):
    groups = {"metrics": {}, "work": {}, "operational": {}, "mechanism": {}}
    shape = {}
    for group in ("importerPhaseTimings", "localPhaseTimings"):
        phases = debug.get(group)
        require(isinstance(phases, list) and phases, f"Missing {group}")
        shape[group] = [phase["phase"] for phase in phases]
        for index, phase in enumerate(phases):
            prefix = f"{group}[{index}]:{phase['phase']}"
            groups["metrics"][prefix + ".elapsedMs"] = finite(phase["elapsedMs"], prefix)
            for key, value in flatten(phase.get("details", {})):
                path = prefix + ".details." + key
                root_key = key.split(".", 1)[0].split("[", 1)[0]
                if key.endswith("Ms"):
                    groups["metrics"][path] = finite(value, path) if value is not None else None
                elif is_mechanism_key(root_key, kind):
                    groups["mechanism"][path] = value
                elif root_key in OPERATIONAL_KEYS:
                    groups["operational"][path] = value
                else:
                    groups["work"][path] = value
    groups["work"]["phaseShape"] = shape
    for key in ("hasResult", "errorCount", "addSettingsErrorCount", "usesFallbackStorage",
                "fallbackDatabaseContentBase64Length", "useImportSession", "finalizeImportSession"):
        if key in debug:
            groups["work"]["importDebug." + key] = debug[key]
    return groups


def comparison(observations, metric, left_arm, right_arm):
    names = [f"{arm}{index}" for index in range(1, 5) for arm in (left_arm, right_arm)]
    missing = [name for name in names if observations[name]["metrics"].get(metric) is None]
    if missing:
        return {"available": False, "missingObservations": missing,
                "valuesByObservation": {name: observations[name]["metrics"].get(metric) for name in names}}
    pairs = []
    for index in range(1, 5):
        left_name, right_name = f"{left_arm}{index}", f"{right_arm}{index}"
        left, right = (observations[name]["metrics"][metric] for name in (left_name, right_name))
        pairs.append({"pair": index, "order": sorted((left_name, right_name), key=ORDER.index),
                      "leftMs": left, "rightMs": right, "differenceMs": right - left,
                      "changePercent": 100 * (right / left - 1) if left else None})
    lefts, rights = ([pair[key] for pair in pairs] for key in ("leftMs", "rightMs"))
    percentages = [pair["changePercent"] for pair in pairs]
    return {"available": True, "pairCount": 4,
            "leftMedianMs": statistics.median(lefts), "rightMedianMs": statistics.median(rights),
            "medianPairedDifferenceMs": statistics.median(pair["differenceMs"] for pair in pairs),
            "medianPairedChangePercent": statistics.median(percentages) if None not in percentages else None,
            "equalWorkTotalChangePercent": 100 * (sum(rights) / sum(lefts) - 1) if sum(lefts) else None,
            "fasterPairs": sum(right < left for left, right in zip(lefts, rights)), "pairs": pairs}


def equality(observations, field):
    keys = sorted({key for observation in observations.values() for key in observation[field]})
    equal, differing = {}, {}
    for key in keys:
        values = {name: {"present": key in observation[field], "value": observation[field].get(key)}
                  for name, observation in observations.items()}
        first = next(iter(values.values()))
        if all(value == first for value in values.values()):
            equal[key] = first["value"]
        else:
            differing[key] = values
    return {"allEqual": not differing, "fieldCount": len(keys),
            "equalValues": equal, "differingValuesByObservation": differing}


def activation(banks, final, arm, dictionary, kind, fixture):
    if kind == "metadata":
        keys = ["fastPathParserNestedMetadataReuseCount", "fastPathParserNestedMetadataReuseBytes"]
        source = banks
    else:
        keys = ["termRecordFieldRunEncodedRows", "termRecordFieldRunCount"]
        source = final
    values = {key: {"present": key in source, "value": source.get(key)} for key in keys}
    if arm != "B":
        require(all(not item["present"] or item["value"] == 0 for item in values.values()),
                "Baseline unexpectedly activates candidate work")
        return values
    require(all(item["present"] and type(item["value"]) is int and item["value"] >= 0
                for item in values.values()), "Missing/invalid activation counters")
    first, second = (values[key]["value"] for key in keys)
    if kind == "metadata":
        require(16 * first <= second <= 512 * first, "Metadata hit byte bound failed")
        require(second <= banks["fastPathParserSourceUncompressedBytes"], "Metadata reused more than source bytes")
        if dictionary in ("jmdict", "jitendex"):
            require(first > 0, "Expected repeated metadata path did not activate")
    else:
        require(second <= first <= fixture["termRows"], "Invalid run encoding counts")
        require((first, second) == EXPECTED_RECORD_ACTIVATION[dictionary],
                "Run activation differs from the complete production-group component oracle")
        if dictionary == "vndb":
            require(first > 0 and second > 0, "VNDB record runs did not activate")
    return values


def main():
    evidence, dictionary, kind = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
    require(kind in PACKAGE_CHANGES, "Unknown candidate")
    baseline = (evidence / "baseline-sha.txt").read_text().strip()
    candidate = (evidence / "candidate-sha.txt").read_text().strip()
    qualification = (evidence / "qualification-sha.txt").read_text().strip()
    require(baseline == BASELINE_SHA and candidate == qualification and candidate != baseline,
            "Wrong frozen source identities")
    require((evidence / "observation-order.txt").read_text().split() == ORDER, "Observation order changed")
    observed = {path.name for path in evidence.iterdir() if path.is_dir()
                and (re.fullmatch(r"[ABCD]\d+", path.name) or path.name.startswith("warmup-"))}
    require(observed == set(WARMUPS + ORDER), "Incomplete or unexpected observations")
    old, new = (read_json(evidence / (name + "-package-entry-sha256.json")) for name in ("baseline", "candidate"))
    changes = {key for key in old.keys() | new.keys() if old.get(key) != new.get(key)}
    require(changes == PACKAGE_CHANGES[kind], f"Unexpected packaged source changes: {sorted(changes)}")
    require({key: new[key] for key in changes} == EXPECTED_ENTRIES[kind],
            "Candidate packaged bytes differ from frozen reviewed source hashes")
    package_lines = (evidence / "package-sha256.txt").read_text().splitlines()
    require(len(package_lines) == 2, "Expected pre-timing candidate and baseline ZIP hashes")
    candidate_zip, baseline_zip = (line.split(maxsplit=1)[0] for line in package_lines)
    require(all(re.fullmatch(r"[0-9a-f]{64}", value) for value in (candidate_zip, baseline_zip)),
            "Invalid pre-timing package digest")
    require(old["lib/term-bank-parser.wasm"] == BASELINE_WASM, "Baseline parser WASM changed")
    manifest = read_json(evidence / "candidate-wasm-manifest.json")
    wasm = next(target for target in manifest["targets"] if target["name"] == "term-bank-parser.wasm")
    require(new["lib/term-bank-parser.wasm"] == wasm["sha256"], "Candidate WASM differs from pinned manifest")
    all_observations, package_hashes, hashes = {}, {}, {}
    reference_validation = expected_fixture = expected_browser = None
    for name in WARMUPS + ORDER:
        summary_path, report_path = (evidence / name / filename for filename in ("summary.json", "run-1.json"))
        summary, report = read_json(summary_path), read_json(report_path)
        arm = name[-1] if name.startswith("warmup-") else name[0]
        require(summary["gitSha"] == (candidate if arm == "B" else baseline), f"{name}: source changed")
        require(summary["dictionary"] == dictionary and summary["buildTarget"] == report["buildTarget"] == "chrome",
                f"{name}: dictionary/target changed")
        require(summary["authoritativeTiming"] is True and summary["traceEnabled"] is False
                and summary["importFlags"] is None, f"{name}: timing mode changed")
        require(report["status"] == "success" and report["skippedVerification"] is False, f"{name}: incomplete import")
        benchmark = report["benchmark"]
        require(benchmark["authoritativeTiming"] is True and benchmark["traceEnabled"] is False
                and benchmark["importFlags"] is None and benchmark["productionImportDefaults"] is True
                and benchmark["pinnedDictionaries"] is True, f"{name}: raw benchmark mode changed")
        fixture, browser = summary["fixture"], summary["browserVersion"]
        require((fixture["sha256"], fixture["sizeBytes"], fixture["termRows"]) == FIXTURES[dictionary],
                f"{name}: wrong locked fixture")
        if expected_fixture is None:
            expected_fixture, expected_browser = fixture, browser
        require(fixture == expected_fixture and browser == expected_browser == report["browserVersion"],
                f"{name}: fixture/browser changed")
        require(len(summary["runs"]) == 1, f"{name}: expected one complete import")
        run = summary["runs"][0]
        package_hashes.setdefault(arm, run["packageSha256"])
        require(run["packageSha256"] == report["packageSha256"] == package_hashes[arm], f"{name}: package changed")
        require(run["packageSha256"] == (candidate_zip if arm == "B" else baseline_zip),
                f"{name}: timed package differs from pre-timing ZIP")
        validation = run["validation"]
        require(validation["contentReadable"] is True and validation["probeCount"] == 12
                and validation["termRows"] == fixture["termRows"]
                and validation["restart"]["contentReadable"] is True
                and validation["restart"]["termRows"] == fixture["termRows"], f"{name}: persistence failed")
        if dictionary == "vndb":
            require(validation["mediaRows"] == fixture["mediaRows"]
                    and 0 < validation["generationMedia"]["count"] <= fixture["mediaRows"]
                    and validation["packedMediaActivation"]["entries"] == validation["generationMedia"]["count"]
                    and validation["mediaBeforeRestart"] == validation["mediaAfterRestart"]
                    and len(validation["mediaBeforeRestart"]) == 5
                    and "img/cc18737.webp" in [entry["path"] for entry in validation["mediaBeforeRestart"]],
                    f"{name}: packed/source media validation failed")
        if reference_validation is None:
            reference_validation = validation
        require(validation == reference_validation == benchmark["validation"], f"{name}: stored output changed")
        imports = [phase["data"] for phase in report["phases"] if (phase.get("data") or {}).get("kind") == "dictionary-import"]
        require(len(imports) == 1, f"{name}: expected exactly one complete import")
        imported = imports[0]
        debug, timing = imported["importDebug"], imported["browserTiming"]
        require(timing["trigger"] == "file-input-change" and timing["errorCount"] == debug["errorCount"]
                == debug["addSettingsErrorCount"] == 0, f"{name}: import boundary/error changed")
        duration = finite(timing["completedAtMs"] - timing["startedAtMs"], name, positive=True)
        require(math.isclose(duration, run["totalImportMs"], rel_tol=0, abs_tol=1e-7)
                and run["importDebug"] == debug, f"{name}: raw/summary disagreement")
        phases = debug["importerPhaseTimings"]
        finals = [phase for phase in phases if phase["phase"] == "bulk-finalization"]
        banks = [phase for phase in phases if phase["phase"] == "import-data-banks"]
        fast = [phase for phase in phases if phase["phase"].startswith("term-file-fast-path:")]
        require(len(finals) == len(banks) == 1 and finals[0]["details"]["ok"] is True,
                f"{name}: incomplete phases")
        require(fast and sum(phase["details"]["rows"] for phase in fast) == fixture["termRows"]
                and banks[0]["details"]["terms"] == fixture["termRows"], f"{name}: row work changed")
        item = collect_phases(debug, kind)
        item["metrics"]["completeImportMs"] = duration
        item["activation"] = activation(banks[0]["details"], finals[0]["details"], arm, dictionary, kind, fixture)
        item.update({"arm": arm, "bulkFinalizationMs": finals[0]["elapsedMs"]})
        all_observations[name] = item
        hashes[name] = {"summarySha256": digest(summary_path), "rawReportSha256": digest(report_path)}
    require(package_hashes["A"] == package_hashes["C"] == package_hashes["D"] != package_hashes["B"],
            "Control/candidate package identities disagree")
    candidate_activation = all_observations["warmup-B"]["activation"]
    require(all(all_observations[f"B{i}"]["activation"] == candidate_activation for i in range(1, 5)),
            "Candidate activation changed across repeated imports of the same frozen source")
    observations = {name: all_observations[name] for name in ORDER}
    metrics = sorted({key for item in observations.values() for key in item["metrics"]})
    candidates = {key: comparison(observations, key, "A", "B") for key in metrics}
    controls = {key: comparison(observations, key, "C", "D") for key in metrics}
    fixed = equality(all_observations, "work")
    result = {
        "schemaVersion": 1, "comparisonKind": "exploratory-round3-screen-with-bracketing-controls",
        "candidateKind": kind, "dictionary": dictionary, "baselineSha": baseline,
        "candidateSha": candidate, "qualificationSha": qualification,
        "productSourceShas": {"A": baseline, "B": candidate, "C": baseline, "D": baseline},
        "checkoutShas": {"A": baseline, "B": qualification, "C": baseline, "D": baseline},
        "browser": expected_browser, "fixture": expected_fixture,
        "timingBoundary": "file-input change to post-UI import-complete event",
        "warmups": 2, "measuredImports": len(observations), "pairCount": 4,
        "unchangedCodeControlPairCount": 4,
        "observations": [{"name": name, "arm": item["arm"], "milliseconds": item["metrics"]["completeImportMs"],
                          "bulkFinalizationMs": item["bulkFinalizationMs"]} for name, item in observations.items()],
        "candidateComparisons_B_over_A": candidates, "sameProductControls_D_over_C": controls,
        "fixedReportedWorkAndConfigurationEqualityIncludingWarmups": fixed,
        "timingDependentOperationalWorkIncludingWarmups": equality(all_observations, "operational"),
        "declaredMechanismDifferencesIncludingWarmups": equality(all_observations, "mechanism"),
        "activationByObservation": {name: item["activation"] for name, item in all_observations.items()},
        "packageHashes": package_hashes, "changedPackageEntries": sorted(changes),
        "identicalSampledContentAndMedia": True, "validation": reference_validation,
        "inputHashes": {"verifier": digest(Path(__file__)), "observations": hashes},
        "limitations": [
            "Exploratory four-pair screen; independent confirmation is required before a speed claim.",
            "Both warmups are validated but excluded from timing estimates; every scheduled result is retained.",
            "Controls are not subtracted or pooled with candidate comparisons.",
            "All phase metrics are retained; overlapping worker sums and wall intervals are not additive.",
            "Stored-content/media checks are sampled. They do not prove exhaustive byte equality or peak-memory parity.",
        ],
    }
    (evidence / "comparison.json").write_text(json.dumps(result, indent=2, allow_nan=False) + "\n")
    require(fixed["allEqual"], f"Reported fixed work/configuration changed: {list(fixed['differingValuesByObservation'])}")
    print("IMPORT_COMPARISON_RESULT " + json.dumps({
        "candidate": kind, "dictionary": dictionary, "fixedFields": fixed["fieldCount"],
        "metricCount": len(metrics), "candidateTimings": candidates["completeImportMs"],
        "sameCodeControls": controls["completeImportMs"],
    }, separators=(",", ":")))


if __name__ == "__main__":
    main()
