#!/usr/bin/env python3
"""Compare complete JMdict custom files, retaining raw hashes for every byte.

Equality normalizes only the validated, cross-file generation IDs in MBTRD16X
and MBTIDX11 headers. All other bytes, including checksums, compare unchanged.
Two independent observations per arm and explicit package/harness pins are
required. These observations are never accepted as timing or memory evidence.
Copyright (C) 2026 Manabitan authors
SPDX-License-Identifier: GPL-3.0-or-later
"""

import argparse
from datetime import datetime
import hashlib
import json
import re
from pathlib import Path


CHUNK_BYTES = 4 * 1024 * 1024
EXCLUDED_PREFIX = "manabitan/sqlite-sahpool-v1/.opaque/"
AUDIT_KIND = "OPFS complete raw and generation-normalized byte audit after restart; separate JMdict correctness observation v1"
ALGORITHM = "SHA-256 per consecutive 4 MiB chunk; generation normalization v1"
SOURCE_HARNESS_SHA256 = "d0ae122bd22f7b460cedb11f06d2cb018224674abf9669e0fed567b5f3a870cf"
NORMALIZATION = [{"format": "MBTRD16X", "offset": 8, "bytes": 16}, {"format": "MBTIDX11", "offset": 24, "bytes": 16}]
RECORD_PATH = re.compile(r"^manabitan-term-records/[^/]+\.mbtr$")
LOOKUP_PATH = re.compile(r"^manabitan-term-records/[^/]+\.mbtr\.mbti$")


def valid_hash(value):
    return isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) is not None


def valid_size(value):
    return type(value) is int and 0 <= value < 2**53


def identity_header(path, size, identity):
    record, lookup = bool(RECORD_PATH.fullmatch(path)), bool(LOOKUP_PATH.fullmatch(path))
    if not record and not lookup:
        if identity is not None:
            raise ValueError("Identity normalization supplied for an unknown file type")
        return None, []
    if not isinstance(identity, dict) or set(identity) != {"format", "hex"}:
        raise ValueError("Missing or malformed identity header")
    magic = "MBTRD16X" if record else "MBTIDX11"
    raw = identity["hex"]
    if (identity["format"] != magic or not isinstance(raw, str) or len(raw) % 2 or
            re.fullmatch(r"[a-f0-9]+", raw) is None):
        raise ValueError("Invalid identity header format or encoding")
    header = bytes.fromhex(raw)
    if len(header) < (26 if record else 40) or len(header) > size or header[:8] != magic.encode():
        raise ValueError("Unsupported or truncated record/lookup header")
    if record:
        meta, prefix = int.from_bytes(header[24:26], "little"), 26
        if meta == 0xffff:
            if len(header) < 30:
                raise ValueError("Truncated extended record header")
            meta, prefix = int.from_bytes(header[26:30], "little"), 30
            if meta <= 0x7fff:
                raise ValueError("Noncanonical extended record header")
        elif meta > 0x7fff:
            raise ValueError("Noncanonical short record header")
        code = meta & 255
        name_bytes = meta >> 8 if code == 255 else 0
        if (code != 255 and (code > 5 or meta != code)) or (code == 255 and not 1 <= name_bytes <= 65535):
            raise ValueError("Unsupported record dictionary metadata")
        if len(header) != prefix + name_bytes:
            raise ValueError("Record identity header omits or adds bytes")
        header[prefix:].decode("utf-8", errors="strict")
        return {"generation": header[8:24].hex(), "header": header}, [{"offset": 8, "bytes": 16}]
    if len(header) != 40:
        raise ValueError("Lookup header is not exactly 40 bytes")
    descriptor_bytes = int.from_bytes(header[8:16], "little")
    chunks = int.from_bytes(header[16:20], "little")
    rows = int.from_bytes(header[20:24], "little")
    if not valid_size(descriptor_bytes) or descriptor_bytes < 26 or not 0 < chunks <= rows or size < 40 + chunks * 40:
        raise ValueError("Invalid lookup header framing")
    return {"generation": header[24:40].hex(), "header": header, "descriptorBytes": descriptor_bytes, "rows": rows}, [{"offset": 24, "bytes": 16}]


def audited_files(validation):
    storage = validation["storage"]
    if storage["kind"] != AUDIT_KIND:
        raise ValueError("Not the pinned complete JMdict byte-audit observation")
    files, identities, sizes, paths = [], {}, {}, set()
    total = 0
    for entry in storage["files"]:
        path, size = entry["path"], entry["bytes"]
        if not isinstance(path, str) or not path or any(part in ("", ".", "..") for part in path.split("/")) or path in paths:
            raise ValueError("Invalid or duplicate storage path")
        paths.add(path)
        if not valid_size(size):
            raise ValueError("Invalid file size")
        total += size
        if path.startswith(EXCLUDED_PREFIX):
            continue
        if path.startswith("manabitan-dictionary-media-v1/"):
            raise ValueError("Generation media is outside this JMdict-only audit")
        parsed, ranges = identity_header(path, size, entry.get("identityHeader"))
        if parsed is not None:
            identities[path] = parsed
        sizes[path] = size
        audit = entry["byteAudit"]
        if (audit["algorithm"] != ALGORITHM or audit["chunkBytes"] != CHUNK_BYTES or
                audit["ranges"] != ranges):
            raise ValueError("Unknown algorithm, chunk size, or normalization range")
        cursor, chunks = 0, []
        for chunk in audit["chunks"]:
            length = min(CHUNK_BYTES, size - cursor)
            if (length <= 0 or type(chunk["offset"]) is not int or type(chunk["bytes"]) is not int or
                    chunk["offset"] != cursor or chunk["bytes"] != length or
                    not valid_hash(chunk["sha256"]) or not valid_hash(chunk["normalizedSha256"])):
                raise ValueError("Byte audit has a gap, overlap, invalid hash, or wrong chunk length")
            overlaps = any(r["offset"] < cursor + length and r["offset"] + r["bytes"] > cursor for r in ranges)
            if not overlaps and chunk["sha256"] != chunk["normalizedSha256"]:
                raise ValueError("Bytes outside a generation identity were normalized")
            if parsed is not None and cursor == 0 and size == len(parsed["header"]):
                if hashlib.sha256(parsed["header"]).hexdigest() != chunk["sha256"]:
                    raise ValueError("Complete record header does not match its retained raw hash")
                normalized_header = bytearray(parsed["header"])
                for span in ranges:
                    normalized_header[span["offset"]:span["offset"] + span["bytes"]] = bytes(span["bytes"])
                if hashlib.sha256(normalized_header).hexdigest() != chunk["normalizedSha256"]:
                    raise ValueError("Complete record header normalization changed other bytes")
            chunks.append({"offset": cursor, "bytes": length, "sha256": chunk["sha256"], "normalizedSha256": chunk["normalizedSha256"]})
            cursor += length
        if cursor != size:
            raise ValueError("Byte audit does not cover the entire file")
        files.append({"path": path, "bytes": size, "ranges": ranges, "identityHeader": entry.get("identityHeader"), "chunks": chunks})
    if not valid_size(storage["bytes"]) or total != storage["bytes"]:
        raise ValueError("Enumerated file sizes do not cover the storage receipt")
    records = {path: value for path, value in identities.items() if RECORD_PATH.fullmatch(path)}
    indexes = {path: value for path, value in identities.items() if LOOKUP_PATH.fullmatch(path)}
    if "manabitan-term-content.bin" not in sizes or sizes["manabitan-term-content.bin"] == 0 or not records or len(records) != len(indexes):
        raise ValueError("Missing persisted content or complete record/lookup pairs")
    rows = 0
    for path, index in indexes.items():
        record_path = path[:-5]
        record = records.get(record_path)
        if (record is None or record["generation"] != index["generation"] or
                index["descriptorBytes"] != sizes[record_path]):
            raise ValueError("Record/lookup generation or descriptor length mismatch")
        rows += index["rows"]
    if not valid_size(validation["termRows"]) or rows != validation["termRows"]:
        raise ValueError("Lookup headers do not cover the complete term corpus")
    return sorted(files, key=lambda entry: entry["path"])


def comparison_files(files):
    return [{"path": f["path"], "bytes": f["bytes"], "ranges": f["ranges"], "chunks": [
        {"offset": c["offset"], "bytes": c["bytes"], "sha256": c["normalizedSha256"]} for c in f["chunks"]
    ]} for f in files]


def lookup_receipt(validation):
    probes = validation["probeTerms"]
    if len(probes) != 12 or any(not isinstance(term, str) or not term for term in probes) or len(set(probes)) != 12:
        raise ValueError("Missing complete distinct lookup probe set")
    observations = validation["lookup"]["observations"]
    keys, stable, result = set(), {}, []
    if len(observations) != 72:
        raise ValueError("Missing restart/warm lookup observations")
    for row in observations:
        term, iteration = row["term"], row["pass"]
        key = (term, iteration)
        if (term not in probes or type(iteration) is not int or not 0 <= iteration < 6 or key in keys or
                row["originalTextLength"] != len(term.encode("utf-16-le")) // 2 or row["hasExactHeadwordMatch"] is not True or
                type(row["results"]) is not int or row["results"] <= 0 or not valid_hash(row["sha256"])):
            raise ValueError("Invalid or duplicate lookup observation")
        keys.add(key)
        signature = (row["results"], row["sha256"])
        if term in stable and stable[term] != signature:
            raise ValueError("Lookup results changed between cold and warm observations")
        stable[term] = signature
        result.append({"term": term, "pass": iteration, "results": row["results"], "sha256": row["sha256"]})
    return sorted(result, key=lambda row: (row["term"], row["pass"]))


def lookahead_receipt(report, arm, fixture):
    phases = [phase for phase in report["phases"] if phase.get("name") == fixture.get("label", "JMdict") + ": total import"]
    if len(phases) != 1:
        raise ValueError("Missing unique lookahead import receipt")
    debug = phases[0]["data"]["importDebug"]
    if (debug["hasResult"] is not True or debug["resultTitle"] != fixture["expectedTitle"] or
            debug["errorCount"] != 0 or debug["addSettingsErrorCount"] != 0 or debug["usesFallbackStorage"] is not False):
        raise ValueError("Lookahead import receipt contains errors or fallback")
    sums = {"contentLookaheadPreparedCount": 0, "contentLookaheadCompressionCount": 0}
    found = False
    for phase in debug["importerPhaseTimings"]:
        if not phase["phase"].startswith("term-file-fast-path:"):
            continue
        details = phase["details"]
        if all(key in details for key in sums):
            found = True
        for key in sums:
            value = details.get(key, 0)
            if type(value) is not int or value < 0:
                raise ValueError("Invalid lookahead participation counter")
            sums[key] += value
    flags = report["benchmark"].get("importFlags") or {}
    if arm == "B":
        if not found or flags.get("experimentalTermContentLookahead") is not True or not 0 < sums["contentLookaheadCompressionCount"] <= sums["contentLookaheadPreparedCount"]:
            raise ValueError("Candidate did not execute claimed lookahead compression")
    elif any(sums.values()) or flags.get("experimentalTermContentLookahead") is True:
        raise ValueError("Baseline unexpectedly executed lookahead")
    return sums


def compare(args):
    paths = [p.resolve() for p in args.baseline + args.candidate]
    if len(args.baseline) != 2 or len(args.candidate) != 2 or len(set(paths)) != 4:
        raise ValueError("Exactly four distinct report paths, two per arm, are required")
    if not all(valid_hash(v) for v in (args.expected_baseline_package_sha256, args.expected_candidate_package_sha256, args.expected_patched_harness_sha256)):
        raise ValueError("Expected SHA-256 pins must be explicit lowercase digests")
    instrumentation_bytes = args.instrumentation.read_bytes()
    instrumentation = json.loads(instrumentation_bytes)
    lock_bytes = args.fixture_lock.read_bytes()
    if (instrumentation["sourceHarnessSha256"] != SOURCE_HARNESS_SHA256 or
            instrumentation["patchedHarnessSha256"] != args.expected_patched_harness_sha256 or
            not valid_hash(instrumentation["installerSha256"]) or
            instrumentation["fixtureLockSha256"] != hashlib.sha256(lock_bytes).hexdigest() or
            instrumentation["excludedPrefix"] != EXCLUDED_PREFIX or instrumentation["normalization"] != NORMALIZATION or
            instrumentation["kind"] != AUDIT_KIND or instrumentation["algorithm"] != ALGORITHM or instrumentation["chunkBytes"] != CHUNK_BYTES):
        raise ValueError("Instrumentation/fixture provenance does not match the pinned audit")
    fixture = json.loads(lock_bytes)["dictionaries"]["jmdict"]
    result = {"scope": "JMdict only: every custom-file raw byte hashed; equality normalizes only paired 16-byte generation IDs; SQLite opaque files excluded; no timing or memory claim", "status": "running", "instrumentationSha256": hashlib.sha256(instrumentation_bytes).hexdigest(), "observations": []}
    started = set()
    expected_identity = {"title": fixture["expectedTitle"], "revision": fixture["revision"], "termRows": fixture["termRows"]}
    for index, path in enumerate(paths):
        arm = "A" if index < 2 else "B"
        expected_package = args.expected_baseline_package_sha256 if arm == "A" else args.expected_candidate_package_sha256
        raw = path.read_bytes()
        report = json.loads(raw)
        stamp = report["startedAtIso"]
        parsed_stamp = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
        if parsed_stamp.tzinfo is None or parsed_stamp in started:
            raise ValueError("Independent observations require distinct timestamp identities")
        started.add(parsed_stamp)
        provenance = report["byteAuditProvenance"]
        if (report["status"] != "success" or report["skippedVerification"] is not False or report["packageSha256"] != expected_package or
                any(provenance.get(key) != instrumentation[key] for key in
                    ("sourceHarnessSha256", "patchedHarnessSha256", "installerSha256", "fixtureLockSha256"))):
            raise ValueError("Report did not complete the expected package and patched harness")
        benchmark = report["benchmark"]
        if benchmark["dictionary"] != "jmdict" or benchmark["pinnedDictionaries"] is not True or benchmark.get("mediaCheck", "all") != "all":
            raise ValueError("Report is not the pinned complete JMdict observation")
        validation = benchmark["validation"]
        restart = validation["restart"]
        if (any(validation.get(key) != value or restart.get(key) != value for key, value in expected_identity.items()) or
                validation["contentReadable"] is not True or restart["contentReadable"] is not True or
                not valid_hash(validation["outputDigestSha256"]) or validation["probeCount"] != 12 or restart["probeCount"] != 12 or
                validation["media"]["mode"] != "all" or validation["media"]["files"] != 0 or validation["media"]["bytes"] != 0 or
                validation["media"]["totalFiles"] != 0 or validation["media"]["totalBytes"] != 0 or restart["mediaFiles"] != 0 or
                validation["media"]["sha256"] != hashlib.sha256(b"").hexdigest()):
            raise ValueError("Incomplete restart/corpus verification or unsupported media")
        files = audited_files(validation)
        lookup = lookup_receipt(validation)
        participation = lookahead_receipt(report, arm, fixture) if args.require_lookahead else None
        result["observations"].append({"arm": arm, "path": str(path), "startedAtIso": stamp, "reportSha256": hashlib.sha256(raw).hexdigest(), "packageSha256": expected_package, **expected_identity, "outputDigestSha256": validation["outputDigestSha256"], "lookup": lookup, "lookahead": participation, "fileCount": len(files), "bytesAudited": sum(f["bytes"] for f in files), "files": files})
    baseline = result["observations"][0]
    reference = comparison_files(baseline["files"])
    for other in result["observations"][1:]:
        if comparison_files(other["files"]) != reference or other["outputDigestSha256"] != baseline["outputDigestSha256"] or other["lookup"] != baseline["lookup"]:
            raise ValueError("Baseline reproducibility or candidate parity failed outside validated generation IDs")
    result.update(status="passed", bytesComparedPerObservation=baseline["bytesAudited"])
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for arm in ("baseline", "candidate"):
        parser.add_argument(f"--{arm}", action="append", required=True, type=Path)
    for name in ("instrumentation", "fixture-lock", "output"):
        parser.add_argument(f"--{name}", required=True, type=Path)
    for name in ("baseline-package", "candidate-package", "patched-harness"):
        parser.add_argument(f"--expected-{name}-sha256", required=True)
    parser.add_argument("--require-lookahead", action="store_true", help="Require B-only enabled flag and positive claimed preparation/compression counters; A must remain zero")
    args = parser.parse_args()
    result = {"scope": "Complete JMdict byte parity with validated generation normalization; no performance claim", "status": "failed"}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    try:
        result = compare(args)
        print(json.dumps({key: value for key, value in result.items() if key != "observations"}))
    except Exception as error:
        result["error"] = str(error)
        raise
    finally:
        args.output.write_text(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    main()
