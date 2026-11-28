"""One frozen hosted build and correctness acquisition. No timing is collected."""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import traceback
import urllib.request

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
PIN = json.loads((HERE / "toolchain.json").read_text())
SOURCE = json.loads((HERE / "source-pins.json").read_text())
EXPORTS = [
    "_ZSTD_isError", "_ZSTD_compressBound", "_ZSTD_createCCtx", "_ZSTD_freeCCtx",
    "_ZSTD_compress_usingDict", "_ZSTD_compress", "_ZSTD_createDCtx", "_ZSTD_freeDCtx",
    "_ZSTD_getFrameContentSize", "_ZSTD_decompress_usingDict", "_ZSTD_decompress",
    "_manabitan_write_block_envelope", "_malloc", "_free",
]

def digest(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""): h.update(block)
    return h.hexdigest()

def write_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2) + "\n")

def leb(value):
    out = bytearray()
    while value >= 128:
        out.append((value & 127) | 128)
        value >>= 7
    out.append(value)
    return bytes(out)

def sections(data):
    assert data[:8] == b"\0asm\x01\0\0\0"
    at = 8
    while at < len(data):
        start = at
        kind = data[at]
        at += 1
        size = shift = 0
        while True:
            byte = data[at]
            at += 1
            size |= (byte & 127) << shift
            if byte < 128: break
            shift += 7
        yield kind, data[start:at + size]
        at += size
    assert at == len(data)

def named_mirror(arm):
    """Add the compiler's actual symbol map without recompiling code."""
    symbols = list(arm.glob("*.symbols"))
    assert len(symbols) == 1, symbols
    names = {}
    for line in symbols[0].read_text().splitlines():
        index, name = line.split(":", 1)
        assert int(index) not in names
        names[int(index)] = name
    assert names
    entries = bytearray(leb(len(names)))
    for index, name in sorted(names.items()):
        encoded = name.encode()
        entries += leb(index) + leb(len(encoded)) + encoded
    payload = b"\x04name\x01" + leb(len(entries)) + entries
    original = (arm / "zstd-simd-module.wasm").read_bytes()
    named = original + b"\x00" + leb(len(payload)) + payload
    assert [data for kind, data in sections(original) if kind] == [data for kind, data in sections(named) if kind]
    (arm / "zstd-named.wasm").write_bytes(named)
    write_json(arm / "function-names.json", names)
    return {"method": "append the compiler --emit-symbol-map as a name custom section",
            "allNoncustomSectionsIdentical": True,
            "functionNames": len(names), "namedSha256": digest(arm / "zstd-named.wasm")}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--work", type=Path, required=True)
    args = parser.parse_args()
    out, work = args.output.resolve(), args.work.resolve()
    out.mkdir(parents=True, exist_ok=True)
    work.mkdir(parents=True, exist_ok=False)
    logs = out / "logs"
    logs.mkdir()
    manifest = {"status": "started", "purpose": "Build and correctness only; no performance observations",
                "pins": PIN, "sourcePins": SOURCE, "python": sys.version,
                "platform": platform.platform(), "commands": [], "arms": {},
                "controlC": "Exact identity copy of rebuilt A; not independent rebuild evidence"}

    def run(command, name, cwd=None, env=None):
        manifest["commands"].append({"name": name, "argv": list(map(str, command)), "cwd": str(cwd or ROOT)})
        write_json(out / "manifest.json", manifest)
        with (logs / f"{name}.log").open("wb") as log:
            result = subprocess.run(list(map(str, command)), cwd=cwd or ROOT,
                                    env=env, stdout=log, stderr=subprocess.STDOUT)
        manifest["commands"][-1]["returncode"] = result.returncode
        write_json(out / "manifest.json", manifest)
        if result.returncode: raise RuntimeError(f"{name} failed ({result.returncode}); retained log")
        return (logs / f"{name}.log").read_text()

    def git_show(path):
        return subprocess.check_output(["git", "show", f"{PIN['manabitanBase']}:{path}"], cwd=ROOT)

    try:
        manifest["researchCommit"] = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
        run(["git", "diff", "--exit-code", PIN["manabitanBase"], "--", "ext/js",
             "dev/lib/zstd-simd-module.js", "dev/data/zstd-simd.wasm", "dev/data/zstd-block-envelope.c",
             "dev/data/zstd-dicts/jmdict.zdict", "package.json", "package-lock.json"], "unchanged-production-source")
        inputs = out / "inputs"
        inputs.mkdir()
        for path in HERE.iterdir():
            if path.is_file(): shutil.copy2(path, inputs / path.name)
        for path in ["dev/data/zstd-block-envelope.c", "dev/data/zstd-dicts/jmdict.zdict"]:
            (inputs / Path(path).name).write_bytes(git_show(path))
        manifest["researchFiles"] = {str(p.relative_to(HERE)): digest(p)
                                     for p in sorted(HERE.rglob("*")) if p.is_file()}
        manifest["baseBuildScriptSha256"] = hashlib.sha256(git_show("dev/bin/build-zstd-wasm.js")).hexdigest()
        prod = out / "arms/P"
        prod.mkdir(parents=True)
        (prod / "zstd-simd-module.wasm").write_bytes(git_show("dev/data/zstd-simd.wasm"))
        (prod / "zstd-simd-module.js").write_bytes(git_show("dev/lib/zstd-simd-module.js"))
        assert digest(prod / "zstd-simd-module.wasm") == PIN["productionWasmSha256"]

        # Reconstruct only from the untouched baseline. Original semantic
        # manifest stays immutable; machine-dependent capture fields live in
        # a separate receipt and never redefine the expected benchmark input.
        expected_bytes = (HERE / "corpus-manifest.json").read_bytes()
        assert hashlib.sha256(expected_bytes).hexdigest() == SOURCE["expectedCorpusManifestSha256"]
        expected = json.loads(expected_bytes)
        lock_bytes = (ROOT / "test/perf/dictionaries.lock.json").read_bytes()
        assert lock_bytes == git_show("test/perf/dictionaries.lock.json")
        assert hashlib.sha256(lock_bytes).hexdigest() == expected["lockSha256"]
        assert digest(ROOT / "dev/data/dictionary-wasm/term-bank-parser.wasm") == expected["wasmSha256"]
        assert digest(HERE / "capture-records-original.mjs.txt") == expected["captureSha256"]
        assert digest(HERE / "pack-records-original.py.txt") == expected["packerSha256"]
        spec = json.loads(lock_bytes)["dictionaries"]["jmdict"]
        cache = ROOT / "builds/e2e-dictionary-cache"
        cache.mkdir(parents=True, exist_ok=True)
        zip_path = cache / spec["cacheFile"]
        if not zip_path.exists():
            request = urllib.request.Request(spec["url"], headers={"User-Agent": "Manabitan-count64-research"})
            with urllib.request.urlopen(request, timeout=120) as src, zip_path.open("wb") as dst:
                shutil.copyfileobj(src, dst)
        assert zip_path.stat().st_size == spec["sizeBytes"] and digest(zip_path) == spec["sha256"]
        records = work / "records-jmdict"
        corpus = out / "corpus-jmdict"
        run(["node", "--expose-gc", HERE / "capture-records.mjs", "jmdict", records], "capture-frozen-baseline")
        run(["python3", HERE / "pack-records.py", records, corpus, work / "dedup-spill"], "pack-frozen-records")
        actual_bytes = (corpus / "manifest.json").read_bytes()
        actual = json.loads(actual_bytes)
        environment_fields = {"captureSha256", "node", "maxRssKiB", "recordManifestSha256", "packerSha256"}
        assert {k: v for k, v in actual.items() if k not in environment_fields} == {k: v for k, v in expected.items() if k not in environment_fields}, "Frozen corpus semantic manifest mismatch"
        for entry in expected["blocks"]:
            block = gzip.decompress((corpus / entry["name"]).read_bytes())
            assert len(block) == entry["bytes"] and hashlib.sha256(block).hexdigest() == entry["sha256"]
        (corpus / "expected-manifest.json").write_bytes(expected_bytes)
        shutil.copy2(records / "manifest.json", inputs / "reconstructed-record-manifest.json")
        manifest["corpusReconstruction"] = {
            "allSemanticFieldsEqual": True, "allBlocksExact": True,
            "expectedManifestSha256": SOURCE["expectedCorpusManifestSha256"],
            "actualManifestSha256": hashlib.sha256(actual_bytes).hexdigest(),
            "environmentFieldsRetainedSeparately": sorted(environment_fields),
            "rows": expected["rows"], "bytes": expected["persistedBytes"], "blocks": len(expected["blocks"]),
        }

        archive = work / "sdk.tar.xz"
        with urllib.request.urlopen(PIN["sdkArchiveUrl"], timeout=120) as src, archive.open("wb") as dst:
            shutil.copyfileobj(src, dst)
        assert digest(archive) == PIN["sdkArchiveSha256"], "Official SDK archive checksum mismatch"
        sdk = work / "sdk"
        sdk.mkdir()
        # Same one-directory stripping used by the official pinned emsdk.py.
        run(["tar", "-xf", archive, "--strip-components=1", "-C", sdk], "extract-official-sdk")
        config = work / "emscripten-config.py"
        node = shutil.which("node")
        assert node is not None
        config.write_text(f"LLVM_ROOT = {str(sdk / 'bin')!r}\nBINARYEN_ROOT = {str(sdk)!r}\nNODE_JS = [{node!r}]\n")
        env = dict(os.environ, EM_CONFIG=str(config), EM_CACHE=str(work / "em-cache"))
        emcc = sdk / "emscripten/emcc"
        manifest["toolVersions"] = {
            "emcc": run([emcc, "--version"], "emcc-version", env=env),
            "clang": run([sdk / "bin/clang", "--version"], "clang-version", env=env),
            "wasmLd": run([sdk / "bin/wasm-ld", "--version"], "wasm-ld-version", env=env),
            "wasmOpt": run([sdk / "bin/wasm-opt", "--version"], "wasm-opt-version", env=env),
            "node": run([node, "--version"], "node-version", env=env),
        }
        assert "5.0.1" in manifest["toolVersions"]["emcc"]
        manifest["toolFiles"] = {p: digest(sdk / p) for p in [
            "emscripten/emcc.py", "emscripten/emscripten-version.txt", "bin/clang", "bin/wasm-ld", "bin/wasm-opt"]}
        source_a = work / "source-A"
        run(["git", "init", "--quiet", source_a], "init-upstream")
        run(["git", "-C", source_a, "fetch", "--quiet", "--depth=1", "https://github.com/facebook/zstd.git", PIN["zstdCommit"]], "fetch-upstream")
        run(["git", "-C", source_a, "checkout", "--quiet", "FETCH_HEAD"], "checkout-upstream")
        assert subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source_a, text=True).strip() == PIN["zstdCommit"]
        source_b = work / "source-B"
        run(["git", "clone", "--quiet", "--shared", source_a, source_b], "clone-candidate")
        assert digest(source_a / "lib/compress/zstd_compress_internal.h") == SOURCE["upstreamHeaderSha256"]
        assert digest(HERE / "count64.patch") == SOURCE["patchSha256"]
        run(["git", "apply", "--check", HERE / "count64.patch"], "patch-check", cwd=source_b)
        run(["git", "apply", HERE / "count64.patch"], "patch-apply", cwd=source_b)
        assert digest(source_b / "lib/compress/zstd_compress_internal.h") == SOURCE["candidateHeaderSha256"]
        assert subprocess.check_output(["git", "diff", "--name-only"], cwd=source_b, text=True).strip() == "lib/compress/zstd_compress_internal.h"
        (inputs / "actual-upstream.diff").write_bytes(subprocess.check_output(["git", "diff"], cwd=source_b))
        settings = ["-s", "EXPORTED_FUNCTIONS=" + json.dumps(EXPORTS, separators=(",", ":")),
                    "-s", 'EXPORTED_RUNTIME_METHODS=["HEAPU8"]', "-s", "FILESYSTEM=0",
                    "-s", "ALLOW_MEMORY_GROWTH=1", "-s", "MODULARIZE=1", "-s", "EXPORT_ES6=1",
                    "-s", "EXPORT_NAME=createZstdModule", "-s", "ENVIRONMENT=web,worker"]
        for label, source in [("A", source_a), ("B", source_b)]:
            arm = out / "arms" / label
            arm.mkdir()
            single = source / "build/single_file_libs"
            run(["./create_single_file_library.sh"], f"amalgamate-{label}", cwd=single)
            shutil.copy2(single / "zstd.c", inputs / f"zstd-{label}.c")
            command = [emcc, single / "zstd.c", inputs / "zstd-block-envelope.c", "-O3", "-flto", "-msimd128",
                       "-o", arm / "zstd-simd-module.js", *settings, "--emit-symbol-map"]
            run(command, f"build-{label}", env=env)
            manifest["arms"][label] = {"sourceSha256": digest(single / "zstd.c"), "nameMirror": named_mirror(arm)}
            run([sdk / "bin/wasm-dis", arm / "zstd-named.wasm", "-o", arm / "zstd-named.wat"], f"disassemble-{label}", env=env)
            wat = (arm / "zstd-named.wat").read_text()
            manifest["arms"][label]["i64CtzSites"] = wat.count("(i64.ctz")
            probe = arm / "count-probe.wasm"
            run([emcc, HERE / "wasm-boundary-probe.c", "-I", source, "-O3", "-msimd128", "--no-entry",
                 "-s", "STANDALONE_WASM=1", "-s", 'EXPORTED_FUNCTIONS=["_count_probe","_count_two_probe"]',
                 "-s", "FILESYSTEM=0", "-s", "INITIAL_MEMORY=1048576", "-s", "STACK_SIZE=65536",
                 "-o", probe], f"build-probe-{label}", env=env)
        shutil.copytree(out / "arms/A", out / "arms/C")
        manifest["arms"]["C"] = {"identityCopyOf": "A"}
        for label in ["P", "A", "B", "C"]:
            arm = out / "arms" / label
            manifest["arms"].setdefault(label, {})["files"] = {
                p.name: {"bytes": p.stat().st_size, "sha256": digest(p)} for p in sorted(arm.iterdir())}
        manifest["productionVsRebuilt"] = {
            "wasmIdentical": (prod / "zstd-simd-module.wasm").read_bytes() == (out / "arms/A/zstd-simd-module.wasm").read_bytes(),
            "loaderIdentical": (prod / "zstd-simd-module.js").read_bytes() == (out / "arms/A/zstd-simd-module.js").read_bytes(),
            "allNoncustomWasmSectionsIdentical": [s for k, s in sections((prod / "zstd-simd-module.wasm").read_bytes()) if k] == [s for k, s in sections((out / "arms/A/zstd-simd-module.wasm").read_bytes()) if k],
        }
        manifest["toolVersions"]["nativeCc"] = run(["cc", "--version"], "native-cc-version")
        manifest["nativeCcSha256"] = digest(shutil.which("cc"))
        oracle = work / "native-oracle"
        run(["cc", "-O2", "-D__wasm32__", "-I", source_b, HERE / "native-boundary-oracle.c", "-o", oracle], "build-native-oracle")
        manifest["nativeOracle"] = json.loads(run([oracle], "native-oracle"))
        write_json(out / "manifest.json", manifest)
        run([node, HERE / "qualify-wasm.mjs", out, corpus], "wasm-parity")
        manifest["qualification"] = json.loads((out / "qualification.json").read_text())
        assert manifest["qualification"]["status"] == "passed"
        for relative, expected_hash in manifest["researchFiles"].items():
            assert digest(HERE / relative) == expected_hash
        manifest["postResearchIdentity"] = "passed"
        manifest["status"] = "passed"
    except BaseException as error:
        manifest["status"] = "failed"
        manifest["error"] = repr(error)
        (out / "failure.txt").write_text(traceback.format_exc())
        raise
    finally:
        write_json(out / "manifest.json", manifest)

if __name__ == "__main__": main()
