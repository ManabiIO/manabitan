#!/usr/bin/env python3
"""Read-only reconciliation of archived score-validation evidence; no native replay."""

import datetime
import hashlib
import json
import math
import pathlib
import re
import statistics
import sys
import tarfile
import zipfile


def sha(data):
    return hashlib.sha256(data).hexdigest()


def file_sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


if len(sys.argv) != 8:
    raise SystemExit(
        "usage: audit-storage-evidence.py BUNDLE_DIR FIXTURE_RECEIPT FIXTURE_DIR "
        "BASELINE_ROOT CANDIDATE_ROOT NEW_OUTPUT_JSON EXPECTED_INDEX_SHA256"
    )

bundle, fixture_receipt, fixture_dir, baseline, candidate, output = map(
    pathlib.Path, sys.argv[1:7]
)
index_path = bundle / "score-validation-index.json"
index_bytes = index_path.read_bytes()
assert sha(index_bytes) == sys.argv[7], "index identity differs"
index = json.loads(index_bytes)
fixture_bytes = fixture_receipt.read_bytes()
fixtures = json.loads(fixture_bytes)
assert fixtures["lockSha256"] == index["scope"]["lockSha256"]
fixture_map = {item["id"]: item for item in fixtures["fixtures"]}

archive_path = bundle / index["archive"]["path"]
assert archive_path.stat().st_size == index["archive"]["bytes"]
assert file_sha(archive_path) == index["archive"]["sha256"]
with tarfile.open(archive_path, "r:gz") as archive:
    members = archive.getmembers()
    assert all(member.isfile() for member in members)
    assert len({member.name for member in members}) == len(members)
    assert {member.name for member in members} == set(index["archive"]["members"])
    raw = {}
    for member in members:
        data = archive.extractfile(member).read()
        expected = index["archive"]["members"][member.name]
        assert len(data) == member.size == expected["bytes"]
        assert sha(data) == expected["sha256"], member.name
        raw[member.name] = data

runtime_path = index["runtime"]["path"]
assert file_sha(baseline / runtime_path) == index["runtime"]["baselineSha256"]
assert file_sha(candidate / runtime_path) == index["runtime"]["candidateSha256"]
for root in (baseline, candidate):
    assert file_sha(root / "test/perf/dictionaries.lock.json") == index["scope"]["lockSha256"]
    assert file_sha(root / "ext/lib/term-bank-parser.wasm") == index["scope"]["parserWasmSha256"]

plain_runner = bundle / "score-validation-corpus-parity-v2.mjs"
assert plain_runner.read_bytes() == raw["raw/score-validation-corpus-parity-v2.mjs"]
totals = {"rows": 0, "runs": 0, "compactScoreEntries": 0}
corpora = {}
reports = {}
for dictionary, claimed in index["corpora"].items():
    report = json.loads(raw[claimed["receipt"]])
    reports[dictionary] = report
    independent = fixture_map[dictionary]
    assert report["complete"] is True and report["error"] is None
    assert report["dictionary"] == dictionary
    assert report["node"] == index["environment"]["node"]
    assert report["parentSourceSha256"] == index["runtime"]["baselineSha256"]
    assert report["candidateSourceSha256"] == index["runtime"]["candidateSha256"]
    assert report["lockSha256"] == index["scope"]["lockSha256"]
    assert report["parserWasmSha256"] == index["scope"]["parserWasmSha256"]
    assert report["runnerSha256"] == claimed["runnerSha256"] == sha(raw[claimed["runner"]])
    assert report["fixture"]["sha256"] == claimed["archiveSha256"] == independent["sha256"]
    assert report["fixture"]["sizeBytes"] == independent["archiveBytes"]
    assert report["fixture"]["termRows"] == independent["termRows"]
    assert report["encodedByteSha256"] == claimed["encodedByteSha256"]
    assert re.fullmatch(r"[0-9a-f]{64}", report["encodedByteSha256"])

    zip_path = fixture_dir / report["fixture"]["cacheFile"]
    assert zip_path.stat().st_size == independent["archiveBytes"]
    assert file_sha(zip_path) == independent["sha256"]
    with zipfile.ZipFile(zip_path) as source_zip:
        all_files = source_zip.infolist()
        banks = sorted(
            (item for item in all_files if re.fullmatch(r"term_bank_\d+\.json", item.filename)),
            key=lambda item: int(item.filename[10:-5]),
        )
    assert len(all_files) == independent["archiveFiles"]
    assert len(banks) == independent["termBanks"]
    assert len(report["groups"]) == len(report["profiles"]) == len(banks)
    assert report["sourceGroups"] == [
        {"files": [item.filename], "bytes": [item.file_size]} for item in banks
    ]
    assert sum(item.file_size for item in banks) == independent["termJsonBytes"]
    observed = {"rows": 0, "runs": 0, "compactScoreEntries": 0}
    for group, profile in zip(report["groups"], report["profiles"]):
        assert group["rows"] == sum(group["runRows"]) == group["compactScoreEntries"]
        assert profile["rowCount"] == group["rows"]
        assert profile["chunkCount"] == 1
        assert group["prepared"] == [f"0:{group['rows']}"]
        observed["rows"] += group["rows"]
        observed["runs"] += len(group["runRows"])
        observed["compactScoreEntries"] += group["compactScoreEntries"]
    assert observed == report["summary"]
    assert observed == {name: claimed[name] for name in observed}
    assert observed["rows"] == independent["termRows"]
    for name, value in observed.items():
        totals[name] += value
    runner_source = raw[claimed["runner"]].decode()
    for assertion in (
        "assert.deepEqual(after.writes, before.writes)",
        "assert.deepEqual(after.envelopes, before.envelopes)",
        "for (const envelope of after.envelopes) { fullDigest.update(envelope) }",
        "assert.equal(rowCount, fixture.termRows)",
    ):
        assert assertion in runner_source
    assert "hardwareConcurrency: 1, deviceMemory: 4" in runner_source
    assert (report["hardwareConcurrency"], report["deviceMemory"]) == (
        (1, 4) if dictionary == "vndb" else (4, 8)
    )
    corpora[dictionary] = {
        **observed,
        "termJsonBytes": independent["termJsonBytes"],
        "archiveSha256": independent["sha256"],
        "receiptSha256": sha(raw[claimed["receipt"]]),
        "runnerSha256": report["runnerSha256"],
        "reconciledEncodedByteSha256": report["encodedByteSha256"],
    }
assert totals == index["totals"]
assert raw["raw/score-validation-vndb-parity-v2.exit"] == b"exit_code=0\n"
assert reports["jitendex"]["timing"] is None and reports["vndb"]["timing"] is None

timing = reports["jmdict"]["timing"]
assert timing["inputs"] == 6 and timing["compactRows"] == 60000
assert timing["equivalentBadIdErrors"] == 6
assert len(timing["observations"]) == index["exploratoryTiming"]["rawObservations"] == 72
recomputed = {}
for boundary in ("validator", "sidecar"):
    observations = [item for item in timing["observations"] if item["boundary"] == boundary]
    expected_order = [
        (block, arm)
        for block in range(12)
        for arm in ["ABC", "ACB", "BAC", "BCA", "CAB", "CBA"][block % 6]
    ]
    assert [(item["block"], item["arm"]) for item in observations] == expected_order
    assert {item["repeats"] for item in observations} == {32 if boundary == "validator" else 4}
    assert {item["rows"] for item in observations} == {60000}
    assert len({item["sink"] for item in observations}) == 1
    by_block_arm = {(item["block"], item["arm"]): item["elapsedMs"] for item in observations}
    summary = {
        "observations": len(observations),
        "medianMilliseconds": {
            arm: statistics.median(item["elapsedMs"] for item in observations if item["arm"] == arm)
            for arm in "ABC"
        },
        "medianPairedPercentChange": {
            f"{num}/{den}": statistics.median(
                (by_block_arm[block, num] / by_block_arm[block, den] - 1) * 100
                for block in range(12)
            )
            for num, den in (("B", "A"), ("B", "C"), ("C", "A"))
        },
    }
    claimed = index["exploratoryTiming"]["summary"][boundary]
    assert summary["observations"] == claimed["observations"]
    for name in ("medianMilliseconds", "medianPairedPercentChange"):
        for key, value in summary[name].items():
            assert math.isclose(value, claimed[name][key], rel_tol=1e-12, abs_tol=1e-12)
    recomputed[boundary] = summary

result = {
    "schemaVersion": 1,
    "complete": True,
    "auditUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "auditRunnerSha256": file_sha(pathlib.Path(__file__)),
    "indexSha256": sha(index_bytes),
    "rawArchiveSha256": file_sha(archive_path),
    "rawMembersVerified": len(raw),
    "independentFixtureReceiptSha256": sha(fixture_bytes),
    "runtime": index["runtime"],
    "corpora": corpora,
    "totals": totals,
    "recomputedTimingSummary": recomputed,
    "scope": "Read-only artifact/hash/count/statistic audit, with compressed fixture SHA and ZIP directory reconciliation; no native or timed reexecution.",
    "staticReview": "Reviewed the archived encode/consume paths, real product sidecar invocation, equality assertions, cumulative envelope digest, native single-bank options, and validator test-only export. The final VNDB runner pins runtime hashes before import, at import completion, and at corpus completion.",
    "limits": [
        "Encoded-byte digests reconcile between index and source-bound acquisition receipts; encoded output bytes were not archived, so these output digests were not independently recomputed.",
        "Original JMdict/Jitendex receipt CPU/memory labels are stale 4/8; archived runner navigator settings are 1/4, as explicitly corrected by the index.",
        "Full row counts match the separate complete JSON traversal; this audit does not parse those rows again.",
        "Native component parity omits production worker grouping, physical compression, persistence, and browser import behavior.",
        "Exploratory validator timing is local; sidecar timing is inconclusive and no complete-import speedup is established.",
        "Failed and provenance-uncertain attempts are retained and excluded from accepted totals.",
    ],
}
with output.open("x") as stream:
    json.dump(result, stream, indent=2)
    stream.write("\n")
print(json.dumps({"complete": True, "rawMembersVerified": len(raw), **totals}))
