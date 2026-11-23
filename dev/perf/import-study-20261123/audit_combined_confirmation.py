#!/usr/bin/env python3
"""Audit a frozen combined confirmation after acquisition; never launch imports.

Run and confirmation-study identities must be supplied and match the frozen campaign.
The candidate, discovery, measurement sources, package differences, and gates remain
pinned below. This script does not turn a numerical pass into a promotion decision.
"""

import argparse
import hashlib
import importlib.util
import itertools
import json
import math
from pathlib import Path
import re
import stat
import statistics
import subprocess
import zipfile


DISCOVERY_RUN = "45129037078"
DISCOVERY_HARNESS = "a492044455d200df593fe152638cc1383efa0dde"
CONFIRMATION_RUN = "45130250310"
CONFIRMATION_HARNESS = "8f4a5a5e25315369a0e8344c33f8fdee7c28fcf6"
BASELINE = "5e1f8c12f7ff798ba407323aff675cb23b22af02"
CANDIDATE = "958099525e6017c9faa3d912168da51575527b7d"
EXPECTED_WORKER_FILES = {"jmdict": 0, "jitendex": 0, "vndb": 2}
EXPECTED_SOURCE_CRC_BYTES = {"jmdict": 0, "jitendex": 0, "vndb": 4267992967}
EXPECTED_INDEX_WRITES = {"jmdict": (5, 23693336), "jitendex": (6, 23526384), "vndb": (83, 401899752)}
EXPECTED_COMPONENTS = ["7b6f5115f8d837a035c34ba395c9cb63b4eca39a", "0d5a05c40410fd97b0b85a2ad5e432dc5507bb33"]
EXPECTED_PACKAGE_DIFFERENCES = [
    "js/dictionary/dictionary-database.js",
    "js/dictionary/dictionary-importer.js",
    "js/dictionary/term-bank-source-crc.js",
    "js/dictionary/term-bank-wasm-parser-worker.js",
    "js/dictionary/term-bank-wasm-parser.js",
    "js/dictionary/term-record-import-index-worker-client.js",
    "js/dictionary/term-record-import-index-worker.js",
    "js/dictionary/term-record-import-index-writer.js",
    "js/dictionary/term-record-opfs-store.js",
    "js/dictionary/wasm/term-bank-parser.c",
    "lib/term-bank-parser.wasm",
]
CONFIG_PATH = "dev/perf/import-study-20261123/config.json"
MAX_OBSERVED_INDEX_QUEUE_BYTES = 24 * 1024 * 1024


def digest(path):
    hasher = hashlib.sha256()
    with path.open("rb") as source:
        while data := source.read(4 * 1024 * 1024):
            hasher.update(data)
    return hasher.hexdigest()


def read(path):
    return json.loads(path.read_text())


def check_config(config):
    assert config["schemaVersion"] == 1 and config["stage"] == "confirmation"
    assert config["baseline"] == BASELINE and config["candidate"] == CANDIDATE
    assert config["dictionaries"] == ["jmdict", "jitendex", "vndb"]
    assert config["confirmationOf"] == "https://github.com/ManabiIO/manabitan/actions/runs/" + DISCOVERY_RUN
    assert config["expectedPackageDifferences"] == EXPECTED_PACKAGE_DIFFERENCES
    assert config["expectedCandidateIndexWorkerFiles"] == EXPECTED_WORKER_FILES
    assert config["expectedSourceCrcCoverageBytes"] == EXPECTED_SOURCE_CRC_BYTES
    assert all(type(value) is int for value in config["expectedCandidateIndexWorkerFiles"].values())
    assert all(type(value) is int for value in config["expectedSourceCrcCoverageBytes"].values())
    assert config["components"] == EXPECTED_COMPONENTS


def expected_schedule(replication):
    orders = ["ABC", "CBA", "BCA", "ACB", "CAB", "BAC"]
    if replication == 2:
        orders.reverse()
    return ([{"name": "warmup-" + arm, "kind": "warmup", "triplet": 0, "arm": arm}
             for arm in ("ABC" if replication == 1 else "CBA")] +
            [{"name": arm + str(number), "kind": "measured", "triplet": number, "arm": arm}
             for number, order in enumerate(orders, 1) for arm in order])


def audit(root, node, fixtures, run, harness):
    assert re.fullmatch(r"[0-9]+", run) and re.fullmatch(r"[0-9a-f]{40}", harness)
    assert run == CONFIRMATION_RUN and harness == CONFIRMATION_HARNESS
    verifier = Path(__file__).with_name("verify.mjs").resolve()
    repository = verifier.parents[3]
    frozen_hashes = {}
    frozen_config = json.loads(subprocess.check_output(["git", "show", f"{harness}:{CONFIG_PATH}"], cwd=repository))
    check_config(frozen_config)
    frozen_packages = None
    browser_version = None
    fixture_cache = {}
    semantic_by_dictionary = {}
    workflow_run = read(root / "workflow-run.github.json")
    assert workflow_run["id"] == int(run) and workflow_run["head_sha"] == harness
    assert workflow_run["run_attempt"] == 1
    assert workflow_run["status"] == "completed" and workflow_run["conclusion"] == "success"
    jobs = read(root / "workflow-jobs.github.json")["jobs"]
    assert {job["name"] for job in jobs} == {"plan"} | {f"compare ({dictionary}, {replication})"
            for dictionary, replication in itertools.product(("jmdict", "jitendex", "vndb"), (1, 2))}
    assert len(jobs) == 7 and len({job["id"] for job in jobs}) == 7
    assert all(job["run_id"] == int(run) and job["status"] == "completed" and job["conclusion"] == "success" for job in jobs)
    assert all("run_attempt" not in job or job["run_attempt"] == 1 for job in jobs)
    expected_artifact_names = {f"import-study-{dictionary}-{replication}-attempt-1"
            for dictionary, replication in itertools.product(("jmdict", "jitendex", "vndb"), (1, 2))}
    assert {path.name.removesuffix(".github.json") for path in root.glob("import-study-*.github.json")} == expected_artifact_names
    spec = importlib.util.spec_from_file_location("frozen_import_study", verifier.with_name("run.py"))
    runner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)
    script = ("import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs'; "
              "import {pathToFileURL} from 'node:url'; "
              "const {verifyStudy}=await import(pathToFileURL(process.argv[2])); "
              "const result=verifyStudy(process.argv[3]); "
              "assert.deepEqual(result,JSON.parse(readFileSync(process.argv[3]+'/result.json','utf8'))); "
              "console.log(JSON.stringify(result))")
    cells = []
    readback_states = 0
    sampled_responses = 0
    media_byte_probes = 0
    for dictionary, replication in itertools.product(("jmdict", "jitendex", "vndb"), (1, 2)):
        name = f"import-study-{dictionary}-{replication}-attempt-1"
        extracted = root / name
        evidence = extracted / dictionary / str(replication)
        archive = root / (name + ".zip")
        github = read(root / (name + ".github.json"))
        assert github["name"] == name
        assert github["workflow_run"]["id"] == int(run) and github["workflow_run"]["head_sha"] == harness
        assert archive.stat().st_size == github["size_in_bytes"]
        assert "sha256:" + digest(archive) == github["digest"]
        with zipfile.ZipFile(archive) as package:
            entries = package.infolist()
            members = [entry for entry in entries if not entry.is_dir()]
            assert len({entry.filename for entry in entries}) == len(entries)
            for entry in entries:
                relative = Path(entry.filename)
                assert not relative.is_absolute() and ".." not in relative.parts and "\\" not in entry.filename
                assert stat.S_IFMT(entry.external_attr >> 16) != stat.S_IFLNK
                target = extracted / relative
                assert not target.is_symlink()
                if not entry.is_dir():
                    assert package.read(entry) == target.read_bytes()
            assert {entry.filename for entry in members} == {
                path.relative_to(extracted).as_posix() for path in extracted.rglob("*") if path.is_file()
            }
        checked = json.loads(subprocess.check_output([node, "--input-type=module", "-e", script, "import-discovery-audit",
                                                     str(verifier), str(evidence)], text=True))
        plan = read(evidence / "plan.json")
        assert plan["workflowRun"] == run and plan["harnessSha"] == harness
        assert plan["workflowAttempt"] == "1"
        assert plan["dictionary"] == dictionary and plan["replication"] == replication
        assert plan["config"] == frozen_config
        assert plan["schedule"] == expected_schedule(replication)
        for name, expected_hash in plan["sourceFiles"].items():
            if name not in frozen_hashes:
                content = subprocess.check_output(["git", "show", f"{harness}:{name}"], cwd=repository)
                frozen_hashes[name] = hashlib.sha256(content).hexdigest()
            assert frozen_hashes[name] == expected_hash
            if name != CONFIG_PATH:
                discovery_source = subprocess.check_output(["git", "show", f"{DISCOVERY_HARNESS}:{name}"], cwd=repository)
                assert hashlib.sha256(discovery_source).hexdigest() == expected_hash
                assert digest(repository / name) == expected_hash
        assert checked["layoutDifferences"] == []
        assert checked["packageDifferences"] == EXPECTED_PACKAGE_DIFFERENCES
        packages = {arm: read(evidence / f"{arm}-package-entries.json") for arm in "AB"}
        if frozen_packages is None:
            frozen_packages = packages
            browser_version = checked["browserVersion"]
        assert packages == frozen_packages and checked["browserVersion"] == browser_version
        for module in ("js/dictionary/term-record-import-index-worker.js", "js/dictionary/term-record-import-index-worker-client.js", "js/dictionary/term-bank-source-crc.js"):
            assert module not in packages["A"] and module in packages["B"]
        if dictionary not in semantic_by_dictionary:
            semantic_by_dictionary[dictionary] = checked["semanticDigestSha256"]
        assert semantic_by_dictionary[dictionary] == checked["semanticDigestSha256"]
        fixture = plan["fixture"]
        source = fixtures / fixture["cacheFile"]
        media = read(evidence / "media-reference.json")
        if dictionary not in fixture_cache:
            assert source.stat().st_size == fixture["sizeBytes"] and digest(source) == fixture["sha256"]
            with zipfile.ZipFile(source) as source_zip:
                source_banks = [entry for entry in source_zip.infolist() if re.fullmatch(r"term_bank_[0-9]+\.json", entry.filename)]
                source_bank_bytes = sum(entry.file_size for entry in source_banks)
            fixture_cache[dictionary] = (fixture, runner.media_reference(source, fixture), len(source_banks), source_bank_bytes)
        frozen_fixture, source_media, source_bank_count, source_bank_bytes = fixture_cache[dictionary]
        assert frozen_fixture == fixture and source_media == media
        assert (0 if media is None else len(media)) == {"jmdict": 0, "jitendex": 236, "vndb": 5}[dictionary]
        if media is not None:
            with zipfile.ZipFile(source) as source_zip:
                for probe in media:
                    data = source_zip.read(probe["path"])
                    assert len(data) == probe["bytes"] and hashlib.sha256(data).hexdigest() == probe["sha256"]
        observations = []
        for item in plan["schedule"]:
            directory = evidence / item["name"]
            raw = read(directory / "run-1.json")
            phases = [phase for phase in raw["phases"] if (phase.get("data") or {}).get("kind") == "dictionary-import"]
            assert len(phases) == 1
            timing = phases[0]["data"]["browserTiming"]
            duration = timing["completedAtMs"] - timing["startedAtMs"]
            expected = next(row for row in checked["observations"] if row["name"] == item["name"])
            assert math.isfinite(duration) and duration > 0
            assert duration == expected["metrics"]["totalImportMs"]
            for state_name in ("preRestart", "postRestart"):
                state = raw["benchmark"]["readbackDiagnostics"][state_name]
                readback_states += 1
                sampled_responses += len(state["semanticProbes"])
                media_byte_probes += 0 if media is None else len(media)
            phase_profiles = phases[0]["data"]["importDebug"]["importerPhaseTimings"]
            index_profiles = [phase["details"] for phase in phase_profiles
                              if "termRecordLookupIndexWriteBytes" in phase.get("details", {})]
            assert len(index_profiles) == 1
            index_profile = index_profiles[0]
            index_names = ("termRecordLookupIndexWriteCallCount", "termRecordLookupIndexWriteBytes",
                           "termRecordLookupIndexAwaitMs", "termRecordLookupIndexMaxQueuedBytes",
                           "termRecordLookupIndexWorkerFileCount")
            index_writer = {name: index_profile.get(name) for name in index_names}
            count = index_writer["termRecordLookupIndexWorkerFileCount"]
            if item["arm"] == "B":
                assert type(count) is int and count == EXPECTED_WORKER_FILES[dictionary]
                index_writer["workerPathActive"] = count > 0
                index_writer["activationEvidence"] = "Explicit runtime counter matches the frozen source-admission split"
            else:
                assert count is None
                index_writer["workerPathActive"] = False
                index_writer["activationEvidence"] = "New worker modules absent from the baseline package; counter is absent, not a measured zero"
            calls, written_bytes = EXPECTED_INDEX_WRITES[dictionary]
            assert index_writer["termRecordLookupIndexWriteCallCount"] == calls
            assert index_writer["termRecordLookupIndexWriteBytes"] == written_bytes
            queued = index_writer["termRecordLookupIndexMaxQueuedBytes"]
            assert type(queued) is int and 0 <= queued < MAX_OBSERVED_INDEX_QUEUE_BYTES
            profiles = [phase["details"] for phase in phase_profiles
                        if "parserSourceUncompressedBytes" in phase.get("details", {})]
            assert len(profiles) == 1
            profile = profiles[0]
            assert profile["parserSourceUncompressedBytes"] == source_bank_bytes
            diagnostic_names = ("parserSourceUncompressedBytes", "parserSourceInflateMs", "parserParseBankMs",
                                "parserParallelWorkerWallMs", "parserSourceCrcMs", "parserSourceCrcScannedBytes",
                                "parserSourceCrcReusedBytes", "parserSourceCrcReusedGlossaryCount")
            source_crc = {name: profile.get(name) for name in diagnostic_names}
            if item["arm"] == "B":
                if dictionary == "vndb":
                    for metric in ("parserSourceCrcScannedBytes", "parserSourceCrcReusedBytes", "parserSourceCrcReusedGlossaryCount"):
                        assert type(source_crc[metric]) is int and source_crc[metric] >= 0
                    assert source_crc["parserSourceCrcScannedBytes"] + source_crc["parserSourceCrcReusedBytes"] == source_bank_bytes == EXPECTED_SOURCE_CRC_BYTES[dictionary]
                    assert source_crc["parserSourceCrcReusedBytes"] > 0
                    assert 0 < source_crc["parserSourceCrcReusedGlossaryCount"] <= fixture["termRows"]
                    assert isinstance(source_crc["parserSourceCrcMs"], (int, float)) and math.isfinite(source_crc["parserSourceCrcMs"]) and source_crc["parserSourceCrcMs"] >= 0
                else:
                    assert all(source_crc[name] == 0 for name in diagnostic_names if "Crc" in name)
            else:
                assert all(source_crc[name] is None for name in diagnostic_names if "Crc" in name)
            observations.append({**item, "totalImportMs": duration, "phaseMetrics": expected["metrics"],
                                 "sourceCrc": source_crc, "indexWriter": index_writer,
                                 "reportSha256": digest(directory / "run-1.json"),
                                 "summarySha256": digest(directory / "summary.json")})
        triples = [{arm: next(row["totalImportMs"] for row in observations
                             if row["triplet"] == number and row["arm"] == arm) for arm in "ABC"}
                   for number in range(1, 7)]
        comparisons = {}
        for numerator, denominator, key in (("B", "A", "candidateVersusA"), ("B", "C", "candidateVersusC"), ("C", "A", "identicalCodeControl")):
            changes = [100 * (row[numerator] / row[denominator] - 1) for row in triples]
            result = {"pairedChangesPercent": changes, "medianPairedChangePercent": statistics.median(changes),
                      "minPairedChangePercent": min(changes), "maxPairedChangePercent": max(changes),
                      "equalWorkChangePercent": 100 * (sum(row[numerator] for row in triples) / sum(row[denominator] for row in triples) - 1),
                      "fasterPairs": sum(change < 0 for change in changes)}
            original = checked["comparisons"]["totalImportMs"][key]
            for metric in ("medianPairedChangePercent", "equalWorkChangePercent", "fasterPairs"):
                assert result[metric] == original[metric]
            comparisons[key] = result
        meets_threshold = all(comparisons[key]["medianPairedChangePercent"] <= -5 and
                              comparisons[key]["equalWorkChangePercent"] < 0 and comparisons[key]["fasterPairs"] >= 5
                              for key in ("candidateVersusA", "candidateVersusC"))
        assert meets_threshold == checked["meetsMaterialityAndDirectionThreshold"]
        regression_screen = any(comparisons[key]["medianPairedChangePercent"] >= 5
                                for key in ("candidateVersusA", "candidateVersusC"))
        cells.append({"dictionary": dictionary, "replication": replication, "archive": {"path": archive.name, "bytes": archive.stat().st_size,
                        "sha256": digest(archive), "githubArtifactId": github["id"], "rawMembers": len(members)}, "browserVersion": checked["browserVersion"],
                      "sourceTermBankCount": source_bank_count, "sourceTermBankBytes": source_bank_bytes,
                      "sourceMediaProbeBytes": 0 if media is None else sum(probe["bytes"] for probe in media),
                      "semanticDigestSha256": checked["semanticDigestSha256"], "semanticEntryCount": checked["semanticEntryCount"],
                      "mediaProbesPerReadback": 0 if media is None else len(media), "layoutDifferences": [],
                      "observations": observations, "comparisons": comparisons,
                      "meetsConfirmationThreshold": meets_threshold, "materialRegressionScreen": regression_screen,
                      "expectedCandidateIndexWorkerFiles": EXPECTED_WORKER_FILES[dictionary],
                      "expectedSourceCrcCoverageBytes": EXPECTED_SOURCE_CRC_BYTES[dictionary]})
    ordinary_imports = sum(len(cell["observations"]) for cell in cells)
    measured_imports = sum(row["kind"] == "measured" for cell in cells for row in cell["observations"])
    assert ordinary_imports == 126 and measured_imports == 108
    assert readback_states == 252 and sampled_responses == 3024
    assert media_byte_probes == 20244
    target_cells = [cell for cell in cells if cell["dictionary"] == "vndb"]
    assert len(target_cells) == 2
    target_passes = all(cell["meetsConfirmationThreshold"] for cell in target_cells)
    regression_cells = [{"dictionary": cell["dictionary"], "replication": cell["replication"]}
                        for cell in cells if cell["materialRegressionScreen"]]
    numerical_gate_passes = target_passes and not regression_cells
    for metric in ("parserSourceCrcScannedBytes", "parserSourceCrcReusedBytes", "parserSourceCrcReusedGlossaryCount"):
        assert len({row["sourceCrc"][metric] for cell in target_cells for row in cell["observations"] if row["arm"] == "B"}) == 1
    package_map_hashes = {arm: hashlib.sha256(json.dumps(members, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
                          for arm, members in frozen_packages.items()}
    return {"schemaVersion": 1, "workflowRun": run, "workflowUrl": "https://github.com/ManabiIO/manabitan/actions/runs/" + run,
            "harnessSha": harness, "baselineSha": BASELINE, "candidateSha": CANDIDATE,
            "workflowAttempt": workflow_run["run_attempt"], "workflowRunMetadataSha256": digest(root / "workflow-run.github.json"),
            "discoveryRun": DISCOVERY_RUN, "discoveryHarnessSha": DISCOVERY_HARNESS,
            "expectedPackageDifferences": EXPECTED_PACKAGE_DIFFERENCES, "packageEntryMapSha256": package_map_hashes,
            "workflowJobs": [{"id": job["id"], "name": job["name"], "conclusion": job["conclusion"]} for job in jobs],
            "ordinaryImports": ordinary_imports, "measuredImports": measured_imports, "excludedWarmups": ordinary_imports - measured_imports,
            "completeSampledResponsesChecked": sampled_responses, "preAndPostRestartStates": readback_states,
            "sourceMediaByteProbesChecked": media_byte_probes,
            "bothTargetReplicationsPass": target_passes, "materialRegressionCells": regression_cells,
            "numericalGatePasses": numerical_gate_passes,
            "qualificationStatus": "REVIEW_REQUIRED" if numerical_gate_passes else "HOLD",
            "decision": ("Both independent VNDB replications meet the fixed numerical gate and no corpus crosses the paired-median regression screen. Review retained equal-work costs, tails and identical-code controls before deciding qualification; this receipt does not authorize promotion." if numerical_gate_passes else
                         "HOLD: the fixed two-replication numerical gate is not satisfied without a material-regression screen. Retain every tail and control observation. Do not retry, extend, subtract drift or pool replications to rescue the gate."),
            "retention": "Every GitHub-digest-verified ZIP member and all 126 acquired observations are retained and byte-verified, including 18 predeclared warmups. No import was rerun, replaced or removed. Source archives independently match their locks; all 236 referenced Jitendex images and five VNDB references are rederived from the originals. Complete semantic/provenance verifier reproduces every original receipt, with matching semantic digests across replications. Python independently recomputes raw browser durations, each six-pair statistic, control spread, and the fixed gate separately by replication. Every candidate observation matches the frozen worker-file split; index write calls/bytes match the pinned baseline totals and all reported index queues remain below 24 MiB. Source CRC covers every source byte on each VNDB candidate observation. Source CRC time is nested in parse-bank time; absent baseline CRC/worker counters remain null. Queue counters do not establish total memory or peak RSS.",
            "cells": cells}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifacts", type=Path)
    parser.add_argument("--run", required=True, help="Actual completed confirmation workflow run ID")
    parser.add_argument("--harness", required=True, help="Actual frozen confirmation study commit SHA")
    parser.add_argument("--node", default="node")
    parser.add_argument("--fixtures", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path, help="New receipt path; existing files are never overwritten")
    args = parser.parse_args()
    if args.output.exists():
        parser.error("Output already exists; retain it and choose a new replay receipt path")
    result = audit(args.artifacts.resolve(), args.node, args.fixtures.resolve(), args.run, args.harness)
    with args.output.open("x") as output:
        output.write(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"verified": True, "imports": result["ordinaryImports"], "decision": result["decision"]}))
