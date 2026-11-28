#!/usr/bin/env python3
"""Read-only audit of exact original native-field correctness artifacts."""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import importlib.util
import json
from pathlib import Path, PurePosixPath
import re
import tarfile
import zipfile

from transport import (
    AuditError, GitHub, MAX_EXPANDED, MAX_MEMBER, MAX_MEMBERS,
    digest, file_digest, inspect_zip, parse_json, read_json, require,
    safe_name, stream_digest, write_json,
)

REPOSITORY = "ManabiIO/manabitan"
BASELINE = "f28c2801fcfd9416f220b46b9cbafeee901c1cb2"
BASELINE_TREE = "b428d0c9fa18e4956f3e2b182cae934de78e8f63"
PRODUCT = "8982dd89fac525100bdcaca7507bfff7feb2c842"
PRODUCT_TREE = "76f8a0cbe2b3820b5e33d16b5f3a4f836ef0860d"
CANDIDATE = "5cfbd2ebd21e6a814be976aa496afcde70d35e47"
CANDIDATE_TREE = "71bb7a59810ebdfcd2ee896d8d269ed83e92ebaf"
BRANCH = "test/native-record-fields-current-20261128-1c413"
RUN_ID = 46133913032
JOB_IDS = {"validation": 140944881152, "corpus": 140944880913}
JOB_NAMES = {
    "validation": "Rebuild, complete units, types, lint and all-target builds",
    "corpus": "Untimed original baseline and candidate importer parity",
}
KIT = "dev/perf/native-record-fields-recovery-20261128-1c413"
CORPUS = KIT + "/corpus"
WORKFLOW = ".github/workflows/native-record-fields-correctness-1c413.yml"
CORPUS_ROOT = "builds/perf/native-record-fields-correctness-corpus"
VALIDATION_ROOT = "builds/perf/native-record-fields-correctness"
TAR_NAME = "native-record-fields-corpus-evidence.tar.gz"
TAR_RECEIPT = "native-record-fields-corpus-evidence.json"
RUNTIME_DELTA = {
    "js/dictionary/dictionary-database.js", "js/dictionary/term-record-opfs-store.js",
    "js/dictionary/term-record-fields.js", "js/dictionary/wasm/term-record-fields.c",
    "lib/term-record-fields.wasm",
}
GROUPS = {"jmdict": 12, "jitendex": 22, "vndb": 170}
PARSER_KEYS = (
    "fastPathParserFusedAttempts", "fastPathParserFusedFallbacks",
    "fastPathParserSourceTransferredBytes",
    "fastPathParserSourceCrcScannedBytes", "fastPathParserSourceCrcReusedBytes",
    "fastPathParserSourceCrcReusedGlossaryCount",
    "fastPathParserSourceCompressedBytes", "fastPathParserSourceUncompressedBytes",
    "fastPathParserCompactContentMetadataGroups",
    "fastPathParserParallelWorkerCount", "fastPathParserParallelPipelineGroupsPerWorker",
    "fastPathParserParallelGroupCount", "fastPathParserParallelSkipReason",
)
REQUIRED_STEPS = {
    "source": "Bind the original attempt and exact reconstructed source",
    "setup": "Prepare the pinned Node runtime and dependencies",
    "generated": "Bind generated assets and the setup-produced license document",
    "toolchain": "Install the pinned native toolchain",
    "native": "Reproduce every checked-in native target",
    "lint": "Changed-source lint",
    "unit": "Complete ordinary unit suite",
    "options": "Complete options unit suite",
    "main_types": "Complete main-source types",
    "dev_types": "Complete development-source types",
    "test_types": "Complete test-source types",
    "builds": "All-target dry builds",
}
PROTECTED_FIXED = {
    "dev/bin/build-dictionary-wasm.js", "dev/perf/prepare-dictionaries.js",
    "package.json", "package-lock.json", ".github/actions/setup/action.yml",
    "test/perf/dictionaries.lock.json", "dev/perf/import-qualification-20261125-a7f7.py",
    "test/chromium/extension-two-dictionary-import.e2e.js", "test/e2e/import-timing.js",
    "dev/data/dictionary-wasm/term-bank-parser.wasm",
    "dev/data/dictionary-wasm/term-content-canonical-scan-v1.wasm",
}
NATIVE_ASSETS = (
    "term-content-canonical-scan-v1.wasm", "term-bank-parser.wasm", "term-record-fields.wasm",
)
VALIDATION_LOGS = {
    "apt-update.log", "apt-install.log", "native-build.log", "lint.log",
    "unit.log", "unit-options.log", "types-main.log", "types-dev.log",
    "types-test.log", "dry-build.log",
}
CRC_POLICY_SOURCES = {
    "ext/js/dictionary/dictionary-importer.js": "e5863de2d3a0e827c514db48c6a24f62f03d6a2b",
    "ext/js/dictionary/term-bank-wasm-parser.js": "4f3f7e73c78bca23672f46588cb897633fc7a4ac",
    "ext/js/dictionary/term-bank-wasm-parser-worker.js": "82808931b73e099a604c598460cdeaed43d67bd5",
    "ext/js/dictionary/term-bank-source-crc.js": "47ad13920a149c643c06862c1c62b2b1ed9f2036",
    "ext/js/dictionary/term-bank-experiments.js": "38ffe9035ffad5a4cb00de5406ce2dda5b823b4c",
    "ext/js/dictionary/wasm/term-bank-parser.c": "403272a3e65cbd4084f6211a46df7d3db78979ac",
    CORPUS + "/run.mjs": "97963dba2500c4ba557ec2c2b2367b74199e6ced",
}
CRC_REUSE_MIN_SOURCE_BYTES = 4 * 1024 * 1024
CRC_REUSE_MIN_COMPRESSION_RATIO = 32
TRANSPORT_SHA256 = "1c3c6f1c180eb8512146e7999561d8fd8cfdf10efb693a54b21d805a3a2a0aa6"
ACTIVATION_SHA256 = "15c994658125015edaa4aae931ce82f122526bd4c0cc4e65286cd3975642010a"


def same(actual, expected, label):
    if type(actual) is set or type(expected) is set:
        require(type(actual) is set and type(expected) is set and actual == expected, label)
    else:
        require(json.dumps(actual, sort_keys=True, allow_nan=False) ==
                json.dumps(expected, sort_keys=True, allow_nan=False), label)


def identity(path):
    return {"bytes": Path(path).stat().st_size, "sha256": file_digest(path)}


def git_blob(data):
    return hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()


def file_git_blob(path):
    path = Path(path)
    result = hashlib.sha1(b"blob " + str(path.stat().st_size).encode() + b"\0")
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def integer(value, name, minimum=0):
    require(type(value) is int and minimum <= value <= 2 ** 53 - 1, "Invalid safe integer: " + name)
    return value


def object_digest(value):
    return digest(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode())


def load_activation(source_directory):
    path = Path(source_directory) / "field_activation.py"
    require(file_digest(path) == ACTIVATION_SHA256, "Reviewed pure activation helper differs")
    spec = importlib.util.spec_from_file_location("correctness_field_activation", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module



def opaque_kit_bytecode(path):
    """Optional generated evidence only; it is never materialized or imported."""
    return (
        re.fullmatch(re.escape(KIT) + r"/__pycache__/archive-evidence\.cpython-[0-9]+\.pyc", path) is not None or
        re.fullmatch(re.escape(CORPUS) + r"/__pycache__/run-all\.cpython-[0-9]+\.pyc", path) is not None
    )

def extract_zip(path, destination):
    destination = Path(destination)
    destination.mkdir()
    manifest = {}
    with zipfile.ZipFile(path) as archive:
        for info in inspect_zip(archive):
            name = str(safe_name(info.filename))
            target = destination / name
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                manifest[name] = {"kind": "directory"}
                continue
            if opaque_kit_bytecode(name):
                with archive.open(info) as source:
                    value = stream_digest(source, expected=info.file_size)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(info) as source, target.open("xb") as output:
                    value = stream_digest(source, output, info.file_size)
                value["gitBlob"] = file_git_blob(target)
            value["kind"] = "file"
            manifest[name] = value
    return manifest


def inside(name, root):
    return name == root or name.startswith(root + "/")


def validate_tar_manifest(receipt):
    require(type(receipt) is dict and receipt.get("kind") == "complete-corpus-evidence-archive",
            "Unexpected corpus archive receipt")
    require(receipt.get("verified") is True and receipt.get("performanceMeasurements") is False,
            "Corpus archive was not verified or scope changed")
    same(receipt.get("archive"), TAR_NAME, "Corpus tar basename changed")
    members = receipt.get("members")
    require(type(members) is dict and len(members) <= MAX_MEMBERS, "Invalid tar member inventory")
    roots = (CORPUS_ROOT, KIT, WORKFLOW)
    require(type(receipt.get("missingRequestedRoots")) is list and
            len(receipt["missingRequestedRoots"]) == len(set(receipt["missingRequestedRoots"])) and
            set(receipt["missingRequestedRoots"]) <= set(roots), "Invalid missing-root receipt")
    nondirectories, total = set(), 0
    for name, item in members.items():
        require(str(safe_name(name)) == name, "Noncanonical tar receipt member")
        require(any(inside(name, root) for root in roots), "Tar member escaped the exact evidence/source roots")
        require(type(item) is dict, "Invalid tar member receipt")
        if item.get("kind") == "directory":
            same(set(item), {"kind"}, "Unexpected directory metadata")
        elif item.get("kind") == "symlink":
            same(set(item), {"kind", "target"}, "Unexpected symbolic-link metadata")
            require(type(item["target"]) is str and "\0" not in item["target"] and
                    len(item["target"].encode()) <= 1024 * 1024, "Invalid opaque symbolic-link target")
            nondirectories.add(name)
        else:
            same(set(item), {"kind", "bytes", "sha256"}, "Unexpected file metadata")
            require(item["kind"] == "file", "Unsupported tar member kind")
            require(integer(item["bytes"], "tar member bytes") <= MAX_MEMBER, "Oversized tar member")
            require(type(item["sha256"]) is str and re.fullmatch(r"[0-9a-f]{64}", item["sha256"]),
                    "Invalid tar member SHA256")
            total += item["bytes"]
            require(total <= MAX_EXPANDED, "Tar expanded-size bound exceeded")
            nondirectories.add(name)
    for name in members:
        require(not any(str(parent) in nondirectories for parent in PurePosixPath(name).parents if str(parent) != "."),
                "Tar file/directory collision")
    return members


def verify_tar(path, receipt, destination):
    """Hash every payload. Raw disk files stay in the exact retained tar, never extracted."""
    require(identity(path) == {"bytes": receipt["archiveBytes"], "sha256": receipt["archiveSha256"]},
            "Corpus tar identity differs from original archive receipt")
    members = validate_tar_manifest(receipt)
    destination = Path(destination)
    destination.mkdir()
    verified = {}
    with tarfile.open(path, "r|gz") as archive:
        for item in archive:
            name = item.name
            require(str(safe_name(name)) == name and name in members and name not in verified,
                    "Unknown, duplicate or noncanonical PAX member")
            require(not item.issparse() and not item.islnk(), "Sparse/hard-link tar members are not accepted")
            require(set(item.pax_headers) <= {"path", "linkpath", "mtime", "atime", "ctime", "size", "uid", "gid", "uname", "gname"},
                    "Unsupported PAX metadata")
            expected = members[name]
            if item.issym():
                require(item.size == 0 and expected == {"kind": "symlink", "target": item.linkname},
                        "Symbolic-link type or opaque target changed")
                # Preserve metadata only. Never follow, resolve or materialize a link.
                verified[name] = expected
                continue
            require(not item.linkname, "Unexpected link target on regular member")
            if item.isdir():
                require(expected == {"kind": "directory"} and item.size == 0, "Directory payload/type changed")
                verified[name] = {"kind": "directory"}
                continue
            require(item.isfile() and expected["kind"] == "file" and item.size == expected["bytes"],
                    "File type/size differs")
            source = archive.extractfile(item)
            require(source is not None, "Missing tar file payload")
            # Failed full raw sinks can be large. Their bytes are verified and retained
            # in the original archive, while receipt/source/log files are materialized.
            raw_disk = "/disk/" in "/" + name + "/" or name.endswith("/disk")
            target = destination / name
            if raw_disk or opaque_kit_bytecode(name):
                with source:
                    value = stream_digest(source, expected=item.size)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with source, target.open("xb") as output:
                    value = stream_digest(source, output, item.size)
            value["kind"] = "file"
            same(value, expected, "Archived member bytes differ: " + name)
            verified[name] = value
    same(verified, members, "Incomplete original tar inventory")
    return {"verified": True, "members": verified, "memberCount": len(verified),
            "rawDiskPayloadsRetainedInOriginalTar": True}


def bind_archived_sources(extracted, members, tree, required):
    seen = set()
    receipts = {}
    for path, member in members.items():
        if member["kind"] != "file":
            continue
        if path in tree and (inside(path, KIT) or path == WORKFLOW or path in required):
            data = (Path(extracted) / path).read_bytes()
            entry = tree[path]
            require(entry["mode"] in ("100644", "100755") and git_blob(data) == entry["sha"],
                    "Archived tracked source differs: " + path)
            receipts[path] = {"gitBlob": entry["sha"], "sha256": digest(data), "bytes": len(data)}
            seen.add(path)
        else:
            generated_cache = opaque_kit_bytecode(path)
            require(inside(path, CORPUS_ROOT) or inside(path, VALIDATION_ROOT) or generated_cache,
                    "Unexpected unbound artifact file: " + path)
            if generated_cache:
                receipts[path] = {
                    "opaqueGeneratedBytecode": True, "executedByReader": False,
                    **{key: member[key] for key in ("bytes", "sha256")},
                }
    require(set(required) <= seen, "A required original source file is missing from artifact")
    return receipts


def source_proof(path, api, source, generated=False):
    proof = read_json(path)
    if proof.get("passed") is not True:
        return {"passed": False, "original": proof, "identity": identity(path)}
    for key, value in (
        ("baseline", BASELINE), ("candidate", CANDIDATE), ("parent", PRODUCT),
        ("productCommit", PRODUCT), ("productParent", BASELINE), ("tree", CANDIDATE_TREE),
        ("timingAcquired", False), ("productExecution", False), ("kind", "source-only-validation"),
    ):
        same(proof.get(key), value, "Original source proof field differs: " + key)
    expected_paths = set(source["files"]) | {KIT + "/source.json"}
    same(proof.get("changedPaths"), sorted(expected_paths), "Original changed source inventory differs")
    protected = PROTECTED_FIXED | {
        name for name in api.tree(BASELINE)
        if name.startswith("dev/perf/import-memory-20261125-a7f7/")
    }
    require(len(protected) == 21, "Frozen baseline protected-source inventory changed")
    same(set(proof.get("protected", {})), protected, "Complete original protected-source inventory differs")
    expected_generated = {}
    if generated:
        for name in NATIVE_ASSETS:
            data = api.source(CANDIDATE, "dev/data/dictionary-wasm/" + name)
            expected_generated["ext/lib/" + name] = {"bytes": len(data), "sha256": digest(data)}
    same(proof.get("generatedAssets"), expected_generated, "Original generated native-asset proof differs")
    if not generated:
        same(proof.get("setupGeneratedDocuments"), {}, "Pre-setup source proof contains a generated document")

    same(proof["sourceDigest"], source["digest"], "Source proof aggregate differs")
    same(set(proof["sources"]), set(source["files"]) | {KIT + "/source.json"}, "Source proof file inventory differs")
    for group in ("sources", "protected"):
        for name, value in proof[group].items():
            data = api.source(CANDIDATE, name)
            same(value, {"gitBlob": git_blob(data), "sha256": digest(data), "bytes": len(data),
                         "mode": api.tree(CANDIDATE)[name]["mode"]}, "Source proof binding differs: " + name)
            if group == "protected":
                require(api.tree(BASELINE).get(name) == api.tree(CANDIDATE).get(name),
                        "Protected mode/blob differs from baseline")
    require(set(proof["setupGeneratedDocuments"]) <= {"ext/legal-npm.html"}, "Unexpected generated tracked exception")
    for name, value in proof["setupGeneratedDocuments"].items():
        same(value["committedSha256"], digest(api.source(CANDIDATE, name)), "Committed license SHA differs")
        require(re.fullmatch(r"[0-9a-f]{64}", value["sha256"]), "Invalid generated license SHA")
    return {"passed": True, "original": proof, "identity": identity(path)}


def runtime_delta(a, b):
    changed = sorted(path for path in set(a) | set(b) if a.get(path) != b.get(path))
    same(changed, sorted(RUNTIME_DELTA), "Exact five-entry complete runtime delta differs")
    return changed


def bind_runtime(value, commit, tree, api, kit_hashes):
    same(value["commit"], commit, "Actual importer commit differs")
    same(value["tree"], tree, "Actual importer tree differs")
    same(value["kit"], kit_hashes, "Actual driver source inventory differs")
    legal = value["setupGeneratedLicense"]
    same(legal["path"], "ext/legal-npm.html", "Setup exception path changed")
    data = api.source(commit, "ext/legal-npm.html")
    same(legal["committed"], {"bytes": len(data), "sha256": digest(data)}, "Committed license differs")
    same(legal["generated"], value["runtimeFiles"]["legal-npm.html"], "Generated license runtime differs")
    require(type(legal["listedTrackedDelta"]) is bool, "Invalid license dirty-state receipt")
    for path, recorded in value["sources"].items():
        target = ("dev/data/dictionary-wasm/" + Path(path).name
                  if path.startswith("ext/lib/") and path.endswith(".wasm") else path)
        if target not in api.tree(commit):
            require(recorded is None, "Untracked optional source unexpectedly present: " + path)
            continue
        data = api.source(commit, target)
        same(recorded, {"bytes": len(data), "sha256": digest(data)}, "Actual critical source differs: " + path)
    for path, item in value["runtimeFiles"].items():
        require(str(safe_name(path)) == path and set(item) == {"bytes", "sha256"},
                "Invalid full runtime inventory member")
        integer(item["bytes"], "runtime bytes")
        require(re.fullmatch(r"[0-9a-f]{64}", item["sha256"]), "Invalid runtime SHA")


def process_receipt(root, name, expected_suffix, dictionary=None, arm=None, commit=None):
    path = Path(root) / (name + ".process.json")
    value = read_json(path)
    require(value.get("exitCode") == 0, "Original subprocess did not succeed")
    same(value["log"], identity(Path(root) / (name + ".log")), "Original subprocess log hash differs")
    argv = value["argv"]
    require(type(argv) is list and argv[0] == "node" and argv[1].endswith(expected_suffix),
            "Original subprocess command differs")
    if dictionary is not None:
        require(len(argv) == 8 and argv[3] == dictionary and argv[6] == arm and argv[7] == commit,
                "Original importer arguments differ")
    return {"process": value, "identity": identity(path)}



def native_layout(rows, unique_count):
    """Recompute the immutable helper's bounded private layout; no native execution."""
    integer(rows, "native layout rows", 1)
    integer(unique_count, "native layout unique references", 1)
    score_capacity = min(rows, 65535)
    slots = 2
    while slots < 2 * score_capacity:
        slots *= 2
    cursor = 2 * 65536
    for size, alignment in (
        (rows * 4, 4), (rows * 4, 4), (unique_count * 8, 8),
        (unique_count * 4, 4), (slots * 4, 4), (score_capacity * 4, 4),
        (rows * 2, 2), (rows * 12, 4),
    ):
        cursor = (cursor + alignment - 1) // alignment * alignment + size
    require(cursor <= 1024 * 65536, "An attempted native layout exceeded the source-bound memory cap")
    return {
        "uniqueReferences": unique_count, "scoreCapacity": score_capacity,
        "slotCount": slots, "tableBytes": slots * 4,
        "scratchBytes": slots * 4 + score_capacity * 4 + rows * 2,
        "requiredMemoryBytes": (cursor + 65535) // 65536 * 65536,
        "layoutEnd": cursor,
    }

def counters(calls, final, fixture, activation):
    require(calls and all(type(item) is dict for item in calls), "Missing actual field-call inventory")
    require([item["ordinal"] for item in calls] == list(range(len(calls))), "Field-call order changed")
    require(sum(integer(item["rowCount"], "field rows", 1) for item in calls) == fixture["termRows"],
            "Incomplete complete-field row coverage")
    previous = None
    readiness = 0
    observations = []
    for index, call in enumerate(calls):
        before, after = call["before"], call["after"]
        require(type(before) is dict and type(after) is dict, "Missing actual before/after counters")
        for value, expected_calls in ((before, index), (after, index + 1)):
            same(set(value), {"calls", "javascriptCalls", "native"}, "Session metric keys differ")
            integer(value["calls"], "calls")
            require(value["calls"] == expected_calls, "Observed entry count differs")
            integer(value["javascriptCalls"], "javascriptCalls")
            native = value["native"]
            if native is not None:
                same(set(native), activation.NATIVE_COUNTERS | {"declines"}, "Native metric keys differ")
                for key in activation.NATIVE_COUNTERS:
                    integer(native[key], key)
                require(type(native["declines"]) is dict, "Invalid decline map")
                for key, count in native["declines"].items():
                    integer(count, "decline " + key)
            require(value["calls"] == value["javascriptCalls"] + (native or {}).get("nativeCalls", 0),
                    "Per-call session counters differ")
        if previous is None:
            require(before["javascriptCalls"] == 0, "Initial JavaScript count is not zero")
            if before["native"] is not None:
                initial = before["native"]
                require(initial["declines"] == {} and all(initial[key] == 0 for key in activation.NATIVE_COUNTERS
                         if key != "maximumLinearMemoryBytes") and
                        initial["maximumLinearMemoryBytes"] == activation.INITIAL_MEMORY_BYTES,
                        "Initial native state is not empty")
        if previous is not None:
            if previous["native"] is None and before["native"] is not None:
                same(before["calls"], previous["calls"], "Readiness changed calls")
                same(before["javascriptCalls"], previous["javascriptCalls"], "Readiness changed JS calls")
                initial = before["native"]
                require(initial["declines"] == {} and all(initial[key] == 0 for key in activation.NATIVE_COUNTERS
                         if key != "maximumLinearMemoryBytes") and
                        initial["maximumLinearMemoryBytes"] == activation.INITIAL_MEMORY_BYTES,
                        "Readiness created nonempty native counters")
            else:
                same(before, previous, "Counters changed between actual synchronous calls")
        if before["native"] is None:
            readiness += 1
            require(after["native"] is None, "Optional readiness changed inside a synchronous field call")
        old, new = before["native"] or {}, after["native"] or {}
        native_delta = new.get("nativeCalls", 0) - old.get("nativeCalls", 0)
        require(native_delta in (0, 1) and type(native_delta) is int, "Invalid native call delta")
        require(after["javascriptCalls"] - before["javascriptCalls"] == 1 - native_delta,
                "Each actual encoder entry must choose one path")
        require(new.get("nativeRows", 0) - old.get("nativeRows", 0) == native_delta * call["rowCount"],
                "Native row increment differs from actual buffer")
        require(new.get("outputCopiedBytes", 0) - old.get("outputCopiedBytes", 0) == native_delta * call["bytes"],
                "Native owned-output bytes differ from actual field buffer")
        for key in activation.NATIVE_COUNTERS:
            require(new.get(key, 0) >= old.get(key, 0), "Native counters decreased")
        for key, count in old.get("declines", {}).items():
            require(new.get("declines", {}).get(key, 0) >= count, "Decline count decreased")
        decline_deltas = {key: new.get("declines", {}).get(key, 0) - old.get("declines", {}).get(key, 0)
                          for key in set(new.get("declines", {})) | set(old.get("declines", {}))}
        decline_deltas = {key: value for key, value in decline_deltas.items() if value}
        ready_fallback = native_delta == 0 and before["native"] is not None
        require(sum(decline_deltas.values()) == int(ready_fallback), "One ready fallback must record exactly one decline")
        require(new.get("nativeAttempts", 0) - old.get("nativeAttempts", 0) ==
                native_delta + sum(decline_deltas.get(key, 0) for key in activation.ATTEMPT_DECLINES),
                "Per-call native attempt delta differs")
        layout = None
        score_count = None
        attempt_delta = new.get("nativeAttempts", 0) - old.get("nativeAttempts", 0)
        if attempt_delta:
            input_delta = new["inputCopiedBytes"] - old["inputCopiedBytes"]
            reference_bytes = input_delta - call["rowCount"] * 8
            require(reference_bytes > 0 and reference_bytes % 12 == 0,
                    "Attempted input copies do not contain exact row and unique-reference columns")
            layout = native_layout(call["rowCount"], reference_bytes // 12)
            require(new["tableBytesRequested"] - old["tableBytesRequested"] == layout["tableBytes"],
                    "Attempted score-table bytes differ from the source-bound layout")
            require(new["maximumScratchBytes"] == max(old["maximumScratchBytes"], layout["scratchBytes"]),
                    "Native scratch maximum differs from the source-bound layout")
            expected_memory = max(old["maximumLinearMemoryBytes"], layout["requiredMemoryBytes"])
            require(new["maximumLinearMemoryBytes"] == expected_memory and
                    new["memoryGrowthBytes"] - old["memoryGrowthBytes"] ==
                    expected_memory - old["maximumLinearMemoryBytes"],
                    "Native page growth or private memory maximum differs")
            if native_delta:
                score_bytes = call["bytes"] - 16 - call["rowCount"] * 8
                require(score_bytes > 0 and score_bytes % 4 == 0, "Native compact score table has invalid bytes")
                score_count = score_bytes // 4
                require(score_count < 65535 and score_count <= layout["scoreCapacity"] and
                        call["bytes"] < call["rowCount"] * 12, "Native compact output is outside exact format bounds")
        elif before["native"] is not None:
            for key in ("inputCopiedBytes", "tableBytesRequested", "memoryGrowthBytes",
                        "maximumLinearMemoryBytes", "maximumScratchBytes"):
                same(new[key], old[key], "A pre-attempt fallback changed private staging work: " + key)
        observations.append({"ordinal": index, "rowCount": call["rowCount"], "bytes": call["bytes"],
                             "native": native_delta == 1, "readinessJavascript": before["native"] is None,
                             "declines": decline_deltas, "nativeLayout": layout,
                             "compactScoreCount": score_count})
        previous = after
    same(final, calls[-1]["after"], "Final detached counters differ from last actual call")
    policy = {
        "expectedCalls": len(calls), "termRows": fixture["termRows"],
        "minimumNativeCalls": 1, "minimumNativeRows": 1,
        "maximumReadinessJavascriptCalls": len(calls) - 1,
        "allowedDeclineMaximums": {key: len(calls) for key in activation.ALLOWED_DECLINES},
    }
    checked = activation.validate_metrics(final, "B", policy)
    same(checked["readinessJavascriptCalls"], readiness, "Inferred readiness differs from observed before-call state")
    return {"actualCalls": observations, "final": checked, "readinessCallsObserved": readiness,
            "scope": "Original correctness activation gate; does not seal future browser coverage minima"}


def field_identity(calls):
    result = []
    for index, item in enumerate(calls):
        require(item["ordinal"] == index, "Field ordinal changed")
        integer(item["rowCount"], "rowCount", 1)
        integer(item["bytes"], "field bytes", 1)
        integer(item["contentOffsetBase"], "content base")
        require(re.fullmatch(r"[0-9a-f]{64}", item["sha256"]), "Invalid whole-field SHA")
        result.append({key: item[key] for key in ("ordinal", "rowCount", "contentOffsetBase", "bytes", "sha256")})
    return result


def term_inventory(report):
    rows = report["termFiles"]
    require(type(rows) is list and rows and len({item["path"] for item in rows}) == len(rows),
            "Invalid finalized term inventory")
    result = []
    for item in rows:
        require(item["termPayload"] is True, "Non-term payload in complete term inventory")
        require(str(safe_name(item["path"])) == item["path"], "Unsafe original term basename")
        integer(item["bytes"], "final term bytes", 1)
        for key in ("sha256", "normalizedSha256"):
            require(re.fullmatch(r"[0-9a-f]{64}", item[key]), "Invalid final term digest")
        normalization = item["normalization"]
        if item["path"].endswith(".mbtr"):
            same(normalization, {"offset": 8, "bytes": 16, "format": "MBTRD16X"}, "Record normalization changed")
        elif item["path"].endswith(".mbti"):
            same(normalization, {"offset": 24, "bytes": 16, "format": "MBTIDX11"}, "Lookup normalization changed")
        else:
            require(normalization is None and item["sha256"] == item["normalizedSha256"],
                    "Content bytes were normalized")
        result.append({key: item[key] for key in ("path", "bytes", "normalizedSha256", "normalization")})
    return sorted(result, key=lambda item: item["path"])


def parser_groups(workers):
    result = []
    for worker in workers:
        require(worker["failures"] == [], "Original worker failure")
        if worker["entry"] == "term-bank-wasm-parser-worker.js":
            require(worker["ready"] == 1, "Parser worker did not initialize once")
            for item in worker["parseRequests"]:
                require(item["banks"], "Actual compressed bank metadata missing")
                result.append({"banks": item["banks"], "sourceByteLengths": item["sourceByteLengths"]})
    return sorted(result, key=lambda item: json.dumps(item, sort_keys=True))



def group_field_plan(workers, calls, expected_groups, term_rows):
    """Join recorded parser results to their source banks and downstream field calls."""
    groups = []
    for worker in workers:
        require(worker["failures"] == [], "Original worker failed")
        if worker["entry"] != "term-bank-wasm-parser-worker.js":
            continue
        require(worker["ready"] == 1, "Parser worker readiness changed")
        results = {}
        for result in worker["parseResults"]:
            job_id = integer(result["id"], "parser result ID")
            require(job_id not in results, "Duplicate parser terminal result")
            results[job_id] = integer(result["rowCount"], "parser result rows", 1)
        requests = set()
        for request in worker["parseRequests"]:
            job_id = integer(request["id"], "parser request ID")
            require(job_id not in requests and job_id in results, "Duplicate or unmatched parser request")
            requests.add(job_id)
            banks = request["banks"]
            require(banks, "Empty actual parser source group")
            ordinals = []
            for bank in banks:
                match = re.fullmatch(r"term_bank_([1-9][0-9]*)\.json", bank["filename"])
                require(match is not None, "Unexpected pinned raw source-bank name")
                ordinals.append(int(match.group(1)))
            same(ordinals, list(range(ordinals[0], ordinals[0] + len(ordinals))),
                 "Source banks within a parser group are not contiguous")
            groups.append({"firstBank": ordinals[0], "banks": banks,
                           "sourceByteLengths": request["sourceByteLengths"], "rowCount": results[job_id]})
        same(requests, set(results), "A parser result has no source request")
    groups.sort(key=lambda item: item["firstBank"])
    require(len(groups) == expected_groups and sum(item["rowCount"] for item in groups) == term_rows,
            "Complete parser result rows/groups do not match the fixture")
    next_bank = 1
    call_index = 0
    for group in groups:
        require(group["firstBank"] == next_bank, "Actual complete source groups have a gap or overlap")
        next_bank += len(group["banks"])
        start = call_index
        rows = 0
        while rows < group["rowCount"]:
            require(call_index < len(calls), "Field calls end before their source group")
            rows += integer(calls[call_index]["rowCount"], "group field rows", 1)
            require(rows <= group["rowCount"], "A field call crosses an actual parser group boundary")
            call_index += 1
        group["fieldCallOrdinals"] = list(range(start, call_index))
        group["fieldCallRows"] = [item["rowCount"] for item in calls[start:call_index]]
    require(call_index == len(calls), "Unattributed field calls remain after all parser groups")
    return {
        "groups": groups, "groupCount": len(groups), "sourceBankCount": next_bank - 1,
        "fieldCallCount": len(calls), "termRows": term_rows,
        "splitGroupCount": sum(len(item["fieldCallOrdinals"]) > 1 for item in groups),
        "extraFieldCallsBeyondGroups": len(calls) - len(groups),
        "scope": "Actual recorded parser request/result and complete field-row boundaries; no inferred browser execution",
    }

def parser_counts(phases):
    details = [item["details"] for item in phases if item["phase"] == "import-data-banks"]
    require(len(details) == 1 and all(key in details[0] for key in PARSER_KEYS), "Missing original parser work counts")
    return {key: details[0][key] for key in PARSER_KEYS}


def crc_policy_sources(api):
    """Bind the route/defaults/metric semantics used below; never execute source."""
    result = {}
    candidate_tree = api.tree(CANDIDATE)
    baseline_tree = api.tree(BASELINE)
    for path, expected_blob in CRC_POLICY_SOURCES.items():
        entry = candidate_tree.get(path)
        require(entry is not None and entry["sha"] == expected_blob and entry["mode"] == "100644",
                "Source CRC policy binding changed: " + path)
        if path.startswith("ext/"):
            same(baseline_tree.get(path), entry, "A/B CRC route or policy source differs: " + path)
        data = api.source(CANDIDATE, path)
        same(git_blob(data), expected_blob, "Source CRC policy bytes changed: " + path)
        result[path] = {"gitBlob": expected_blob, "bytes": len(data), "sha256": digest(data)}
    return {
        "sources": result,
        "versionAndValidation": "The pinned importer admits the recorded compressed-worker route only for version3 and sets validateGlossaryTypes=true; request receipts do not independently record those options",
        "defaults": "The pinned driver supplies only its bound ordinary flags; snapshot defaults enable validated glossary reuse and disable skip-fused parsing",
        "nativeVerifier": "The unchanged source-bound native parser exports verify_term_bank_source_crcs; complete original native rebuild and parser asset identities are separately required",
        "metricScope": "Only deferred verification writes scanned/reused counters; immediate inflation validates original CRCs but worker metrics report0",
    }


def crc_coverage(phases, plan, counts):
    """Check deferred-only metric conservation against actual original source groups."""
    details = [item["details"] for item in phases if item["phase"] == "import-data-banks"]
    require(len(details) == 1, "Missing actual CRC experiment receipt")
    effective = details[0].get("fastPathParserEffectiveExperiments")
    require(type(effective) is dict and effective.get("experimentalValidatedGlossaryReuse") is True and
            effective.get("experimentalSkipFusedParse") is False,
            "Actual CRC experiment defaults differ from the source-bound route")
    groups = plan["groups"]
    deferred_bytes = immediate_bytes = compressed_bytes = deferred_rows = 0
    observed_groups = []
    for ordinal, group in enumerate(groups):
        banks = group["banks"]
        require(type(banks) is list and banks, "Missing original CRC group metadata")
        compressed = sum(integer(bank["compressedSize"], "CRC compressed size") for bank in banks)
        uncompressed = sum(integer(bank["uncompressedSize"], "CRC uncompressed size") for bank in banks)
        rows = integer(group["rowCount"], "CRC source group rows", 1)
        deferred = (len(banks) > 1 and uncompressed >= CRC_REUSE_MIN_SOURCE_BYTES and
                    compressed <= uncompressed // CRC_REUSE_MIN_COMPRESSION_RATIO)
        compressed_bytes += compressed
        if deferred:
            deferred_bytes += uncompressed
            deferred_rows += rows
        else:
            immediate_bytes += uncompressed
        observed_groups.append({
            "ordinal": ordinal, "bankCount": len(banks), "rowCount": rows,
            "compressedBytes": compressed, "uncompressedBytes": uncompressed,
            "deferredCounterCoverage": deferred,
        })
    source_bytes = deferred_bytes + immediate_bytes
    same(counts["fastPathParserSourceCompressedBytes"], compressed_bytes,
         "Complete compressed source total differs from original group metadata")
    same(counts["fastPathParserSourceUncompressedBytes"], source_bytes,
         "Complete uncompressed source total differs from original group metadata")
    scanned = integer(counts["fastPathParserSourceCrcScannedBytes"], "deferred CRC scanned bytes")
    reused = integer(counts["fastPathParserSourceCrcReusedBytes"], "deferred CRC reused bytes")
    witnesses = integer(counts["fastPathParserSourceCrcReusedGlossaryCount"], "deferred CRC witness count")
    require(scanned + reused == deferred_bytes,
            "Deferred source CRC coverage differs: recorded=" + str(scanned + reused) +
            ", metadata-admitted=" + str(deferred_bytes) + ", immediate=" + str(immediate_bytes))
    require(witnesses <= deferred_rows and ((witnesses == 0) == (reused == 0)),
            "Deferred CRC witness count is outside its source-bound rows")
    return {
        "passed": True, "groups": observed_groups, "compressedBytes": compressed_bytes,
        "uncompressedBytes": source_bytes, "deferredCounterBytes": deferred_bytes,
        "immediateCrcBytesWithoutCounters": immediate_bytes,
        "recordedScannedBytes": scanned, "recordedReusedBytes": reused,
        "recordedReusedGlossaries": witnesses, "effectiveExperiments": effective,
        "scope": "Metadata-derived coverage of deferred counters only; immediate CRC validation is source-bound and has no scanned/reused metric",
    }


def verify_retirement(root):
    inventory = read_json(Path(root) / "files.json")
    retired = read_json(Path(root) / "retired-disk.json")
    require(retired["retired"] is True and retired["everyRawByteRehashed"] is True and retired["rawFilesRetained"] is False,
            "Original successful sink retirement was not fully verified")
    expected = {item["path"]: {"bytes": item["bytes"], "sha256": item["sha256"]} for item in inventory}
    require(len(expected) == len(inventory), "Duplicate original raw file inventory")
    same(retired["files"], expected, "Independent producer rehash differs from finalized raw hashes")
    same(retired["originalFinalizedInventory"], identity(Path(root) / "files.json"), "Retirement inventory hash differs")
    return {"identity": identity(Path(root) / "retired-disk.json"), "verifiedOriginalRehashReceipt": True,
            "rawFilesPresentForThisReader": False}


def compare_corpus(root, dictionary, fixture, api, kit_hashes, prepared, activation):
    root = Path(root)
    reports, calls, groups, counts, retirements, call_plans, crc_scopes = {}, {}, {}, {}, {}, {}, {}
    for arm, commit, tree in (("A", BASELINE, BASELINE_TREE), ("B", CANDIDATE, CANDIDATE_TREE)):
        directory = root / arm
        report = read_json(directory / "report.json")
        require(report["passed"] is True and report["performanceMeasurements"] is False and
                report["newReconstructedDriver"] is True, "Original actual-import arm did not pass")
        same(report["arm"], arm, "Arm label differs")
        same(report["dictionary"], dictionary, "Dictionary label differs")
        same(report["fixture"], {"sha256": fixture["sha256"], "bytes": fixture["sizeBytes"]}, "Fixture bytes differ")
        require(report["fieldRows"] == fixture["termRows"] and report["parserGroups"] == GROUPS[dictionary]
                and report["parserWorkers"] == 3, "Complete corpus/current grouping not exercised")
        require(report["sqlite"]["persistentSqlite"] is False and report["sqlite"]["usesFallbackStorageOverride"] is False,
                "SQLite host boundary changed")
        same(report["flags"], {"prefixWildcardsSupported": True, "yomitanVersion": "0.0.0.0",
                               "skipImageMetadata": True, "skipMediaImport": False, "zipUseWebWorkers": False},
             "Actual host adaptation flags changed")
        same(read_json(directory / "cleanup.json"), {"completed": True, "cleanupErrors": []},
             "Original post-receipt cleanup failed")
        before, after = read_json(directory / "source-before.json"), read_json(directory / "source-after.json")
        same(report["source"], before, "Reported source differs from pre-import source")
        same(before, after, "Source changed during actual import")
        bind_runtime(before, commit, tree, api, kit_hashes)
        same(before["runtimeFiles"], prepared[arm]["runtimeFiles"], "Actual runtime differs from prepared preflight")
        process_receipt(root, arm, CORPUS + "/run.mjs", dictionary, arm, commit)
        file_inventory = read_json(directory / "files.json")
        same(report["termFiles"], [item for item in file_inventory if item["termPayload"] is True],
             "Reported complete term inventory omits an original finalized file")
        same(report["otherFiles"], [item for item in file_inventory if item["termPayload"] is False],
             "Reported non-term inventory differs")
        phases = read_json(directory / "product-work-counts.json")
        finalizations = [item["details"] for item in phases if item["phase"] == "bulk-finalization"]
        require(len(finalizations) == 1 and finalizations[0]["ok"] is True, "Actual original import finalization failed")
        same(finalizations[0].get("termRecordFields"), report["fieldMetrics"], "Actual importer forwarded metrics differ")
        finalized_store = read_json(directory / "final-store-counts.json")
        same(finalized_store.get("recordFields"), report["fieldMetrics"], "Owning store final metrics differ")
        assets = read_json(directory / "assets.json")
        same(report["optionalAssets"], [item for item in assets if item["path"].endswith("/term-record-fields.wasm")],
             "Reported optional asset witness differs from actual fetches")
        calls[arm] = read_json(directory / "field-calls.json")
        require(len(calls[arm]) == report["fieldCalls"], "Actual encoder call count differs")
        workers = read_json(directory / "workers.json")
        groups[arm] = parser_groups(workers)
        call_plans[arm] = group_field_plan(workers, calls[arm], GROUPS[dictionary], fixture["termRows"])
        counts[arm] = parser_counts(phases)
        crc_scopes[arm] = crc_coverage(phases, call_plans[arm], counts[arm])
        retirements[arm] = verify_retirement(directory)
        reports[arm] = report
    changed = runtime_delta(reports["A"]["source"]["runtimeFiles"], reports["B"]["source"]["runtimeFiles"])
    same(reports["A"]["semantic"], reports["B"]["semantic"], "Complete counts or live lookup results differ")
    term_files = term_inventory(reports["A"])
    same(term_files, term_inventory(reports["B"]), "A complete finalized term byte differs")
    fields = field_identity(calls["A"])
    same(fields, field_identity(calls["B"]), "A complete synchronous field buffer differs")
    require(sum(item["rowCount"] for item in fields) == fixture["termRows"], "Field inventory is incomplete")
    require(reports["A"]["fieldMetrics"] is None and reports["A"]["optionalAssets"] == [] and
            all(item["before"] is None and item["after"] is None for item in calls["A"]), "Baseline activated new code")
    metrics = reports["B"]["fieldMetrics"]
    actual_activation = counters(calls["B"], metrics, fixture, activation)
    same(reports["B"]["nativeCoverage"], {"nativeCalls": metrics["native"]["nativeCalls"],
         "totalCalls": metrics["calls"], "nativeRows": metrics["native"]["nativeRows"], "totalRows": fixture["termRows"]},
         "Reported actual native coverage differs")
    require(len(reports["B"]["optionalAssets"]) == 1, "Missing actual natural optional-WASM fetch witness")
    asset = reports["B"]["optionalAssets"][0]
    wasm = api.source(CANDIDATE, "dev/data/dictionary-wasm/term-record-fields.wasm")
    same(asset, {"path": "ext/lib/term-record-fields.wasm", "bytes": len(wasm), "sha256": digest(wasm)},
         "Wrong actual optional native asset bytes")
    same(groups["A"], groups["B"], "Actual compressed-source group boundaries differ")
    same(call_plans["A"], call_plans["B"], "Actual source-group to field-call boundaries differ")
    require(len(groups["A"]) == GROUPS[dictionary], "Wrong complete group count")
    same(counts["A"], counts["B"], "Parser/CRC/fallback work differs")
    require(counts["A"]["fastPathParserFusedFallbacks"] == 0, "Unexpected fused parser fallback")
    same(crc_scopes["A"], crc_scopes["B"], "Source CRC coverage or effective experiments differ")

    original = read_json(root / "comparison.json")
    require(original["passed"] is True and original["performanceMeasurements"] is False, "Original pair did not pass")
    same(original["completeTermFiles"], [[item["path"], item["bytes"], item["normalizedSha256"], item["normalization"]]
                                      for item in term_files], "Original complete-file comparison differs")
    same(original["parserWorkCounts"], counts["A"], "Original parser comparison differs")
    same(original["candidateMetrics"], metrics, "Original native comparison differs")
    same(original["sourceGroupsSha256"], digest(json.dumps(groups["A"], sort_keys=True).encode()),
         "Original group-plan hash differs")
    same(original["completeRuntimeDelta"], changed, "Original runtime delta differs")
    for arm in ("A", "B"):
        same(set(original["receipts"][arm]), {path.name for path in (root / arm).glob("*.json")} - {"retired-disk.json"},
             "Original pair receipt inventory is incomplete")
        for name, value in original["receipts"][arm].items():
            require(Path(name).name == name and name.endswith(".json"), "Unexpected original receipt path")
            same(value, identity(root / arm / name), "Original pair receipt digest differs: " + name)
    return {
        "passed": True, "dictionary": dictionary, "termRows": fixture["termRows"], "fieldCalls": len(fields),
        "completeFieldIdentitySha256": object_digest(fields),
        "completeFieldOutputBytes": sum(item["bytes"] for item in fields), "completeTermFiles": term_files,
        "parserWorkCounts": counts["A"], "sourceGroupsSha256": original["sourceGroupsSha256"],
        "crcCoverage": crc_scopes["B"],
        "activation": actual_activation, "retirement": retirements,
        "sourceGroupFieldPlan": call_plans["B"], "sourceGroupFieldPlanSha256": object_digest(call_plans["B"]),
        "comparisonFile": identity(root / "comparison.json"),
        "candidateReportFile": identity(root / "B/report.json"),
        "candidateFieldCallsFile": identity(root / "B/field-calls.json"),
        "scope": "Independent comparison of source-bound complete-byte receipts; original successful raw sinks were retired",
    }


def prepared_pair(root, api):
    root = Path(root)
    prepared = {arm: read_json(root / ("prepared-source-" + arm + ".json")) for arm in ("A", "B")}
    for arm, commit, tree in (("A", BASELINE, BASELINE_TREE), ("B", CANDIDATE, CANDIDATE_TREE)):
        value = prepared[arm]
        same(value["commit"], commit, "Prepared commit differs")
        same(value["tree"], tree, "Prepared tree differs")
        require(value["independentNodeModulesDirectory"] is True, "Prepared dependencies were not independent directories")
        for field, path in (("packageLock", "package-lock.json"), ("packageJson", "package.json")):
            data = api.source(commit, path)
            same(value[field], {"bytes": len(data), "sha256": digest(data)}, "Prepared dependency input differs")
    changed = runtime_delta(prepared["A"]["runtimeFiles"], prepared["B"]["runtimeFiles"])
    expected_delta = {
        "passed": True, "expectedChangedPaths": sorted(RUNTIME_DELTA), "actualChangedPaths": changed,
        "unexpectedChangedPaths": [], "missingExpectedChanges": [],
        "changedPathIdentities": {path: {"A": prepared["A"]["runtimeFiles"].get(path),
                                          "B": prepared["B"]["runtimeFiles"].get(path)} for path in changed},
        "fileCounts": {arm: len(prepared[arm]["runtimeFiles"]) for arm in ("A", "B")},
    }
    same(read_json(root / "runtime-delta.json"), expected_delta, "Original preflight comparison differs")
    receipt = read_json(root / "runtime-preflight.json")
    require(receipt["passed"] is True and receipt["productModulesExecuted"] is False and
            receipt["performanceMeasurements"] is False and receipt["node"] == "v22.22.0",
            "Original prepared-runtime preflight failed or scope changed")
    same(receipt["comparison"], expected_delta, "Original preflight summary differs")
    for arm in ("A", "B"):
        same(receipt["sourceReceipts"][arm], identity(root / ("prepared-source-" + arm + ".json")),
             "Original preflight source digest differs")
    return prepared


def audit_validation(root, job, api, source):
    base = Path(root) / VALIDATION_ROOT
    receipts = {}
    for name in ("source-before-setup.json", "source-after-setup.json"):
        if (base / name).exists():
            receipts[name] = source_proof(base / name, api, source, generated=name == "source-after-setup.json")
    path = base / "step-outcomes.json"
    if not path.exists():
        return {"passed": False, "reason": "Original validation outcome receipt is absent",
                "sourceProofs": receipts, "job": job}
    value = read_json(path)
    same(value["required"], list(REQUIRED_STEPS), "Original required validation gates differ")
    failed = [key for key in REQUIRED_STEPS if value["steps"].get(key, {}).get("outcome") != "success"]
    same(value["failed"], failed, "Original failed-gate list differs")
    same(value["passed"], not failed, "Original validation summary differs")
    require(value["performanceMeasurements"] is False, "Validation scope changed")
    by_name = {}
    for item in job["steps"]:
        require(item["name"] not in by_name, "Duplicate original validation step name")
        by_name[item["name"]] = item
    for key, name in REQUIRED_STEPS.items():
        require(name in by_name, "Missing original validation API step")
        same(value["steps"].get(key, {}).get("conclusion"), by_name[name]["conclusion"],
             "Original validation API/receipt conclusion differs: " + key)
    passed = not failed and job["conclusion"] == "success" and len(receipts) == 2 and all(
        item["passed"] for item in receipts.values())
    logs = {}
    for path in sorted(base.glob("*.log")):
        logs[path.name] = identity(path)
    missing_logs = sorted(VALIDATION_LOGS - set(logs))
    if passed:
        require(not missing_logs, "A required original validation log is absent: " + ", ".join(missing_logs))
    return {"passed": passed, "steps": value, "sourceProofs": receipts, "missingLogs": missing_logs,
            "outcomeFile": identity(base / "step-outcomes.json"), "logs": logs,
            "scope": "Original complete validation outcomes and logs; no build or test rerun"}


def audit_corpus(root, job, api, source, activation):
    base = Path(root) / CORPUS_ROOT
    proofs = {}
    for name in ("source-before-setup.json", "source-after-setup.json"):
        if (base / name).exists():
            proofs[name] = source_proof(base / name, api, source, generated=name == "source-after-setup.json")
    acquisition = base / "acquisition"
    report_path = acquisition / "report.json"
    failure_path = acquisition / "failure.json"
    if not report_path.exists() or failure_path.exists():
        failures = {}
        for name in ("runtime-preflight/failure.json", "acquisition/failure.json"):
            if (base / name).exists():
                failures[name] = {"identity": identity(base / name), "original": read_json(base / name)}
        return {"passed": False, "reason": "Original corpus acquisition did not finish all three pairs",
                "sourceProofs": proofs, "originalFailures": failures,
                "partialJsonFiles": {path.relative_to(base).as_posix(): identity(path)
                                     for path in sorted(base.rglob("*.json")) if "/disk/" not in path.as_posix()},
                "jobConclusion": job["conclusion"], "noReplacementAcquisition": True}
    require(job["conclusion"] == "success", "A completed corpus report belongs to a failed original job")
    require(len(proofs) == 2 and all(item["passed"] for item in proofs.values()), "Corpus source guards did not both pass")
    outside = prepared_pair(base / "runtime-preflight", api)
    inside_sources = prepared_pair(acquisition, api)
    same(outside, inside_sources, "Prepared runtime changed between independent preflight and actual acquisition")
    kit_tree = api.tree(CANDIDATE)
    kit_hashes = {}
    for name in sorted(kit_tree):
        if name.startswith(CORPUS + "/") and "/" not in name[len(CORPUS) + 1:]:
            data = api.source(CANDIDATE, name)
            kit_hashes[Path(name).name] = {"bytes": len(data), "sha256": digest(data)}
    plan = read_json(acquisition / "plan.json")
    require(plan["baseline"] == BASELINE and plan["candidate"] == CANDIDATE and
            plan["dictionaryOrder"] == list(GROUPS) and plan["armOrder"] == ["A", "B"] and
            plan["freshProcessPerArm"] is True and plan["performanceMeasurements"] is False and
            plan["optionalReadinessWait"] is False and plan["replacementObservations"] is False and
            plan["readOnlyPreflightOnly"] is False, "Actual acquisition plan changed")
    same(plan["source"], kit_hashes, "Actual acquisition kit hashes differ")
    smoke_cases = (
        "exact BufferSource view and commit visibility",
        "keepExistingData, seek, positioned write and truncate",
        "abort preserves previously committed bytes",
        "BufferSource is snapshotted when write is requested",
        "queued command properties are snapshotted",
        "sync access exact offsets, seek cursor, flush and close",
        "adapter writer exclusion and locked directory deletion",
        "directories, missing entries, kinds and resolution",
        "file tokens stay within the exact adapter and reject symlinks",
        "unchanged production index worker and real transferred buffers",
        "generation media actual stage, select, read and rollback",
    )
    smoke = {}
    for arm in ("A", "B"):
        process_receipt(acquisition, "smoke-" + arm, CORPUS + "/test-opfs.mjs")
        path = acquisition / ("smoke-" + arm) / "report.json"
        value = read_json(path)
        require(value["passed"] is True and value["newReconstructedAdapter"] is True and
                value["timingAcquired"] is False and value["node"] == "v22.22.0", "Original adapter smoke did not pass")
        same(value["cases"], list(smoke_cases), "Original complete actual-I/O smoke inventory differs")
        smoke[arm] = {"identity": identity(path), "cases": value["cases"]}
    crc_policy = crc_policy_sources(api)
    fixtures = parse_json(api.source(BASELINE, "test/perf/dictionaries.lock.json"))["dictionaries"]
    comparisons = []
    for dictionary in GROUPS:
        comparisons.append(compare_corpus(acquisition / dictionary, dictionary, fixtures[dictionary],
                                          api, kit_hashes, inside_sources, activation))
    reported = read_json(report_path)
    require(reported["passed"] is True and reported["performanceMeasurements"] is False, "Original full-corpus report failed")
    same(reported["plan"], plan, "Final original plan differs")
    same([item["dictionary"] for item in reported["comparisons"]], list(GROUPS), "Original final corpus order differs")
    for item in reported["comparisons"]:
        same(item, read_json(acquisition / item["dictionary"] / "comparison.json"), "Final original pair receipt differs")
    return {
        "passed": True, "comparisons": comparisons, "smoke": smoke, "sourceProofs": proofs,
        "crcPolicySources": crc_policy,
        "reportFile": identity(report_path), "planFile": identity(acquisition / "plan.json"),
        "completeRuntimeInventories": {arm: identity(acquisition / ("prepared-source-" + arm + ".json")) for arm in ("A", "B")},
        "limitations": [
            "Real nonpersistent memory SQLite plus disk OPFS-shaped sidecars",
            "Only complete term-content/record/index and field bytes are compared",
            "No browser persistence, restart, image decoding, complete-media or performance qualification",
            "Successful raw sinks were independently rehashed then retired by the original producer; this reader compares retained complete-byte receipts",
        ],
    }


def validate_manifest(manifest):
    integer(RUN_ID, "frozen original run ID", 1)
    require(type(BRANCH) is str and BRANCH, "Original source branch is not frozen")
    for job_id in JOB_IDS.values():
        integer(job_id, "frozen original job ID", 1)
    require(manifest.get("schemaVersion") == 1 and manifest.get("enabled") is True,
            "Correctness artifact audit remains inert until original artifacts are frozen")
    same(manifest["publication"], {"runId": RUN_ID, "headSha": CANDIDATE, "headBranch": BRANCH, "attempt": 1},
         "Original correctness publication changed")
    same(manifest["source"], {"baseline": BASELINE, "baselineTree": BASELINE_TREE,
                             "product": PRODUCT, "productTree": PRODUCT_TREE,
                             "candidate": CANDIDATE, "candidateTree": CANDIDATE_TREE},
         "Original correctness source changed")
    same(set(manifest["jobs"]), set(JOB_IDS), "Original correctness job inventory changed")
    same(set(manifest["artifacts"]), set(JOB_IDS), "Original correctness artifact inventory changed")
    for kind in JOB_IDS:
        job = manifest["jobs"][kind]
        require(type(job) is dict and job["id"] == JOB_IDS[kind] and job["name"] == JOB_NAMES[kind]
                and job["conclusion"] in ("success", "failure", "cancelled", "timed_out"), "Unfrozen original job result")
        artifact = manifest["artifacts"][kind]
        require(type(artifact) is dict, "Original artifact metadata is still absent")
        integer(artifact["id"], "artifact ID", 1)
        integer(artifact["sizeBytes"], "artifact ZIP bytes", 1)
        require(re.fullmatch(r"[0-9a-f]{64}", artifact["sha256"]), "Invalid original artifact digest")
        expected = ("native-record-fields-correctness-" if kind == "validation" else "native-record-fields-corpus-") + CANDIDATE
        same(artifact["name"], expected, "Original artifact name changed")



def prerequisite_receipt(manifest, validation, corpus, runtime):
    """Stable verified-original boundary for the later browser records reader."""
    passed = validation.get("passed") is True and corpus.get("passed") is True
    per_corpus = {}
    for item in corpus.get("comparisons", []):
        dictionary = item["dictionary"]
        require(dictionary in GROUPS and dictionary not in per_corpus, "Unexpected prerequisite corpus")
        per_corpus[dictionary] = {
            "comparisonSha256": item["comparisonFile"]["sha256"],
            "candidateReportSha256": item["candidateReportFile"]["sha256"],
            "fieldCallsSha256": item["candidateFieldCallsFile"]["sha256"],
            "completeTermByteParity": item.get("passed") is True,
        }
    require(not passed or set(per_corpus) == set(GROUPS), "Complete prerequisite corpus proof is absent")
    jobs = {}
    for kind, value, receipt_key in (
        ("validation", validation, "outcomeFile"), ("corpus", corpus, "reportFile"),
    ):
        jobs[kind] = {
            "runId": RUN_ID, "attempt": 1, "jobId": JOB_IDS[kind], "headSha": CANDIDATE,
            "artifact": manifest["artifacts"][kind],
            "receiptSha256": value.get(receipt_key, {}).get("sha256"),
        }
    return {
        "passed": passed, "product": {"commit": PRODUCT, "tree": PRODUCT_TREE},
        "runtimeSha256": runtime, **jobs, "perCorpus": per_corpus,
    }

def audit_correctness(manifest, destination, api=None):
    """Explicit read-only GET/file audit. Importing this module does not invoke it."""
    validate_manifest(manifest)
    destination = Path(destination)
    require(not destination.exists(), "Correctness audit destination must be fresh")
    if api is not None:
        require(Path(api.output) == destination and api.repository == REPOSITORY, "Transport output/repository differs")
    destination.mkdir(parents=True)
    api = GitHub(REPOSITORY, destination) if api is None else api
    activation = load_activation(Path(__file__).parent)
    partial = {"schemaVersion": 1, "auditCompleted": False, "correctnessPassed": False,
               "publication": manifest["publication"], "artifacts": {}, "performanceMeasurements": False}
    write_json(destination / "frozen-input.json", manifest)
    try:
        run = api.json("/actions/runs/" + str(RUN_ID), "original-run")
        require(run["id"] == RUN_ID and run["head_sha"] == CANDIDATE and run["head_branch"] == BRANCH
                and run["run_attempt"] == 1 and run["status"] == "completed", "Original run is not the exact completed first attempt")
        jobs = {}
        for kind, job_id in JOB_IDS.items():
            job = api.json("/actions/jobs/" + str(job_id), "original-job-" + kind)
            require(job["id"] == job_id and job["run_id"] == RUN_ID and job["head_sha"] == CANDIDATE and
                    job["run_attempt"] == 1 and job["status"] == "completed", "Original job identity/status differs")
            same(job["name"], manifest["jobs"][kind]["name"], "Original job name differs")
            same(job["conclusion"], manifest["jobs"][kind]["conclusion"], "Original terminal job conclusion differs")
            jobs[kind] = job
        api.tree(BASELINE, BASELINE_TREE)
        api.tree(PRODUCT, PRODUCT_TREE)
        tree = api.tree(CANDIDATE, CANDIDATE_TREE)
        for commit, expected_parent in ((CANDIDATE, PRODUCT), (PRODUCT, BASELINE)):
            value = api.json("/git/commits/" + commit, "ancestry-" + commit)
            same([item["sha"] for item in value["parents"]], [expected_parent], "Original source ancestry changed")
        source_bytes = api.source(CANDIDATE, KIT + "/source.json")
        source = parse_json(source_bytes)
        recovery = parse_json(api.source(CANDIDATE, KIT + "/recovery.json"))
        require(source["baseline"] == BASELINE and source["productCommit"] == PRODUCT and
                source["productTree"] == PRODUCT_TREE, "Original source manifest differs")
        for name, expected in source["files"].items():
            data = api.source(CANDIDATE, name)
            same(expected, {"gitBlob": git_blob(data), "sha256": digest(data), "bytes": len(data),
                            "mode": tree[name]["mode"]}, "Original source manifest entry differs")
        same(source["digest"], digest("".join(name + "\0" + source["files"][name]["sha256"] + "\n"
                                            for name in sorted(source["files"])).encode()), "Original source digest differs")
        required_kit = {name for name in tree if name.startswith(KIT + "/")} | {WORKFLOW}
        required_validation = required_kit | {item["path"] for item in recovery["productFiles"]}
        downloads = destination / "downloads"
        downloads.mkdir()
        extracted = {}
        for kind in JOB_IDS:
            archive, metadata = api.artifact(manifest["artifacts"][kind], manifest["publication"], downloads)
            folder = destination / (kind + "-zip")
            members = extract_zip(archive, folder)
            write_json(destination / (kind + "-zip-members.json"), members)
            partial["artifacts"][kind] = {"metadata": metadata, "outerZip": identity(archive),
                                          "memberManifest": identity(destination / (kind + "-zip-members.json"))}
            extracted[kind] = folder
            if kind == "validation":
                sources = bind_archived_sources(folder, members, tree, required_validation)
                write_json(destination / "validation-source-bindings.json", sources)
            else:
                same(set(name for name, item in members.items() if item["kind"] == "file"),
                     {TAR_NAME, TAR_RECEIPT}, "Unexpected corpus outer ZIP inventory")
                receipt = read_json(folder / TAR_RECEIPT)
                verified = verify_tar(folder / TAR_NAME, receipt, destination / "corpus-contents")
                write_json(destination / "corpus-tar-verified.json", verified)
                sources = bind_archived_sources(destination / "corpus-contents", verified["members"], tree, required_kit)
                write_json(destination / "corpus-source-bindings.json", sources)
                partial["artifacts"][kind]["tarReceipt"] = identity(folder / TAR_RECEIPT)
                partial["artifacts"][kind]["tarVerified"] = identity(destination / "corpus-tar-verified.json")
            write_json(destination / "partial.json", partial)
        validation = audit_validation(extracted["validation"], jobs["validation"], api, source)
        corpus = audit_corpus(destination / "corpus-contents", jobs["corpus"], api, source, activation)
        runtime = {}
        for name in sorted(activation.RUNTIME_PATHS):
            data = api.source(CANDIDATE, "dev/data/dictionary-wasm/term-record-fields.wasm"
                              if name == "ext/lib/term-record-fields.wasm" else name)
            runtime[name] = digest(data)
        result = {**partial, "auditCompleted": True,
                  "correctnessPassed": validation["passed"] and corpus["passed"],
                  "validation": validation, "corpus": corpus, "runtimeSha256": runtime,
                  "browserPrerequisite": prerequisite_receipt(manifest, validation, corpus, runtime),
                  "source": manifest["source"], "sourceManifest": {"gitBlob": git_blob(source_bytes), "sha256": digest(source_bytes)},
                  "auditSourceFiles": {name: identity(Path(__file__).with_name(name))
                                       for name in ("audit.py", "transport.py", "field_activation.py")},
                  "frozenInputFile": identity(destination / "frozen-input.json"),
                  "apiSnapshots": {path.relative_to(destination).as_posix(): identity(path)
                                   for path in sorted((destination / "api").glob("*.json"))},
                  "scope": "Original artifact/source/receipt audit only; no imports, tests, builds, browser, timings or replacement observations"}
        write_json(destination / "result.json", result)
        return result
    except Exception as cause:
        failure = {**partial, "failure": {"type": type(cause).__name__, "message": str(cause)},
                   "scope": "Reader failure; all downloaded original bytes and partial receipts remain untouched"}
        write_json(destination / "reader-failure.json", failure)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    require(file_digest(Path(__file__).with_name("transport.py")) == TRANSPORT_SHA256,
            "Frozen transport source differs")
    result = audit_correctness(read_json(args.manifest), args.output)
    print(json.dumps(result, sort_keys=True, allow_nan=False))


if __name__ == "__main__":
    main()
