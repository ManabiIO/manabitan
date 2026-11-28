#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Separate hosted acquisition; the failed local cohort is never resumed."""

import argparse
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import platform
import shutil
import struct
import subprocess
import sys
import tarfile
import time
import zipfile
import zlib

ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
BASELINE = "9e10d3b3fcf66d344ab31bc42c9b522fa5215da2"
ORIGINAL_PRODUCT = "1c93b0a18f5dd53a13dfdd3d054687c85e097247"
ORIGINAL_TREE = "7bf2f889a94d955bf8845b9f8d9e2d4afb464617"
ORIGINAL_INPUTS = {
    "observer": "4bd1085be4fd16cc5e5246be3682bcabfdb546331afb4d5ce123084a9f37a4e4",
    "controller": "6740a59f94254e2d0060f094993c818f73a472fd9b7be96deceaa13139274c92",
    "plan": "1ae467eaa524b3aa71d25463fab594379d6d2ee607294bfb351cdde266eee802",
}
ORIGINAL_ORACLE_SHA256 = "507c25a0257d5fd8b789e294386f6b703f77efda0863e0ef64b7c176e06d8023"
OUTPUT_NAMES = {"observer": "observe.mjs", "controller": "original-run.py.txt",
                "plan": "original-plan.json"}
CHECK_NAMES = {
    "candidateMedianWallAgainstBoth", "candidateEqualWorkWallAgainstBoth",
    "candidateMedianCpuAgainstBoth", "candidateFasterBlocksAgainstBoth",
    "sameCodeMedianWallDrift", "sameCodeMedianCpuDrift", "coldWallAgainstBoth",
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def file_sha(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def write_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2) + "\n")


def emit(label, value):
    print(label + " " + json.dumps(value, sort_keys=True), flush=True)


def hosted_controller(original):
    """Only unmeasured file hashing changes; all acquisition/statistics stay exact."""
    text = original.decode()
    needle = "sha = lambda data: hashlib.sha256(data).hexdigest()"
    insert = needle + '''

def file_sha(filename):
    digest = hashlib.sha256()
    with Path(filename).open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()
'''
    assert text.count(needle) == 1
    text = text.replace(needle, insert)
    replacements = {
        "sha((HERE / 'observer-manifest.json').read_bytes())": "file_sha(HERE / 'observer-manifest.json')",
        "sha((HERE / name).read_bytes())": "file_sha(HERE / name)",
        "sha(Path(plan['oracle']['path']).read_bytes())": "file_sha(Path(plan['oracle']['path']))",
        "sha(Path(plan['nodeExecutable']).read_bytes())": "file_sha(Path(plan['nodeExecutable']))",
        "sha((Path(source['root']) / name).read_bytes())": "file_sha(Path(source['root']) / name)",
        "sha((out / (label + '.log')).read_bytes())": "file_sha(out / (label + '.log'))",
    }
    for before, after in replacements.items():
        assert text.count(before) == 1, before
        text = text.replace(before, after)
    compile(text, "streamed-controller", "exec")
    return text.encode()


def extract_original_inputs(evidence):
    index_path = HERE / "local-evidence-manifest.json.txt"
    index = json.loads(index_path.read_bytes())
    archive_record = index["archive"]
    archive_path = HERE / archive_record["path"]
    assert archive_path.resolve().parent == HERE.resolve()
    assert archive_path.stat().st_size == archive_record["bytes"]
    assert file_sha(archive_path) == archive_record["sha256"]
    records = index["componentInputs"]
    assert set(records) == set(ORIGINAL_INPUTS)
    raw = {}
    with tarfile.open(archive_path, "r:*") as archive:
        names = archive.getnames()
        assert len(names) == len(set(names))
        for kind, expected in ORIGINAL_INPUTS.items():
            record = records[kind]
            assert record["sha256"] == expected
            info = archive.getmember(record["member"])
            assert info.isfile()
            assert not Path(info.name).is_absolute() and ".." not in Path(info.name).parts
            assert info.size == record["bytes"]
            with archive.extractfile(info) as source:
                raw[kind] = source.read()
            assert sha(raw[kind]) == expected
            (evidence / OUTPUT_NAMES[kind]).write_bytes(raw[kind])
    return raw, {"indexSha256": file_sha(index_path), "archive": archive_record,
                 "componentInputs": records}



def decode_oracle_bank(compressed_file, entry, archive_bytes):
    assert entry.compress_type == 8 and not entry.flag_bits & 1
    assert entry.header_offset >= 0 and entry.compress_size >= 0
    compressed_file.seek(entry.header_offset)
    header = compressed_file.read(30)
    assert len(header) == 30
    signature, _version, flags, method, _time, _date, _crc, _compressed, _decoded, name_bytes, extra_bytes = struct.unpack("<4s5H3I2H", header)
    assert signature == b"PK\x03\x04" and method == 8 and not flags & 1
    assert compressed_file.read(name_bytes) == entry.filename.encode("utf-8")
    payload_offset = entry.header_offset + 30 + name_bytes + extra_bytes
    assert payload_offset <= archive_bytes - entry.compress_size
    compressed_file.seek(payload_offset)
    compressed = compressed_file.read(entry.compress_size)
    assert len(compressed) == entry.compress_size
    decoder = zlib.decompressobj(-15)
    decoded = decoder.decompress(compressed) + decoder.flush()
    assert decoder.eof and not decoder.unused_data and not decoder.unconsumed_tail
    assert len(decoded) == entry.file_size
    actual_crc = zlib.crc32(decoded)
    assert actual_crc == entry.CRC
    return {
        "filename": entry.filename, "compressedBytes": len(compressed),
        "decodedBytes": len(decoded), "crc32": actual_crc,
        "compressedSha256": sha(compressed), "decodedSha256": sha(decoded),
        "consumedCompressedBytes": len(compressed), "eof": True,
        "unusedInputBytes": 0, "unconsumedInputBytes": 0,
    }


def prepare_hosted_oracle(fixture, original_plan, evidence):
    """Independent new oracle; never rebuild or relabel the lost native census."""
    import re
    fixture_identity = original_plan["fixture"]
    assert fixture.stat().st_size == fixture_identity["bytes"]
    assert file_sha(fixture) == fixture_identity["sha256"]
    output = evidence / "oracle.json"
    report = {
        "complete": False,
        "kind": "New hosted independent raw-zlib oracle, generated outside all measured calls",
        "originalNativeCensusUnavailableSha256": ORIGINAL_ORACLE_SHA256,
        "noNativeCensusCounts": True,
        "archive": {"sha256": fixture_identity["sha256"], "bytes": fixture_identity["bytes"]},
        "runtime": {"python": sys.version, "zlibCompile": zlib.ZLIB_VERSION,
                    "zlibRuntime": zlib.ZLIB_RUNTIME_VERSION},
        "banks": [],
    }
    write_json(output, report)
    expected_names = [name for group in original_plan["groups"] for name in group]
    assert expected_names == [f"term_bank_{index}.json" for index in range(1, 54)]
    with zipfile.ZipFile(fixture) as archive, fixture.open("rb") as compressed_file:
        banks = sorted((entry for entry in archive.infolist()
                        if re.fullmatch(r"term_bank_\d+\.json", entry.filename)),
                       key=lambda entry: int(entry.filename[10:-5]))
        assert [entry.filename for entry in banks] == expected_names
        for entry in banks:
            report["banks"].append(decode_oracle_bank(compressed_file, entry, fixture_identity["bytes"]))
            write_json(output, report)
    assert len(report["banks"]) == 53
    assert sum(bank["decodedBytes"] for bank in report["banks"]) == 171617523
    assert sum(bank["compressedBytes"] for bank in report["banks"]) == 15632849
    report["complete"] = True
    write_json(output, report)
    return {"path": str(output), "sha256": file_sha(output),
            "scope": "New hosted Python raw-zlib oracle: every fixed bank has exact compressed consumption, decoded size, CRC and full compressed/decoded SHA before acquisition. The unavailable original native census is not reconstructed."}


def oracle_preflight_checks(evidence):
    """Small synthetic correctness cases, never the registered corpus or WASM."""
    payload = b'[["key","reading","",0,["literal"],1,""]]\n' * 17
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("term_bank_1.json", payload)
    source = buffer.getvalue()
    with zipfile.ZipFile(io.BytesIO(source)) as archive:
        entry = archive.getinfo("term_bank_1.json")
    valid = decode_oracle_bank(io.BytesIO(source), entry, len(source))
    assert valid["decodedSha256"] == sha(payload)
    assert valid["crc32"] == zlib.crc32(payload)
    assert valid["decodedBytes"] == len(payload)
    names = ["valid-known-bytes-hash-crc-size-consumption"]

    def reject(label, data=source, changed=None):
        modified = copy.copy(entry)
        for field, value in (changed or {}).items():
            setattr(modified, field, value)
        try:
            decode_oracle_bank(io.BytesIO(data), modified, len(data))
        except (AssertionError, zlib.error):
            names.append(label)
        else:
            raise AssertionError(f"Oracle accepted synthetic failure: {label}")

    reject("trailing-compressed-byte", changed={"compress_size": entry.compress_size + 1})
    reject("truncated-deflate-stream", changed={"compress_size": entry.compress_size - 1})
    reject("central-crc-mismatch", changed={"CRC": entry.CRC ^ 1})
    reject("decoded-size-too-small", changed={"file_size": entry.file_size - 1})
    reject("decoded-size-too-large", changed={"file_size": entry.file_size + 1})
    reject("payload-out-of-bounds", changed={"compress_size": len(source)})
    reject("negative-local-header-offset", changed={"header_offset": -1})
    reject("short-physical-local-header", data=source[:29])
    changed = bytearray(source)
    changed[0] ^= 1
    reject("local-signature-mismatch", data=changed)
    changed = bytearray(source)
    changed[8] = 0
    reject("local-method-mismatch", data=changed)
    changed = bytearray(source)
    changed[6] |= 1
    reject("local-encryption-bit", data=changed)
    changed = bytearray(source)
    changed[30] ^= 1
    reject("local-filename-mismatch", data=changed)
    changed = bytearray(source)
    payload_offset = 30 + len(entry.filename.encode("utf-8")) + len(entry.extra)
    changed[payload_offset] = 7  # BFINAL=1 and the invalid BTYPE=3.
    reject("invalid-deflate-block", data=changed)
    fixture = evidence / "synthetic-oracle-input.zip"
    fixture.write_bytes(source)
    wrong_hash_plan = {"fixture": {"bytes": len(source), "sha256": "0" * 64}}
    try:
        prepare_hosted_oracle(fixture, wrong_hash_plan, evidence)
    except AssertionError:
        names.append("whole-archive-hash-mismatch")
    else:
        raise AssertionError("Oracle accepted the wrong whole archive hash")
    return {"scope": "Synthetic independent-oracle correctness only; no registered corpus or WASM decode",
            "cases": names, "caseCount": len(names), "syntheticArchiveSha256": sha(source),
            "knownDecodedSha256": sha(payload), "zlibRuntime": zlib.ZLIB_RUNTIME_VERSION}


def get_guard():
    location = ROOT / "dev/perf/inflate-short-word-screen-5a86.py"
    spec = importlib.util.spec_from_file_location("short_word_source_guard", location)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    if not __debug__:
        raise RuntimeError("Assertions must remain enabled")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--preflight-only", action="store_true")
    args = parser.parse_args()
    evidence = args.evidence.resolve()
    evidence.mkdir(parents=True, exist_ok=False)
    receipt = {
        "kind": "Separate hosted acquisition, never continuation or replacement of local failed cohort",
        "originalProductCommit": ORIGINAL_PRODUCT, "originalProductTree": ORIGINAL_TREE,
        "baseline": BASELINE, "candidate": args.candidate,
        "originalLocalCohort": {"status": "FAILED/HOLD", "children": 0, "sweeps": 0,
                                "signal": 9, "cause": "unknown",
                                "rawReceiptAvailability": "Exact failed report, outer receipt, empty log and historical reviews recovered by known hashes; native census and most raw validation/preflight logs remain unavailable"},
        "commands": [], "status": "preparing", "startedUnixSeconds": time.time(),
        "host": {"platform": platform.platform(), "machine": platform.machine(),
                 "logicalCpuCount": os.cpu_count(),
                 "githubRunId": os.environ.get("GITHUB_RUN_ID"),
                 "githubRunAttempt": os.environ.get("GITHUB_RUN_ATTEMPT"),
                 "githubSha": os.environ.get("GITHUB_SHA")},
    }

    def save():
        write_json(evidence / "invocation.json", receipt)

    def command(label, arguments, cwd=ROOT):
        item = {"label": label, "command": [str(value) for value in arguments],
                "cwd": str(cwd), "status": "starting"}
        receipt["commands"].append(item)
        save()
        log_path = evidence / (label + ".log")
        try:
            with log_path.open("xb") as log:
                result = subprocess.run(item["command"], cwd=cwd, stdout=log, stderr=subprocess.STDOUT)
            item.update({"exitCode": result.returncode if result.returncode >= 0 else None,
                         "signal": -result.returncode if result.returncode < 0 else None,
                         "status": "complete" if result.returncode == 0 else "failed"})
        except BaseException as error:
            item.update({"status": "failed", "launchError": repr(error)})
            raise
        finally:
            if log_path.exists():
                item["logSha256"] = file_sha(log_path)
            save()
        if result.returncode != 0:
            raise RuntimeError(f"{label} failed; no retry or replacement")
        return item

    save()
    try:
        guard = get_guard()
        receipt["sourceIdentity"] = guard.source_check(args.candidate)
        raw, original_identity = extract_original_inputs(evidence)
        receipt["originalEvidence"] = original_identity
        original_plan = json.loads(raw["plan"])
        assert original_plan["sources"]["A"]["commit"] == BASELINE
        assert original_plan["sources"]["C"] == original_plan["sources"]["A"]
        assert original_plan["sources"]["B"]["commit"] == ORIGINAL_PRODUCT
        assert original_plan["sources"]["B"]["tree"] == ORIGINAL_TREE
        assert original_plan["observerSha256"] == ORIGINAL_INPUTS["observer"]
        assert original_plan["oracle"]["sha256"] == ORIGINAL_ORACLE_SHA256
        assert original_plan["orders"] == ["ABC", "ACB", "BAC", "BCA", "CAB", "CBA"] * 2
        assert original_plan["freshProcesses"] == 36
        assert original_plan["sweeps"] == {"cold": 1, "postcold": 4, "selectiveDiscard": False, "steadyStateClaim": False}
        node = Path(shutil.which("node")).resolve()
        assert file_sha(node) == original_plan["nodeExecutableSha256"]
        version = subprocess.check_output([str(node), "--version"], text=True).strip()
        assert version == original_plan["nodeVersion"]
        receipt["host"]["nodeVersion"] = version
        receipt["host"]["nodeExecutable"] = str(node)
        receipt["host"]["nodeExecutableSha256"] = file_sha(node)
        if args.preflight_only:
            adapted = hosted_controller(raw["controller"])
            (evidence / "streamed-controller.py").write_bytes(adapted)
            command("observer-syntax", [node, "--check", evidence / "observe.mjs"])
            receipt["oracleValidation"] = oracle_preflight_checks(evidence)
            receipt.update({"status": "preflight-complete", "noWasmDecodeOrTimingObservation": True,
                            "adaptedControllerSha256": sha(adapted),
                            "eligibleForBrowserScreen": False, "endedUnixSeconds": time.time()})
            save()
            emit("ORIGINAL_INPUT_PREFLIGHT", receipt)
            return 0
        command("prepare-fixture", [node, "dev/perf/prepare-dictionaries.js", "jmdict"])
        fixture = ROOT / "builds/e2e-dictionary-cache/JMdict.zip"
        assert fixture.stat().st_size == original_plan["fixture"]["bytes"]
        assert file_sha(fixture) == original_plan["fixture"]["sha256"]
        hosted_oracle = prepare_hosted_oracle(fixture, original_plan, evidence)
        receipt["newHostedOracle"] = hosted_oracle
        save()

        sources_root = evidence.with_name(evidence.name + "-sources")
        sources_root.mkdir(exist_ok=False)
        source_roots = {}
        for arm, revision in (("A", BASELINE), ("B", args.candidate)):
            target = sources_root / arm
            command("checkout-" + arm, ["git", "worktree", "add", "--detach", str(target), revision])
            shutil.copytree(ROOT / "node_modules", target / "node_modules",
                            copy_function=os.link, symlinks=True)
            command("build-libs-" + arm, ["npm", "run", "build:libs"], cwd=target)
            source_roots[arm] = target
        source_roots["C"] = source_roots["A"]

        plan = copy.deepcopy(original_plan)
        plan["nodeExecutable"] = str(node)
        plan["fixture"]["path"] = str(fixture)
        plan["oracle"] = hosted_oracle
        for arm, source in plan["sources"].items():
            target = source_roots[arm]
            source["root"] = str(target)
            source["commit"] = args.candidate if arm == "B" else BASELINE
            source["tree"] = subprocess.check_output(["git", "rev-parse", "HEAD^{tree}"], cwd=target, text=True).strip()
        assert plan["sources"]["A"] == plan["sources"]["C"]
        # Only host locations, exact hosted candidate commit/tree and the
        # independently prepared new oracle identity/scope may change. Every
        # original timing policy, grouping, control and criterion stays literal.
        restored = copy.deepcopy(plan)
        restored["nodeExecutable"] = original_plan["nodeExecutable"]
        restored["fixture"]["path"] = original_plan["fixture"]["path"]
        restored["oracle"] = original_plan["oracle"]
        for arm in restored["sources"]:
            for field in ("root", "commit", "tree"):
                restored["sources"][arm][field] = original_plan["sources"][arm][field]
        assert restored == original_plan

        observer_root = evidence / "observer"
        observer_root.mkdir()
        (observer_root / "observe.mjs").write_bytes(raw["observer"])
        (observer_root / "run.py").write_bytes(hosted_controller(raw["controller"]))
        write_json(observer_root / "plan.json", plan)
        manifest = {"files": {name: file_sha(observer_root / name)
                              for name in ("observe.mjs", "run.py", "plan.json")}}
        write_json(observer_root / "observer-manifest.json", manifest)
        manifest_sha = file_sha(observer_root / "observer-manifest.json")
        receipt["hostedObserver"] = {"manifestSha256": manifest_sha, **manifest}
        receipt["hashingChange"] = "Only unmeasured file hashing reads bounded 1MiB chunks; no claim that allocation caused or fixes local SIGKILL"
        receipt["status"] = "acquiring"
        save()
        command("controller", [sys.executable, observer_root / "run.py", manifest_sha, evidence / "cohort"])

        report_path = evidence / "cohort/report.json"
        receipt["reportSha256"] = file_sha(report_path)
        report = json.loads(report_path.read_bytes())
        assert report["complete"] is True and report["failure"] is None
        assert report["manifestSha256"] == manifest_sha
        assert len(report["observations"]) == 36
        assert set(report["continuationChecks"]) == CHECK_NAMES
        assert all(type(value) is bool for value in report["continuationChecks"].values())
        assert type(report["eligibleForHostedScreen"]) is bool
        assert report["eligibleForHostedScreen"] == all(report["continuationChecks"].values())
        guard.source_check(args.candidate)
        receipt["status"] = "complete"
        receipt["eligibleForBrowserScreen"] = report["eligibleForHostedScreen"]
        receipt["endedUnixSeconds"] = time.time()
        save()
        emit("COMPONENT_CONTINUATION", report["continuationChecks"])
        emit("COMPONENT_SUMMARY", {clock: {key: value for key, value in summary.items() if key != "allSweeps"}
                                  for clock, summary in report["summary"].items()})
        emit("COMPONENT_IDENTITY", {"manifestSha256": manifest_sha,
                                    "reportSha256": receipt["reportSha256"],
                                    "originalEvidence": original_identity,
                                    "eligibleForBrowserScreen": receipt["eligibleForBrowserScreen"]})
        if os.environ.get("GITHUB_OUTPUT"):
            with Path(os.environ["GITHUB_OUTPUT"]).open("a") as output:
                output.write("eligible=" + str(receipt["eligibleForBrowserScreen"]).lower() + "\n")
        return 0
    except BaseException as error:
        receipt.update({"status": "failed", "error": {"type": type(error).__name__, "message": str(error)},
                        "endedUnixSeconds": time.time(), "eligibleForBrowserScreen": False})
        save()
        raise


if __name__ == "__main__":
    sys.exit(main())
