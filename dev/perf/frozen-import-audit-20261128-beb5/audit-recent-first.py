#!/usr/bin/env python3
"""New post-experiment auditor reconstructed from frozen recent-first protocol.

This is not the unavailable original prefix-first auditor. It reads existing
observations only and never invokes the parser or a timing runner.
"""
import argparse
import hashlib
import json
import math
import re
from pathlib import Path
import statistics
import subprocess

BASELINE = "9e10d3b3fcf66d344ab31bc42c9b522fa5215da2"
SOURCE = "633761548509a77b43b414b83a80033e17ed7399"
TREE = "db21a53519b602b29234cb535cc59cead5118494"
RUNTIME = "1a935bddf29c4d87606d2facd4b168af7e1a40f1"
REGISTRATION_SHA = "d7cfbc8ce454a3535193a87da9cb4c7ec69211237a8168d911fb3f4725ff8b35"
WASM = {
    "baseline": "8ae00698649c5a3e41039b13c5ffe1dff2d4e69948cba2e3c063f381250031ee",
    "candidate": "9fa76a9037b5874ecebeb59adea2e96f6603266a0dc4d12409175b1da5f697d3",
}
GROUPS = {"jmdict": 12, "jitendex": 22, "vndb": 170}
STUDY = "dev/perf/whole-glossary-prefix-followup-20261128"
PROFILE = "recent-first"
SCOPE = (
    "Sequential group-by-group warm synchronous component work. No import or "
    "parser reruns, prior-host pooling, control subtraction, trimming, or "
    "independent cold-start claim. VNDB synchronous options and fallback counts "
    "do not establish production worker activation. Original release ZIP bytes "
    "are absent; package-member hash maps are audited, not rehashed release ZIPs."
)

def sha(data):
    return hashlib.sha256(data).hexdigest()

def read(path):
    return json.loads(path.read_text(), parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))

def same(a, b, label):
    assert json.dumps(a, sort_keys=True, allow_nan=False) == json.dumps(b, sort_keys=True, allow_nan=False), label

def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()

def finite_positive(value, label):
    assert type(value) in (int, float) and math.isfinite(value) and value > 0, label

def nonnegative(value, label):
    assert type(value) in (int, float) and math.isfinite(value) and value >= 0, label

def hash_file(root, name):
    return sha((root / name).read_bytes())

def audit_identities(location, source, baseline):
    assert git(source, "rev-parse", "HEAD") == SOURCE
    assert git(source, "rev-parse", "HEAD^{tree}") == TREE
    assert git(baseline, "rev-parse", "HEAD") == BASELINE
    if PROFILE == "recent-first":
        registration_bytes = (source / STUDY / "registration.json").read_bytes()
        assert sha(registration_bytes) == REGISTRATION_SHA
        assert (location / "registration.json").read_bytes() == registration_bytes
        registration = json.loads(registration_bytes)
        assert registration["candidateCommit"] == RUNTIME
        assert registration["candidateTree"] == "99563392c65e4b1655de3e504982b9a0fc496c13"
        for collection in ("sourceSha256", "harnessSha256"):
            for name, expected in registration[collection].items():
                assert hash_file(source, name) == expected, f"Frozen source: {name}"
    else:
        assert PROFILE == "prefix-first-known-answer"
        assert not (location / "registration.json").exists()
        names = [
            "ext/js/dictionary/wasm/term-bank-parser.c",
            "dev/data/dictionary-wasm/term-bank-parser.wasm",
            "dev/data/dictionary-wasm/manifest.json",
            "package-lock.json", "test/perf/dictionaries.lock.json",
        ]
        registration = {
            "sourceSha256": {name: hash_file(source, name) for name in names},
            "harnessSha256": {str(path.relative_to(source)): sha(path.read_bytes())
                              for path in (source / STUDY).iterdir() if path.is_file()},
            "workflow": ".github/workflows/whole-glossary-prefix-screen-beb5.yml",
            "runtimeChangedFiles": sorted(names[:3]),
            "packageChangedEntries": ["js/dictionary/wasm/term-bank-parser.c", "lib/term-bank-parser.wasm"],
            "syntheticCases": ["unique-prefixes", "common-prefix-unique-middles", "short-unique", "nonlocal-reuse"],
        }
        registration["workflowSha256"] = hash_file(source, registration["workflow"])
    assert hash_file(source, registration["workflow"]) == registration["workflowSha256"]
    assert (location / "source-sha.txt").read_text().strip() == SOURCE
    assert (location / "source-tree.txt").read_text().strip() == TREE
    identity = read(location / "identities.json")
    assert identity["complete"] is True
    if PROFILE == "recent-first":
        same(identity["registration"], registration, "Embedded registration")
        assert identity["registrationSha256"] == REGISTRATION_SHA
    assert identity["workflowSha256"] == registration["workflowSha256"]
    expected_harness = {Path(name).name: expected for name, expected in registration["harnessSha256"].items()}
    if PROFILE == "recent-first":
        expected_harness["registration.json"] = REGISTRATION_SHA
    same(identity["harness"], expected_harness, "Complete harness census")
    same(identity["changedProductSources"], registration["runtimeChangedFiles"], "Product source allowlist")
    same(identity["changedPackageEntries"], registration["packageChangedEntries"], "Package allowlist")
    expected_roots = {"baseline": baseline, "candidate": source}
    for arm, root in expected_roots.items():
        value = identity["arms"][arm]
        assert value["commit"] == (BASELINE if arm == "baseline" else SOURCE)
        assert value["tree"] == git(root, "rev-parse", "HEAD^{tree}")
        for name, expected in value["sources"].items():
            assert hash_file(root, name) == expected, f"{arm} source {name}"
        expected_files = set(registration["sourceSha256"])
        assert set(value["sources"]) == expected_files
        assert value["entries"]["lib/term-bank-parser.wasm"] == WASM[arm]
        assert value["entries"]["js/dictionary/wasm/term-bank-parser.c"] == hash_file(root, "ext/js/dictionary/wasm/term-bank-parser.c")
        assert value["nativeModuleBytes"] == (root / "dev/data/dictionary-wasm/term-bank-parser.wasm").stat().st_size
        assert len(value["packageSha256"]) == 64 and value["packageBytes"] > 0
    a, b = identity["arms"]["baseline"]["entries"], identity["arms"]["candidate"]["entries"]
    assert set(a) == set(b)
    assert sorted(name for name in a if a[name] != b[name]) == registration["packageChangedEntries"]
    return registration, identity

def compare_totals(totals):
    output = {}
    for kind, pairs in totals.items():
        ratios = [(b / a - 1) * 100 for a, b in pairs]
        output[kind] = {
            "pairTotals": pairs,
            "pairedPercentChanges": ratios,
            "medianPairedPercentChange": statistics.median(ratios),
            "equalWorkPercentChange": (sum(b for a, b in pairs) / sum(a for a, b in pairs) - 1) * 100,
            "alternateFasterPairs": sum(value < 0 for value in ratios),
        }
    return output

def audit_report(path, dictionary, mode, registration, source, baseline, fixture):
    data = read(path)
    assert data["complete"] is True and "failure" not in data
    pairs = 3 if mode == "disabled" else 6
    assert data["pairs"] == pairs
    assert data["maxGroups"] == (1 if mode == "disabled" else 0)
    assert data["synthetic"] is (mode == "synthetic")
    same(data["experiments"], {"experimentalValidatedGlossaryReuse": False} if mode == "disabled" else {}, "Experimental flags")
    same(data["grouping"], {"parserWorkers": 3, "targetBytes": 25165824, "executionConcurrency": 1}, "Grouping")
    assert data["node"] == "v22.22.0"
    assert data["lockSha256"] == registration["sourceSha256"]["test/perf/dictionaries.lock.json"]
    assert data["runnerSha256"] == registration["harnessSha256"][STUDY + "/replay.mjs"]
    assert data["negativeFixtureHelperSha256"] == registration["harnessSha256"][STUDY + "/negative-fixtures.mjs"]
    sources = data["sources"]
    same(sources["baseline"]["hashes"], sources["control"]["hashes"], "Identical-code control")
    expected_files = {
        "ext/js/dictionary/term-bank-wasm-parser.js",
        "ext/js/dictionary/term-bank-experiments.js",
        "ext/js/dictionary/term-record-preinterned-plan.js",
        "ext/js/dictionary/term-lookup-index-preparation.js",
        "ext/js/dictionary/term-lookup-index.js",
        "ext/js/dictionary/dense-zip-directory.js",
        "ext/js/dictionary/term-bank-source-pipeline.js",
        "ext/js/media/media-util.js",
        "ext/lib/term-bank-parser.wasm",
        "ext/js/dictionary/wasm/term-bank-parser.c",
        "dev/data/dictionary-wasm/manifest.json",
    }
    for arm in ("baseline", "candidate", "control"):
        root = source if arm == "candidate" else baseline
        assert set(sources[arm]["hashes"]) == expected_files
        for name, expected in sources[arm]["hashes"].items():
            actual_name = "dev/data/dictionary-wasm/term-bank-parser.wasm" if name == "ext/lib/term-bank-parser.wasm" else name
            assert hash_file(root, actual_name) == expected, f"{arm} parser source {name}"
        assert sources[arm]["moduleBytes"] == (root / "dev/data/dictionary-wasm/term-bank-parser.wasm").stat().st_size
        nonnegative(sources[arm]["compileMs"], "Excluded compilation duration")
    expected_names = registration["syntheticCases"] if mode == "synthetic" else [dictionary]
    assert [row["dictionary"] for row in data["dictionaries"]] == expected_names
    journal_path = path.with_name(path.name + ".observations.jsonl")
    journal = [json.loads(line) for line in journal_path.read_text().splitlines()]
    reconstructed = []
    results = []
    invocation = 0
    for item in data["dictionaries"]:
        name = item["dictionary"]
        count = 1 if mode in ("synthetic", "disabled") else GROUPS[dictionary]
        assert len(item["groups"]) == count
        assert item["totalGroups"] == (1 if mode == "synthetic" else GROUPS[dictionary])
        assert item["banks"] > 0
        if mode == "synthetic":
            assert isinstance(item["syntheticSourceSha256"], str) and len(item["syntheticSourceSha256"]) == 64
            assert isinstance(item["syntheticSpec"], dict) and item["groupsPerWorker"] is None
        else:
            assert item["archiveSha256"] == fixture["sha256"]
            assert item["groupsPerWorker"] == (3 if item["mediaHintFastScan"] else 4)
        totals = {kind: [[0.0, 0.0] for _ in range(pairs)] for kind in ("treatment", "control")}
        diagnostics = {arm: {"rows": 0, "glossaryWitnesses": 0, "contentWitnesses": 0, "fusedFallbacks": 0,
                            "crcReusedBytes": 0, "maxHeapBytes": 0, "floatScoreGroups": 0}
                       for arm in ("baseline", "candidate", "control")}
        rows = 0
        previous_bank = 0
        for index, group in enumerate(item["groups"]):
            assert group["firstInvocation"] is (invocation == 0)
            invocation += 1
            assert group["sourceBytes"] > 0 and group["compressedBytes"] > 0
            first = re.fullmatch(r"term_bank_(\d+)\.json", group["firstBank"])
            last = re.fullmatch(r"term_bank_(\d+)\.json", group["lastBank"])
            assert first and last
            assert int(first[1]) == previous_bank + 1 and int(last[1]) >= int(first[1])
            previous_bank = int(last[1])
            assert previous_bank <= item["banks"]
            verification = group["verification"]
            assert set(verification) == {"baseline", "candidate", "control"}
            reference = verification["baseline"]
            rows += reference["rows"]
            assert type(reference["rows"]) is int and reference["rows"] > 0
            assert len(reference["digest"]) == 64
            def check(value):
                for key in ("digest", "rows", "scoreType", "sequenceType"):
                    same(value[key], reference[key], f"{name}/{index}: {key}")
                for key in ("totalMs", "inflateMs", "parseCopyLookupMs"):
                    finite_positive(value[key], key)
                assert math.isclose(value["totalMs"], value["inflateMs"] + value["parseCopyLookupMs"], abs_tol=1e-7, rel_tol=1e-12)
                if mode == "disabled":
                    assert value["profile"]["validatedGlossaryReuseCount"] == 0
            for arm in ("baseline", "candidate", "control"):
                value = verification[arm]
                check(value)
                reconstructed.append({"context": {"dictionary": name, "group": index, "phase": "verification", "arm": arm}, "observation": value})
                profile, summary = value["profile"], diagnostics[arm]
                summary["rows"] += value["rows"]
                for dst, src in (("glossaryWitnesses", "validatedGlossaryReuseCount"), ("contentWitnesses", "recentContentDedupHitCount"),
                                 ("fusedFallbacks", "fusedParseFallbacks"), ("crcReusedBytes", "sourceCrcReusedBytes")):
                    summary[dst] += profile.get(src, 0)
                summary["maxHeapBytes"] = max(summary["maxHeapBytes"], profile.get("maxWasmHeapBytes", 0))
                summary["floatScoreGroups"] += value["scoreType"] == "Float64Array"
            expected_schedule = []
            for pair in range(pairs):
                for kind in ("treatment", "control") if pair % 2 == 0 else ("control", "treatment"):
                    alternate = "candidate" if kind == "treatment" else "control"
                    order = ["baseline", alternate] if pair % 2 == 0 else [alternate, "baseline"]
                    expected_schedule.append((pair, kind, order))
            assert len(group["observations"]) == len(expected_schedule)
            for observed, (pair, kind, order) in zip(group["observations"], expected_schedule):
                assert observed["pair"] == pair and observed["comparison"] == kind
                same(observed["order"], order, "Within-pair order")
                assert set(observed["arms"]) == set(order)
                for arm in order:
                    value = observed["arms"][arm]
                    check(value)
                    for counter in ("validatedGlossaryReuseCount", "recentContentDedupHitCount", "fusedParseFallbacks", "sourceCrcReusedBytes"):
                        assert value["profile"].get(counter, 0) == verification[arm]["profile"].get(counter, 0), f"Unstable activation: {counter}"
                    reconstructed.append({"context": {"dictionary": name, "group": index, "phase": kind, "pair": pair, "arm": arm}, "observation": value})
                    totals[kind][pair][0 if arm == "baseline" else 1] += value["totalMs"]
            if mode == "synthetic":
                assert verification["baseline"]["profile"]["validatedGlossaryReuseCount"] == 0
                assert verification["control"]["profile"]["validatedGlossaryReuseCount"] == 0
                hits = verification["candidate"]["profile"]["validatedGlossaryReuseCount"]
                assert hits > 9000 if name == "nonlocal-reuse" else hits == 0
        assert rows == item["rows"]
        if mode != "disabled":
            assert previous_bank == item["banks"]
        if mode == "synthetic":
            assert rows == 10000
        elif mode == "main":
            assert rows == fixture["termRows"]
        results.append({"dictionary": name, "rows": rows, "groups": count, "diagnostics": diagnostics, "comparisons": compare_totals(totals)})
    same(journal, reconstructed, "Every ordered raw journal entry must equal the saved report")
    return {"file": path.name, "sha256": sha(path.read_bytes()), "journalSha256": sha(journal_path.read_bytes()),
            "exactJournalEntries": len(journal), "dictionaries": results}

def audit(location, source, baseline, dictionary):
    registration, identities = audit_identities(location, source, baseline)
    fixture = read(source / "test/perf/dictionaries.lock.json")["dictionaries"][dictionary]
    oracle = read(location / "oracle.json")
    assert oracle["complete"] is True and oracle["cases"] == 42 and oracle["comparisons"] == 242
    assert oracle["passedSuccesses"] == 175 and oracle["passedErrors"] == 67
    assert len(oracle["observations"]) == 242
    assert sum(row["error"] is None for row in oracle["observations"]) == 175
    assert len({(row["case"], row["variant"]) for row in oracle["observations"]}) == 242
    assert len(oracle["sources"]) == 2
    for arm, value in zip(("baseline", "candidate"), oracle["sources"]):
        root = baseline if arm == "baseline" else source
        assert value["wasmSha256"] == WASM[arm]
        assert value["cSha256"] == hash_file(root, "ext/js/dictionary/wasm/term-bank-parser.c")
    assert oracle["parserJavascriptSha256"] == hash_file(source, "ext/js/dictionary/term-bank-wasm-parser.js")
    reports = [
        audit_report(location / "screen.json", dictionary, "main", registration, source, baseline, fixture),
        audit_report(location / "reuse-disabled.json", dictionary, "disabled", registration, source, baseline, fixture),
    ]
    if dictionary == "jmdict":
        reports.append(audit_report(location / "enabled-probe-negatives.json", dictionary, "synthetic", registration, source, baseline, fixture))
    else:
        assert not (location / "enabled-probe-negatives.json").exists()
    return {"complete": True, "profile": PROFILE, "dictionary": dictionary, "sourceCommit": SOURCE, "sourceTree": TREE,
            "runtimeCommit": RUNTIME, "registrationSha256": REGISTRATION_SHA, "auditorSha256": sha(Path(__file__).read_bytes()),
            "auditorOrigin": "New reconstruction reviewed after experiment publication; original prefix-first auditor source was unavailable.",
            "sourceAndPackageMemberMapsVerified": True, "originalReleaseZipBytesRehashed": False,
            "packageEntryCount": len(identities["arms"]["baseline"]["entries"]), "oracleComparisons": 242,
            "exactJournalEntries": sum(row["exactJournalEntries"] for row in reports),
            "reports": reports, "scope": SCOPE}

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("artifact_directory", type=Path)
    parser.add_argument("--profile", choices=("recent-first", "prefix-first-known-answer"), default="recent-first")
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--baseline-root", type=Path, required=True)
    parser.add_argument("--dictionary", choices=tuple(GROUPS), required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    PROFILE = args.profile
    if PROFILE == "prefix-first-known-answer":
        SOURCE = "47f3c3262931d0a92728c72fcd5cfb9b0ccc49a0"
        TREE = "023368b2731c17c91f16cd740d868ae2ebafa27b"
        RUNTIME = None
        REGISTRATION_SHA = None
        WASM["candidate"] = "9972fb2df890f77fe43b3401b464c0ff1c36c4b89784b47268e3888bd7979d23"
        STUDY = "dev/perf/whole-glossary-prefix-20261128"
    try:
        result = audit(args.artifact_directory, args.source_root, args.baseline_root, args.dictionary)
    except Exception as error:
        result = {"complete": False, "dictionary": args.dictionary, "type": type(error).__name__, "error": str(error), "scope": SCOPE}
        args.out.write_text(json.dumps(result, indent=2, allow_nan=False) + "\n")
        raise
    args.out.write_text(json.dumps(result, indent=2, allow_nan=False) + "\n")
    print(json.dumps({"complete": True, "dictionary": args.dictionary, "exactJournalEntries": result["exactJournalEntries"]}, sort_keys=True))
