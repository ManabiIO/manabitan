#!/usr/bin/env python3
"""Record pinned WASM and compiler assembly identities; never instrument timing binaries."""
import argparse
import collections
import hashlib
import json
import pathlib
import re
import shutil
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument("baseline", type=pathlib.Path)
parser.add_argument("candidate", type=pathlib.Path)
parser.add_argument("output", type=pathlib.Path)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
compiler = shutil.which("clang-21")
linker = shutil.which("wasm-ld-21")
if not compiler or not linker:
    raise RuntimeError("The pinned compiler and linker are unavailable")

def sections(data):
    if data[:8] != b"\0asm\x01\0\0\0":
        raise RuntimeError("Not a WASM v1 module")
    cursor, result = 8, []
    while cursor < len(data):
        identifier = data[cursor]
        cursor += 1
        length, shift = 0, 0
        while True:
            byte = data[cursor]
            cursor += 1
            length |= (byte & 127) << shift
            shift += 7
            if byte < 128:
                break
        if cursor + length > len(data):
            raise RuntimeError("Invalid WASM section length")
        result.append({"id": identifier, "bytes": length})
        cursor += length
    return result

report = {"schema": 1, "scope": "Static compiler assembly sites and module sizes, not dynamic operation counts or a performance result",
          "compiler": subprocess.check_output([compiler, "--version"], text=True),
          "linker": subprocess.check_output([linker, "--version"], text=True),
          "runnerSha256": sha(pathlib.Path(__file__)), "arms": {}}
for arm in ["baseline", "candidate"]:
    root = getattr(args, arm).resolve()
    manifest = json.loads((root / "dev/data/dictionary-wasm/manifest.json").read_text())
    target = next(item for item in manifest["targets"] if item["name"] == "term-bank-parser.wasm")
    arguments = [arg for arg in target["arguments"] if not arg.startswith("-Wl,")]
    assembly = args.output / f"{arm}-term-bank-parser.s"
    source = root / "ext/js/dictionary/wasm/term-bank-parser.c"
    command = [compiler, *arguments, "-S", "-o", str(assembly), str(source)]
    subprocess.run(command, check=True)
    functions, active, lines = {}, None, []
    for number, line in enumerate(assembly.read_text().splitlines(), 1):
        match = re.match(r"^([A-Za-z_][A-Za-z0-9_.$]*):", line)
        if match and "parse_composite_span" in match.group(1):
            active, lines = match.group(1), []
        if active is not None:
            lines.append({"line": number, "text": line})
            if re.search(r"\bend_function\b", line):
                operations = collections.Counter()
                sites = []
                for entry in lines:
                    instruction = re.match(r"\s*((?:i32|i64|f32|f64|v128)\.(?:load|store)[A-Za-z0-9_]*)(?:\s|$)", entry["text"])
                    if instruction:
                        operations[instruction.group(1)] += 1
                        sites.append(entry)
                functions[active] = {"assemblyLines": len(lines), "loadStoreSites": dict(operations), "sites": sites}
                active = None
    wasm = root / "ext/lib/term-bank-parser.wasm"
    report["arms"][arm] = {"sourceSha256": sha(source), "manifestSha256": sha(root / "dev/data/dictionary-wasm/manifest.json"),
                           "wasmSha256": sha(wasm), "wasmBytes": wasm.stat().st_size,
                           "wasmSections": sections(wasm.read_bytes()), "assemblySha256": sha(assembly),
                           "command": command, "functions": functions}
(args.output / "codegen.json").write_text(json.dumps(report, indent=2) + "\n")
compact = {**report, "arms": {arm: {**data, "functions": {name: {key: value for key, value in fn.items() if key != "sites"}
                                                       for name, fn in data["functions"].items()}}
                             for arm, data in report["arms"].items()}}
print("HINTS_CODEGEN " + json.dumps(compact, separators=(",", ":")), flush=True)
