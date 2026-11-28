"""Independently audit the frozen JMdict decompression component receipts."""

import argparse
import hashlib
import json
import math
from pathlib import Path
import statistics
import subprocess
import sys
import zipfile


REPO = None
BASE = "9e10d3b3fcf66d344ab31bc42c9b522fa5215da2"
SOURCE = "70f3cda48ba768979a117f58a3901334d402f700"
TREE = "17ff7a2b17c9130f43c347791567a6a9b0e631a0"
BROWSER = "153.0.8010.12"
BROWSER_SHA256 = "8c599d43aec53f2460a31ae2f4af6bd863f8258b34ff519564bc5d4726bfaa1e"
HELPERS = "dev/perf/decompression-stream-chromium"


def load(path):
    return json.loads(path.read_text())


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def close(left, right):
    assert math.isfinite(left) and math.isfinite(right)
    assert math.isclose(left, right, rel_tol=1e-12, abs_tol=1e-7), (left, right)


def valid_time(value):
    assert isinstance(value, (int, float)) and not isinstance(value, bool)
    assert math.isfinite(value) and value >= 0


def expected_source_files():
    output = subprocess.check_output([
        "git", "ls-tree", "-r", BASE, "--", "ext/js", "dev/data/dictionary-wasm",
        "package.json", "package-lock.json", "test/perf/dictionaries.lock.json",
    ], cwd=REPO, text=True)
    files = {}
    for line in output.splitlines():
        metadata, path = line.split("\t")
        if not path.endswith((".js", ".json", ".wasm")):
            continue
        content = (REPO / path).read_bytes()
        blob = hashlib.sha1(f"blob {len(content)}\0".encode() + content).hexdigest()
        assert blob == metadata.split()[2], path
        files[path] = hashlib.sha256(content).hexdigest()
    for name in ("gzip-inflater.mjs", "worker.mjs", "capture.mjs", "fixtures.mjs", "campaign.mjs"):
        path = f"{HELPERS}/{name}"
        files[path] = digest(REPO / path)
    return files


def audit(directory):
    assert subprocess.check_output(["git", "rev-parse", "HEAD^{tree}"], cwd=REPO, text=True).strip() == TREE
    assert subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=no"], cwd=REPO, text=True).strip() == ""
    campaign_dir = directory / "campaign"
    registration = load(campaign_dir / "registration.json")
    campaign = load(campaign_dir / "campaign.json")
    capture = load(directory / "capture-manifest.json")
    conformance = load(directory / "conformance-manifest.json")
    host = load(directory / "host.json")
    assert host["nodeVersion"] == "v22.22.0" and host["platform"] == "linux" and host["arch"] == "x64"
    assert (directory / "source-sha.txt").read_text().strip() == SOURCE
    assert (directory / "source-tree.txt").read_text().strip() == TREE
    identities = registration["identities"]
    assert campaign["identities"] == identities
    assert identities["source"] == SOURCE and identities["tree"] == TREE
    assert identities["baseline"] == capture["baseline"] == BASE
    assert identities["expectedBrowserVersion"] == BROWSER
    assert identities["browserExecutableSha256"] == BROWSER_SHA256
    assert identities["playwrightVersion"] == "1.63.0" and identities["browserRevision"] == "1243"
    assert identities["inputManifestSha256"] == digest(directory / "capture-manifest.json")
    assert identities["conformanceManifestSha256"] == digest(directory / "conformance-manifest.json")
    expected_files = expected_source_files()
    assert identities["sourceFiles"] == expected_files
    assert identities["wasmSha256"] == capture["wasmSha256"] == conformance["nativeWasmSha256"] == expected_files["dev/data/dictionary-wasm/term-bank-parser.wasm"]
    lock = load(REPO / "test/perf/dictionaries.lock.json")
    assert identities["lockSha256"] == capture["lockSha256"] == expected_files["test/perf/dictionaries.lock.json"]
    assert identities["packageLockSha256"] == expected_files["package-lock.json"]
    assert identities["archiveSha256"] == capture["archiveSha256"] == lock["dictionaries"]["jmdict"]["sha256"]
    assert capture["captureSha256"] == expected_files[f"{HELPERS}/capture.mjs"]
    assert capture["totalRows"] == 528299 and len(capture["groups"]) == 12
    assert capture["grouping"] == {"parserWorkers": 3, "groupsPerWorker": 4, "targetBytes": 25165824, "executionConcurrency": 1}
    assert sum(len(group["banks"]) for group in capture["groups"]) == 53
    assert sum(group["rows"] for group in capture["groups"]) == capture["totalRows"]
    assert sum(group["compressedBytes"] for group in capture["groups"]) == capture["compressedBytes"] == 15632849
    assert sum(group["decodedBytes"] for group in capture["groups"]) == capture["decodedBytes"] == 171617523
    for index, group in enumerate(capture["groups"]):
        assert group["groupIndex"] == index and len(group["banks"]) > 1
        assert not group["crcReuseEligible"] and group["decodedBytes"] / group["compressedBytes"] < 32
        assert all(bank["compressionMethod"] == 8 for bank in group["banks"])

    schedule = []
    for pair in range(6):
        scenarios = ["gzip64", "gzip1k", "control"]
        offset = pair % 3
        scenarios = scenarios[offset:] + scenarios[:offset]
        if pair % 2:
            scenarios.reverse()
        for scenario in scenarios:
            schedule.append({"pair": pair, "scenario": scenario,
                             "order": ["candidate", "baseline"] if pair % 2 else ["baseline", "candidate"]})
    assert registration["schedule"] == schedule
    assert registration["pairs"] == campaign["pairs"] == 6 and registration["samples"] == 36
    assert registration["dictionary"] == campaign["dictionary"] == "jmdict"
    assert len(conformance["formats"]) == 14 and len(conformance["cases"]) == 157

    prerequisite = campaign["prerequisite"]
    assert prerequisite == load(campaign_dir / "conformance.json")
    assert prerequisite["browserVersion"] == BROWSER
    verified = prerequisite.get("verified", [])
    intended = [("format", entry) for entry in conformance["formats"]] + [("source", entry) for entry in conformance["cases"]]
    assert len(verified) <= len(intended)
    for result, (kind, expected) in zip(verified, intended):
        assert result["type"] == kind and result["name"] == expected["name"]
        if kind == "format":
            assert result["actual"]["accepted"] == expected["expectedAccepted"]
            if result["actual"]["accepted"]:
                assert result["actual"]["decodedSha256"] == expected["expectedSha256"]
        else:
            assert result["originalInputPreserved"] is True
            assert result["native"] == expected["expected"]
            assert [row["variant"] for row in result["direct"]] == ["gzip64", "gzip1k"]
            for direct in result["direct"]:
                assert direct["accepted"] == expected["expected"]["accepted"]
                if direct["accepted"]:
                    assert direct["decodedBytes"] == expected["expected"]["decodedBytes"]
                    assert direct["decodedSha256"] == expected["expected"]["decodedSha256"]
    if prerequisite["complete"]:
        assert len(verified) == 171
    else:
        assert not campaign["cases"] and not campaign["complete"]
    prerequisite_journal = [json.loads(line) for line in (campaign_dir / "conformance.observations.jsonl").read_text().splitlines()]
    assert prerequisite_journal[0]["type"] == "initialization"
    assert prerequisite_journal[1:] == verified

    completed_arms = []
    for case_index, case in enumerate(campaign["cases"]):
        assert {key: case[key] for key in ("pair", "scenario", "order")} == schedule[case_index]
        for label in case["order"]:
            result = case["samples"][label]
            name = f"{case['pair'] + 1:02d}-{case['scenario']}-{label}"
            assert load(campaign_dir / f"{name}.json") == result
            arm = "native" if label == "baseline" or case["scenario"] == "control" else case["scenario"]
            assert result["arm"] == arm
            assert result.get("browserVersion", BROWSER) == BROWSER
            journal_file = campaign_dir / f"{name}.observations.jsonl"
            journal = [json.loads(line) for line in journal_file.read_text().splitlines()] if journal_file.exists() else []
            metrics = result.get("metrics", [])
            if journal:
                assert journal[0]["type"] == "initialization"
                assert journal[1:] == [{"type": "group", **group} for group in metrics]
            for index, metric in enumerate(metrics):
                group = capture["groups"][index]
                assert metric["arm"] == arm and metric["groupIndex"] == index
                assert metric["workerIndex"] == index % 3 and metric["invocation"] == index // 3 + 1
                assert metric["firstInvocation"] == (index < 3)
                assert metric["expectedRows"] == group["rows"]
                assert metric["compressedBytes"] == group["compressedBytes"]
                assert metric["decodedBytes"] == group["decodedBytes"]
                assert metric["decodedSha256"] == group["decodedSha256"]
                assert metric["nativeFallbackCalls"] == 0 and metric["wasmMemoryShared"] is True
                assert metric["wasmCapacityBytes"] >= group["decodedBytes"]
                valid_time(metric["inflateAndCrcMs"])
                if arm == "native":
                    assert metric["inputCopiedBytes"] == group["compressedBytes"]
                    assert metric["outputCopiedBytes"] == metric["framedBytes"] == 0
                    assert metric["inputChunkBytes"] is None and metric["inputChunks"] is None
                else:
                    size = 1024 if arm == "gzip1k" else 65536
                    assert metric["inputChunkBytes"] == size
                    assert metric["inputChunks"] == sum(2 + math.ceil(bank["compressedSize"] / size) for bank in group["banks"])
                    assert metric["inputCopiedBytes"] == 0 and metric["outputCopiedBytes"] == group["decodedBytes"]
                    assert metric["framedBytes"] == len(group["banks"]) * 18 and metric["decodedChunks"] > 0
            if not result["complete"]:
                continue
            assert len(metrics) == 12 and len(result["inits"]) == 3
            assert all(init["arm"] == arm and init["crossOriginIsolated"] is True for init in result["inits"])
            assert result["noWarmupCalls"] is True and result["passesPerWorker"] == 1 and result["groupsPerWorker"] == 4
            for field in ("initializationMs", "compileMs", "moduleReadMs", "workMs", "coldWorkMs", "laterWorkMs", "totalMs", "browserLaunchMs", "sampleWallMs"):
                valid_time(result[field])
            close(result["workMs"], sum(group["inflateAndCrcMs"] for group in metrics))
            close(result["coldWorkMs"], sum(group["inflateAndCrcMs"] for group in metrics[:3]))
            close(result["laterWorkMs"], sum(group["inflateAndCrcMs"] for group in metrics[3:]))
            close(result["totalMs"], result["initializationMs"] + result["workMs"])
            completed_arms.append(name)
        left, right = case["samples"]["baseline"], case["samples"]["candidate"]
        if left["complete"] and right["complete"]:
            for field, metric in (("workRatio", "workMs"), ("totalRatio", "totalMs"), ("coldRatio", "coldWorkMs"), ("laterRatio", "laterWorkMs")):
                close(case[field], right[metric] / left[metric])
            close(case["workDeltaMs"], right["workMs"] - left["workMs"])
            close(case["totalDeltaMs"], right["totalMs"] - left["totalMs"])

    computed = []
    for scenario in ("gzip64", "gzip1k", "control"):
        rows = [row for row in campaign["cases"] if row["scenario"] == scenario and "workRatio" in row]
        summary = {"scenario": scenario, "completedPairs": len(rows)}
        for output, field in (("medianWorkRatio", "workRatio"), ("medianTotalRatio", "totalRatio"), ("medianWorkDeltaMs", "workDeltaMs"), ("medianTotalDeltaMs", "totalDeltaMs"), ("medianColdRatio", "coldRatio"), ("medianLaterRatio", "laterRatio")):
            summary[output] = statistics.median(row[field] for row in rows) if rows else None
        summary["workWins"] = sum(row["workRatio"] < 1 for row in rows)
        stored = next(row for row in campaign["summaries"] if row["scenario"] == scenario)
        assert stored.keys() == summary.keys()
        for field, value in summary.items():
            if isinstance(value, float):
                close(stored[field], value)
            else:
                assert stored[field] == value
        if rows:
            summary["equalWorkRatio"] = sum(row["samples"]["candidate"]["workMs"] for row in rows) / sum(row["samples"]["baseline"]["workMs"] for row in rows)
            summary["totalWins"] = sum(row["totalRatio"] < 1 for row in rows)
            summary["workRatios"] = [row["workRatio"] for row in rows]
            summary["totalRatios"] = [row["totalRatio"] for row in rows]
        computed.append(summary)
    assert campaign["complete"] == (prerequisite["complete"] and len(campaign["cases"]) == 18 and len(completed_arms) == 36 and not campaign["failures"])
    return {"rawEvidenceDirectory": str(directory), "source": SOURCE, "tree": TREE, "host": host,
            "campaignSha256": digest(campaign_dir / "campaign.json"), "registrationSha256": digest(campaign_dir / "registration.json"),
            "sourceFilesChecked": len(expected_files), "strictConformanceComplete": prerequisite["complete"],
            "verifiedConformanceRecords": len(verified), "complete": campaign["complete"],
            "completedArms": completed_arms, "failures": campaign["failures"], "summaries": computed,
            "scope": "Initialization wall time plus summed serial group inflate/CRC/copy work in three worker instances, not parallel import wall time.",
            "resourcePromotionBlocked": True,
            "resourceLimit": "Fixed compressed-input slices and JS overflow checks do not reproduce the existing hard declared-output allocation cap or guarantee process residency."}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path, help="Extracted artifact jmdict directory")
    parser.add_argument("--source-repo", type=Path, required=True, help="Clean checkout with the frozen research tree")
    parser.add_argument("--artifact", type=Path, default=Path(__file__).with_name("artifact.zip"))
    parser.add_argument("--original-audit", type=Path, default=Path(__file__).with_name("independent-audit.json"))
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    REPO = args.source_repo.resolve()
    directory = args.directory.resolve()
    assert args.artifact.stat().st_size == 220443
    assert digest(args.artifact) == "b49c57e37e181d19541de6e9da21a30e267363df928dd6b99d00bca345c15591"
    with zipfile.ZipFile(args.artifact) as archive:
        names = [entry.filename for entry in archive.infolist() if not entry.is_dir()]
        assert len(names) == len(set(names)) == 120
        for name in names:
            path = Path(name)
            assert not path.is_absolute() and ".." not in path.parts
            assert (directory.parent / path).read_bytes() == archive.read(name), name
    result = audit(directory)
    original = load(args.original_audit)
    normalized = dict(result)
    normalized.pop("rawEvidenceDirectory")
    original.pop("rawEvidenceDirectory")
    assert normalized == original, "Portable audit differs from original beyond extraction path"
    args.out.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"complete": result["complete"], "verifiedOriginalArtifactMembers": len(names),
                      "sourceFilesChecked": result["sourceFilesChecked"],
                      "completedArms": len(result["completedArms"]),
                      "verifiedConformanceRecords": result["verifiedConformanceRecords"],
                      "matchesOriginalAuditExceptExtractionPath": True,
                      "out": str(args.out)}, indent=2))
