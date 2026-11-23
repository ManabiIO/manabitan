#!/usr/bin/env python3
"""Independently audit the retained large-source I/O-worker discovery without rerunning imports."""

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import stat
import statistics
import subprocess
import zipfile


RUN = "45127809761"
HARNESS = "fdeb101730347cc4f657406ab82c3c5f6e16d0f1"
BASELINE = "5e1f8c12f7ff798ba407323aff675cb23b22af02"
CANDIDATE = "7b6f5115f8d837a035c34ba395c9cb63b4eca39a"
EXPECTED_WORKER_FILES = {"jmdict": 0, "jitendex": 0, "vndb": 2}


def digest(path):
    hasher = hashlib.sha256()
    with path.open("rb") as source:
        while data := source.read(4 * 1024 * 1024):
            hasher.update(data)
    return hasher.hexdigest()


def read(path):
    return json.loads(path.read_text())


def audit(root, node, fixtures):
    verifier = Path(__file__).with_name("verify.mjs").resolve()
    repository = verifier.parents[3]
    frozen_hashes = {}
    jobs = read(root / "workflow-jobs.github.json")["jobs"]
    assert {job["name"] for job in jobs} == {"plan", "compare (jmdict, 1)", "compare (jitendex, 1)", "compare (vndb, 1)"}
    assert all(job["run_id"] == int(RUN) and job["status"] == "completed" and job["conclusion"] == "success" for job in jobs)
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
    for dictionary in ("jmdict", "jitendex", "vndb"):
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
        fixture = plan["fixture"]
        source = fixtures / fixture["cacheFile"]
        assert source.stat().st_size == fixture["sizeBytes"] and digest(source) == fixture["sha256"]
        media = read(evidence / "media-reference.json")
        assert runner.media_reference(source, fixture) == media
        assert (0 if media is None else len(media)) == {"jmdict": 0, "jitendex": 236, "vndb": 5}[dictionary]
        with zipfile.ZipFile(source) as source_zip:
            source_banks = [entry for entry in source_zip.infolist() if re.fullmatch(r"term_bank_[0-9]+\.json", entry.filename)]
            source_bank_bytes = sum(entry.file_size for entry in source_banks)
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
            assert duration == expected["metrics"]["totalImportMs"]
            for state_name in ("preRestart", "postRestart"):
                state = raw["benchmark"]["readbackDiagnostics"][state_name]
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
            parser_profile = {name: parser_profiles[0][name] for name in
                              ("parserParallelWorkerWallMs", "parserSourceInflateMs", "parserParseBankMs", "sourceArchiveReadMs")}
            observations.append({**item, "totalImportMs": duration, "phaseMetrics": expected["metrics"],
                                 "indexWriter": index_writer, "parserProfile": parser_profile,
                                 "reportSha256": digest(directory / "run-1.json"),
                                 "summarySha256": digest(directory / "summary.json")})
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
                      "observations": observations, "comparisons": comparisons,
                      "meetsDiscoveryThreshold": checked["meetsMaterialityAndDirectionThreshold"],
                      "expectedCandidateIndexWorkerFiles": EXPECTED_WORKER_FILES[dictionary]})
    ordinary_imports = sum(len(cell["observations"]) for cell in cells)
    measured_imports = sum(row["kind"] == "measured" for cell in cells for row in cell["observations"])
    assert ordinary_imports == 36 and measured_imports == 27
    assert readback_states == 72 and sampled_responses == 864
    assert media_byte_probes == 5784
    qualifying_corpora = [cell["dictionary"] for cell in cells if cell["meetsDiscoveryThreshold"]]
    apparent_regressions = [cell["dictionary"] for cell in cells if any(
        cell["comparisons"][key]["medianPairedChangePercent"] >= 5
        for key in ("candidateVersusA", "candidateVersusC"))]
    promising = "vndb" in qualifying_corpora and not apparent_regressions
    decision = ("Promising discovery screen: VNDB meets the predeclared materiality and direction gates against both controls, and no corpus reaches the 5% paired-median regression screen. Advance only to a separately frozen next study; this discovery does not qualify a production speed claim." if promising else
                "Hold cross-corpus qualification: a passing VNDB materiality screen does not resolve the other corpora's apparent regressions or control instability. Retain every tail and the complete fixed schedule; do not retry, extend, subtract control drift, or claim production qualification.")
    return {"schemaVersion": 1, "workflowRun": RUN, "workflowUrl": "https://github.com/ManabiIO/manabitan/actions/runs/" + RUN,
            "harnessSha": HARNESS, "baselineSha": BASELINE, "candidateSha": CANDIDATE,
            "workflowJobs": [{"id": job["id"], "name": job["name"], "conclusion": job["conclusion"]} for job in jobs],
            "ordinaryImports": ordinary_imports, "measuredImports": measured_imports, "excludedWarmups": ordinary_imports - measured_imports,
            "completeSampledResponsesChecked": sampled_responses, "preAndPostRestartStates": readback_states,
            "sourceMediaByteProbesChecked": media_byte_probes,
            "qualifyingCorpora": qualifying_corpora, "apparentMaterialRegressions": apparent_regressions,
            "screenPromising": promising, "decision": decision,
            "retention": "Every GitHub-digest-verified ZIP member and acquired observation is retained and byte-verified. No import was rerun, replaced or removed. Source archives independently match their locks; all 236 referenced Jitendex images and five VNDB references are rederived from the originals. Complete semantic/provenance verifier reproduces the original receipts; Python independently recomputes timing from raw browser timestamps and all paired arithmetic. Every candidate observation matches the predeclared worker-file count: zero for JMdict/Jitendex and two for VNDB; the baseline excludes its modules and lacks the new counter, retained as null. Queue maxima remain below even the 24 MiB low-memory budget; byte totals and write-call counts remain unchanged. Compare only within this runner cohort; no total-memory or isolated worker-startup claim.",
            "cells": cells}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifacts", type=Path)
    parser.add_argument("--node", default="node")
    parser.add_argument("--fixtures", required=True, type=Path)
    parser.add_argument("--output", type=Path, default=Path(__file__).with_name("discovery-large-io.json"))
    args = parser.parse_args()
    result = audit(args.artifacts.resolve(), args.node, args.fixtures.resolve())
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"verified": True, "imports": result["ordinaryImports"], "decision": result["decision"]}))
