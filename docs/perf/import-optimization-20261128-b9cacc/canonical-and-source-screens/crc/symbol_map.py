#!/usr/bin/env python3
"""Bind function names to frozen WASM bytes without changing executable sections."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys

BASE = "9e10d3b3fcf66d344ab31bc42c9b522fa5215da2"
MANIFEST = "dev/data/dictionary-wasm/manifest.json"
MODULE_HASHES = {
    "term-bank-parser.wasm": "8ae00698649c5a3e41039b13c5ffe1dff2d4e69948cba2e3c063f381250031ee",
    "term-content-canonical-scan-v1.wasm": "40948d5c20d26253e86c93d267e3cbb3817ea87c9731e02bcca0523c0eb3d6af",
}
SOURCE_DIGEST = "3a57887352cbc53a62bd3bda797f6513a72634515e6ea65a9a4ae9120739a1b6"
BUILD_INPUTS = (MANIFEST, "dev/bin/build-dictionary-wasm.js", "dev/dictionary-wasm.js",
                "dev/json.js", "ext/js/core/json.js", "package.json", "package-lock.json")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def git(root: pathlib.Path, *args: str) -> str:
    return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()


class Reader:
    def __init__(self, data: bytes):
        self.data, self.position = data, 0

    def take(self, count: int) -> bytes:
        require(count >= 0 and self.position + count <= len(self.data), "Truncated WASM structure")
        result = self.data[self.position:self.position + count]
        self.position += count
        return result

    def byte(self) -> int:
        return self.take(1)[0]

    def u32(self) -> int:
        result = 0
        for shift in range(0, 35, 7):
            byte = self.byte()
            require(shift != 28 or byte < 16, "Overflowing varuint32")
            result |= (byte & 127) << shift
            if byte < 128:
                return result
        raise ValueError("Overlong varuint32")

    def name(self) -> str:
        return self.take(self.u32()).decode("utf-8", errors="strict")

    def finish(self) -> None:
        require(self.position == len(self.data), "Unexpected trailing WASM structure bytes")


def sections(data: bytes) -> list[dict]:
    reader = Reader(data)
    require(reader.take(8) == b"\x00asm\x01\x00\x00\x00", "Unexpected WASM header/version")
    result = []
    ids = set()
    while reader.position < len(data):
        start = reader.position
        kind = reader.byte()
        require(kind <= 13 and (kind == 0 or kind not in ids), "Invalid/duplicate WASM section")
        ids.add(kind)
        payload = reader.take(reader.u32())
        result.append({"id": kind, "raw": data[start:reader.position], "payload": payload})
    return result


def noncustom(data: bytes) -> bytes:
    return data[:8] + b"".join(section["raw"] for section in sections(data) if section["id"] != 0)


def function_metadata(data: bytes, require_names: bool = True) -> list[dict]:
    parsed = sections(data)
    by_id = {section["id"]: section["payload"] for section in parsed if section["id"] != 0}
    # These exact locked modules import no functions. The canonical module
    # imports only memory; reject a changed ABI rather than invent an offset.
    if 2 in by_id:
        imports = Reader(by_id[2])
        for _ in range(imports.u32()):
            imports.name()
            imports.name()
            require(imports.byte() == 2, "Unexpected non-memory import in frozen dictionary module")
            flags = imports.u32()
            require(flags in (0, 1, 3), "Unexpected memory limits")
            imports.u32()
            if flags & 1:
                imports.u32()
        imports.finish()
    functions = Reader(by_id[3])
    count = functions.u32()
    type_indexes = [functions.u32() for _ in range(count)]
    functions.finish()
    code = Reader(by_id[10])
    require(code.u32() == count, "Function/code counts disagree")
    bodies = [code.take(code.u32()) for _ in range(count)]
    code.finish()
    exports = {i: [] for i in range(count)}
    if 7 in by_id:
        exported = Reader(by_id[7])
        for _ in range(exported.u32()):
            name, kind, index = exported.name(), exported.byte(), exported.u32()
            if kind == 0:
                require(index < count, "Exported function index out of range")
                exports[index].append(name)
        exported.finish()
    names = {}
    saw_function_names = False
    for section in parsed:
        if section["id"] != 0:
            continue
        custom = Reader(section["payload"])
        if custom.name() != "name":
            continue
        while custom.position < len(custom.data):
            kind, size = custom.byte(), custom.u32()
            payload = Reader(custom.take(size))
            if kind != 1:
                continue
            require(not saw_function_names, "Duplicate function-name subsection")
            saw_function_names = True
            for _ in range(payload.u32()):
                index, name = payload.u32(), payload.name()
                require(index < count and index not in names and bool(name), "Invalid/duplicate function name")
                names[index] = name
            payload.finish()
    if require_names:
        require(set(names) == set(range(count)), "Function-name map is incomplete")
    return [{"index": index, "name": names.get(index), "exports": exports[index],
             "typeIndex": type_indexes[index], "bodyBytes": len(bodies[index]), "bodySha256": sha256(bodies[index])}
            for index in range(count)]


def prove_mapping(stripped: bytes, named: bytes) -> dict:
    require(noncustom(stripped) == noncustom(named), "Executable/data/ABI sections differ after removing strip flag")
    mapping = function_metadata(named)
    original = function_metadata(stripped, require_names=False)
    require([{k: v for k, v in row.items() if k != "name"} for row in mapping] ==
            [{k: v for k, v in row.items() if k != "name"} for row in original], "Function body/export identity mismatch")
    return {"strippedSha256": sha256(stripped), "namedSha256": sha256(named),
            "noncustomSectionsEqual": True, "noncustomSha256": sha256(noncustom(stripped)),
            "sections": [{"id": s["id"], "bytes": len(s["raw"]), "sha256": sha256(s["raw"])} for s in sections(named)],
            "functions": mapping}


def snapshot(root: pathlib.Path) -> tuple[dict, dict[str, str]]:
    require(git(root, "rev-parse", "HEAD") == BASE, "Expected exact frozen product HEAD")
    require(not git(root, "diff", "--name-only") and not git(root, "diff", "--cached", "--name-only"), "Tracked product inputs are dirty")
    manifest = json.loads((root / MANIFEST).read_text())
    require(manifest["toolchain"] == {"compilerVersion": "21.1.8", "linkerVersion": "21.1.8"}, "Toolchain lock drift")
    sources = []
    for directory, child_directories, files in os.walk(root / "ext/js/dictionary/wasm", followlinks=False):
        for name in (*child_directories, *files):
            require(not (pathlib.Path(directory) / name).is_symlink(), "Linked native source is unsupported")
        sources.extend((pathlib.Path(directory) / name).relative_to(root).as_posix() for name in files if name.lower().endswith((".c", ".h")))
    source_hashes = {path: sha256((root / path).read_bytes()) for path in sorted(sources)}
    source_digest = sha256("".join(f"{path}\0{value}\n" for path, value in source_hashes.items()).encode())
    require(len(sources) == manifest["sourceFileCount"] == 14 and source_digest == manifest["sourceDigest"] == SOURCE_DIGEST,
            "Native source-set identity drift")
    require({target["name"]: target["sha256"] for target in manifest["targets"]} == MODULE_HASHES, "Native artifact lock drift")
    hashes = {**source_hashes, **{path: sha256((root / path).read_bytes()) for path in BUILD_INPUTS}}
    for name, expected in MODULE_HASHES.items():
        path = "dev/data/dictionary-wasm/" + name
        hashes[path] = sha256((root / path).read_bytes())
        require(hashes[path] == expected, f"Frozen module hash mismatch: {name}")
    return manifest, hashes


def run(root: pathlib.Path, output: pathlib.Path) -> None:
    output.mkdir(parents=True, exist_ok=True)
    require(not (output / "receipt.json").exists(), "Refusing to overwrite an earlier diagnostic receipt")
    receipt = {"schemaVersion": 1, "baseline": BASE, "scope": "Symbol identity only; no import, tuning, or performance claim",
               "status": "started", "commands": [], "targets": {}}
    save = lambda: (output / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    save()
    try:
        manifest, hashes = snapshot(root)
        receipt.update({"baselineTree": git(root, "rev-parse", "HEAD^{tree}"), "sourceIdentity": hashes, "manifest": manifest})
        for path in hashes:
            destination = output / "frozen-inputs" / path
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(root / path, destination)
        compiler, linker = shutil.which("clang-21"), shutil.which("wasm-ld-21")
        require(compiler is not None and linker is not None, "Pinned native toolchain is unavailable")
        env = {**os.environ, "MANABITAN_CLANG": compiler, "MANABITAN_WASM_LD": linker}

        def command(label: str, argv: list[str]) -> str:
            process = subprocess.run(argv, cwd=root, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            (output / (label + ".stdout.log")).write_text(process.stdout)
            (output / (label + ".stderr.log")).write_text(process.stderr)
            receipt["commands"].append({"label": label, "argv": argv, "cwd": str(root), "returncode": process.returncode,
                                        "stdoutSha256": sha256(process.stdout.encode()), "stderrSha256": sha256(process.stderr.encode())})
            save()
            require(process.returncode == 0, f"Command failed: {label}")
            return process.stdout

        versions = {"compiler": command("clang-version", [compiler, "--version"]),
                    "linker": command("lld-version", [linker, "--version"]),
                    "node": command("node-version", ["node", "--version"])}
        require(re.search(r"\bclang version 21\.1\.8\b", versions["compiler"]) is not None and
                re.search(r"\bLLD 21\.1\.8\b", versions["linker"]) is not None, "Pinned native compiler/linker version mismatch")
        receipt["tools"] = {"compiler": compiler, "linker": linker, "versions": versions}
        # Execute the repository's original stripped reproduction gate before
        # compiling any names-enabled module, with the same explicit linker.
        command("existing-wasm-check", ["npm", "run", "build:dictionary-wasm", "--", "--check"])
        require(snapshot(root)[1] == hashes, "Inputs changed during existing reproduction check")
        scratch = output / "named-modules"
        scratch.mkdir()
        for target in manifest["targets"]:
            arguments = target["arguments"]
            require(arguments.count("-Wl,--strip-all") == 1, "Expected exactly one strip-all argument")
            changed = [argument for argument in arguments if argument != "-Wl,--strip-all"]
            destination = scratch / target["name"]
            argv = [compiler, "-fuse-ld=" + linker, *changed, "-o", str(destination),
                    *[str(root / path) for path in target["sources"]]]
            command("compile-" + target["name"], argv)
            require(snapshot(root)[1] == hashes, "Inputs changed during names-enabled reproduction")
            stripped = (root / "dev/data/dictionary-wasm" / target["name"]).read_bytes()
            proof = prove_mapping(stripped, destination.read_bytes())
            proof["onlyRemovedArgument"] = "-Wl,--strip-all"
            receipt["targets"][target["name"]] = proof
            (output / (target["name"] + ".functions.json")).write_text(json.dumps(proof, indent=2) + "\n")
            save()
        require(snapshot(root)[1] == hashes, "Final frozen input drift")
        receipt["status"] = "passed"
        receipt["trackedProductCleanAfter"] = True
        print(json.dumps({"status": "passed", "baseline": BASE, "targets": {name: {"functions": len(proof["functions"]),
                           "noncustomSectionsEqual": proof["noncustomSectionsEqual"], "strippedSha256": proof["strippedSha256"]}
                           for name, proof in receipt["targets"].items()}}, indent=2))
    except Exception as error:
        receipt["status"] = "failed"
        receipt["error"] = str(error)
        raise
    finally:
        save()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    args = parser.parse_args()
    root, output = args.root.resolve(), args.output.resolve()
    require(not output.is_relative_to(root / "ext") and not output.is_relative_to(root / "dev"), "Diagnostic outputs must not enter product input directories")
    run(root, output)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Native symbol-map diagnostic rejected: {error}", file=sys.stderr)
        raise
