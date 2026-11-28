#!/usr/bin/env python3
"""Build a measurement-only seeded Zstd module after stock reproduction passes."""
import ast
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

root = Path(__file__).resolve().parents[2]
output = Path(sys.argv[1]).resolve()
source = Path(sys.argv[2]).resolve()
output.mkdir(parents=True, exist_ok=True)
sdk = Path(os.environ["EMSDK"]).resolve()
sdk_commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=sdk, text=True).strip()
assert sdk_commit == "14c18b569f55138fe4963924162244251f454fb0"
releases = json.loads((sdk / "emscripten-releases-tags.json").read_text())
sdk_build = releases["releases"]["5.0.1"]
assert sdk_build == "bf32ae8b61ac8efeb7eca01b54c8307f992724f7"
assert (sdk / "upstream/emscripten/emscripten-version.txt").read_text().strip() == "5.0.1-git"
emcc_path = Path(shutil.which("emcc")).resolve()
assert emcc_path.is_relative_to(sdk / "upstream/emscripten")
commit = "82d322c4973d9e2968d94047a40892bc6d9a9bdf"
assert subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source, text=True).strip() == commit
subprocess.run(["git", "diff", "--exit-code"], cwd=source, check=True)
single = source / "build/single_file_libs"
subprocess.run(["./create_single_file_library.sh"], cwd=single, check=True)
script = (root / "dev/bin/build-zstd-wasm.js").read_text()
matched = re.search(r"const EXPORTED_FUNCTIONS = (\[[\s\S]*?\]);", script)
assert matched
exports = ast.literal_eval(matched.group(1))
assert exports == [
    "_ZSTD_isError", "_ZSTD_compressBound", "_ZSTD_createCCtx", "_ZSTD_freeCCtx",
    "_ZSTD_compress_usingDict", "_ZSTD_compress", "_ZSTD_createDCtx", "_ZSTD_freeDCtx",
    "_ZSTD_getFrameContentSize", "_ZSTD_decompress_usingDict", "_ZSTD_decompress",
    "_manabitan_write_block_envelope", "_malloc", "_free",
]
exports += ["_ZSTD_sizeof_CCtx", "_mb_create", "_mb_free", "_mb_compress", "_mb_context_bytes", "_mb_seed_builds", "_mb_direct_fallbacks"]
probe = root / "dev/perf/seed-cctx-probe.c"
digest = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
assert digest(probe) == "6221f4c2fa9c0cbccf3911f0a89b9bbbb6f904c79fd7a2c233d16d1ef1f94081"
assert digest(root / "dev/data/zstd-simd.wasm") == "ad3a18c197d72167262d01fd202976325f57a6697bca627f4527c96d4dbbcfcc"
command = [
    "emcc", str(probe), str(root / "dev/data/zstd-block-envelope.c"),
    "-I", str(single), "-O3", "-flto", "-msimd128", "-o", str(output / "seed-module.js"),
    "-s", "EXPORTED_FUNCTIONS=" + json.dumps(exports),
    "-s", 'EXPORTED_RUNTIME_METHODS=["HEAPU8"]',
    "-s", "FILESYSTEM=0", "-s", "ALLOW_MEMORY_GROWTH=1",
    "-s", "MODULARIZE=1", "-s", "EXPORT_ES6=1",
    "-s", "EXPORT_NAME=createZstdModule", "-s", "ENVIRONMENT=web,worker",
]
receipt = {
    "scope": "Measurement-only seeded module; stock artifacts must reproduce before this build",
    "zstdCommit": commit,
    "emsdkCommit": sdk_commit,
    "sdkRelease": "5.0.1",
    "sdkBuild": sdk_build,
    "emccPath": str(emcc_path),
    "releaseMapSha256": digest(sdk / "emscripten-releases-tags.json"),
    "emccVersion": subprocess.check_output(["emcc", "--version"], text=True),
    "command": command,
    "exports": exports,
    "sourceHashes": {str(p.relative_to(root)): digest(p) for p in [probe, root / "dev/data/zstd-block-envelope.c", root / "dev/bin/build-zstd-wasm.js"]},
    "amalgamationSha256": digest(single / "zstd.c"),
    "status": "building",
}
receipt_path = output / "build-receipt.json"
def save():
    receipt_path.write_text(json.dumps(receipt, indent=2) + "\n")
save()
try:
    subprocess.run(command, check=True)
    for stem in ("seed", "stock"):
        if stem == "seed":
            original_js, wasm = output / "seed-module.js", output / "seed-module.wasm"
        else:
            original_js, wasm = root / "dev/lib/zstd-simd-module.js", root / "dev/data/zstd-simd.wasm"
        # Only the file suffix changes for explicit Node ESM loading. Both factories
        # receive wasmBinary, so their original relative WASM URL is never fetched.
        (output / f"{stem}-module.mjs").write_bytes(original_js.read_bytes())
        if stem == "stock":
            (output / "stock-module.wasm").write_bytes(wasm.read_bytes())
        receipt[stem] = {"javascriptSha256": digest(original_js), "wasmSha256": digest(wasm), "wasmBytes": wasm.stat().st_size}
    receipt["status"] = "complete"
except BaseException as error:
    receipt["status"] = "failed"
    receipt["error"] = repr(error)
    raise
finally:
    save()
print(json.dumps(receipt, separators=(",", ":")))
