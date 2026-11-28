#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Audit retained diagnostic bytes and arithmetic without rerunning the census."""
import argparse
import copy
import hashlib
import io
import json
from pathlib import Path
import tarfile

if not __debug__:
    raise RuntimeError("Do not disable audit assertions with -O or PYTHONOPTIMIZE")

EXPECTED_TOTALS = {"banks": 53, "rows": 528299, "sourceBytes": 171617523,
                   "validatedGlossaryReuseRows": 54641, "recentContentHits": 154416}
RUNNER = "f4592074cb5e16a17e8ef206002beb4b5868d1d10ecec8944ecf21a6b358f02a"
BASELINE_C = "5a8257cb77d061694b6b2d247057aebb53ea2f49521d8d9893b3af175f145d8a"
MASK_C = "3c5c6d89a44356e2f0c3af8636f82a4a77a1f7212891161707e4465acaa2ca5e"
MASK_WASM = "6b327b4b5c85a973b1e2344276bb5476b6d036b197d87ab03b2a930ed50059eb"
BASELINE_WASM = "8ae00698649c5a3e41039b13c5ffe1dff2d4e69948cba2e3c063f381250031ee"

def sha(data):
    return hashlib.sha256(data).hexdigest()

def sum_counts(values):
    result = {}
    for key in values[0]:
        items = [value[key] for value in values]
        result[key] = sum_counts(items) if isinstance(items[0], dict) else (
            max(items) if key == "maxContainerDepth" else sum(items))
    return result

def audit_counts(c):
    assert c["compositeCalls"] > 0
    assert c["allRawStringTokens"] == (c["genericStringCalls"] + c["commonContentKeys"] +
                                     c["commonTagKeys"] + c["shortTagValueShortcuts"])
    assert c["textNormalizationTriggers"] == c["textNormalizationRows"] == 0
    assert c["normalizationRows"] == 0
    assert 0 < c["maxContainerDepth"] <= 256
    assert c["shortTagValueShortcuts"] == 0  # Observed corpus fact, not a general parser rule.
    assert c["rawStringBytes"] == (c["baseline"]["tokenBytes"] +
                                  c["commonContentKeys"] * 9 + c["commonTagKeys"] * 5)
    b, m, reset = [c[key] for key in ("baseline", "mask", "resetEachString")]
    for s in (b, m, reset):
        assert s["calls"] == s["quoteReturns"] == c["genericStringCalls"]
        assert s["tokenBytes"] == b["tokenBytes"]
        assert s["shortEscapes"] == b["shortEscapes"]
        assert s["unicodeEscapes"] == b["unicodeEscapes"]
        assert s["byteVisits"] == s["calls"] + s["shortEscapes"] + s["unicodeEscapes"] + s["scalarPlainSteps"]
        assert s["word8Loads"] == s["word8Plain"] + s["word8Special"]
        assert all(isinstance(v, int) and v >= 0 for v in s.values())
    assert b["iterations"] == b["word8Special"] == b["byteVisits"]
    assert b["scalarPlainSteps"] == 0
    for s in (m, reset):
        assert s["rangeLowerChecks"] == s["rangeUpperChecks"] == s["iterations"]
        assert s["cacheHits"] == s["crossStringCacheHits"] + s["sameStringCacheHits"]
        assert s["cacheHits"] == s["cachedZeroMasks"] + s["cachedSpecialMasks"]
        assert s["cacheHits"] == s["cacheHitWith16ByteRoom"] + s["cacheHitNearBankEnd"]
        assert s["iterations"] == s["cacheHits"] + s["fresh16Tests"]
        assert s["fresh16Tests"] == s["fresh16Loads"] + s["fallback8Entries"]
        assert s["fresh16Loads"] == s["fresh16ZeroMasks"] + s["fresh16SpecialMasks"]
        assert s["cachedSpecialMasks"] + s["fresh16SpecialMasks"] == s["byteVisits"]
        assert s["word8Loads"] == s["fallback8Entries"] == s["scalarPlainSteps"] == s["cacheHitNearBankEnd"] == 0
        assert s["callsEntirelyFromPriorWindow"] <= s["callsWithoutFresh16"] <= s["calls"]
        assert s["callsWithEntryCacheHit"] <= s["callsWithAnyCacheHit"] <= s["calls"]
    assert reset["crossStringCacheHits"] == reset["callsWithEntryCacheHit"] == reset["callsEntirelyFromPriorWindow"] == 0
    assert m["callsEntirelyFromPriorWindow"] == m["callsWithoutFresh16"]
    return {
        "baselineWord8Classifications": b["word8Loads"],
        "baselineClassifiedByteSum": b["word8Loads"] * 8,
        "actualFresh16Classifications": m["fresh16Loads"],
        "actualClassifiedByteSum": m["fresh16Loads"] * 16 + m["word8Loads"] * 8,
        "resetEachStringFresh16Classifications": reset["fresh16Loads"],
        "crossStringPersistenceFresh16Difference": reset["fresh16Loads"] - m["fresh16Loads"],
        "cacheHitRatio": m["cacheHits"] / m["iterations"],
        "crossStringHitRatio": m["crossStringCacheHits"] / m["iterations"],
        "fullyCoveredByPriorWindowCalls": m["callsEntirelyFromPriorWindow"],
        "zeroMaskFreshClassifications": m["fresh16ZeroMasks"],
        "sourceWindowFieldInitializations": c["compositeCalls"] * 3,
        "sourceWindowFieldAssignments": m["fresh16Loads"] * 3,
        "sourceZeroMaskFieldAssignments": m["fresh16ZeroMasks"] * 3,
        "sourceRangeComparisons": m["rangeLowerChecks"] + m["rangeUpperChecks"],
        "sourceMaskShifts": m["cacheHits"],
        "sourceCtzOperations": m["cachedSpecialMasks"] + m["fresh16SpecialMasks"] + m["word8Special"],
    }

def audit_report(report, oracle):
    assert report["complete"] is True and report["failure"] is None
    assert report["noWasmInstantiation"] is True and report["noPerformanceObservation"] is True
    assert report["totals"] == EXPECTED_TOTALS
    assert report["provenance"]["runnerSha256"] == RUNNER
    assert report["source"]["baselineC"] == BASELINE_C and report["source"]["maskC"] == MASK_C
    assert report["node"] == "v24.22.3"
    assert len(report["groups"]) == len(oracle["groups"]) == 12
    assert report["counts"] == sum_counts([g["counts"] for g in report["groups"]])
    for key in EXPECTED_TOTALS:
        actual = sum(len(g["banks"]) if key == "banks" else g[key] for g in report["groups"])
        assert actual == EXPECTED_TOTALS[key], key
    for index, (group, old) in enumerate(zip(report["groups"], oracle["groups"])):
        assert group["index"] == index
        assert group["rows"] == old["rows"] and group["sourceBytes"] == old["sourceBytes"]
        assert group["validatedGlossaryReuseRows"] == old["baselineReuseRows"]
        assert group["recentContentHits"] == old["rawContentMatches"]
        assert group["counts"]["compositeCalls"] == group["rows"] - group["validatedGlossaryReuseRows"]
        assert len(group["banks"]) == len(old["bankInputs"])
        for bank, existing in zip(group["banks"], old["bankInputs"]):
            assert bank["name"] == existing["filename"]
            assert bank["rows"] == existing["rows"]
            assert bank["bytes"] == existing["sourceBytes"]
            assert bank["sha256"] == existing["sha256"]
            assert bank["crc32"] == existing["crc32"]
        derived = audit_counts(group["counts"])
        for key, value in derived.items():
            assert group["analysis"][key] == value
    assert report["counts"]["compositeCalls"] == 473658
    derived = audit_counts(report["counts"])
    for key, value in derived.items():
        assert report["analysis"][key] == value
    return derived

def audit_payload(files):
    for name, expected in (("scan-window-census.mjs", RUNNER), ("baseline.c", BASELINE_C),
                           ("mask.c", MASK_C), ("baseline.wasm", BASELINE_WASM), ("mask.wasm", MASK_WASM)):
        assert sha(files[name]) == expected, name
    read = lambda name: json.loads(files[name])
    report, oracle = read("result/report.json"), read("existing-group-census.json")
    assert sha(files["existing-group-census.json"]) == "5d809c6ac68e083f48003e711b576d080d82d0a067c32dc606180b907e0c4904"
    assert read("plan.json")["runnerSha256"] == RUNNER
    assert read("self-test-receipt.json")["exitCode"] == 0
    receipt = read("census-receipt.json")
    assert receipt["exitCode"] == 0 and receipt["signal"] is None
    assert receipt["logSha256"] == sha(files["census.log"])
    assert read("preflight-history.json")["correctedRunnerSha256"] == RUNNER
    result = audit_report(report, oracle)
    dis = read("mask-bytecode.json")
    assert dis["sha256"] == MASK_WASM and dis["node"] == "v24.22.3"
    assert "no module instantiation" in dis["kind"]
    lines = [line for chunk in dis["chunks"] for line in chunk["lines"]]
    offsets = [value for chunk in dis["chunks"] for value in chunk["bytecodeOffsets"]]
    assert len(lines) == len(offsets) == dis["totalNumberOfLines"] == 32653
    assert ("\n".join(lines) + "\n").encode() == files["mask.wat"]
    hold = read("bytecode-hold.json")
    assert hold["disposition"] == "HOLD_NO_STORE_ELISION_CANDIDATE"
    assert hold["moduleSha256"] == MASK_WASM and hold["sourceCsha256"] == MASK_C
    assert hold["bytecodeJsonSha256"] == sha(files["mask-bytecode.json"])
    assert hold["watSha256"] == sha(files["mask.wat"])
    assert hold["toolSha256"] == sha(files["disassemble.mjs"])
    assert hold["functionBodyOffsets"] == dis["functionBodyOffsets"][26:28]
    for row in hold["snippet"]:
        i = row["watLine"] - 1
        assert row["instruction"] == lines[i].strip()
        assert row["bytecodeOffset"] == offsets[i]
        assert hold["functionBodyOffsets"][0] <= offsets[i] < hold["functionBodyOffsets"][1]
        assert "store" not in row["instruction"]
    assert any(row["instruction"] == "i8x16.bitmask" for row in hold["snippet"])
    source = files["mask.c"].decode().splitlines()
    for row in hold["sourceLines"]:
        assert row["text"] == source[row["line"] - 1]
    return {"status": "PASS", "scope": "Retained bytes and diagnostic arithmetic only; no census rerun or speed qualification",
            "totals": report["totals"], "analysis": result, "bytecodeDisposition": hold["disposition"]}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, default=Path(__file__).with_name("mask-census-manifest.json.txt"))
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text())
    assert manifest["noPerformanceObservation"] is True
    assert sha(Path(__file__).read_bytes()) == manifest["verifierSha256"]
    archive = args.manifest.parent / manifest["archive"]["path"]
    data = archive.read_bytes()
    assert len(data) == manifest["archive"]["bytes"] and sha(data) == manifest["archive"]["sha256"]
    files = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        for member in tar:
            assert member.isfile() and not Path(member.name).is_absolute() and ".." not in Path(member.name).parts
            assert member.name not in files and member.name in manifest["members"]
            content = tar.extractfile(member).read()
            expected = manifest["members"][member.name]
            assert len(content) == expected["bytes"] and sha(content) == expected["sha256"], member.name
            files[member.name] = content
    assert set(files) == set(manifest["members"])
    output = audit_payload(files)
    if args.self_test:
        original, oracle = json.loads(files["result/report.json"]), json.loads(files["existing-group-census.json"])
        mutations = [
            lambda r: r.update(complete=False),
            lambda r: r["counts"]["mask"].__setitem__("fresh16Loads", r["counts"]["mask"]["fresh16Loads"] + 1),
            lambda r: r["groups"][0]["counts"].__setitem__("textNormalizationRows", 1),
            lambda r: r["analysis"].__setitem__("sourceRangeComparisons", 0),
            lambda r: r.__setitem__("noPerformanceObservation", False),
        ]
        for change in mutations:
            altered = copy.deepcopy(original); change(altered)
            try:
                audit_report(altered, oracle)
            except AssertionError:
                continue
            raise RuntimeError("Negative diagnostic audit did not reject a mutation")
        output["negativeChecks"] = len(mutations)
    print(json.dumps(output, indent=2))

if __name__ == "__main__":
    main()

