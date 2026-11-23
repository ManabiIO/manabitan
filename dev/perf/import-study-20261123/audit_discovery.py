#!/usr/bin/env python3
"""Independently audit the retained 16 MiB discovery without rerunning imports."""

import argparse
import hashlib
import json
from pathlib import Path
import statistics
import subprocess
import zipfile


RUN = "45119016466"
HARNESS = "6427e3d801f797271cd1e68b038f9babe13ac18d"
BASELINE = "5e1f8c12f7ff798ba407323aff675cb23b22af02"
CANDIDATE = "e31032d575e329e6021b96359a74e825707004b3"


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
    script = ("import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs'; "
              "import {pathToFileURL} from 'node:url'; "
              "const {verifyStudy}=await import(pathToFileURL(process.argv[2])); "
              "const result=verifyStudy(process.argv[3]); "
              "assert.deepEqual(result,JSON.parse(readFileSync(process.argv[3]+'/result.json','utf8'))); "
              "console.log(JSON.stringify(result))")
    cells = []
    readback_states = 0
    sampled_responses = 0
    for dictionary in ("jmdict", "jitendex", "vndb"):
        name = f"import-study-{dictionary}-1-attempt-1"
        extracted = root / name
        evidence = extracted / dictionary / "1"
        archive = root / (name + ".zip")
        with zipfile.ZipFile(archive) as package:
            members = [entry for entry in package.infolist() if not entry.is_dir()]
            assert len({entry.filename for entry in members}) == len(members)
            for entry in members:
                relative = Path(entry.filename)
                assert not relative.is_absolute() and ".." not in relative.parts
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
        assert checked["layoutDifferences"] == []
        fixture = plan["fixture"]
        source = fixtures / fixture["cacheFile"]
        assert source.stat().st_size == fixture["sizeBytes"] and digest(source) == fixture["sha256"]
        media = read(evidence / "media-reference.json")
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
            observations.append({**item, "totalImportMs": duration, "phaseMetrics": expected["metrics"],
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
                      "fasterPairs": sum(change < 0 for change in changes)}
            original = checked["comparisons"]["totalImportMs"][key]
            for metric in ("medianPairedChangePercent", "equalWorkChangePercent", "fasterPairs"):
                assert result[metric] == original[metric]
            comparisons[key] = result
        cells.append({"dictionary": dictionary, "archive": {"path": archive.name, "bytes": archive.stat().st_size,
                        "sha256": digest(archive), "rawMembers": len(members)}, "browserVersion": checked["browserVersion"],
                      "semanticDigestSha256": checked["semanticDigestSha256"], "semanticEntryCount": checked["semanticEntryCount"],
                      "mediaProbesPerReadback": 0 if media is None else len(media), "layoutDifferences": [],
                      "observations": observations, "comparisons": comparisons})
    ordinary_imports = sum(len(cell["observations"]) for cell in cells)
    measured_imports = sum(row["kind"] == "measured" for cell in cells for row in cell["observations"])
    assert ordinary_imports == 36 and measured_imports == 27
    assert readback_states == 72 and sampled_responses == 864
    return {"schemaVersion": 1, "workflowRun": RUN, "workflowUrl": "https://github.com/ManabiIO/manabitan/actions/runs/" + RUN,
            "harnessSha": HARNESS, "baselineSha": BASELINE, "candidateSha": CANDIDATE,
            "ordinaryImports": ordinary_imports, "measuredImports": measured_imports, "excludedWarmups": ordinary_imports - measured_imports,
            "completeSampledResponsesChecked": sampled_responses, "preAndPostRestartStates": readback_states,
            "decision": "Do not advance unconditional 16 MiB flushing to confirmation or production: VNDB meets the materiality screen, but JMdict has an unresolved material regression versus C and broad A/C variation; Jitendex has no material gain.",
            "retention": "Every ZIP member and acquired observation is retained and byte-verified. No import was rerun, replaced or removed. Source archives independently match their locks. Complete semantic/provenance verifier reproduces the original receipts; Python independently recomputes timing from raw browser timestamps and all paired arithmetic.",
            "cells": cells}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifacts", type=Path)
    parser.add_argument("--node", default="node")
    parser.add_argument("--fixtures", required=True, type=Path)
    parser.add_argument("--output", type=Path, default=Path(__file__).with_name("discovery-16mib.json"))
    args = parser.parse_args()
    result = audit(args.artifacts.resolve(), args.node, args.fixtures.resolve())
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"verified": True, "imports": result["ordinaryImports"], "decision": result["decision"]}))
