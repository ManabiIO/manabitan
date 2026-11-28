#!/usr/bin/env python3
"""Native component feasibility only; no browser or WASM timing claim."""
import argparse
import ctypes as C
import hashlib
import json
import os
from pathlib import Path
import platform
import statistics
import sys
import time

PINNED_ZSTD = "82d322c4973d9e2968d94047a40892bc6d9a9bdf"
DICT_SHA = "f384a821c2f122bde518ee8a513ea76cbe9876c3534fc1fff4cacdf1ecc509cb"
LEVEL = -1
p = argparse.ArgumentParser()
p.add_argument("--library", required=True)
p.add_argument("--manifest", required=True)
p.add_argument("--dictionary", required=True)
p.add_argument("--lock", required=True)
p.add_argument("--out", required=True)
p.add_argument("--pairs", type=int, default=3)
p.add_argument("--control-pairs", type=int, default=2)
a = p.parse_args()
if a.pairs < 2 or a.control_pairs < 1:
    p.error("Use at least two A/B pairs and one A/A control pair")
out = Path(a.out)
out.parent.mkdir(parents=True, exist_ok=True)
sha = lambda data: hashlib.sha256(data).hexdigest()
manifest_path = Path(a.manifest)
manifest_bytes = manifest_path.read_bytes()
manifest = json.loads(manifest_bytes)
locks = json.loads(Path(a.lock).read_text())["dictionaries"]
name = manifest["dictionary"]
spec = locks[name]
if manifest.get("partial") is not False or manifest["rows"] != spec["termRows"]:
    raise ValueError("Capture is partial or has the wrong row count")
if manifest["fixture"]["sha256"] != spec["sha256"]:
    raise ValueError("Capture fixture identity does not match the lock")
if manifest["blockTargetBytes"] != 1024 * 1024:
    raise ValueError("Capture does not use the current database block target")
dictionary = Path(a.dictionary).read_bytes()
if sha(dictionary) != DICT_SHA:
    raise ValueError("Unexpected compression dictionary")
dict_buffer = C.create_string_buffer(dictionary, len(dictionary))
blocks = []
for item in manifest["blocks"]:
    path = manifest_path.parent / item["filename"]
    data = path.read_bytes()
    if not data or len(data) != item["bytes"] or sha(data) != item["sha256"]:
        raise ValueError("Canonical block identity mismatch: " + item["filename"])
    blocks.append((item, C.create_string_buffer(data, len(data))))
if sum(item["bytes"] for item, _ in blocks) != manifest["packedBytes"]:
    raise ValueError("Packed byte count does not match the manifest")

z = C.CDLL(a.library)
ptr, size = C.c_void_p, C.c_size_t
def bind(name, args, result=size):
    fn = getattr(z, name)
    fn.argtypes = args
    fn.restype = result
    return fn
version = bind("ZSTD_versionString", [], C.c_char_p)
is_error = bind("ZSTD_isError", [size], C.c_uint)
error_name = bind("ZSTD_getErrorName", [size], C.c_char_p)
bound = bind("ZSTD_compressBound", [size])
create = bind("ZSTD_createCCtx", [], ptr)
free = bind("ZSTD_freeCCtx", [ptr])
context_size = bind("ZSTD_sizeof_CCtx", [ptr])
raw = bind("ZSTD_compress_usingDict", [ptr, ptr, size, ptr, size, ptr, size, C.c_int])
create_seed = bind("mb_create", [], ptr)
free_seed = bind("mb_free", [ptr], None)
seeded = bind("mb_compress", [ptr, ptr, size, ptr, size, ptr, size, C.c_int])
seed_size = bind("mb_context_bytes", [ptr])
seed_builds = bind("mb_seed_builds", [ptr])
seed_fallbacks = bind("mb_direct_fallbacks", [ptr])
create_d = bind("ZSTD_createDCtx", [], ptr)
free_d = bind("ZSTD_freeDCtx", [ptr])
decode = bind("ZSTD_decompress_usingDict", [ptr, ptr, size, ptr, size, ptr, size])
capacity = max(bound(item["bytes"]) for item, _ in blocks)
dest_a, dest_b = C.create_string_buffer(capacity), C.create_string_buffer(capacity)
decoded = C.create_string_buffer(max(item["bytes"] for item, _ in blocks))

def check(value):
    if is_error(value):
        raise RuntimeError(error_name(value).decode())
    return value

def allocate(fn):
    value = fn()
    if not value:
        raise MemoryError("Native context allocation failed")
    return value

result = {
    "scope": "Native same-binary component feasibility; immutable dictionary; actual canonical blocks in capture order. No WASM, IPC, envelope, OPFS or browser timing claim.",
    "zstdSourceCommit": PINNED_ZSTD,
    "nativeVersion": version().decode(),
    "nativeLibrarySha256": sha(Path(a.library).read_bytes()),
    "runnerSha256": sha(Path(__file__).read_bytes()),
    "manifestSha256": sha(manifest_bytes),
    "captureSourceHashes": manifest["sourceHashes"],
    "captureWasmSha256": manifest["wasmSha256"],
    "dictionaryArchiveSha256": spec["sha256"],
    "compressionDictionarySha256": DICT_SHA,
    "compressionDictionaryBytes": len(dictionary),
    "dictionary": name,
    "rows": manifest["rows"],
    "blocks": len(blocks),
    "inputBytes": manifest["packedBytes"],
    "blockTargetBytes": manifest["blockTargetBytes"],
    "level": LEVEL,
    "python": sys.version,
    "platform": platform.platform(),
    "loadBefore": os.getloadavg(),
    "status": "started",
    "prefixTransitionControls": [],
    "parity": [],
    "controls": [],
    "observations": [],
}
def save():
    out.write_text(json.dumps(result, indent=2) + "\n")

def compress_one(fn, ctx, dest, source, length):
    value = fn(ctx, dest, capacity, source, length, dict_buffer, len(dictionary), LEVEL)
    if value > capacity:
        check(value)
        raise ValueError("Compressed result exceeds destination capacity")
    return value

try:
    # Correctness only: empty frames and source-size parameter transitions.
    # These prefixes are never used for the actual-block timing observations.
    control_a, control_b, control_d = allocate(create), allocate(create_seed), allocate(create_d)
    first_data = blocks[0][1].raw
    control_lengths = [len(first_data), 0, 1, 7, 1024, 8192, 16384, 65536,
                       98303, 98304, 131071, 131072, 262144, len(first_data), 0, len(first_data)]
    try:
        for n in control_lengths:
            if n > len(first_data):
                continue
            data = first_data[:n]
            source = C.create_string_buffer(data, max(1, n))
            n_a = compress_one(raw, control_a, dest_a, source, n)
            n_b = compress_one(seeded, control_b, dest_b, source, n)
            bytes_a, bytes_b = dest_a.raw[:n_a], dest_b.raw[:n_b]
            if bytes_a != bytes_b:
                raise ValueError("Prefix transition control frame mismatch at size " + str(n))
            decoded_size = check(decode(control_d, decoded, len(decoded), dest_b, n_b,
                                        dict_buffer, len(dictionary)))
            if decoded_size != n or decoded.raw[:n] != data:
                raise ValueError("Prefix transition control decode mismatch at size " + str(n))
            result["prefixTransitionControls"].append({"inputBytes": n, "outputBytes": n_a, "identical": True})
        result["controlSeedBuilds"] = seed_builds(control_b)
        result["controlDirectFallbacks"] = seed_fallbacks(control_b)
    finally:
        free(control_a)
        free_seed(control_b)
        free_d(control_d)

    raw_context, seed_context, decoder = allocate(create), allocate(create_seed), allocate(create_d)
    output_digest = hashlib.sha256()
    try:
        for item, source in blocks:
            n = item["bytes"]
            n_a = compress_one(raw, raw_context, dest_a, source, n)
            n_b = compress_one(seeded, seed_context, dest_b, source, n)
            bytes_a, bytes_b = dest_a.raw[:n_a], dest_b.raw[:n_b]
            for encoded, encoded_size in [(dest_a, n_a), (dest_b, n_b)]:
                decoded_size = check(decode(decoder, decoded, len(decoded), encoded, encoded_size,
                                            dict_buffer, len(dictionary)))
                if decoded_size != n or sha(decoded.raw[:n]) != item["sha256"]:
                    raise ValueError("Decoded content differs: " + item["filename"])
            output_digest.update(n_a.to_bytes(8, "little"))
            output_digest.update(bytes_a)
            result["parity"].append({
                "filename": item["filename"], "inputBytes": n,
                "baselineBytes": n_a, "candidateBytes": n_b,
                "identical": bytes_a == bytes_b,
                "baselineSha256": sha(bytes_a), "candidateSha256": sha(bytes_b),
            })
        result["baselineContextBytes"] = context_size(raw_context)
        result["candidateContextBytes"] = seed_size(seed_context)
        result["candidateSeedBuilds"] = seed_builds(seed_context)
        result["candidateDirectFallbacks"] = seed_fallbacks(seed_context)
    finally:
        free(raw_context)
        free_seed(seed_context)
        free_d(decoder)
    result["baselineOutputDigest"] = output_digest.hexdigest()
    result["baselineOutputBytes"] = sum(row["baselineBytes"] for row in result["parity"])
    result["candidateOutputBytes"] = sum(row["candidateBytes"] for row in result["parity"])
    if not all(row["identical"] for row in result["parity"]):
        result["status"] = "parity_failed_no_timings"
        save()
        sys.exit(2)

    def measure(mode):
        make, release, fn, destination = (
            (create, free, raw, dest_a) if mode == "raw"
            else (create_seed, free_seed, seeded, dest_b)
        )
        start = time.perf_counter_ns()
        ctx = allocate(make)
        after_create = time.perf_counter_ns()
        try:
            total = 0
            for item, source in blocks:
                total += compress_one(fn, ctx, destination, source, item["bytes"])
            end = time.perf_counter_ns()
            if total != result["baselineOutputBytes"]:
                raise ValueError("Timed output byte count changed")
            observation = {
                "mode": mode,
                "elapsedMs": (end - start) / 1e6,
                "creationMs": (after_create - start) / 1e6,
                "compressionMs": (end - after_create) / 1e6,
                "contextBytes": context_size(ctx) if mode == "raw" else seed_size(ctx),
            }
            if mode != "raw":
                observation["seedBuilds"] = seed_builds(ctx)
                observation["directFallbacks"] = seed_fallbacks(ctx)
            return observation
        finally:
            release(ctx)

    # Warm code and input pages only. Every measured pass creates fresh contexts.
    measure("raw")
    measure("seeded")
    for pair in range(a.control_pairs):
        for arm in ["A1", "A2"]:
            result["controls"].append({"pair": pair, "arm": arm, **measure("raw")})
    for pair in range(a.pairs):
        order = ["A", "B"] if pair % 2 == 0 else ["B", "A"]
        for arm in order:
            observation = {"pair": pair, "arm": arm, **measure("raw" if arm == "A" else "seeded")}
            result["observations"].append(observation)
            save()
            print(json.dumps(observation), flush=True)

    def summarize(observations, left, right):
        paired = []
        for pair in sorted({row["pair"] for row in observations}):
            a1 = next(row["elapsedMs"] for row in observations if row["pair"] == pair and row["arm"] == left)
            b1 = next(row["elapsedMs"] for row in observations if row["pair"] == pair and row["arm"] == right)
            paired.append(b1 / a1)
        total_a = sum(row["elapsedMs"] for row in observations if row["arm"] == left)
        total_b = sum(row["elapsedMs"] for row in observations if row["arm"] == right)
        return {
            "pairedChangesPercent": [(ratio - 1) * 100 for ratio in paired],
            "medianPairedChangePercent": (statistics.median(paired) - 1) * 100,
            "equalWorkChangePercent": (total_b / total_a - 1) * 100,
            "fasterPairs": sum(ratio < 1 for ratio in paired),
        }
    result["controlSummary"] = summarize(result["controls"], "A1", "A2")
    result["summary"] = summarize(result["observations"], "A", "B")
    result["loadAfter"] = os.getloadavg()
    result["status"] = "complete"
    save()
    print(json.dumps({"summary": result["summary"], "controls": result["controlSummary"]}))
except Exception as error:
    result["status"] = "failed"
    result["error"] = repr(error)
    save()
    raise
