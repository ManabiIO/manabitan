"""Read-only accounting from all six original source maps and exclusion receipts."""
import datetime
import hashlib
import json
import pathlib
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = pathlib.Path(__file__).resolve().parent
BASE = "a300da36d00df8e353c5679b1528b50a1299b75f"
CANDIDATE = "61ac55c50d9ade7b90dbeb9299de18e094e25044"
RUN = 46141233321
EXPECTED = "006d19ea2498cb3b561f084dba2c41b133c0c5b23a65137b8afb7756716f49f9"
RAW_AUDITOR = "2dcd4c56bed134871a1cc35b5b05d170d73bca47aeb74ae38bbed9bb3ee6ace0"
SOURCE_BINDING = ROOT / "numeric-suffix-proof-consumer-982-qualification-preparation/source-binding.json"
SOURCE_BINDING_SHA = "c9da17e30c264ea31b10367294a9d31f431de705d52e3c9a3bedeee584a942f3"
CELLS = [d + "-" + o for d in ("jmdict", "jitendex", "vndb") for o in ("AB", "BA")]
CHANGED = ["js/dictionary/wasm/term-bank-parser.c", "lib/term-bank-parser.wasm"]


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read_json(path):
    raw = path.read_bytes()
    return json.loads(raw), sha(raw)


def file_receipt(path):
    raw = path.read_bytes()
    return {"path": str(path.relative_to(ROOT)), "bytes": len(raw), "sha256": sha(raw)}


output = OUT / "package-byte-deltas.json"
assert not output.exists(), "Refuse to replace an existing receipt"
binding, binding_sha = read_json(SOURCE_BINDING)
assert binding_sha == SOURCE_BINDING_SHA
assert binding["baseline"]["commit"] == BASE and binding["candidate"]["commit"] == CANDIDATE
products = {x["path"]: x for x in binding["productFiles"]}
changed = {}
for package_path, source_path, baseline_field in [
    (CHANGED[0], "ext/js/dictionary/wasm/term-bank-parser.c", "cSha256"),
    (CHANGED[1], "dev/data/dictionary-wasm/term-bank-parser.wasm", "wasmSha256"),
]:
    baseline_file = ROOT / "numeric-suffix-972-build-evidence/reverse-patch-verification-final" / source_path
    candidate_file = ROOT / "numeric-suffix-proof-consumer-evidence/build-failed/product" / source_path
    first, second = file_receipt(baseline_file), file_receipt(candidate_file)
    assert first["sha256"] == binding["nativeBaseline"][baseline_field]
    assert second["sha256"] == products[source_path]["sha256"]
    assert second["bytes"] == products[source_path]["bytes"]
    changed[package_path] = {
        "A": first,
        "B": second,
        "candidateProductBinding": products[source_path],
        "uncompressedDeltaBytes": second["bytes"] - first["bytes"],
    }

cells = {}
reference_maps = None
for name in CELLS:
    directory = OUT / name / "raw-recovery-1"
    audit, audit_sha = read_json(directory / "independent-raw-evidence-audit.json")
    assert audit["auditIntegrityPassed"] is True
    assert audit["runId"] == RUN and audit["dictionary"] + "-" + audit["order"] == name
    assert audit["expectedSha256"] == EXPECTED and audit["auditorSha256"] == RAW_AUDITOR
    manifest, manifest_sha = read_json(directory / "raw-evidence-manifest.json")
    assert audit["archiveManifestSha256"] == manifest_sha
    assert manifest["complete"] is True and manifest["acquisitionOrObservationsChanged"] is False
    inventory = {x["path"]: x for x in manifest["members"]}
    with zipfile.ZipFile(directory / "raw-evidence.zip") as archive:
        raw = archive.read("source-identities.json")
    assert len(raw) == inventory["source-identities.json"]["bytes"]
    assert sha(raw) == inventory["source-identities.json"]["sha256"]
    identities = json.loads(raw)
    assert identities["changedPackageEntries"] == CHANGED
    first, second = identities["arms"]["A"], identities["arms"]["B"]
    assert first["sha"] == BASE and second["sha"] == CANDIDATE
    maps = {"A": first["entries"], "B": second["entries"]}
    assert set(maps["A"]) == set(maps["B"]) and len(maps["A"]) == 582
    actual_changes = sorted(k for k in maps["A"] if maps["A"][k] != maps["B"][k])
    assert actual_changes == CHANGED
    for path in CHANGED:
        for arm in ("A", "B"):
            assert maps[arm][path] == changed[path][arm]["sha256"]
    if reference_maps is None:
        reference_maps = maps
    else:
        assert maps == reference_maps
    excluded = {x["path"]: x for x in manifest["excluded"]}
    assert set(excluded) == {"package-A.zip", "package-B.zip"}
    for arm, identity in (("A", first), ("B", second)):
        assert excluded["package-" + arm + ".zip"]["sha256"] == identity["packageSha256"]
    cells[name] = {
        "jobId": audit["jobId"],
        "originalRawAuditSha256": audit_sha,
        "originalManifestSha256": manifest_sha,
        "sourceIdentitiesMemberSha256": sha(raw),
        "packageEntryCount": len(maps["A"]),
        "unchangedEntryCount": len(maps["A"]) - len(actual_changes),
        "changedEntryNames": actual_changes,
        "excludedPackages": [excluded["package-A.zip"], excluded["package-B.zip"]],
        "compressedArchiveDeltaBytes": excluded["package-B.zip"]["bytes"] - excluded["package-A.zip"]["bytes"],
    }

sizes = {(v["excludedPackages"][0]["bytes"], v["excludedPackages"][1]["bytes"]) for v in cells.values()}
assert len(sizes) == 1
first_size, second_size = next(iter(sizes))
result = {
    "schemaVersion": 1,
    "recordedAtUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "scope": "Read-only exact package-size accounting for the completed a300-to-61ac cohort; no download, rebuild, acquisition or observation change.",
    "runId": RUN,
    "baseline": BASE,
    "candidate": CANDIDATE,
    "sourceBindingSha256": binding_sha,
    "baselineCSourceInventory": {
        "gitBlob": "ead1b75b3ca69ca4caf04ad7297d8395df54b425",
        "sha256": "8bb3036aa3916061d4b7fa30339505d591fc2eee80b262fb0d57a9a3ee492c87",
        "field": "nativeManifestInputs entry ext/js/dictionary/wasm/term-bank-parser.c",
        "currentBytes": 161067,
        "currentGitBlobSha1": "403272a3e65cbd4084f6211a46df7d3db78979ac",
        "equalityProof": "Exact baseline file SHA is checked against the fresh current source binding and every original package entry map.",
    },
    "changedEntries": changed,
    "uncompressedChangedEntryTotalDeltaBytes": sum(x["uncompressedDeltaBytes"] for x in changed.values()),
    "cells": cells,
    "commonCompressedArchiveSizes": {"baselineBytes": first_size, "candidateBytes": second_size, "deltaBytes": second_size - first_size},
    "allSixSameArmPackageEntryMapsEqual": True,
    "limits": [
        "Whole compressed release ZIP sizes come from exact post-acquisition exclusion receipts tied to original source identities; release ZIPs were not downloaded again.",
        "Uncompressed total entry-byte delta is derived from the two exact changed files; the other 580 entry hashes and the complete entry-name set are identical.",
        "Baseline and candidate bytes are reused only by exact SHA equality to the current source/package bindings; the recovered failed-build candidate copy is not reused as successful correctness evidence.",
        "Individual entry compressed sizes are absent from the hash-only maps and are not claimed.",
        "Native code-file size changes are not process-memory measurements.",
    ],
    "noMeasurementsChanged": True,
}
encoded = (json.dumps(result, indent=2) + "\n").encode()
with output.open("xb") as handle:
    handle.write(encoded)
print(json.dumps({"path": str(output), "sha256": sha(encoded), "bytes": len(encoded), "compressed": result["commonCompressedArchiveSizes"], "uncompressedDeltaBytes": result["uncompressedChangedEntryTotalDeltaBytes"]}))
