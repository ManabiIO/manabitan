#!/usr/bin/env python3
"""Build a separately instrumented module; every diagnostic duration is excluded."""
import argparse
import hashlib
import json
import pathlib
import shutil
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('candidate', type=pathlib.Path)
parser.add_argument('output', type=pathlib.Path)
parser.add_argument('--source-only', action='store_true')
args = parser.parse_args()
here = pathlib.Path(__file__).resolve().parent
binding = json.loads((here / 'binding.json').read_text())
assert args.source_only or binding['finalized'] is True, 'Unreviewed diagnostic can only emit source text'
fields = json.loads((here / 'diagnostic-fields.json').read_text())
assert len(fields) == 16
args.output.mkdir(parents=True, exist_ok=True)
source_path = args.candidate / 'ext/js/dictionary/wasm/term-bank-parser.c'
source = source_path.read_text()
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
assert sha(source_path) == binding['candidateCSourceSha256']
original = source


def replace_once(old, new):
    global source
    if source.count(old) != 1:
        raise RuntimeError('Instrumentation anchor is not unique: ' + old[:100])
    source = source.replace(old, new, 1)


# Slots0..8 retain the already-qualified numeric-admission diagnostic meaning.
replace_once('static int reuse_validated_format3_suffix(', '''static uint64_t row_suffix_diag[16];
__attribute__((visibility("default"))) uint64_t row_suffix_diag_get(uint32_t index) {
    return index < 16u ? row_suffix_diag[index] : 0u;
}
static int reuse_validated_format3_suffix(''')
replace_once('    const uint32_t prior_start = prior->definition_tags_start;',
             '    ++row_suffix_diag[0];\n    const uint32_t prior_start = prior->definition_tags_start;')
replace_once('''    const uint32_t sample = length < 8u ? length : 8u;
    if (!content_bytes_equal_between(src, start + length - sample, src, prior_start + length - sample, sample) ||
        !content_bytes_equal_between(src, start, src, prior_start, length)) { return 0; }''', '''    ++row_suffix_diag[1];
    row_suffix_diag[6] += length;
    const uint32_t sample = length < 8u ? length : 8u;
    if (!content_bytes_equal_between(src, start + length - sample, src, prior_start + length - sample, sample)) {
        ++row_suffix_diag[2]; return 0;
    }
    if (!content_bytes_equal_between(src, start, src, prior_start, length)) {
        ++row_suffix_diag[3]; return 0;
    }
    ++row_suffix_diag[4];
    row_suffix_diag[5] += length;''')
replace_once('        const int reuse_row_suffix = validate_glossary_types != 0u &&', '''        if (validate_glossary_types != 0u && recent_content_match_streak != 0u && row_count >= 2u) {
            ++row_suffix_diag[7];
            if (scores[row_count - 1u] != scores[row_count - 2u] || sequences[row_count - 1u] != sequences[row_count - 2u]) {
                ++row_suffix_diag[8];
            }
        }
        const int reuse_row_suffix = validate_glossary_types != 0u &&''')

# A successful proof skips token-end rescans before current-key interning.
replace_once('        if (row_parse_status == 0) { return -1; }', '''        if (row_parse_status == 0) { return -1; }
        if (row_parse_status == TERM_ROW_PARSE_REUSED_SUFFIX) {
            ++row_suffix_diag[9];
            ++row_suffix_diag[10];
            if (rows[row_count].sequence_start != 0xffffffffu) { ++row_suffix_diag[11]; }
        }''')

# Only rows that reach the numeric consumer avoid conversions. A malformed or
# oversized current key can leave these lower than successful parse proofs.
replace_once('''        if (row_parse_status == TERM_ROW_PARSE_REUSED_SUFFIX) {
            // This proof is stronger than glossary equality.''', '''        if (row_parse_status == TERM_ROW_PARSE_REUSED_SUFFIX) {
            ++row_suffix_diag[12];
            ++row_suffix_diag[13];
            if (parsed_row->sequence_start != 0xffffffffu) { ++row_suffix_diag[14]; }
            // This proof is stronger than glossary equality.''')

# This anchor is solely in the ordinary recent-window branch. The global-exact
# path keeps its original comparator and does not accrue this avoided count.
replace_once('''            ) {
                recent_match = glossary_witness;
                recent_content_signatures[row_count % RECENT_CONTENT_DEDUP_WINDOW] =''', '''            ) {
                if (row_parse_status == TERM_ROW_PARSE_REUSED_SUFFIX) { ++row_suffix_diag[15]; }
                recent_match = glossary_witness;
                recent_content_signatures[row_count % RECENT_CONTENT_DEDUP_WINDOW] =''')

diagnostic_source = args.output / 'diagnostic-source.c'
assert not diagnostic_source.exists(), 'Never overwrite a previous diagnostic preparation'
diagnostic_source.write_text(source)
assert source != original and sha(source_path) == binding['candidateCSourceSha256']
report = {
    'scope': 'Separate counter-only module. All diagnostic durations excluded from performance comparisons.',
    'sourceOnly': args.source_only,
    'productSourceSha256': sha(source_path),
    'diagnosticSourceSha256': sha(diagnostic_source),
    'diagnosticFieldsSha256': sha(here / 'diagnostic-fields.json'),
    'diagnosticFields': fields,
    'command': None, 'compiler': None, 'linker': None, 'diagnosticWasmSha256': None,
}
if not args.source_only:
    manifest = json.loads((args.candidate / 'dev/data/dictionary-wasm/manifest.json').read_text())
    target = next(item for item in manifest['targets'] if item['name'] == 'term-bank-parser.wasm')
    compiler, linker = shutil.which('clang-21'), shutil.which('wasm-ld-21')
    if not compiler or not linker:
        raise RuntimeError('Pinned compiler/linker are unavailable')
    compiler_version = subprocess.check_output([compiler, '--version'], text=True)
    linker_version = subprocess.check_output([linker, '--version'], text=True)
    assert '21.1.8' in compiler_version and '21.1.8' in linker_version
    diagnostic_wasm = args.output / 'diagnostic.wasm'
    command = [compiler, '-fuse-ld=' + linker, *target['arguments'],
               '-Wl,--export=row_suffix_diag_get', '-o', str(diagnostic_wasm),
               str(diagnostic_source), str(args.candidate / target['sources'][1]),
               '-I' + str(args.candidate / 'ext/js/dictionary/wasm')]
    subprocess.run(command, check=True)
    report.update(command=command, compiler=compiler_version, linker=linker_version,
                  diagnosticWasmSha256=sha(diagnostic_wasm))
(args.output / 'diagnostic-build.json').write_text(json.dumps(report, indent=2) + '\n')
print('SUFFIX_PROOF_DIAGNOSTIC_BUILD ' + json.dumps(report, separators=(',', ':')), flush=True)
