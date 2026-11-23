#!/usr/bin/env python3
"""Independently audit the retained combined gated-I/O and source-CRC discovery without rerunning imports."""

import argparse
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import re
import stat
import statistics
import subprocess
import zipfile


RUN = "45129037078"
HARNESS = "a492044455d200df593fe152638cc1383efa0dde"
BASELINE = "5e1f8c12f7ff798ba407323aff675cb23b22af02"
CANDIDATE = "958099525e6017c9faa3d912168da51575527b7d"
EXPECTED_WORKER_FILES = {"jmdict": 0, "jitendex": 0, "vndb": 2}
EXPECTED_CRC_BYTES = {"jmdict": 0, "jitendex": 0, "vndb": 4_267_992_967}
HARNESS_TREE = "8eac9b7b4c1a7dd97065f2415b1d7e849035e7eb"
CANDIDATE_TREE = "ddf70903a004965361c9ab58a1f1e434c47edd01"
COMPONENTS = ["7b6f5115f8d837a035c34ba395c9cb63b4eca39a", "0d5a05c40410fd97b0b85a2ad5e432dc5507bb33"]
CORPORA = ("jmdict", "jitendex", "vndb")
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


def digest(path):
    hasher = hashlib.sha256()
    with path.open("rb") as source:
        while data := source.read(4 * 1024 * 1024):
            hasher.update(data)
    return hasher.hexdigest()


def read(path):
    return json.loads(path.read_text())


def verify_unit_receipt(directory):
    receipt_path = directory / "combined-unit-first-attempt.json"
    log_path = directory / "combined-unit-first-attempt.log"
    receipt = read(receipt_path)
    assert receipt["tree"] == CANDIDATE_TREE
    assert receipt["publishedEquivalentCommit"] == CANDIDATE
    assert receipt["attempt"] == 1 and receipt["exitCode"] == 0
    assert receipt["passedFiles"] == receipt["totalFiles"] == 632
    assert receipt["passedTests"] == 14079 and receipt["skippedTests"] == 47
    assert receipt["totalTests"] == receipt["passedTests"] + receipt["skippedTests"]
    assert not receipt["failures"] and not receipt["codeEdits"] and not receipt["reruns"]
    assert receipt["trackedFilesCleanAfterRun"] is True
    assert log_path.stat().st_size == receipt["logBytes"]
    assert digest(log_path) == receipt["logSha256"]
    log = log_path.read_text()
    assert "Test Files  632 passed (632)" in log
    assert "Tests  14079 passed | 47 skipped (14126)" in log
    return {"receiptPath": receipt_path.name, "receiptSha256": digest(receipt_path),
            "logPath": log_path.name, "logBytes": log_path.stat().st_size,
            "logSha256": digest(log_path), "passedFiles": 632, "passedTests": 14079,
            "skippedTests": 47, "attempt": 1, "rerun": False}


def audit(root, node, fixtures, dictionaries=CORPORA):
    verifier = Path(__file__).with_name("verify.mjs").resolve()
    repository = verifier.parents[3]
    frozen_hashes = {}
    for commit, tree in ((HARNESS, HARNESS_TREE), (CANDIDATE, CANDIDATE_TREE)):
        assert subprocess.check_output(["git", "rev-parse", commit + "^{tree}"], cwd=repository, text=True).strip() == tree
    jobs = read(root / "workflow-jobs.github.json")["jobs"]
    assert {job["name"] for job in jobs} == {"plan", "compare (jmdict, 1)", "compare (jitendex, 1)", "compare (vndb, 1)"}
    selected_job_names = {"plan", *(f"compare ({dictionary}, 1)" for dictionary in dictionaries)}
    assert all(job["run_id"] == int(RUN) for job in jobs)
    assert all(job["status"] == "completed" and job["conclusion"] == "success"
               for job in jobs if job["name"] in selected_job_names)
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
    for dictionary in dictionaries:
        name = f"import-study-{dictionary}-1-attempt-1"
        extracted = root / name
        evidence = extracted / dictionary / "1"
        archive = root / (name + ".zip")
        github = read(root / (name + ".github.json"))
        assert github["workflow_run"]["id"] == int(RUN) and github["workflow_run"]["head_sha"] == HARNESS
        assert archive.stat().st_size == github["size_in_bytes"]
        assert "sha256:" + digest(archive) == github["digest"]
        with zipfile.ZipFile(archive) as package:
            members = [entry for entry in package.infolist() if not entry.is_dir()]
            assert len({entry.filename for entry in members}) == len(members)
            for entry in members:
                relative = Path(entry.filename)
                assert not relative.is_absolute() and ".." not in relative.parts and "\\" not in entry.filename
                assert stat.S_IFMT(entry.external_attr >> 16) != stat.S_IFLNK
                assert package.read(entry) == (extracted / relative).read_bytes()
            assert {entry.filename for entry in members} == {
                path.relative_to(extracted).as_posix() for path in extracted.rglob("*") if path.is_file()
            }
        checked = json.loads(subprocess.check_output([node, "--input-type=module", "-e", script, "import-discovery-audit",
                                                     str(verifier), str(evidence)], text=True))
        plan = read(evidence / "plan.json")
        assert plan["workflowRun"] == RUN and plan["harnessSha"] == HARNESS
        assert plan["config"]["baseline"] == BASELINE and plan["config"]["candidate"] == CANDIDATE
        assert plan["config"]["stage"] == "discovery" and plan["replication"] == 1
        assert plan["config"]["expectedCandidateIndexWorkerFiles"] == EXPECTED_WORKER_FILES
        assert plan["config"]["expectedSourceCrcCoverageBytes"] == EXPECTED_CRC_BYTES
        assert plan["config"]["components"] == COMPONENTS
        assert plan["config"]["expectedPackageDifferences"] == EXPECTED_PACKAGE_DIFFERENCES
        assert checked["packageDifferences"] == EXPECTED_PACKAGE_DIFFERENCES
        assert plan["schedule"] == [{"name": f"warmup-{arm}", "kind": "warmup", "triplet": 0, "arm": arm} for arm in "ABC"] + [
            {"name": f"{arm}{triplet}", "kind": "measured", "triplet": triplet, "arm": arm}
            for triplet, order in enumerate(("ABC", "BCA", "CAB"), 1) for arm in order]
        for name, expected_hash in plan["sourceFiles"].items():
            if name not in frozen_hashes:
                content = subprocess.check_output(["git", "show", f"{HARNESS}:{name}"], cwd=repository)
                frozen_hashes[name] = hashlib.sha256(content).hexdigest()
            assert frozen_hashes[name] == expected_hash
            assert digest(repository / name) == expected_hash
        assert checked["layoutDifferences"] == []
        packages = {arm: read(evidence / f"{arm}-package-entries.json") for arm in "AB"}
        for worker_file in ("js/dictionary/term-record-import-index-worker.js", "js/dictionary/term-record-import-index-worker-client.js"):
            assert worker_file not in packages["A"] and worker_file in packages["B"]
        for arm, commit in (("A", BASELINE), ("B", CANDIDATE)):
            for name in EXPECTED_PACKAGE_DIFFERENCES:
                source_path = "dev/data/dictionary-wasm/term-bank-parser.wasm" if name == "lib/term-bank-parser.wasm" else "ext/" + name
                present = subprocess.run(["git", "cat-file", "-e", f"{commit}:{source_path}"], cwd=repository, capture_output=True)
                if present.returncode:
                    assert name not in packages[arm]
                else:
                    content = subprocess.check_output(["git", "show", f"{commit}:{source_path}"], cwd=repository)
                    assert hashlib.sha256(content).hexdigest() == packages[arm][name]
        fixture = plan["fixture"]
        source = fixtures / fixture["cacheFile"]
        assert source.stat().st_size == fixture["sizeBytes"] and digest(source) == fixture["sha256"]
        media = read(evidence / "media-reference.json")
        assert runner.media_reference(source, fixture) == media
        assert (0 if media is None else len(media)) == {"jmdict": 0, "jitendex": 236, "vndb": 5}[dictionary]
        with zipfile.ZipFile(source) as source_zip:
            source_banks = [entry for entry in source_zip.infolist() if re.fullmatch(r"term_bank_[0-9]+\.json", entry.filename)]
            source_bank_bytes = sum(entry.file_size for entry in source_banks)
            source_compressed_bytes = sum(entry.compress_size for entry in source_banks)
        assert len(source_banks) == {"jmdict": 53, "jitendex": 218, "vndb": 665}[dictionary]
        assert (source_bank_bytes >= 1024 ** 3) == (EXPECTED_WORKER_FILES[dictionary] > 0)
        if media is not None:
            with zipfile.ZipFile(source) as source_zip:
                for probe in media:
                    data = source_zip.read(probe["path"])
                    assert len(data) == probe["bytes"] and hashlib.sha256(data).hexdigest() == probe["sha256"]
        observations = []
        canonical_semantic = None
        canonical_physical = {}
        previous_end = 0
        for item in plan["schedule"]:
            directory = evidence / item["name"]
            acquisition = read(directory / "acquisition.json")
            assert {key: acquisition[key] for key in item} == item
            assert previous_end <= acquisition["startedEpochSeconds"] < acquisition["endedEpochSeconds"]
            previous_end = acquisition["endedEpochSeconds"]
            raw = read(directory / "run-1.json")
            phases = [phase for phase in raw["phases"] if (phase.get("data") or {}).get("kind") == "dictionary-import"]
            assert len(phases) == 1
            timing = phases[0]["data"]["browserTiming"]
            duration = timing["completedAtMs"] - timing["startedAtMs"]
            expected = next(row for row in checked["observations"] if row["name"] == item["name"])
            assert duration == expected["metrics"]["totalImportMs"]
            phase_profiles = phases[0]["data"]["importDebug"]["importerPhaseTimings"]
            by_phase = {phase["phase"]: phase for phase in phase_profiles}
            assert len(by_phase) == len(phase_profiles)
            def optional(value):
                return value if type(value) in (float, int) and math.isfinite(value) and value >= 0 else None
            final = by_phase.get("bulk-finalization", {})
            details = final.get("details", {})
            phase_metrics = {
                "totalImportMs": duration,
                "archiveAndIndexMs": optional(by_phase.get("archive-and-index", {}).get("elapsedMs")),
                "importDataBanksMs": optional(by_phase.get("import-data-banks", {}).get("elapsedMs")),
                "bulkFinalizationMs": optional(final.get("elapsedMs")),
                "termRecordCloseMs": optional(details.get("termRecordEndImportSessionCloseWritableMs")),
                "termRecordFlushPendingMs": optional(details.get("termRecordEndImportSessionFlushPendingWritesMs")),
                "termRecordAwaitQueuedMs": optional(details.get("termRecordEndImportSessionAwaitQueuedWritesMs")),
                "termContentEndSessionMs": optional(details.get("termContentEndImportSessionMs")),
            }
            assert phase_metrics == expected["metrics"]
            for state_name in ("preRestart", "postRestart"):
                state = raw["benchmark"]["readbackDiagnostics"][state_name]
                semantic = state["semanticProbes"]
                if canonical_semantic is None:
                    canonical_semantic = semantic
                assert semantic == canonical_semantic
                arm_package = "B" if item["arm"] == "B" else "A"
                if arm_package not in canonical_physical:
                    canonical_physical[arm_package] = state["physicalProbes"]
                assert state["physicalProbes"] == canonical_physical[arm_package]
                assert len(semantic) == 12
                for probe in semantic:
                    assert probe["result"]["dictionaryEntries"]
                    assert not probe["result"].get("dictionaryAvailability")
                readback_states += 1
                sampled_responses += len(state["semanticProbes"])
                media_byte_probes += 0 if media is None else len(media)
            phase_profiles = phases[0]["data"]["importDebug"]["importerPhaseTimings"]
            profiles = [phase["details"] for phase in phase_profiles if "termRecordLookupIndexWriteBytes" in phase.get("details", {})]
            assert len(profiles) == 1
            profile = profiles[0]
            diagnostic_names = ("termRecordLookupIndexWriteCallCount", "termRecordLookupIndexWriteBytes",
                                "termRecordLookupIndexAwaitMs", "termRecordLookupIndexMaxQueuedBytes",
                                "termRecordLookupIndexWorkerFileCount")
            index_writer = {name: profile.get(name) for name in diagnostic_names}
            if item["arm"] == "B":
                assert type(index_writer["termRecordLookupIndexWorkerFileCount"]) is int
                assert index_writer["termRecordLookupIndexWorkerFileCount"] == EXPECTED_WORKER_FILES[dictionary]
                index_writer["workerPathActive"] = EXPECTED_WORKER_FILES[dictionary] > 0
                index_writer["activationEvidence"] = "Explicit runtime file-count counter matches the predeclared large-source eligibility split"
            else:
                assert index_writer["termRecordLookupIndexWorkerFileCount"] is None
                index_writer["workerPathActive"] = False
                index_writer["activationEvidence"] = "New I/O worker modules absent from frozen baseline package; legacy counter is absent, not a measured zero"
            assert 0 <= index_writer["termRecordLookupIndexMaxQueuedBytes"] < 24 * 1024 * 1024
            parser_profiles = [phase["details"] for phase in phase_profiles if "parserSourceUncompressedBytes" in phase.get("details", {})]
            assert len(parser_profiles) == 1 and parser_profiles[0]["parserSourceUncompressedBytes"] == source_bank_bytes
            parser = parser_profiles[0]
            assert parser["rows"] == fixture["termRows"]
            assert parser["parserSourceCompressedBytes"] == source_compressed_bytes
            assert parser["parserBankSpanCount"] == len(source_banks)
            parser_profile = {name: parser.get(name) for name in
                              ("parserParallelWorkerWallMs", "parserSourceInflateMs", "parserParseBankMs", "sourceArchiveReadMs",
                               "parserBankSpanCount", "parserSourceCompressedBytes", "parserSourceUncompressedBytes")}
            source_crc = {name: parser.get(name) for name in
                          ("parserSourceCrcMs", "parserSourceCrcScannedBytes", "parserSourceCrcReusedBytes", "parserSourceCrcReusedGlossaryCount")}
            if item["arm"] == "B":
                assert all(type(source_crc[name]) in (int, float) and source_crc[name] >= 0 for name in source_crc)
                coverage = source_crc["parserSourceCrcScannedBytes"] + source_crc["parserSourceCrcReusedBytes"]
                assert coverage == EXPECTED_CRC_BYTES[dictionary]
                if coverage:
                    assert coverage == source_bank_bytes
                    assert source_crc["parserSourceCrcReusedBytes"] > 0
                    assert 0 < source_crc["parserSourceCrcReusedGlossaryCount"] <= fixture["termRows"]
                else:
                    assert all(value == 0 for value in source_crc.values())
            else:
                assert all(value is None for value in source_crc.values())
            work = {"rows": parser["rows"], "chunkCount": parser["chunkCount"],
                    "sourceBankCount": parser["parserBankSpanCount"],
                    "sourceUncompressedBytes": parser["parserSourceUncompressedBytes"],
                    "sourceCompressedBytes": parser["parserSourceCompressedBytes"],
                    "termContentTotalWriteBytes": profile["termContentTotalWriteBytes"],
                    "termRecordTotalWriteBytes": profile["termRecordTotalWriteBytes"],
                    "termRecordLookupIndexWriteBytes": profile["termRecordLookupIndexWriteBytes"]}
            observations.append({**item, "totalImportMs": duration, "phaseMetrics": phase_metrics,
                                 "indexWriter": index_writer, "parserProfile": parser_profile, "sourceCrc": source_crc,
                                 "workReceipt": work, "acquisition": acquisition,
                                 "reportSha256": digest(directory / "run-1.json"),
                                 "summarySha256": digest(directory / "summary.json")})
        assert len({json.dumps(row["workReceipt"], sort_keys=True) for row in observations}) == 1
        all_comparisons = {}
        for metric in observations[0]["phaseMetrics"]:
            all_comparisons[metric] = {}
            for numerator, denominator, key in (("B", "A", "candidateVersusA"), ("B", "C", "candidateVersusC"), ("C", "A", "identicalCodeControl")):
                pairs = []
                for number in range(1, 4):
                    values = {row["arm"]: row["phaseMetrics"][metric] for row in observations if row["triplet"] == number}
                    baseline, candidate = values[denominator], values[numerator]
                    available = baseline is not None and baseline > 0 and candidate is not None
                    pairs.append({"triplet": number, "baselineMs": baseline, "candidateMs": candidate,
                                  "changePercent": 100 * (candidate / baseline - 1) if available else None})
                available_pairs = [pair for pair in pairs if pair["changePercent"] is not None]
                result = {"pairs": pairs, "measuredPairs": len(available_pairs), "missingOrZeroBaselinePairs": 3 - len(available_pairs),
                          "medianPairedChangePercent": statistics.median(pair["changePercent"] for pair in available_pairs) if available_pairs else None,
                          "equalWorkChangePercent": 100 * (sum(pair["candidateMs"] for pair in available_pairs) / sum(pair["baselineMs"] for pair in available_pairs) - 1) if available_pairs else None,
                          "fasterPairs": sum(pair["changePercent"] < 0 for pair in available_pairs)}
                assert result == checked["comparisons"][metric][key]
                all_comparisons[metric][key] = result
        triples = [{arm: next(row["totalImportMs"] for row in observations
                             if row["triplet"] == number and row["arm"] == arm) for arm in "ABC"}
                   for number in range(1, 4)]
        comparisons = {}
        for numerator, denominator, key in (("B", "A", "candidateVersusA"), ("B", "C", "candidateVersusC"), ("C", "A", "identicalCodeControl")):
            changes = [100 * (row[numerator] / row[denominator] - 1) for row in triples]
            result = {"pairedChangesPercent": changes, "medianPairedChangePercent": statistics.median(changes),
                      "equalWorkChangePercent": 100 * (sum(row[numerator] for row in triples) / sum(row[denominator] for row in triples) - 1),
                      "fasterPairs": sum(change < 0 for change in changes),
                      "pairedRangePercent": [min(changes), max(changes)]}
            original = checked["comparisons"]["totalImportMs"][key]
            for metric in ("medianPairedChangePercent", "equalWorkChangePercent", "fasterPairs"):
                assert result[metric] == original[metric]
            comparisons[key] = result
        for name in ("termRecordLookupIndexWriteBytes", "termRecordLookupIndexWriteCallCount"):
            assert len({row["indexWriter"][name] for row in observations}) == 1
        independently_meets_threshold = all(
            comparisons[key]["medianPairedChangePercent"] <= -5 and
            comparisons[key]["equalWorkChangePercent"] < 0 and
            comparisons[key]["fasterPairs"] >= 2
            for key in ("candidateVersusA", "candidateVersusC"))
        assert independently_meets_threshold == checked["meetsMaterialityAndDirectionThreshold"]
        cells.append({"dictionary": dictionary, "archive": {"path": archive.name, "bytes": archive.stat().st_size,
                        "sha256": digest(archive), "githubArtifactId": github["id"], "rawMembers": len(members)}, "browserVersion": checked["browserVersion"],
                      "sourceTermBankCount": len(source_banks), "sourceTermBankBytes": source_bank_bytes,
                      "sourceMediaProbeBytes": 0 if media is None else sum(probe["bytes"] for probe in media),
                      "semanticDigestSha256": checked["semanticDigestSha256"], "semanticEntryCount": checked["semanticEntryCount"],
                      "mediaProbesPerReadback": 0 if media is None else len(media), "layoutDifferences": [],
                      "observations": observations, "comparisons": comparisons, "allMetricComparisons": all_comparisons,
                      "meetsDiscoveryThreshold": checked["meetsMaterialityAndDirectionThreshold"],
                      "expectedCandidateIndexWorkerFiles": EXPECTED_WORKER_FILES[dictionary],
                      "expectedSourceCrcCoverageBytes": EXPECTED_CRC_BYTES[dictionary],
                      "packageDifferences": checked["packageDifferences"],
                      "packages": checked["packages"],
                      "packageMemberCounts": {arm: len(packages[arm]) for arm in "AB"},
                      "packageMemberMapSha256": {arm: hashlib.sha256(json.dumps(packages[arm], sort_keys=True, separators=(",", ":")).encode()).hexdigest() for arm in "AB"},
                      "harnessFileSha256": checked["harnessFileSha256"]})
    ordinary_imports = sum(len(cell["observations"]) for cell in cells)
    measured_imports = sum(row["kind"] == "measured" for cell in cells for row in cell["observations"])
    assert ordinary_imports == 12 * len(dictionaries) and measured_imports == 9 * len(dictionaries)
    assert readback_states == 24 * len(dictionaries) and sampled_responses == 288 * len(dictionaries)
    assert media_byte_probes == 24 * sum({"jmdict": 0, "jitendex": 236, "vndb": 5}[dictionary] for dictionary in dictionaries)
    qualifying_corpora = [cell["dictionary"] for cell in cells if cell["meetsDiscoveryThreshold"]]
    apparent_regressions = [cell["dictionary"] for cell in cells if any(
        cell["comparisons"][key]["medianPairedChangePercent"] >= 5
        for key in ("candidateVersusA", "candidateVersusC"))]
    complete = tuple(dictionaries) == CORPORA
    promising = complete and bool(qualifying_corpora) and not apparent_regressions
    if complete:
        assert len({json.dumps(cell["harnessFileSha256"], sort_keys=True) for cell in cells}) == 1
        for arm in "AB":
            # The protocol compares complete uncompressed member maps across
            # independently built cells. Retain each container digest without
            # imposing byte-identical ZIP-container serialization.
            assert len({cell["packageMemberMapSha256"][arm] for cell in cells}) == 1
    decision = ("Promising discovery screen: VNDB meets the predeclared materiality and direction gates against both controls, and no corpus reaches the 5% paired-median regression screen. Advance only to a separately frozen next study; this discovery does not qualify a production speed claim." if promising else
                "Hold cross-corpus qualification: the complete discovery does not satisfy the materiality and cross-corpus regression screen. Retain every tail and the complete fixed schedule; do not retry, extend, subtract control drift, or claim production qualification.")
    if not complete:
        decision = "Partial audit of completed cells only; await the other fixed cells before a campaign decision."
    return {"schemaVersion": 1, "workflowRun": RUN, "workflowUrl": "https://github.com/ManabiIO/manabitan/actions/runs/" + RUN,
            "harnessSha": HARNESS, "harnessTree": HARNESS_TREE, "baselineSha": BASELINE, "candidateSha": CANDIDATE, "candidateTree": CANDIDATE_TREE, "completeCampaign": complete,
            "workflowJobs": [{"id": job["id"], "name": job["name"], "conclusion": job["conclusion"]} for job in jobs],
            "ordinaryImports": ordinary_imports, "measuredImports": measured_imports, "excludedWarmups": ordinary_imports - measured_imports,
            "completeSampledResponsesChecked": sampled_responses, "preAndPostRestartStates": readback_states,
            "sourceMediaByteProbesChecked": media_byte_probes,
            "fullUnitSuite": verify_unit_receipt(verifier.parent),
            "qualifyingCorpora": qualifying_corpora, "apparentMaterialRegressions": apparent_regressions,
            "screenPromising": promising, "decision": decision,
            "retention": "Every GitHub-digest-verified ZIP member and acquired observation is retained and byte-verified. No import was rerun, replaced or removed. Source archives independently match their locks; all 236 referenced Jitendex images and five VNDB references are rederived from the originals. Complete semantic/provenance verifier reproduces the original receipts; Python independently recomputes timing from raw browser timestamps and all paired arithmetic. Every candidate observation matches the predeclared worker-file count: zero for JMdict/Jitendex and two for VNDB; the baseline excludes its modules and lacks the new counter, retained as null. Queue maxima remain below even the 24 MiB low-memory budget; byte totals and write-call counts remain unchanged. Candidate source CRC coverage matches the separately predeclared 0/0/4,267,992,967-byte split, independently checked against original ZIP term-bank metadata. Source CRC time is nested in parse-bank time and must not be added. The exact eleven product differences are checked against frozen Git blobs. Compare only within this runner cohort; no total-memory or isolated worker-startup claim.",
            "cells": cells}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifacts", type=Path)
    parser.add_argument("--node", default="node")
    parser.add_argument("--fixtures", required=True, type=Path)
    parser.add_argument("--dictionary", choices=CORPORA, help="Audit one completed cell without claiming a complete campaign")
    parser.add_argument("--output", type=Path, default=Path(__file__).with_name("discovery-combined.json"))
    args = parser.parse_args()
    result = audit(args.artifacts.resolve(), args.node, args.fixtures.resolve(), (args.dictionary,) if args.dictionary else CORPORA)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"verified": True, "imports": result["ordinaryImports"], "decision": result["decision"]}))
