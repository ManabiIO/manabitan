#!/usr/bin/env python3
"""Build a separate counter-only module; never use it for timing."""
import argparse
import hashlib
import json
import pathlib
import shutil
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument("candidate", type=pathlib.Path)
parser.add_argument("output", type=pathlib.Path)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
source_path = args.candidate / "ext/js/dictionary/wasm/term-bank-parser.c"
source = source_path.read_text()

def replace_once(old, new):
    global source
    if source.count(old) != 1:
        raise RuntimeError(f"Instrumentation anchor is not unique: {old[:80]}")
    source = source.replace(old, new, 1)

replace_once("static int reuse_validated_format3_suffix(", """static uint64_t row_suffix_diag[9];
__attribute__((visibility("default"))) uint64_t row_suffix_diag_get(uint32_t index) {
    return index < 9u ? row_suffix_diag[index] : 0u;
}
static int reuse_validated_format3_suffix(""")
replace_once("    const uint32_t prior_start = prior->definition_tags_start;", "    ++row_suffix_diag[0];\n    const uint32_t prior_start = prior->definition_tags_start;")
replace_once("""    const uint32_t sample = length < 8u ? length : 8u;
    if (!content_bytes_equal_between(src, start + length - sample, src, prior_start + length - sample, sample) ||
        !content_bytes_equal_between(src, start, src, prior_start, length)) { return 0; }""", """    ++row_suffix_diag[1];
    row_suffix_diag[6] += length;
    const uint32_t sample = length < 8u ? length : 8u;
    if (!content_bytes_equal_between(src, start + length - sample, src, prior_start + length - sample, sample)) {
        ++row_suffix_diag[2]; return 0;
    }
    if (!content_bytes_equal_between(src, start, src, prior_start, length)) {
        ++row_suffix_diag[3]; return 0;
    }
    ++row_suffix_diag[4];
    row_suffix_diag[5] += length;""")
replace_once("        const int reuse_row_suffix = validate_glossary_types != 0u &&", """        if (validate_glossary_types != 0u && recent_content_match_streak != 0u && row_count >= 2u) {
            ++row_suffix_diag[7];
            if (scores[row_count - 1u] != scores[row_count - 2u] || sequences[row_count - 1u] != sequences[row_count - 2u]) {
                ++row_suffix_diag[8];
            }
        }
        const int reuse_row_suffix = validate_glossary_types != 0u &&""")
diagnostic_source = args.output / "diagnostic-source.c"
diagnostic_source.write_text(source)
diagnostic_wasm = args.output / "diagnostic.wasm"
manifest = json.loads((args.candidate / "dev/data/dictionary-wasm/manifest.json").read_text())
target = next(item for item in manifest["targets"] if item["name"] == "term-bank-parser.wasm")
compiler = shutil.which("clang-21")
linker = shutil.which("wasm-ld-21")
if not compiler or not linker:
    raise RuntimeError("Pinned compiler/linker are unavailable")
command = [compiler, "-fuse-ld=" + linker, *target["arguments"],
           "-Wl,--export=row_suffix_diag_get", "-o", str(diagnostic_wasm),
           str(diagnostic_source), str(args.candidate / target["sources"][1]),
           "-I" + str(args.candidate / "ext/js/dictionary/wasm")]
subprocess.run(command, check=True)
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
report = {"scope": "Instrumented activation counts only; all durations excluded from performance comparisons",
          "productSourceSha256": sha(source_path), "diagnosticSourceSha256": sha(diagnostic_source),
          "diagnosticWasmSha256": sha(diagnostic_wasm), "command": command,
          "compiler": subprocess.check_output([compiler, "--version"], text=True),
          "linker": subprocess.check_output([linker, "--version"], text=True)}
(args.output / "diagnostic-build.json").write_text(json.dumps(report, indent=2) + "\n")
print("SUFFIX_NUMERIC_DIAGNOSTIC_BUILD " + json.dumps(report, separators=(",", ":")), flush=True)
