#!/usr/bin/env python3
"""Independent read-only audit of the original native-record-fields component artifact.

No JavaScript, WASM, compiler, benchmark, sampler, or capture program is executed.
All clocks, affinity and resource values are inspected only as retained data.
"""
import argparse
import gzip
import hashlib
import io
import json
import math
import re
from pathlib import Path
import statistics
import struct
import sys
import zipfile

from transport import AuditError, GitHub, HEX64, digest, file_digest, inspect_zip, parse_json, read_json, require, safe_name, stream_digest, write_json

REPO = "ManabiIO/manabitan"
RUN = 46115204690
JOB = 140887357214
HEAD = "b5743f37aa49eef96319e594ed42acd7a5e857f3"
TREE = "361ad7c050882e3ab7653ec2bc907265e4b0eefc"
BASE = "9e10d3b3fcf66d344ab31bc42c9b522fa5215da2"
BRANCH = "perf/native-record-fields-screen-20261128-1c413"
WORKFLOW = ".github/workflows/native-record-fields-1c413.yml"
KIT = "dev/perf/native-record-fields-20261128-1c413"
SOURCE_SHA = "d4642966f3ff34737fc633bb239fcd147c8c4f3e78bb0eb2d5aee428c2b58382"
KIT_DIGEST = "d4d5321f58d7f065c97450ccb36dec0f402c6ca529c1a6ed830fa95de0552e61"
PLAN_SHA = "437fac9b74aa0ec3467247adfc58fb5890c822247f436bbd6ea5d8274e9e86f4"
WORKFLOW_SHA = "372fd9e36f31645d84b2398953735425070e09e391a2d177a1913ce7d28dd327"
RUNTIME_DIGEST = "73c774fb00b81979769ffbd0b244a78a10b07afb4fd159c44404344d1d5144a2"
OUTPUT_DIGEST = "88a4c10af8ba9ae444598176d238ab7e4d1d83b9530efd9a930724ff205510e3"
EXPORT = "\nexport {getSynchronousRecordFieldReferences as diagnosticRecordFieldReferences}\n"
FLAGS = {"execArgv": [], "nodeOptionsPresent": False, "nodeCompileCacheConfigured": False,
         "nodeCompileCacheDisabled": True, "activeCompileCacheDirectory": None}
GATE = {"minimumMedianPairedCpuReductionPercent": 20, "minimumMedianPairedCpuSavingMs": 5,
        "minimumFasterPairsAgainstEachControl": 9, "pairsPerControl": 12,
        "maximumAbsoluteControlMedianPercent": 3, "maximumAbsoluteControlEqualWorkPercent": 3,
        "allOutputAndWorkIdentitiesMustPass": True, "componentOnly": True,
        "independentWholeBrowserQualificationRequired": True}
BLOCKS = ["ABC", "ACB", "BAC", "BCA", "CAB", "CBA"] * 2

def same_json(actual, expected):
    if type(expected) in (int, float):
        return type(actual) in (int, float) and math.isfinite(actual) and actual == expected
    if type(expected) is dict:
        return type(actual) is dict and set(actual) == set(expected) and all(same_json(actual[key], value) for key, value in expected.items())
    if type(expected) is list:
        return type(actual) is list and len(actual) == len(expected) and all(same_json(a, b) for a, b in zip(actual, expected))
    return type(actual) is type(expected) and actual == expected

def equal(actual, expected, label):
    require(same_json(actual, expected), label + " differs")

def integer(value, label, minimum=0):
    require(type(value) is int and minimum <= value <= 9007199254740991, label + " is not a safe integer")
    return value

def source_receipt():
    return {"head": HEAD, "tree": TREE, "kitDigest": KIT_DIGEST, "checkedFiles": 77,
            "runtimeDigest": RUNTIME_DIGEST, "runtimeFiles": 323}

def expected_schedule():
    result = []
    for phase, orders in (("warmup", ["ABC", "CBA"]), ("measured", BLOCKS)):
        for index, order in enumerate(orders):
            for position, arm in enumerate(order):
                result.append({"phase": phase, "block": index if phase == "measured" else None,
                               "cycle": index if phase == "warmup" else None, "position": position,
                               "arm": arm, "mode": "timed" if phase == "measured" else "untimed"})
    return result

def schedule_balance():
    positions = {arm: [0, 0, 0] for arm in "ABC"}
    transitions = {pair: 0 for pair in ("AB", "AC", "BA", "BC", "CA", "CB")}
    for order in BLOCKS:
        for position, arm in enumerate(order):
            positions[arm][position] += 1
            if position:
                transitions[order[position - 1:position + 1]] += 1
    return {"positions": positions, "withinBlockTransitions": transitions}

def publication(api):
    run = api.json(f"/actions/runs/{RUN}", "original-run")
    equal(run.get("id"), RUN, "Run ID")
    equal(run.get("head_sha"), HEAD, "Run head")
    equal(run.get("head_branch"), BRANCH, "Run branch")
    equal(run.get("event"), "push", "Original event")
    equal(run.get("path"), WORKFLOW, "Original workflow")
    equal(run.get("run_attempt"), 1, "Original attempt")
    equal(run.get("repository", {}).get("full_name"), REPO, "Original repository")
    attempt = api.json(f"/actions/runs/{RUN}/attempts/1", "original-attempt-1")
    for key in ("id", "head_sha", "head_branch", "event", "path", "run_attempt"):
        equal(attempt.get(key), run.get(key), "Attempt " + key)
    jobs = api.json(f"/actions/runs/{RUN}/attempts/1/jobs?per_page=100", "original-attempt-jobs")
    equal(jobs.get("total_count"), len(jobs.get("jobs", [])), "Complete original job listing")
    matches = [item for item in jobs["jobs"] if item["id"] == JOB]
    equal(len(matches), 1, "Original component job count")
    job = matches[0]
    equal(job.get("run_id"), RUN, "Job run")
    equal(job.get("head_sha"), HEAD, "Job head")
    equal(job.get("name"), "Frozen complete-call native record-field screen", "Job name")
    commit = api.json("/git/commits/" + HEAD, "original-commit")
    equal([item["sha"] for item in commit["parents"]], [BASE], "Original sole parent")
    equal(commit["tree"]["sha"], TREE, "Original tree")
    return {"run": run, "attempt": attempt, "job": job,
            "allOriginalJobsSucceeded": run.get("status") == "completed" and run.get("conclusion") == "success"
                and job.get("status") == "completed" and job.get("conclusion") == "success"}

def preserve_archive(path, destination, metadata):
    destination.mkdir()
    inventory = {}
    with zipfile.ZipFile(path) as archive:
        entries = inspect_zip(archive)
        for info in entries:
            relative = safe_name(info.filename)
            if info.is_dir():
                with archive.open(info) as source:
                    item = stream_digest(source, expected=0)
                item["directory"] = True
            else:
                target = destination / str(relative)
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(info) as source, target.open("xb") as output:
                    item = stream_digest(source, output, info.file_size)
                equal(file_digest(target), item["sha256"], "Extracted member hash")
                item["directory"] = False
            inventory[info.filename] = item
    receipt = {"artifact": metadata, "archiveSha256": file_digest(path),
               "archiveBytes": path.stat().st_size, "members": inventory,
               "allOriginalMembersPreserved": True, "archiveCacheRetained": True}
    write_json(destination.parent / "artifact-inventory.json", receipt)
    return receipt

def verify_frozen_sources(evidence, checkout, api):
    frozen = evidence / "frozen-kit"
    equal(file_digest(frozen / "source.json"), SOURCE_SHA, "Published source manifest")
    source = read_json(frozen / "source.json")
    equal(source["baseline"], BASE, "Kit baseline")
    equal(source["kitPath"], KIT, "Kit path")
    equal(source["kitDigest"], KIT_DIGEST, "Kit digest")
    equal(source["noProductDelta"], True, "No-product declaration")
    equal(source["timingAcquiredBeforeFreeze"], False, "Freeze declaration")
    files = source["files"]
    equal(len(files), 77, "Frozen file count")
    names = [item["path"] for item in files]
    equal(names, sorted(set(names)), "Sorted unique frozen files")
    equal(digest("".join(item["path"] + "\0" + item["sha256"] + "\n" for item in files).encode()), KIT_DIGEST, "Recomputed kit digest")
    equal(source["totalBytes"], sum(item["bytes"] for item in files), "Frozen total bytes")
    actual = {str(path.relative_to(frozen)) for path in frozen.rglob("*") if path.is_file()}
    equal(actual, set(names) | {"source.json"}, "Exact frozen file inventory")
    head_tree = api.tree(HEAD, TREE)
    base_tree = api.tree(BASE)
    changed = {name for name in set(head_tree) | set(base_tree)
               if head_tree.get(name, {}).get("sha") != base_tree.get(name, {}).get("sha")}
    expected_changed = {KIT + "/" + name for name in names + ["source.json"]} | {WORKFLOW}
    equal(changed, expected_changed, "Exact published 79-file boundary")
    for item in files:
        safe_name(item["path"])
        retained = frozen / item["path"]
        published = checkout / KIT / item["path"]
        equal(retained.stat().st_size, item["bytes"], "Frozen file size " + item["path"])
        equal(file_digest(retained), item["sha256"], "Frozen file " + item["path"])
        equal(file_digest(published), item["sha256"], "Published checkout file " + item["path"])
        blob = hashlib.sha1(b"blob " + str(item["bytes"]).encode() + b"\0" + published.read_bytes()).hexdigest()
        equal(blob, head_tree[KIT + "/" + item["path"]]["sha"], "Published Git blob " + item["path"])
    equal(file_digest(checkout / KIT / "source.json"), SOURCE_SHA, "Checkout source manifest")
    equal(file_digest(evidence / "frozen-workflow.yml"), WORKFLOW_SHA, "Retained original workflow")
    equal(file_digest(checkout / WORKFLOW), WORKFLOW_SHA, "Published original workflow")
    equal(source["workflow"], {"path": WORKFLOW, "sha256": WORKFLOW_SHA}, "Workflow binding")
    equal(file_digest(frozen / "plan.json"), PLAN_SHA, "Published plan")
    plan = read_json(frozen / "plan.json")
    equal(plan["baseline"], BASE, "Plan baseline")
    equal(plan["nodeVersion"], "v22.22.0", "Plan Node")
    equal(plan["compilerVersion"], "21.1.8", "Plan compiler")
    equal(plan["warmupCycles"], ["ABC", "CBA"], "Warmup plan")
    equal(plan["blocks"], BLOCKS, "Measured plan")
    equal(plan["nominationGate"], GATE, "Prospective nomination gate")
    equal(plan["expectedOutputDigest"], OUTPUT_DIGEST, "Expected output identity")
    runtime = read_json(frozen / "runtime-identity.json")
    equal(runtime["count"], 323, "Runtime file count")
    equal(len(runtime["files"]), 323, "Runtime inventory")
    equal(runtime["digest"], RUNTIME_DIGEST, "Runtime digest")
    runtime_aggregate = "".join(name + "\0" + runtime["files"][name] + "\n" for name in sorted(runtime["files"])).encode()
    equal(digest(runtime_aggregate), RUNTIME_DIGEST, "Independently reconstructed runtime digest")
    for name, expected in runtime["files"].items():
        safe_name(name)
        path = checkout / name
        require(path.is_file() and not path.is_symlink(), "Nonregular runtime file")
        equal(file_digest(path), expected, "Runtime file " + name)
        data = path.read_bytes()
        equal(hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest(), head_tree[name]["sha"], "Runtime Git blob " + name)
        equal(head_tree[name]["sha"], base_tree[name]["sha"], "Unchanged baseline runtime " + name)
    encoder = (checkout / plan["recordEncoderSource"]).read_bytes()
    equal(digest(encoder), plan["recordEncoderSha256"], "Stock encoder source")
    return plan, frozen, encoder

def read_call(frozen, call):
    path = frozen / "evidence/stage1/run" / call["file"]
    safe_name(call["file"])
    compressed = path.read_bytes()
    equal(len(compressed), call["archiveBytes"], "Capture gzip size")
    equal(digest(compressed), call["archiveSha256"], "Capture gzip hash")
    with gzip.GzipFile(fileobj=io.BytesIO(compressed)) as stream:
        data = stream.read(16 * 1024 * 1024 + 1)
    require(len(data) <= 16 * 1024 * 1024, "Capture expanded size limit")
    equal(digest(data), call["containerSha256"], "Capture container hash")
    require(len(data) >= 4, "Truncated capture")
    header_bytes = struct.unpack_from("<I", data)[0]
    require(0 < header_bytes <= len(data) - 4, "Capture header bounds")
    metadata = parse_json(data[4:4 + header_bytes])
    equal(metadata["version"], 1, "Capture version")
    for key in ("number", "groupIndex", "rowCount", "contentOffsetBase", "fixedContentOffsetBase", "fixedContentLength", "segments"):
        equal(metadata[key], call[key], "Capture metadata " + key)
    equal(call["complete"], True, "Completed capture")
    equal(call["privateSynchronousReferences"], True, "Private capture origin")
    equal(call["fixedContentOffsetBase"], None, "No fixed base")
    equal(call["fixedContentLength"], None, "No fixed length")
    raw = memoryview(data)[4 + header_bytes:]
    equal(len(raw), call["rawBytes"], "Capture raw size")
    kinds = {"uniqueIndexes": ("Uint32Array", "I", 4), "scores": ("Int32Array", "i", 4),
             "resolvedOffsets": ("Float64Array", "d", 8), "resolvedLengths": ("Uint32Array", "I", 4),
             "contentOffsets": ("Float64Array", "d", 8), "contentLengths": ("Uint32Array", "I", 4),
             "output": ("Uint8Array", "B", 1)}
    equal([item["name"] for item in metadata["segments"]], list(kinds), "Capture segment order")
    columns = {}
    consumed = 0
    for segment in metadata["segments"]:
        kind, code, width = kinds[segment["name"]]
        equal(segment["elementKind"], kind, "Captured element kind")
        equal(segment["rawOffset"], consumed, "Segment contiguous raw offset")
        equal(segment["resizable"], False, "Private fixed capture buffer")
        equal(segment["ownShadows"], [], "No captured view shadows")
        length = integer(segment["length"], "Segment length")
        offset = integer(segment["byteOffset"], "Segment byte offset")
        backing = integer(segment["backingBytes"], "Segment backing size")
        equal(segment["byteLength"], length * width, "Typed segment byte length")
        require(offset % width == 0 and offset + length * width <= backing, "Typed segment backing bounds")
        part = raw[consumed:consumed + length * width]
        equal(len(part), length * width, "Segment raw bounds")
        equal(digest(part), segment["sha256"], "Segment SHA256")
        columns[segment["name"]] = bytes(part) if code == "B" else [item[0] for item in struct.iter_unpack("<" + code, part)]
        consumed += len(part)
    equal(consumed, len(raw), "No unaccounted capture bytes")
    equal(len(columns["contentOffsets"]), 0, "Private-reference offset fallback input")
    equal(len(columns["contentLengths"]), 0, "Private-reference length fallback input")
    return columns

def reconstruct(call, columns, memory_before):
    count = call["rowCount"]
    unique = len(columns["resolvedOffsets"])
    equal(len(columns["uniqueIndexes"]), count, "Captured row indexes")
    equal(len(columns["scores"]), count, "Captured scores")
    equal(len(columns["resolvedLengths"]), unique, "Resolved column counts")
    base = call["contentOffsetBase"]
    integer(base, "Content base")
    dictionary = []
    score_indexes = {}
    keys = []
    offsets = []
    lengths = []
    for row in range(count):
        index = columns["uniqueIndexes"][row]
        require(0 <= index < unique, "Unique index bounds")
        length = columns["resolvedLengths"][index]
        require(0 <= length < 65535, "Compact length bounds")
        offset = columns["resolvedOffsets"][index]
        if offset == -1:
            delta = 0xffffffff
        else:
            require(math.isfinite(offset) and offset.is_integer() and 0 <= offset <= 9007199254740991, "Safe resolved offset")
            delta = int(offset) - base
            require(0 <= delta <= 0xfffffffe, "Compact offset delta")
        score = columns["scores"][row]
        if score not in score_indexes:
            score_indexes[score] = len(dictionary)
            dictionary.append(score)
        keys.append(score_indexes[score])
        offsets.append(delta)
        lengths.append(length)
    score_count = len(dictionary)
    require(0 < score_count < 65535, "Compact score count")
    output_size = 16 + score_count * 4 + count * 8
    require(output_size < count * 12, "Compact size is strictly smaller")
    output = bytearray(output_size)
    struct.pack_into("<4I", output, 0, 0x3246524d, count, score_count, 2)
    cursor = 16
    for values, code, width in ((dictionary, "i", 4), (offsets, "I", 4), (lengths, "H", 2), (keys, "H", 2)):
        for value in values:
            struct.pack_into("<" + code, output, cursor, value)
            cursor += width
    equal(cursor, output_size, "Complete reconstructed output")
    equal(bytes(output), columns["output"], "Every original output byte")
    equal(score_count, call["scoreCount"], "Captured score dictionary count")
    capacity = min(count, 65535)
    slots = 2
    while slots < capacity * 2:
        slots *= 2
    cursor = 131072
    for size, alignment in ((count * 4, 4), (count * 4, 4), (unique * 8, 8), (unique * 4, 4),
                            (slots * 4, 4), (capacity * 4, 4), (count * 2, 2), (count * 12, 4)):
        cursor = (cursor + alignment - 1) // alignment * alignment
        cursor += size
    memory_after = max(memory_before, (cursor + 65535) // 65536 * 65536)
    stats = {"native": True, "fallback": None, "inputCopiedBytes": count * 8 + unique * 12,
             "inputCopyCalls": 4, "outputCopiedBytes": output_size, "tableZeroedBytes": slots * 4,
             "scratchBytes": slots * 4 + capacity * 4 + count * 2, "memoryGrowthBytes": memory_after - memory_before,
             "rows": count, "uniqueRows": unique, "slotCount": slots, "outputCapacityBytes": count * 12,
             "layoutEndBytes": cursor, "memoryBytesBefore": memory_before, "memoryBytesAfter": memory_after,
             "nativeReturn": output_size, "scoreCount": score_count,
             "nativeDictionaryCopiedBytes": score_count * 4, "nativeKeysCopiedBytes": count * 2}
    return bytes(output), stats

def verify_captures(plan, frozen):
    capture = read_json(frozen / "evidence/stage1/run/record-field-calls.json")
    equal(capture["complete"], True, "Complete capture")
    equal(capture["stockOutputsConsumed"], True, "Stock capture consumption")
    calls = capture["calls"]
    equal(len(calls), 12, "Every actual sink call")
    equal(sum(call["rowCount"] for call in calls), 528299, "Every captured row")
    output_digest = hashlib.sha256()
    derived = []
    memory = 131072
    for index, call in enumerate(calls):
        equal(call["number"], index, "Capture call number")
        equal(call["groupIndex"], index, "Capture original group")
        output, stats = reconstruct(call, read_call(frozen, call), memory)
        memory = stats["memoryBytesAfter"]
        item = {"number": index, "groupIndex": index, "rows": call["rowCount"], "outputBytes": len(output),
                "outputSha256": digest(output), "stats": stats}
        equal(item, plan["expectedCalls"][index], "Independently reconstructed complete call")
        derived.append(item)
        output_digest.update(struct.pack("<I", len(output)))
        output_digest.update(output)
    equal(output_digest.hexdigest(), OUTPUT_DIGEST, "Complete captured output digest")
    totals = {}
    for key in ("rows", "uniqueRows", "inputCopiedBytes", "inputCopyCalls", "outputCopiedBytes",
                "tableZeroedBytes", "scratchBytes", "memoryGrowthBytes", "nativeDictionaryCopiedBytes",
                "nativeKeysCopiedBytes", "scoreCount"):
        totals[key] = sum(item["stats"][key] for item in derived)
    totals.update({"maximumScratchBytes": max(item["stats"]["scratchBytes"] for item in derived),
                   "maximumLinearMemoryBytes": max(item["stats"]["memoryBytesAfter"] for item in derived),
                   "initialLinearMemoryBytes": 131072, "nativeCalls": 12, "fallbackCalls": 0,
                   "totalInputAndOutputCopyBytes": totals["inputCopiedBytes"] + totals["outputCopiedBytes"]})
    equal(totals, plan["expectedTotals"], "Independent complete work totals")
    return capture, derived, totals

def verify_preparation(evidence, frozen, plan):
    preparation = read_json(evidence / "preparation.json")
    equal(preparation.get("complete"), True, "Completed original preparation")
    equal(preparation.get("timingAcquisition"), False, "Preparation is untimed")
    equal(preparation.get("localUntimed"), False, "Hosted original preparation")
    equal(preparation.get("node"), "v22.22.0", "Preparation Node")
    equal(preparation.get("plannedNode"), "v22.22.0", "Preparation planned Node")
    equal(preparation.get("sources"), source_receipt(), "Preparation source identity")
    equal(preparation.get("schedule"), schedule_balance(), "Independent schedule balance")
    for key in ("compilerVersion", "linkerVersion"):
        require(re.search(r"\b21\.1\.8\b", preparation.get(key, "")) is not None, "Pinned " + key)
    equal(preparation.get("buildExitCode"), 0, "Original pinned build")
    equal(preparation.get("testExitCode"), 0, "Original focused tests")
    command = preparation["buildCommand"]
    equal(len(command), 13, "Original native build command arity")
    require(Path(command[0]).name == "clang-21", "Pinned compiler executable")
    require(command[1].startswith("-fuse-ld=") and Path(command[1].split("=", 1)[1]).name == "wasm-ld-21", "Pinned linker executable")
    equal(command[2:10], ["--target=wasm32", "-O3", "-nostdlib", "-mbulk-memory",
                         "-Wl,--no-entry", "-Wl,--import-memory", "-Wl,-z,stack-size=65536",
                         "-Wl,--strip-all"], "Original native compiler flags")
    equal(command[10], "-o", "Native output flag")
    require(command[11].endswith("/native-record-fields-1c413/rebuilt-record-fields.wasm"), "Original native build output")
    require(command[12].endswith("/" + KIT + "/record-fields.c"), "Original native build source")
    rebuilt = evidence / "rebuilt-record-fields.wasm"
    expected = {"bytes": plan["native"]["wasmBytes"], "sha256": plan["native"]["wasmSha256"]}
    equal({"bytes": rebuilt.stat().st_size, "sha256": file_digest(rebuilt)}, expected, "Actual reproduced WASM bytes")
    equal(preparation.get("rebuild"), expected, "Original rebuild receipt")
    tests_path = evidence / "focused-tests/001/report.json"
    tests = read_json(tests_path)
    equal(tests.get("complete"), True, "Complete focused behavior receipt")
    equal(tests.get("timingAcquisition"), False, "Focused tests untimed")
    equal(tests.get("node"), "v22.22.0", "Focused test Node")
    equal([tests.get("cases"), tests.get("passed"), tests.get("failed")], [51, 51, 0], "Every focused case")
    expected_tests = read_json(frozen / "evidence/stage1/test-attempts/003/report.json")
    equal(tests.get("results"), expected_tests["results"], "Exact ordered focused cases, including duplicate display names")
    expected_hashes = {name: file_digest(frozen / name) for name in
                       ("record-fields.c", "record-fields.wasm", "native-wrapper.mjs", "tests.mjs", "export-hook.mjs")}
    equal(tests.get("sourceHashes"), expected_hashes, "Focused test source bytes")
    equal(preparation.get("tests"), {"passed": 51, "failed": 0, "reportSha256": file_digest(tests_path)}, "Focused test receipt binding")
    return preparation

def raw_timing(timing):
    require(type(timing) is dict, "Missing original clock interval")
    for position in ("cpuBefore", "cpuAfter"):
        equal(set(timing[position]), {"user", "system"}, "Raw CPU clock fields")
        for key in ("user", "system"):
            integer(timing[position][key], position + "." + key)
    user = timing["cpuAfter"]["user"] - timing["cpuBefore"]["user"]
    system = timing["cpuAfter"]["system"] - timing["cpuBefore"]["system"]
    require(user >= 0 and system >= 0 and user + system > 0, "Invalid CPU interval")
    for key in ("wallBeforeNs", "wallAfterNs"):
        require(type(timing[key]) is str and timing[key].isdecimal() and str(int(timing[key])) == timing[key], "Invalid wall nanoseconds")
    wall_ns = int(timing["wallAfterNs"]) - int(timing["wallBeforeNs"])
    require(0 < wall_ns <= 9007199254740991, "Invalid wall interval")
    result = {"cpuMs": (user + system) / 1000, "wallMs": float(wall_ns) / 1000000}
    equal(timing["cpuUserMicros"], user, "CPU user delta")
    equal(timing["cpuSystemMicros"], system, "CPU system delta")
    for key, value in result.items():
        equal(timing[key], value, "Recomputed " + key)
    return result

def verify_observation(receipt, entry, derived, capture, encoder, affinity):
    equal(receipt.get("complete"), True, "Completed original child")
    equal(receipt.get("arm"), entry["arm"], "Child arm")
    equal(receipt.get("mode"), entry["mode"], "Child timing mode")
    equal(receipt.get("node"), "v22.22.0", "Pinned child Node")
    integer(receipt.get("pid"), "Child PID", 1)
    equal(receipt.get("flags"), FLAGS, "Child flags and compile cache")
    equal(receipt.get("source"), source_receipt(), "Child source")
    equal(receipt.get("affinity"), str(affinity["selectedCpu"]), "Child original affinity")
    equal(receipt.get("helperInitializationError"), None, "Helper preparation succeeded")
    hook = receipt["diagnosticExport"]
    require(type(hook.get("path")) is str and hook["path"].endswith("/ext/js/dictionary/term-record-opfs-store.js"), "Diagnostic export source path")
    equal(hook.get("originalSha256"), digest(encoder), "Diagnostic stock source hash")
    equal(hook.get("appendedExport"), EXPORT, "Only the frozen diagnostic export")
    equal(hook.get("instrumentedSha256"), digest(encoder + EXPORT.encode()), "Diagnostic module bytes")
    equal(hook.get("productFunctionBodiesUnchanged"), True, "Unchanged stock function bodies")
    equal(receipt.get("outputDigest"), OUTPUT_DIGEST, "All original output hashes")
    outputs = receipt["outputReceipts"]
    equal(len(outputs), 12, "Complete output list")
    for index, actual in enumerate(outputs):
        item = derived[index]
        expected = {"number": index, "rows": item["rows"], "completeBytesEqual": True,
                    "bytes": item["outputBytes"], "sha256": item["outputSha256"],
                    "retainedBytes": {"directory": "frozen-kit/evidence/stage1/run",
                                      "file": capture["calls"][index]["file"], "segment": "output"}}
        equal(actual, expected, "Owning output receipt " + str(index))
    expected_stats = [item["stats"] for item in derived] if entry["arm"] == "B" else [None] * 12
    equal(receipt.get("nativeStats"), expected_stats, "Every native activation/copy/scratch/growth count")
    if entry["mode"] == "untimed":
        equal(receipt.get("timing"), None, "Warmup has no recorded timing")
        equal(receipt.get("resourceUsageAfterSequence"), None, "Warmup resource usage is not a measured sample")
        return None
    metrics = raw_timing(receipt["timing"])
    resources = receipt.get("resourceUsageAfterSequence")
    require(type(resources) is dict and resources, "Retained process resource snapshot")
    for key, value in resources.items():
        integer(value, "Original resource " + key)
    return metrics

def contrast(observations, candidate, control, metric):
    pairs = []
    for block in range(12):
        selected = {item["arm"]: item for item in observations if item["phase"] == "measured" and item["block"] == block}
        require(candidate in selected and control in selected, "Incomplete contrast")
        a = selected[control]["timing"][metric]
        b = selected[candidate]["timing"][metric]
        require(a > 0 and b > 0, "Nonpositive contrast interval")
        pairs.append({"block": block, "candidate": b, "control": a,
                      "percent": 100 * (b / a - 1), "saving": a - b})
    def sequential_sum(key):
        result = 0.0
        for pair in pairs:
            result += pair[key]
        return result
    return {"candidate": candidate, "control": control, "metric": metric, "pairs": pairs,
            "medianPercent": statistics.median(pair["percent"] for pair in pairs),
            "medianSaving": statistics.median(pair["saving"] for pair in pairs),
            "equalWorkPercent": 100 * (sequential_sum("candidate") / sequential_sum("control") - 1),
            "fasterPairs": sum(pair["candidate"] < pair["control"] for pair in pairs)}

def gate_checks(contrasts):
    cpu = contrasts["cpuMs"]
    return {
        "BoverAMedianReduction": cpu["BoverA"]["medianPercent"] <= -20,
        "BoverCMedianReduction": cpu["BoverC"]["medianPercent"] <= -20,
        "BoverAMedianSaving": cpu["BoverA"]["medianSaving"] >= 5,
        "BoverCMedianSaving": cpu["BoverC"]["medianSaving"] >= 5,
        "BoverAFasterPairs": cpu["BoverA"]["fasterPairs"] >= 9,
        "BoverCFasterPairs": cpu["BoverC"]["fasterPairs"] >= 9,
        "controlMedianStable": abs(cpu["CoverA"]["medianPercent"]) <= 3,
        "controlEqualWorkStable": abs(cpu["CoverA"]["equalWorkPercent"]) <= 3,
        "allSourceOutputAndWorkIdentitiesPassed": True,
    }

def verify_screen(evidence, derived, capture, encoder):
    screen = evidence / "screen"
    acquisition = read_json(screen / "acquisition.json")
    observations = read_json(screen / "observations.json")
    expected = expected_schedule()
    equal(acquisition.get("untimedOnly"), False, "Original timed acquisition")
    equal(acquisition.get("timingAcquisition"), True, "Original timing declaration")
    equal(acquisition.get("plannedNode"), "v22.22.0", "Acquisition planned Node")
    equal(acquisition.get("node"), "v22.22.0", "Acquisition actual Node")
    equal(acquisition.get("source"), source_receipt(), "Acquisition source")
    equal(acquisition.get("schedule"), expected, "Every frozen schedule position")
    equal(acquisition.get("flags"), {"parentExecArgv": [], "childExecArgv": [], "compileCacheDisabled": True,
          "removedChildEnvironmentOptions": ["NODE_COMPILE_CACHE", "NODE_OPTIONS", "NODE_V8_COVERAGE"]}, "Acquisition flags")
    affinity = read_json(evidence / "affinity.json")
    allowed = affinity["initialAllowedCpus"]
    require(type(allowed) is list and allowed and allowed == sorted(set(allowed)), "Original allowed CPUs")
    for cpu in allowed:
        integer(cpu, "Allowed CPU")
    selected = allowed[1] if len(allowed) > 1 else allowed[0]
    equal(affinity["selectedCpu"], selected, "Prospective CPU choice")
    equal(affinity["activeCpus"], [selected], "Exactly one original CPU")
    equal(affinity["rule"], "second allowed CPU, or sole CPU when only one is available", "Affinity rule")
    equal(acquisition.get("affinity"), affinity, "Acquisition affinity receipt")
    equal(acquisition["host"]["affinity"], str(selected), "Original parent affinity")
    equal(acquisition["host"]["platform"], "linux", "Original observation platform, not audit host")
    equal(acquisition.get("attempted"), len(observations), "Every attempted observation retained")
    require(0 <= len(observations) <= 42, "Original observation count")
    expected_names = [f"{index:03d}-{entry['phase']}-{entry['arm']}" for index, entry in enumerate(expected)]
    raw_names = {path.parent.name for path in (screen / "observations").glob("*/receipt.json")}
    require(raw_names <= set(expected_names), "Unexpected extra original receipt")
    failures = []
    checks = []
    pids = []
    for index, entry in enumerate(expected):
        name = expected_names[index]
        try:
            require(index < len(observations), "Planned observation was not attempted")
            aggregate = observations[index]
            for key, value in {**entry, "index": index, "name": name, "exitCode": 0, "signal": None, "spawnError": None}.items():
                equal(aggregate.get(key), value, "Aggregate observation " + key)
            receipt = read_json(screen / "observations" / name / "receipt.json")
            merged = {**entry, "index": index, "name": name, "exitCode": 0, "signal": None, "spawnError": None, **receipt}
            equal(aggregate, merged, "Aggregate/raw receipt exact binding")
            timing = verify_observation(receipt, entry, derived, capture, encoder, affinity)
            pids.append(receipt["pid"])
            stdout_path = screen / "observations" / (name + ".stdout.txt")
            stderr_path = screen / "observations" / (name + ".stderr.txt")
            require(stdout_path.is_file() and stderr_path.is_file(), "Original child streams")
            lines = [line for line in stdout_path.read_text().splitlines() if line]
            equal(len(lines), 1, "One original child completion")
            equal(parse_json(lines[0]), {"complete": True, "arm": entry["arm"], "mode": entry["mode"],
                  "timing": receipt["timing"], "outputDigest": OUTPUT_DIGEST}, "Original child stdout binding")
            checks.append({"index": index, "name": name, "passed": True, "recomputedTiming": timing,
                           "rawReceiptSha256": file_digest(screen / "observations" / name / "receipt.json"),
                           "stdoutSha256": file_digest(stdout_path), "stderrSha256": file_digest(stderr_path)})
        except Exception as error:
            failures.append({"index": index, "name": name, "error": type(error).__name__ + ": " + str(error)})
            checks.append({"index": index, "name": name, "passed": False, "error": failures[-1]["error"]})
    complete = acquisition.get("complete") is True and len(observations) == 42 and not failures
    if len(pids) != len(set(pids)):
        failures.append({"error": "Duplicate PIDs do not establish independent fresh subprocesses"})
        complete = False
    result = {"complete": complete, "observedAttempts": len(observations), "requiredObservations": 42,
              "rawObservationChecks": checks, "failures": failures, "firstFailure": failures[0] if failures else None,
              "producerComplete": acquisition.get("complete"), "producerError": acquisition.get("error"),
              "contrasts": None, "gateChecks": None, "nominationGatePassed": False}
    if not complete:
        return result
    equal(raw_names, set(expected_names), "Every raw receipt present")
    contrasts = {metric: {name: contrast(observations, candidate, control, metric)
                          for name, candidate, control in (("BoverA", "B", "A"), ("BoverC", "B", "C"), ("CoverA", "C", "A"))}
                 for metric in ("cpuMs", "wallMs")}
    checks = gate_checks(contrasts)
    recomputed = {"complete": True, "componentOnly": True, "independentWholeBrowserQualificationRequired": True,
                  "measuredObservations": 36, "warmupObservations": 6, "contrasts": contrasts,
                  "gate": GATE, "checks": checks, "nominationGatePassed": all(checks.values()), "noObservationsRemoved": True}
    equal(read_json(screen / "summary.json"), recomputed, "Complete original summary independently recomputed")
    result.update({"contrasts": contrasts, "gateChecks": checks, "nominationGatePassed": all(checks.values())})
    return result

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--published-checkout", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    require(not output.exists(), "Audit output must be new")
    output.mkdir(parents=True)
    report = {"schemaVersion": 1, "auditorVersion": "reconstructed-hosted-v1",
              "originalRunId": RUN, "originalHead": HEAD, "componentOnly": True,
              "independentWholeBrowserQualificationRequired": True,
              "newTimingOrImportAcquired": False, "benchmarkCodeExecuted": False,
              "archiveIntegrityPassed": False, "sourceAndCaptureIntegrityPassed": False,
              "allOriginalJobsSucceeded": False, "auditPassed": False,
              "nominationGatePassed": False, "qualifiedForComponentNomination": False,
              "limitations": [
                  "This is a newly reconstructed auditor; it is not byte-identical to the unavailable local f00dc30b auditor.",
                  "The original runner deduplicated matching owning output bytes only after full comparison. This audit reconstructs all retained common output bytes and binds every raw observation receipt.",
                  "Original Linux Node clocks, affinity, flags and resource snapshots are data. No audit-host timing or runtime result enters the comparison.",
                  "A component nomination never establishes complete-browser import benefit."
              ]}
    try:
        manifest = read_json(args.manifest)
        equal(manifest.get("schemaVersion"), 1, "Audit manifest schema")
        equal(manifest.get("enabled"), True, "Explicit original-artifact audit authorization")
        equal(manifest.get("repository"), REPO, "Audit repository")
        equal(manifest.get("runId"), RUN, "Frozen run")
        equal(manifest.get("headSha"), HEAD, "Frozen head")
        equal(manifest.get("jobId"), JOB, "Frozen job")
        artifact = manifest["artifact"]
        integer(artifact.get("id"), "Frozen artifact ID", 1)
        integer(artifact.get("sizeBytes"), "Frozen artifact size", 1)
        require(HEX64.fullmatch(artifact.get("sha256", "")) is not None, "Frozen artifact SHA256")
        equal(artifact.get("name"), "native-record-fields-1c413-" + HEAD, "Frozen artifact name")
        write_json(output / "audit-manifest.json", manifest)
        api = GitHub(REPO, output)
        original = publication(api)
        report["allOriginalJobsSucceeded"] = original["allOriginalJobsSucceeded"]
        archive, metadata = api.artifact(artifact, {"runId": RUN, "headSha": HEAD, "headBranch": BRANCH}, output)
        inventory = preserve_archive(archive, output / "original-evidence", metadata)
        report["archiveIntegrityPassed"] = True
        report["artifact"] = {"id": artifact["id"], "sha256": artifact["sha256"], "sizeBytes": artifact["sizeBytes"],
                              "members": len(inventory["members"])}
        roots = list((output / "original-evidence").rglob("preparation.json"))
        equal(len(roots), 1, "One original component artifact root")
        evidence = roots[0].parent
        report["originalEvidenceRoot"] = str(evidence.relative_to(output))
        plan, frozen, encoder = verify_frozen_sources(evidence, args.published_checkout.resolve(), api)
        capture, derived, totals = verify_captures(plan, frozen)
        report["sourceAndCaptureIntegrityPassed"] = True
        write_json(output / "independent-capture-work.json", {"calls": derived, "totals": totals, "outputDigest": OUTPUT_DIGEST})
        verify_preparation(evidence, frozen, plan)
        screen = verify_screen(evidence, derived, capture, encoder)
        write_json(output / "independent-screen-audit.json", screen)
        report["screenComplete"] = screen["complete"]
        report["auditPassed"] = screen["complete"]
        report["nominationGatePassed"] = screen["nominationGatePassed"]
        report["qualifiedForComponentNomination"] = screen["complete"] and screen["nominationGatePassed"] and original["allOriginalJobsSucceeded"]
        if screen["contrasts"] is not None:
            report["contrasts"] = {metric: {name: {key: value for key, value in item.items() if key != "pairs"}
                                             for name, item in contrasts.items()}
                                   for metric, contrasts in screen["contrasts"].items()}
        report["firstFailure"] = screen["firstFailure"]
        # Keep the small original artifact ZIP as well as every extracted member.
        # No original bytes or failed attempts are deleted by this hosted audit.
        report["originalArchiveRetained"] = archive.name
    except Exception as error:
        report["error"] = type(error).__name__ + ": " + str(error)
    finally:
        write_json(output / "final-audit.json", report)
        print(json.dumps(report, sort_keys=True, allow_nan=False))
    return 0 if report["auditPassed"] else 1

if __name__ == "__main__":
    raise SystemExit(main())
