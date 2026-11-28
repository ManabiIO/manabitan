#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Independently audit the complete three-arm corpus proof, without replaying it."""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent
ARMS = ("baseline", "mask", "suffix")
VARIABLE = {"validatedGlossaryReuseCount", "crcScannedBytes", "crcReusedBytes", "crcReusedGlossaries"}
COUNTS = {
    "rows", "stringBytes", "mediaRows", "keys", "aliasedLengthKeys", "omittedOffsetKeys",
    "preparedBuffers", "preparedBufferBytes", "nativeSegments", "nativeFallbacks",
    "scratchReuseGroups", "scratchReuseBytes", "scratchReuseMisses", "fusedAttempts",
    "fusedFallbacks", "heapBytes", "metadataBytes", "metaCapacity", "encodedContentBytes",
    "contentCapacity", "validatedGlossaryReuseCount", "mediaHintRowsSkipped", "bankSpanCount",
    "recentContentDedupHitCount", "escapedKeyDecodeCount", "fastGlossaryNormalizationCount",
    "fastGlossaryNormalizationFallbackCount", "crcScannedBytes", "crcReusedBytes", "crcReusedGlossaries",
}
FIELDS = COUNTS | {"digest", "nativePrepared", "crcDeferred", "crcVerified"}
TOTALS = ("scratchReuseGroups", "scratchReuseBytes", "scratchReuseMisses", "fusedAttempts",
          "fusedFallbacks", "metadataBytes", "validatedGlossaryReuseCount", "crcScannedBytes",
          "crcReusedBytes", "crcReusedGlossaries")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read(path):
    return json.loads(path.read_text())


def verify_group(group, expected_first):
    first = re.fullmatch(r"term_bank_(\d+)\.json", group["firstBank"])
    last = re.fullmatch(r"term_bank_(\d+)\.json", group["lastBank"])
    assert first and last and int(first[1]) == expected_first and int(last[1]) >= expected_first
    assert type(group["sourceBytes"]) is int and group["sourceBytes"] > 0
    outputs = group["arms"]
    assert set(outputs) == set(ARMS), "A missing or partial arm cannot qualify"
    baseline = outputs["baseline"]
    for arm in ARMS:
        value = outputs[arm]
        assert set(value) == FIELDS, (arm, "Unexpected output fields", set(value) ^ FIELDS)
        assert all(type(value[key]) is int and value[key] >= 0 for key in COUNTS)
        assert value["rows"] > 0 and value["heapBytes"] > 0
        assert re.fullmatch(r"[0-9a-f]{64}", value["digest"])
        assert value["nativePrepared"] is True and value["crcVerified"] is True
        assert type(value["crcDeferred"]) is bool
        assert value["scratchReuseGroups"] == value["fusedAttempts"] == 1
        for key in ("nativeSegments", "nativeFallbacks", "scratchReuseMisses", "fusedFallbacks"):
            assert value[key] == 0, (arm, key)
        if value["crcDeferred"]:
            assert value["crcScannedBytes"] + value["crcReusedBytes"] == group["sourceBytes"]
        else:
            assert value["crcScannedBytes"] == value["crcReusedBytes"] == value["crcReusedGlossaries"] == 0
        allowed = VARIABLE if arm == "suffix" else set()
        for key in FIELDS - allowed:
            assert value[key] == baseline[key], (arm, key, baseline[key], value[key])
        if arm == "suffix":
            assert value["crcScannedBytes"] <= baseline["crcScannedBytes"]
            for key in VARIABLE - {"crcScannedBytes"}:
                assert value[key] >= baseline[key], (arm, key, "Unexpected decrease")
    return int(last[1]) + 1


def verify_report(report_path):
    plan_path = ROOT / "plan.json.txt"
    plan = read(plan_path)
    provenance = read(ROOT / "provenance.json.txt")
    assert digest(plan_path.read_bytes()) == provenance["planSha256"]
    assert digest((ROOT / "replay.mjs").read_bytes()) == provenance["adaptedSha256"]
    assert digest((ROOT / "upstream-replay.mjs.txt").read_bytes()) == provenance["upstream"]["sha256"]
    assert digest((ROOT / "adaptation.patch.txt").read_bytes()) == provenance["patchSha256"]
    assert plan["allowedCounterDifferences"]["mask"] == []
    assert set(plan["allowedCounterDifferences"]["suffix"]) == VARIABLE
    report = read(report_path)
    assert report["schema"] == 2 and report["complete"] is True
    assert report["node"] == "v22.22.0"
    assert report["studyPlan"] == plan
    assert report["runnerSha256"] == provenance["adaptedSha256"]
    assert report["planSha256"] == provenance["planSha256"]
    assert report["upstreamReplay"] == provenance["upstream"]
    assert report["adaptationPatchSha256"] == provenance["patchSha256"]
    assert report["lockSha256"] == plan["fixtureLockSha256"]
    assert report["grouping"]["parserWorkers"] == plan["parserWorkers"] == 3
    assert report["grouping"]["targetBytes"] == 24 * 1024 * 1024
    assert report["grouping"]["executionConcurrency"] == 1
    assert set(report["sources"]) == set(ARMS)
    baseline_hashes = report["sources"]["baseline"]["hashes"]
    for arm in ARMS:
        source = report["sources"][arm]
        expected = plan["sources"][arm]
        assert source["git"] == {"sha": expected["commit"], "tree": expected["tree"], "status": ""}
        hashes = source["hashes"]
        assert hashes["ext/js/dictionary/wasm/term-bank-parser.c"] == expected["nativeSourceSha256"]
        for name in ("ext/lib/term-bank-parser.wasm", "dev/data/dictionary-wasm/term-bank-parser.wasm"):
            assert hashes[name] == expected["wasmSha256"]
        assert hashes["test/perf/dictionaries.lock.json"] == plan["fixtureLockSha256"]
        for name in hashes:
            if name.endswith(".js") or name in ("package-lock.json", "test/perf/dictionaries.lock.json"):
                assert hashes[name] == baseline_hashes[name], (arm, name)
    result, = report["dictionaries"]
    dictionary = result["dictionary"]
    assert dictionary in plan["dictionaries"]
    fixture = plan["fixtures"][dictionary]
    assert result["archiveSha256"] == fixture["sha256"]
    assert result["rows"] == fixture["termRows"]
    assert result["banks"] == plan["expectedBanks"][dictionary]
    assert len(result["groups"]) == plan["expectedGroups"][dictionary]
    assert result["totalSourceBytes"] == plan["expectedSourceBytes"][dictionary]
    assert result["policy"] == {"mediaHintFastScan": dictionary != "jmdict",
                                "projectImagePaths": dictionary == "vndb", "prepareLookupRoute": True}
    assert result["groupsPerWorker"] == (4 if dictionary == "jmdict" else 3)
    assert result["minimumGroups"] == 3 * result["groupsPerWorker"]
    observed_rows = observed_bytes = 0
    expected_first = 1
    totals = {arm: {key: 0 for key in TOTALS} | {"maxHeapBytes": 0} for arm in ARMS}
    for group in result["groups"]:
        expected_first = verify_group(group, expected_first)
        observed_rows += group["arms"]["baseline"]["rows"]
        observed_bytes += group["sourceBytes"]
        for arm, value in group["arms"].items():
            assert value["crcDeferred"] == (dictionary == "vndb")
            for key in TOTALS:
                totals[arm][key] += value[key]
            totals[arm]["maxHeapBytes"] = max(totals[arm]["maxHeapBytes"], value["heapBytes"])
    assert expected_first == result["banks"] + 1
    assert observed_rows == result["rows"] and observed_bytes == result["totalSourceBytes"]
    assert result["nativeSegments"] == result["nativeFallbacks"] == 0
    for arm in ARMS:
        assert result[arm] == totals[arm], (arm, "Independent counter totals differ")
        if dictionary == "vndb":
            assert totals[arm]["crcScannedBytes"] + totals[arm]["crcReusedBytes"] == observed_bytes
    return {"status": "PASS", "dictionary": dictionary, "rowsPerArm": observed_rows,
            "groupsPerArm": len(result["groups"]), "sourceBytes": observed_bytes,
            "arms": totals, "reportSha256": digest(report_path.read_bytes()),
            "scope": "Complete parser/lookup/route/media-row output equality; no browser, storage or performance claim"}


def self_test():
    value = {key: 1 for key in COUNTS}
    value.update({key: 0 for key in ("nativeSegments", "nativeFallbacks", "scratchReuseMisses", "fusedFallbacks")})
    value.update(digest="a" * 64, nativePrepared=True, crcDeferred=True, crcVerified=True,
                 crcScannedBytes=70, crcReusedBytes=30, crcReusedGlossaries=1)
    valid = {"firstBank": "term_bank_1.json", "lastBank": "term_bank_2.json", "sourceBytes": 100,
             "arms": {arm: copy.deepcopy(value) for arm in ARMS}}
    valid["arms"]["suffix"].update(validatedGlossaryReuseCount=2, crcScannedBytes=60, crcReusedBytes=40, crcReusedGlossaries=2)
    assert verify_group(valid, 1) == 3
    for arm, key, value in (("mask", "crcReusedBytes", 40), ("suffix", "digest", "b" * 64),
                            ("suffix", "crcReusedBytes", 41), ("suffix", "validatedGlossaryReuseCount", 0),
                            ("suffix", "scratchReuseMisses", 1), ("suffix", "mediaRows", 2)):
        invalid = copy.deepcopy(valid)
        invalid["arms"][arm][key] = value
        try:
            verify_group(invalid, 1)
        except AssertionError:
            continue
        raise AssertionError(f"Guard accepted {arm}/{key}")
    print("PASS: independent audit rejects changed mask work, output drift, CRC gaps, decreased reuse, fallback and media drift")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path, nargs="?")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
    else:
        if args.report is None:
            parser.error("Provide a complete report or --self-test")
        print("CORPUS_PROOF " + json.dumps(verify_report(args.report), sort_keys=True), flush=True)
