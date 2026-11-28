#!/usr/bin/env python3
"""Build isolated selector-origin counters; the diagnostic binary is never timed."""
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
parser.add_argument('--source-file', type=pathlib.Path)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
here = pathlib.Path(__file__).resolve().parent
fields = json.loads((here / 'diagnostic-fields.json').read_text())
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
source_path = args.source_file or args.candidate / 'ext/js/dictionary/wasm/term-bank-parser.c'
assert sha(source_path) == '358428813d7452f55dfd084ee84cc1437e944bd790acaed41adf1634d477cf68'
source = source_path.read_text()

def field(name):
    return f'prefix_selector_diag[{fields.index(name)}]'

def increment(name):
    return f'++{field(name)};'

def replace_once(old, new):
    global source
    if source.count(old) != 1:
        raise RuntimeError(f'Instrumentation anchor count {source.count(old)}: {old[:100]}')
    source = source.replace(old, new, 1)

replace_once('static uint32_t adjacent_key_identity(', f'''static uint64_t prefix_selector_diag[{len(fields)}];
__attribute__((visibility("default"))) uint64_t prefix_selector_diag_get(uint32_t index) {{
    return index < {len(fields)}u ? prefix_selector_diag[index] : 0u;
}}
static uint32_t adjacent_key_identity(''')
replace_once('    uint32_t result = KEY_IDENTITY_CHECKED;',
    '    ' + increment('keyIdentityRows') + '\n    uint32_t result = KEY_IDENTITY_CHECKED;')
replace_once('    TermRowMeta* meta, uint32_t* value_end, uint32_t* witness, uint32_t lookback\n)',
    '    TermRowMeta* meta, uint32_t* value_end, uint32_t* witness, uint32_t lookback, uint32_t prefix_probe_distance\n)')
replace_once("    if (start >= end || (src[start] != '[' && src[start] != '{')) { return 0; }", f'''
    if (start >= end) {{ if (prefix_probe_distance != 0u) {{ {increment('boundsRejected')} }} return 0; }}
    if (src[start] != '[' && src[start] != '{{') {{ if (prefix_probe_distance != 0u) {{ {increment('openerRejected')} }} return 0; }}''')
replace_once('''        if (n == 0u || n > end - start || src[start] != src[p]) { continue; }
        const uint32_t sample = n < 8u ? n : 8u;
        if (!content_bytes_equal_between(src, start + n - sample, src, p + n - sample, sample) ||
            !content_bytes_equal_between(src, start + (n - sample) / 2u, src, p + (n - sample) / 2u, sample) ||
            !content_bytes_equal_between(src, start, src, p, n)) { continue; }''', f'''
        if (n == 0u || n > end - start) {{ if (prefix_probe_distance != 0u) {{ {increment('boundsRejected')} }} continue; }}
        if (src[start] != src[p]) {{ if (prefix_probe_distance != 0u) {{ {increment('openerRejected')} }} continue; }}
        const uint32_t sample = n < 8u ? n : 8u;
        if (!content_bytes_equal_between(src, start + n - sample, src, p + n - sample, sample)) {{
            if (prefix_probe_distance != 0u) {{ {increment('tailRejected')} }} continue;
        }}
        if (!content_bytes_equal_between(src, start + (n - sample) / 2u, src, p + (n - sample) / 2u, sample)) {{
            if (prefix_probe_distance != 0u) {{ {increment('middleRejected')} }} continue;
        }}
        if (prefix_probe_distance != 0u) {{ {field('fullBytesOffered')} += n; }}
        if (!content_bytes_equal_between(src, start, src, p, n)) {{
            if (prefix_probe_distance != 0u) {{
                {increment('fullRejected')}
                {field('failedFullBytesOffered')} += n;
                if (n > {field('maxFailedFullBytes')}) {{ {field('maxFailedFullBytes')} = n; }}
            }}
            continue;
        }}
        if (prefix_probe_distance != 0u) {{
            {increment('hits')}
            {field('hitBytes')} += n;
            ++prefix_selector_diag[{fields.index('hitDistance1')}u + prefix_probe_distance - 1u];
        }}''')
replace_once('    uint32_t expression_escaped = 0u;',
    '    uint32_t prefix_probe_distance = 0u;\n    uint32_t expression_escaped = 0u;')

old_start = '    if (glossary_lookback == 0u && key_escape_mask != 0 &&\n'
old_end = '    if (\n        !(glossary_witness != 0 && glossary_lookback > 0u && reuse_validated_glossary('
assert source.count(old_start) == source.count(old_end) == 1
start, end = source.index(old_start), source.index(old_end)
old_selector = source[start:end]
new_selector = f'''    if (glossary_lookback == 0u && key_escape_mask != 0 &&
        (*key_escape_mask & (KEY_ADJACENT_EXPRESSION_MATCH | KEY_ADJACENT_READING_MATCH)) != 0u) {{
        {increment('admissions')}
        const uint32_t tags_prefix = read_content_signature(src + meta->definition_tags_start, meta->definition_tags_length, 0u);
        const uint32_t rules_prefix = read_content_signature(src + meta->rules_start, meta->rules_length, 0u);
        const uint32_t first = prior_count > RECENT_CONTENT_DEDUP_WINDOW ? prior_count - RECENT_CONTENT_DEDUP_WINDOW : 0u;
        for (uint32_t k = prior_count; k > first;) {{
            const TermRowMeta* prior = &prior_rows[--k];
            {increment('candidateRecordsInspected')}
            if (meta->definition_tags_length != prior->definition_tags_length) {{ {increment('definitionLengthRejected')} continue; }}
            if (meta->rules_length != prior->rules_length) {{ {increment('rulesLengthRejected')} continue; }}
            if (tags_prefix != read_content_signature(src + prior->definition_tags_start, prior->definition_tags_length, 0u)) {{ {increment('definitionSignatureRejected')} continue; }}
            if (rules_prefix != read_content_signature(src + prior->rules_start, prior->rules_length, 0u)) {{ {increment('rulesSignatureRejected')} continue; }}
            prefix_probe_distance = prior_count - k;
            {increment('selected')}
            ++prefix_selector_diag[{fields.index('selectedDistance1')}u + prefix_probe_distance - 1u];
            {field('selectedBytes')} += prior->glossary_length;
            if (prior->glossary_length >= 512u) {{
                {increment('selectedAtLeast512')}
                {field('selectedAtLeast512Bytes')} += prior->glossary_length;
            }}
            if (prior->glossary_length > {field('maxSelectedBytes')}) {{ {field('maxSelectedBytes')} = prior->glossary_length; }}
            prior_count = k + 1u;
            glossary_lookback = 1u;
            break;
        }}
        if (prefix_probe_distance == 0u) {{ {increment('noPrefixCandidate')} }}
    }}
'''
replace_once(old_selector, new_selector)
replace_once('src, len, i, prior_rows, prior_count, meta, &end, glossary_witness, glossary_lookback\n',
    'src, len, i, prior_rows, prior_count, meta, &end, glossary_witness, glossary_lookback, prefix_probe_distance\n')
replace_once('src, len, i, prior_rows, prior_count, out_meta, &value_end, glossary_witness, glossary_lookback\n',
    'src, len, i, prior_rows, prior_count, out_meta, &value_end, glossary_witness, glossary_lookback, 0u\n')
replace_once('        uint32_t key_escape_mask;', f'''        if (recent_content_match_streak > 0u) {{ {increment('priorStreakRows')} }}
        if (glossary_reuse_probe_budget > 0u) {{ {increment('budgetPositiveRows')} }}
        if (validated_glossary_reuse_enabled && validate_glossary_types != 0u && row_count > 0u) {{
            if (glossary_lookback == 0u) {{ {increment('originalLookbackZeroRows')} }}
            else {{ {increment('originalLookbackPositiveRows')} }}
        }}
        uint32_t key_escape_mask;''')
replace_once('        if (glossary_witnesses != 0) { glossary_witnesses[row_count] = glossary_witness; }', f'''
        if (glossary_witness != 0xffffffffu) {{
            {increment('totalGlossaryReuses')}
            if (glossary_lookback > 0u) {{ {increment('originalGlossaryReuses')} }}
        }}
        if (glossary_witnesses != 0) {{ glossary_witnesses[row_count] = glossary_witness; }}''')
replace_once('''                glossary_reuse_probe_budget = VALIDATED_GLOSSARY_REUSE_PROBE_BUDGET;
            }
            const uint32_t canonical_offset = recent_match * 4u;''', f'''                glossary_reuse_probe_budget = VALIDATED_GLOSSARY_REUSE_PROBE_BUDGET;
                {increment('budgetRefreshByRecentStreak')}
            }}
            const uint32_t canonical_offset = recent_match * 4u;''')
replace_once('            ++recent_content_hits;', '            ++recent_content_hits;\n            ' + increment('recentContentHits'))
replace_once('''        ++row_count;
        status = next_term_row(&source, row_end);
    }
    if (status < 0) { return -1; }
    *(uint32_t*)(uintptr_t)unique_count_ptr = unique_count;''', f'''        {increment('rows')}
        ++row_count;
        status = next_term_row(&source, row_end);
    }}
    if (status < 0) {{ return -1; }}
    *(uint32_t*)(uintptr_t)unique_count_ptr = unique_count;''')
diagnostic_source = args.output / 'diagnostic-source.c'
diagnostic_source.write_text(source)
report = {'scope': 'Instrumented selector mechanics only; never timed',
    'productSourceSha256': sha(source_path), 'diagnosticSourceSha256': sha(diagnostic_source),
    'fields': fields, 'fieldsSha256': sha(here / 'diagnostic-fields.json'),
    'preparerSha256': sha(pathlib.Path(__file__)), 'sourceOnly': args.source_only}
if not args.source_only:
    diagnostic_wasm = args.output / 'diagnostic.wasm'
    manifest = json.loads((args.candidate / 'dev/data/dictionary-wasm/manifest.json').read_text())
    target = next(item for item in manifest['targets'] if item['name'] == 'term-bank-parser.wasm')
    compiler, linker = shutil.which('clang-21'), shutil.which('wasm-ld-21')
    assert compiler and linker, 'Pinned compiler/linker are unavailable'
    command = [compiler, '-fuse-ld=' + linker, *target['arguments'], '-Wl,--export=prefix_selector_diag_get',
        '-o', str(diagnostic_wasm), str(diagnostic_source), str(args.candidate / target['sources'][1]),
        '-I' + str(args.candidate / 'ext/js/dictionary/wasm')]
    subprocess.run(command, check=True)
    report.update(diagnosticWasmSha256=sha(diagnostic_wasm), command=command,
        compiler=subprocess.check_output([compiler, '--version'], text=True),
        linker=subprocess.check_output([linker, '--version'], text=True))
(args.output / 'diagnostic-build.json').write_text(json.dumps(report, indent=2) + '\n')
print('PREFIX_SELECTOR_DIAGNOSTIC_BUILD ' + json.dumps(report, separators=(',', ':')), flush=True)
