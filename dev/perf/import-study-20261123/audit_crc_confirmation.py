#!/usr/bin/env python3
"""Independently audit both fixed source-CRC confirmations without rerunning imports."""

import argparse
import hashlib
import importlib.util
import itertools
import json
from pathlib import Path
import re
import stat
import statistics
import subprocess
import zipfile


RUN = "45123577232"
HARNESS = "66920c41491347811cb917d41e4614339fd95dcc"
BASELINE = "5e1f8c12f7ff798ba407323aff675cb23b22af02"
CANDIDATE = "0d5a05c40410fd97b0b85a2ad5e432dc5507bb33"


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
    fixture_cache = {}
    semantic_by_dictionary = {}
    jobs = read(root / "workflow-jobs.github.json")["jobs"]
    assert {job["name"] for job in jobs} == {"plan"} | {f"compare ({dictionary}, {replication})"
            for dictionary, replication in itertools.product(("jmdict", "jitendex", "vndb"), (1, 2))}
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
    for dictionary, replication in itertools.product(("jmdict", "jitendex", "vndb"), (1, 2)):
        name = f"import-study-{dictionary}-{replication}-attempt-1"
        extracted = root / name
        evidence = extracted / dictionary / str(replication)
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
        assert plan["config"]["stage"] == "confirmation" and plan["replication"] == replication
        assert plan["config"]["confirmationOf"] == "https://github.com/ManabiIO/manabitan/actions/runs/45122637633"
        for name, expected_hash in plan["sourceFiles"].items():
            if name not in frozen_hashes:
                content = subprocess.check_output(["git", "show", f"{HARNESS}:{name}"], cwd=repository)
                frozen_hashes[name] = hashlib.sha256(content).hexdigest()
            assert frozen_hashes[name] == expected_hash
        assert checked["layoutDifferences"] == []
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
            assert duration == expected["metrics"]["totalImportMs"]
            for state_name in ("preRestart", "postRestart"):
                state = raw["benchmark"]["readbackDiagnostics"][state_name]
                readback_states += 1
                sampled_responses += len(state["semanticProbes"])
                media_byte_probes += 0 if media is None else len(media)
            profiles = [phase["details"] for phase in phases[0]["data"]["importDebug"]["importerPhaseTimings"]
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
                    assert source_crc["parserSourceCrcScannedBytes"] + source_crc["parserSourceCrcReusedBytes"] == source_bank_bytes
                    assert source_crc["parserSourceCrcReusedBytes"] > 0
                    assert 0 < source_crc["parserSourceCrcReusedGlossaryCount"] <= fixture["termRows"]
                else:
                    assert all(source_crc[name] == 0 for name in diagnostic_names if "Crc" in name)
            observations.append({**item, "totalImportMs": duration, "phaseMetrics": expected["metrics"],
                                 "sourceCrc": source_crc,
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
                      "meetsConfirmationThreshold": meets_threshold, "materialRegressionScreen": regression_screen})
    ordinary_imports = sum(len(cell["observations"]) for cell in cells)
    measured_imports = sum(row["kind"] == "measured" for cell in cells for row in cell["observations"])
    assert ordinary_imports == 126 and measured_imports == 108
    assert readback_states == 252 and sampled_responses == 3024
    assert media_byte_probes == 20244
    target_cells = [cell for cell in cells if cell["dictionary"] == "vndb"]
    assert len(target_cells) == 2 and not any(cell["meetsConfirmationThreshold"] for cell in target_cells)
    assert not any(cell["materialRegressionScreen"] for cell in cells)
    for metric in ("parserSourceCrcScannedBytes", "parserSourceCrcReusedBytes", "parserSourceCrcReusedGlossaryCount"):
        assert len({row["sourceCrc"][metric] for cell in target_cells for row in cell["observations"] if row["arm"] == "B"}) == 1
    return {"schemaVersion": 1, "workflowRun": RUN, "workflowUrl": "https://github.com/ManabiIO/manabitan/actions/runs/" + RUN,
            "harnessSha": HARNESS, "baselineSha": BASELINE, "candidateSha": CANDIDATE,
            "workflowJobs": [{"id": job["id"], "name": job["name"], "conclusion": job["conclusion"]} for job in jobs],
            "ordinaryImports": ordinary_imports, "measuredImports": measured_imports, "excludedWarmups": ordinary_imports - measured_imports,
            "completeSampledResponsesChecked": sampled_responses, "preAndPostRestartStates": readback_states,
            "sourceMediaByteProbesChecked": media_byte_probes,
            "qualificationStatus": "HOLD",
            "decision": "HOLD: both independent VNDB replications fail the predeclared 5% median-improvement requirement against both controls. Direction criteria pass, correctness passes, and no corpus has a material-regression screen, but those findings do not replace materiality. Do not extend or retry this fixed campaign, pool replications to rescue the gate, or present parser component gains as a qualified whole-import gain.",
            "retention": "Every GitHub-digest-verified ZIP member and all 126 acquired observations are retained and byte-verified, including 18 predeclared warmups. No import was rerun, replaced or removed. Source archives independently match their locks; all 236 referenced Jitendex images and five VNDB references are rederived from the originals. Complete semantic/provenance verifier reproduces every original receipt, with matching semantic digests across replications. Python independently recomputes raw browser durations, each six-pair statistic, control spread, and the fixed gate separately by replication. Source CRC time is nested in parse-bank time; absent baseline counters remain null.",
            "cells": cells}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifacts", type=Path)
    parser.add_argument("--node", default="node")
    parser.add_argument("--fixtures", required=True, type=Path)
    parser.add_argument("--output", type=Path, default=Path(__file__).with_name("confirmation-crc.json"))
    args = parser.parse_args()
    result = audit(args.artifacts.resolve(), args.node, args.fixtures.resolve())
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"verified": True, "imports": result["ordinaryImports"], "decision": result["decision"]}))
