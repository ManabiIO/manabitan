#!/usr/bin/env python3
"""Recover names only after exact executable-section parity; no import or timing acquisition."""
import argparse
import collections
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import traceback

import analysis_helpers as helper

PRODUCT_SOURCE = "dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16"
PARSER_MODULE = "lib/term-bank-parser.wasm"
STRIP_ARGUMENT = "-Wl,--strip-all"


def read_u32(data, position, end):
    value = 0
    for shift in range(0, 35, 7):
        helper.require(position < end, "Truncated WASM integer")
        byte = data[position]
        position += 1
        value |= (byte & 127) << shift
        if not byte & 128:
            helper.require(value <= 0xffffffff, "WASM integer overflow")
            return value, position
    raise ValueError("Invalid WASM integer")


def read_name(data, position, end):
    size, position = read_u32(data, position, end)
    helper.require(position + size <= end, "Truncated WASM name")
    return data[position:position + size].decode("utf-8"), position + size


def sections(data):
    helper.require(data[:8] == b"\0asm\x01\0\0\0", "Invalid WASM magic/version")
    result = []
    position = 8
    while position < len(data):
        start = position
        kind = data[position]
        size, begin = read_u32(data, position + 1, len(data))
        end = begin + size
        helper.require(end <= len(data), "Truncated WASM section")
        result.append({"id": kind, "begin": begin, "end": end, "raw": data[start:end]})
        position = end
    return result


def recover_names(baseline, named):
    left, right = sections(baseline), sections(named)
    executable_left = [item["raw"] for item in left if item["id"] != 0]
    executable_right = [item["raw"] for item in right if item["id"] != 0]
    helper.require(executable_left == executable_right,
                   "Noncustom WASM sections differ; function names must not be attributed to the trace")
    # The exact traced parser is freestanding with no imports. Reject a changed
    # index model rather than guessing imported function offsets.
    helper.require(not any(item["id"] == 2 for item in left), "Unexpected parser import section")
    function_sections = [item for item in left if item["id"] == 3]
    code_sections = [item for item in left if item["id"] == 10]
    helper.require(len(function_sections) == len(code_sections) == 1, "Missing or repeated function/code section")
    functions, _ = read_u32(baseline, function_sections[0]["begin"], function_sections[0]["end"])
    code_functions, _ = read_u32(baseline, code_sections[0]["begin"], code_sections[0]["end"])
    helper.require(functions == code_functions, "Function/code counts disagree")
    names = {}
    name_sections = 0
    function_name_subsections = 0
    custom = []
    for section in right:
        if section["id"] != 0:
            continue
        custom_name, position = read_name(named, section["begin"], section["end"])
        custom.append({"name": custom_name, "bytes": len(section["raw"]), "sha256": helper.digest(section["raw"])})
        if custom_name != "name":
            continue
        name_sections += 1
        while position < section["end"]:
            kind = named[position]
            size, begin = read_u32(named, position + 1, section["end"])
            end = begin + size
            helper.require(end <= section["end"], "Truncated WASM name subsection")
            if kind == 1:
                function_name_subsections += 1
                count, cursor = read_u32(named, begin, end)
                for _ in range(count):
                    index, cursor = read_u32(named, cursor, end)
                    name, cursor = read_name(named, cursor, end)
                    helper.require(index < functions and index not in names and name != "", "Invalid or duplicate function name index")
                    names[index] = name
                helper.require(cursor == end, "Trailing function-name bytes")
            position = end
    helper.require(name_sections == function_name_subsections == 1 and names, "Missing or ambiguous function-name section")
    return names, {
        "everyOrderedNoncustomSectionByteIdentical": True,
        "noncustomSectionCount": len(executable_left), "functionCount": functions,
        "noncustomSha256": helper.digest(baseline[:8] + b"".join(executable_left)),
        "sections": [{"id": item["id"], "bytes": len(item["raw"]), "sha256": helper.digest(item["raw"])}
                     for item in left if item["id"] != 0],
        "namedCustomSections": custom, "functionNameCount": len(names)
    }


def git(root, *args):
    return subprocess.check_output(["git", *args], cwd=root, text=True).strip()


def source_snapshot(root, plan):
    helper.require(git(root, "rev-parse", "HEAD") == PRODUCT_SOURCE, "Wrong frozen product commit")
    helper.require(git(root, "rev-parse", "HEAD^{tree}") == plan["productTree"], "Wrong frozen product tree")
    helper.require(git(root, "status", "--porcelain") == "", "Product source checkout is not clean")
    native = {}
    for file in (root / "ext/js/dictionary/wasm").rglob("*"):
        helper.require(not file.is_symlink(), "Native source symlink is not supported")
        if file.is_file() and file.suffix.lower() in (".c", ".h"):
            native[file.relative_to(root).as_posix()] = helper.digest(file.read_bytes())
    identity = "".join(path + "\0" + native[path] + "\n" for path in sorted(native)).encode()
    manifest_path = root / "dev/data/dictionary-wasm/manifest.json"
    manifest_bytes = manifest_path.read_bytes()
    helper.require(helper.digest(manifest_bytes) == plan["manifestSha256"], "Native manifest changed")
    manifest = json.loads(manifest_bytes)
    helper.require(helper.digest(identity) == manifest["sourceDigest"] == plan["nativeSourceDigest"] and
                   len(native) == manifest["sourceFileCount"] == plan["nativeSourceFileCount"], "Native source identity differs")
    tooling = {}
    for path, expected_blob in plan["toolingGitBlobs"].items():
        helper.require(git(root, "hash-object", path) == expected_blob, "Frozen builder dependency changed: " + path)
        tooling[path] = helper.digest((root / path).read_bytes())
    parser = root / "dev/data/dictionary-wasm/term-bank-parser.wasm"
    helper.require(helper.digest(parser.read_bytes()) == plan["tracedParserSha256"], "Checked parser differs from traced module")
    return {"commit": PRODUCT_SOURCE, "tree": plan["productTree"], "nativeFiles": native, "nativeSourceDigest": helper.digest(identity),
            "nativeSourceCount": len(native), "manifestSha256": helper.digest(manifest_bytes), "toolingSha256": tooling,
            "parserSha256": helper.digest(parser.read_bytes())}


def run_command(command, cwd, log, commands):
    entry = {"argv": list(map(str, command)), "cwd": str(cwd), "log": str(log), "exitCode": None}
    commands.append(entry)
    with log.open("xb") as stream:
        result = subprocess.run(command, cwd=cwd, stdout=stream, stderr=subprocess.STDOUT,
                                env={key: value for key, value in os.environ.items() if key != "GITHUB_TOKEN"})
    entry["exitCode"] = result.returncode
    helper.require(result.returncode == 0, "Symbol-recovery command failed; preserved log: " + str(log))


def symbolize(analysis, names, parser_sha):
    result = []
    for row in analysis["roles"]["parser"]["wasmContextRows"]:
        context = row["frame"]["context"]
        if context["module"] != PARSER_MODULE:
            continue
        helper.require(context["moduleSha256"] == parser_sha, "Sampled parser module identity differs")
        index = context["functionIndex"]
        result.append({"functionIndex": index, "recoveredName": names.get(index),
                       "samples": row["samples"], "adjacentWallUs": row["adjacentWallUs"],
                       "nearestExportedAncestor": context.get("nearestExportedAncestor"),
                       "nearestJsAncestor": context.get("nearestJsAncestor"),
                       "originalLeaf": row["frame"]["leaf"]})
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--product", required=True, type=Path)
    parser.add_argument("--plan", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    receipt = {"schemaVersion": 1, "complete": False, "scope": __doc__, "commands": [],
               "githubSha": os.environ.get("GITHUB_SHA"), "githubRunId": os.environ.get("GITHUB_RUN_ID"),
               "githubRunAttempt": os.environ.get("GITHUB_RUN_ATTEMPT")}
    try:
        plan = json.loads(args.plan.read_text())
        helper.require(plan["productSource"] == PRODUCT_SOURCE, "Prospective product source differs")
        own = Path(__file__).resolve()
        root = args.product.resolve()
        helper.require(os.environ.get("GITHUB_REPOSITORY") == helper.REPOSITORY and
                       re.fullmatch(r"[0-9a-f]{40}", os.environ.get("GITHUB_SHA", "")), "Unexpected workflow invocation")
        helper.require(helper.digest(own.read_bytes()) == plan["scriptSha256"], "Symbol recovery control changed")
        receipt["controls"] = {}
        for name in ("recover.py", "test_recover.py", "plan.json", "workflow.yml", "analysis_helpers.py"):
            path = own.with_name(name)
            receipt["controls"][name] = helper.digest(path.read_bytes())
            (output / ("control-" + name)).write_bytes(path.read_bytes())
        helper.require(receipt["controls"]["analysis_helpers.py"] == plan["analysisHelperSha256"] and
                       receipt["controls"]["test_recover.py"] == plan["testsSha256"], "Frozen helper/test control changed")
        before = source_snapshot(root, plan)
        helper.write_json(output / "source-before.json", before)
        manifest = json.loads((root / "dev/data/dictionary-wasm/manifest.json").read_text())
        target = next(item for item in manifest["targets"] if item["name"] == "term-bank-parser.wasm")
        helper.require(target["arguments"].count(STRIP_ARGUMENT) == 1 and target["sha256"] == plan["tracedParserSha256"],
                       "Unexpected parser build argument or module identity")
        helper.require(manifest["toolchain"] == plan["toolchain"], "Toolchain manifest changed")
        compiler = shutil.which("clang-21")
        linker = shutil.which("wasm-ld-21")
        helper.require(compiler is not None and linker is not None, "Pinned Clang/LLD is unavailable")
        compiler_version = subprocess.check_output([compiler, "--version"], text=True)
        linker_version = subprocess.check_output([linker, "--version"], text=True)
        compiler_match = re.search(r"\bclang version (\d+\.\d+\.\d+)\b", compiler_version)
        linker_match = re.search(r"\bLLD (\d+\.\d+\.\d+)\b", linker_version)
        helper.require(compiler_match is not None and linker_match is not None and
                       compiler_match[1] == plan["toolchain"]["compilerVersion"] and
                       linker_match[1] == plan["toolchain"]["linkerVersion"], "Pinned compiler/linker version mismatch")
        receipt["toolchain"] = {"compiler": compiler, "linker": linker, "compilerVersionOutput": compiler_version,
                                "linkerVersionOutput": linker_version,
                                "node": subprocess.check_output(["node", "--version"], text=True).strip()}
        helper.require(receipt["toolchain"]["node"] == plan["nodeVersion"], "Unexpected Node runtime")
        run_command(["node", "dev/bin/build-dictionary-wasm.js", "--check"], root,
                    output / "unchanged-stock-rebuild.log", receipt["commands"])
        # Retain a stripped reproduction too. This command is exactly the stock
        # parser target command except for its independent temporary output path.
        sources = [str(root / path) for path in target["sources"]]
        stripped = output / "reproduced-stripped.wasm"
        named = output / "recovered-names.wasm"
        argv = [compiler, "-fuse-ld=" + linker, *target["arguments"], "-o", str(stripped), *sources]
        run_command(argv, root, output / "stripped-build.log", receipt["commands"])
        baseline = (root / "dev/data/dictionary-wasm/term-bank-parser.wasm").read_bytes()
        helper.require(stripped.read_bytes() == baseline and helper.digest(baseline) == plan["tracedParserSha256"],
                       "Exact stripped parser reproduction failed")
        named_arguments = [argument for argument in target["arguments"] if argument != STRIP_ARGUMENT]
        run_command([compiler, "-fuse-ld=" + linker, *named_arguments, "-o", str(named), *sources],
                    root, output / "names-build.log", receipt["commands"])
        function_names, parity = recover_names(baseline, named.read_bytes())
        helper.write_json(output / "function-names.json", function_names)
        helper.write_json(output / "noncustom-section-parity.json", parity)
        receipt["parser"] = {"tracedSha256": helper.digest(baseline), "reproducedStrippedSha256": helper.digest(stripped.read_bytes()),
                             "namedSha256": helper.digest(named.read_bytes()), "onlyArgumentRemoved": STRIP_ARGUMENT,
                             "noncustomParity": parity}
        original = plan["analysisInput"]
        run = helper.api_json("/repos/" + helper.REPOSITORY + "/actions/runs/" + str(original["runId"]))
        artifact = helper.api_json("/repos/" + helper.REPOSITORY + "/actions/artifacts/" + str(original["artifactId"]))
        helper.require(run["id"] == original["runId"] and run["head_sha"] == original["headSha"] and run["run_attempt"] == 1 and
                       run["status"] == "completed" and run["conclusion"] == "success", "Original analysis run mismatch")
        helper.require(artifact["id"] == original["artifactId"] and artifact["name"] == original["artifactName"] and
                       artifact["workflow_run"]["id"] == original["runId"] and
                       artifact["workflow_run"]["head_sha"] == original["headSha"] and not artifact["expired"] and
                       artifact["size_in_bytes"] == original["artifactBytes"] and
                       artifact["digest"] == "sha256:" + original["artifactSha256"], "Original analysis artifact mismatch")
        helper.write_json(output / "analysis-input-api.json", {"run": run, "artifact": artifact})
        archive_path = output.parent / "download" / "completed-trace-analysis.zip"
        receipt["analysisInputDownload"] = helper.download_archive(artifact, archive_path)
        with helper.checked_zip(archive_path) as archive:
            member = helper.unique_suffix(archive, "analysis-output/analysis.json")
            data = archive.read(member)
        helper.require(helper.digest(data) == original["analysisSha256"], "Frozen analysis JSON changed")
        analysis = json.loads(data)
        helper.require(analysis["complete"] is True and analysis["productSource"] == PRODUCT_SOURCE and
                       analysis["productTree"] == plan["productTree"] and analysis["traceSha256"] == plan["traceSha256"] and
                       analysis["wasmModules"][PARSER_MODULE]["sha256"] == plan["tracedParserSha256"],
                       "Original trace analysis source mismatch")
        attributed = symbolize(analysis, function_names, plan["tracedParserSha256"])
        helper.write_json(output / "symbolicated-parser-samples.json", {
            "scope": "Renaming exact source-bound sampled function indices only. Original counts and weights unchanged; adjacent wall weights are not CPU time or a gain estimate.",
            "inputAnalysisSha256": original["analysisSha256"], "parity": parity, "rows": attributed
        })
        after = source_snapshot(root, plan)
        helper.write_json(output / "source-after.json", after)
        helper.require(before == after, "Source/tooling changed during symbol recovery")
        print("EXACT_FUNCTION_NAMES " + json.dumps(function_names, separators=(",", ":")))
        for row in attributed:
            print("EXACT_PARSER_SAMPLE " + json.dumps(row, separators=(",", ":")))
        receipt["complete"] = True
        receipt["inputAnalysis"] = original
        receipt["symbolicatedRows"] = len(attributed)
        receipt["limitations"] = plan["limitations"]
    except BaseException as error:
        receipt["failure"] = {"type": type(error).__name__, "message": str(error)}
        traceback.print_exc()
        raise
    finally:
        helper.write_json(output / "recovery-receipt.json", receipt)
        print("EXACT_SYMBOL_RECOVERY_RECEIPT " + json.dumps(receipt, separators=(",", ":")))


if __name__ == "__main__":
    main()
