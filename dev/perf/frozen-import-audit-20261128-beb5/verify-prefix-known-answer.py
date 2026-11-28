#!/usr/bin/env python3
"""Validate new audit code against retained, independently audited old receipts."""
import argparse
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("fixed_acquisition", HERE / "acquire-and-audit.py")
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)

def same(a, b, label):
    assert json.dumps(a, sort_keys=True, allow_nan=False) == json.dumps(b, sort_keys=True, allow_nan=False), label

def derived_same(actual, expected, label, units):
    tolerance = 1e-9 if units == "milliseconds" else 1e-10
    if isinstance(expected, list):
        assert isinstance(actual, list) and len(actual) == len(expected), label
        return max((derived_same(a, b, label, units) for a, b in zip(actual, expected)), default=0.0)
    assert type(actual) in (int, float) and type(expected) in (int, float), label
    assert math.isfinite(actual) and math.isfinite(expected)
    difference = abs(actual - expected)
    assert difference <= tolerance, f"{label}: derived arithmetic differs by {difference}"
    return difference

def comparison_same(actual, expected, label):
    assert set(actual) == set(expected) == {"treatment", "control"}
    maxima = {"milliseconds": 0.0, "percentagePoints": 0.0}
    for kind in ("treatment", "control"):
        assert set(actual[kind]) == set(expected[kind])
        for field, value in expected[kind].items():
            if field == "alternateFasterPairs":
                assert actual[kind][field] == value
            else:
                units = "milliseconds" if field == "pairTotals" else "percentagePoints"
                difference = derived_same(actual[kind][field], value, label + "/" + kind + "/" + field, units)
                maxima[units] = max(maxima[units], difference)
    return maxima

def blob(data):
    return hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()

def verify(source, baseline, evidence, output):
    registration = helper.verify_registration()
    same(registration["knownAnswerDerivedTolerances"],
         {"milliseconds": 1e-9, "percentagePoints": 1e-10, "rawReceiptValues": "exact"},
         "Registered arithmetic tolerance")
    assert helper.git(evidence, "rev-parse", "HEAD") == "a355146b6c511f8ccdea3fd7fa60af9c450d904f"
    assert helper.git(evidence, "rev-parse", "HEAD^{tree}") == "bbf0af49d23df4a14b1b280fe0df7775220419d9"
    retained = evidence / "dev/perf/import-round-20261128-beb5/prefix-component"
    known_bytes = (retained / "independent-audit.json").read_bytes()
    assert blob(known_bytes) == "03a0efff5529523183fe92997b0946ff98e7d622"
    known = json.loads(known_bytes)
    assert known["complete"] is True
    assert known["sourceCommit"] == "47f3c3262931d0a92728c72fcd5cfb9b0ccc49a0"
    assert known["sourceTree"] == "023368b2731c17c91f16cd740d868ae2ebafa27b"
    assert [row["dictionary"] for row in known["reports"]] == ["jmdict", "jitendex", "vndb"]
    expected_blobs = {
        "jmdict": "23e501234b4800e030d6d4c3b3268cc06c8ba4ed",
        "jitendex": "8ddf1cf2cbc7a881aa0e054f6a6ea0a1a07baac2",
        "vndb": "72d4f0727d724e9d73277eb910a292e14be6c179",
    }
    output.mkdir(parents=True)
    cases = []
    total_journal_entries = 0
    reference_projection = None
    reference_oracles = {}
    for old in known["reports"]:
        dictionary = old["dictionary"]
        folder = output / dictionary
        folder.mkdir()
        case = {"dictionary": dictionary, "complete": False}
        try:
            archive = retained / (dictionary + ".zip")
            assert helper.file_sha(archive) == old["artifactSha256"]
            assert blob(archive.read_bytes()) == expected_blobs[dictionary]
            location = folder / "original-members"
            census = helper.extract_and_census(archive, location)
            helper.write(folder / "archive-members.json", census)
            assert sum(not row["directory"] for row in census) == old["verifiedRawMembers"]
            destination = folder / "reconstructed-audit.json"
            command = [
                sys.executable, str(HERE / "audit-recent-first.py"), str(location),
                "--profile", "prefix-first-known-answer", "--source-root", str(source),
                "--baseline-root", str(baseline), "--dictionary", dictionary, "--out", str(destination),
            ]
            run = subprocess.run(command, capture_output=True, text=True, check=False)
            (folder / "audit.stdout.log").write_text(run.stdout)
            (folder / "audit.stderr.log").write_text(run.stderr)
            if run.returncode != 0:
                helper.print_diagnostic(dictionary, "known-answer", run.stderr, run.stdout)
            assert run.returncode == 0, "New auditor rejected a retained original corpus"
            new = helper.read(destination)
            assert new["complete"] is True and new["profile"] == "prefix-first-known-answer"
            assert new["oracleComparisons"] == 242
            oracle_path = location / "oracle.json"
            oracle = helper.read(oracle_path)
            projection = [{key: row[key] for key in ("case", "variant", "rows", "error", "digest")}
                          for row in oracle["observations"]]
            if reference_projection is None:
                reference_projection = projection
            else:
                same(projection, reference_projection, "Original baseline oracle projections agree across all three corpora")
            reference_oracles[dictionary] = {
                "path": str(oracle_path.relative_to(output)),
                "sha256": helper.file_sha(oracle_path),
                "baselineProjectionSha256": helper.sha(helper.encoded(projection).encode()),
            }
            assert new["packageEntryCount"] == old["packageEntryCount"]
            assert [row["file"] for row in new["reports"]] == [row["file"] for row in old["reports"]]
            comparisons = []
            for a, b in zip(new["reports"], old["reports"]):
                assert a["sha256"] == b["sha256"]
                assert a["exactJournalEntries"] == b["exactJournalEntries"]
                assert len(a["dictionaries"]) == len(b["dictionaries"])
                for actual, expected in zip(a["dictionaries"], b["dictionaries"]):
                    for key in ("dictionary", "rows", "groups"):
                        assert actual[key] == expected[key]
                    assert actual["diagnostics"]["baseline"]["floatScoreGroups"] == expected["floatScoreGroupsInSynchronousReplay"]
                    comparison_same(actual["comparisons"], expected["comparisons"],
                                    f"{dictionary}/{a['file']}/{actual['dictionary']}")
                comparisons.append({
                    "file": a["file"], "exactJournalEntries": a["exactJournalEntries"],
                    "sha256": a["sha256"], "derivedArithmeticWithinRegisteredTolerance": True,
                })
            total_journal_entries += new["exactJournalEntries"]
            case.update({"complete": True, "reports": comparisons, "oracleComparisons": 242})
        except Exception as error:
            case["failure"] = {"type": type(error).__name__, "error": helper.redact(error)}
        cases.append(case)
    result = {
        "complete": all(case["complete"] for case in cases) and total_journal_entries == 5661,
        "knownAnswerOnly": True, "noNewMeasurements": True,
        "sourceCommit": known["sourceCommit"], "sourceTree": known["sourceTree"],
        "retainedEvidenceCommit": "a355146b6c511f8ccdea3fd7fa60af9c450d904f",
        "originalIndependentAuditGitBlob": "03a0efff5529523183fe92997b0946ff98e7d622",
        "originalIndependentAuditSha256": helper.sha(known_bytes),
        "newAuditorSha256": helper.file_sha(HERE / "audit-recent-first.py"),
        "exactJournalEntries": total_journal_entries,
        "referenceOracles": reference_oracles,
        "baselineOracleProjectionSha256": helper.sha(helper.encoded(reference_projection).encode()) if reference_projection is not None else None,
        "cases": cases,
        "derivedArithmeticTolerance": registration["knownAnswerDerivedTolerances"],
        "schemaDifferences": "New reports add explicit source/profile/origin, diagnostics and journal digests. Raw receipt values, source/output identities, counts and protocol gates remain exact. Only derived pair sums allow absolute 1e-9 ms and derived percentages absolute 1e-10 percentage points for Python-version rounding. The new auditor is not represented as recovered original code.",
    }
    helper.write(output / "known-answer.json", result)
    print("PREFIX_KNOWN_ANSWER " + helper.encoded(result), flush=True)
    return result["complete"]

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--baseline-root", type=Path, required=True)
    parser.add_argument("--evidence-root", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    sys.exit(0 if verify(args.source_root.resolve(), args.baseline_root.resolve(),
                         args.evidence_root.resolve(), args.out.resolve()) else 1)
