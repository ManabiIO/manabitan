#!/usr/bin/env python3
"""Build source-bound prior-streak selector diagnostics; this binary is never timed."""
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
assert len(fields) == 48 and len(set(fields)) == len(fields)
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
source_path = args.source_file or args.candidate / 'ext/js/dictionary/wasm/term-bank-parser.c'
assert sha(source_path) == 'f622f057b7de9db9082d79c6d67eb7d93b86d74cb5ec9b1674d8e9a67f6456fb'
source = source_path.read_text()


def field(name):
    return f'prior_streak_selector_diag[{fields.index(name)}]'


def increment(name):
    return f'++{field(name)};'


def replace_once(old, new):
    global source
    if source.count(old) != 1:
        raise RuntimeError(f'Instrumentation anchor count {source.count(old)}: {old[:120]}')
    source = source.replace(old, new, 1)


replace_once('static int adjacent_key_matches(', f'''static uint64_t prior_streak_selector_diag[{len(fields)}];
__attribute__((visibility("default"))) uint64_t prior_streak_selector_diag_get(uint32_t index) {{
    return index < {len(fields)}u ? prior_streak_selector_diag[index] : 0u;
}}
static int prior_streak_selector_key_equal(
    const uint8_t* a, uint32_t a_start, const uint8_t* b, uint32_t b_start, uint32_t length
) {{
    {increment('keyComparisonCalls')}
    {field('keyComparisonBytesOffered')} += length;
    if (length > {field('maxKeyComparisonBytes')}) {{ {field('maxKeyComparisonBytes')} = length; }}
    return content_bytes_equal_between(a, a_start, b, b_start, length);
}}
static int adjacent_key_matches(''')
helper_start = source.index('static int adjacent_key_matches(')
helper_end = source.index('/* Samples only reject candidates.', helper_start)
original_helper = source[helper_start:helper_end]
assert original_helper.count('content_bytes_equal_between(') == 3
helper = original_helper.replace('content_bytes_equal_between(', 'prior_streak_selector_key_equal(')
helper = helper.replace('    const uint32_t expression_length = current->expression_length;',
    '    ' + increment('keyPredicateRows') + '\n    const uint32_t expression_length = current->expression_length;', 1)
helper = helper.replace('''        return 1;
    }
    const uint32_t reading_length''', f'''        {increment('expressionMatches')}
        return 1;
    }}
    const uint32_t reading_length''', 1)
helper = helper.replace('''    if (reading_length <= 2u || reading_length > 34u || reading_length != previous->reading_length) { return 0; }''', f'''    if (reading_length <= 2u || reading_length > 34u || reading_length != previous->reading_length) {{
        {increment('readingIneligibleRows')}
        return 0;
    }}''', 1)
helper = helper.replace('''        return 0;
    }
    return prior_streak_selector_key_equal(''', f'''        {increment('readingAliasRejected')}
        return 0;
    }}
    const int reading_match = prior_streak_selector_key_equal(''', 1)
helper = helper.replace('''        src, current->reading_start + 1u, src, previous->reading_start + 1u, reading_length - 2u
    );
}''', f'''        src, current->reading_start + 1u, src, previous->reading_start + 1u, reading_length - 2u
    );
    if (reading_match) {{ {increment('readingMatches')} }}
    return reading_match;
}}''', 1)
assert 'const int reading_match' in helper
for name in ['keyPredicateRows', 'expressionMatches', 'readingIneligibleRows', 'readingAliasRejected', 'readingMatches']:
    assert helper.count(increment(name)) == 1, name
replace_once(original_helper, helper)

replace_once('    TermRowMeta* meta, uint32_t* value_end, uint32_t* witness, uint32_t lookback\n)',
    '    TermRowMeta* meta, uint32_t* value_end, uint32_t* witness, uint32_t lookback, uint32_t selector_distance\n)')
replace_once("    if (start >= end || (src[start] != '[' && src[start] != '{')) { return 0; }", f'''
    if (start >= end) {{ if (selector_distance != 0u) {{ {increment('boundsRejected')} }} return 0; }}
    if (src[start] != '[' && src[start] != '{{') {{ if (selector_distance != 0u) {{ {increment('openerRejected')} }} return 0; }}''')
replace_once('''        if (n == 0u || n > end - start || src[start] != src[p]) { continue; }
        const uint32_t sample = n < 8u ? n : 8u;
        if (!content_bytes_equal_between(src, start + n - sample, src, p + n - sample, sample) ||
            !content_bytes_equal_between(src, start + (n - sample) / 2u, src, p + (n - sample) / 2u, sample) ||
            !content_bytes_equal_between(src, start, src, p, n)) { continue; }''', f'''
        if (n == 0u || n > end - start) {{ if (selector_distance != 0u) {{ {increment('boundsRejected')} }} continue; }}
        if (src[start] != src[p]) {{ if (selector_distance != 0u) {{ {increment('openerRejected')} }} continue; }}
        const uint32_t sample = n < 8u ? n : 8u;
        if (!content_bytes_equal_between(src, start + n - sample, src, p + n - sample, sample)) {{
            if (selector_distance != 0u) {{ {increment('tailRejected')} }} continue;
        }}
        if (!content_bytes_equal_between(src, start + (n - sample) / 2u, src, p + (n - sample) / 2u, sample)) {{
            if (selector_distance != 0u) {{ {increment('middleRejected')} }} continue;
        }}
        if (selector_distance != 0u) {{ {field('fullBytesOffered')} += n; }}
        if (!content_bytes_equal_between(src, start, src, p, n)) {{
            if (selector_distance != 0u) {{
                {increment('fullRejected')}
                {field('failedFullBytesOffered')} += n;
                if (n > {field('maxFailedFullBytes')}) {{ {field('maxFailedFullBytes')} = n; }}
            }}
            continue;
        }}
        if (selector_distance != 0u) {{
            {increment('hits')}
            {field('hitBytes')} += n;
            ++prior_streak_selector_diag[{fields.index('hitDistance1')}u + selector_distance - 1u];
        }}''')
replace_once('    uint32_t expression_escaped = 0u;',
    '    uint32_t selector_distance = 0u;\n    uint32_t expression_escaped = 0u;')

selector_start = '    if (glossary_witness != 0 && glossary_lookback == 0u && prior_count > 0u && key_escape_mask != 0 &&\n'
selector_end = '    if (\n        !(glossary_witness != 0 && glossary_lookback > 0u && reuse_validated_glossary('
assert source.count(selector_start) == source.count(selector_end) == 1
start, end = source.index(selector_start), source.index(selector_end)
original_selector = source[start:end]
replacement_selector = f'''    if (glossary_witness != 0 && glossary_lookback == 0u && prior_count > 0u && key_escape_mask != 0 &&
        adjacent_key_matches(src, meta, &prior_rows[prior_count - 1u])) {{
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
            selector_distance = prior_count - k;
            {increment('selected')}
            ++prior_streak_selector_diag[{fields.index('selectedDistance1')}u + selector_distance - 1u];
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
        if (selector_distance == 0u) {{ {increment('noPrefixCandidate')} }}
    }}
'''
replace_once(original_selector, replacement_selector)
replace_once('src, len, i, prior_rows, prior_count, meta, &end, glossary_witness, glossary_lookback\n',
    'src, len, i, prior_rows, prior_count, meta, &end, glossary_witness, glossary_lookback, selector_distance\n')
replace_once('src, len, i, prior_rows, prior_count, out_meta, &value_end, glossary_witness, glossary_lookback\n',
    'src, len, i, prior_rows, prior_count, out_meta, &value_end, glossary_witness, glossary_lookback, 0u\n')
replace_once('        uint32_t key_escape_mask;', f'''        if (recent_content_match_streak > 0u) {{ {increment('priorStreakRows')} }}
        if (glossary_reuse_probe_budget > 0u) {{ {increment('budgetPositiveRows')} }}
        if (validated_glossary_reuse_enabled && validate_glossary_types != 0u && row_count > 0u) {{
            if (glossary_lookback == 0u) {{
                {increment('originalLookbackZeroRows')}
                if (recent_content_match_streak != 0u) {{ {increment('priorStreakLookbackZeroRows')} }}
            }} else {{ {increment('originalLookbackPositiveRows')} }}
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
report = {'scope': 'Instrumented prior-streak selector mechanics only; never timed',
    'productSourceSha256': sha(source_path), 'diagnosticSourceSha256': sha(diagnostic_source),
    'fields': fields, 'fieldsSha256': sha(here / 'diagnostic-fields.json'),
    'preparerSha256': sha(pathlib.Path(__file__)), 'sourceOnly': args.source_only,
    'limits': 'Each added key comparison <=32 body bytes; up to three comparisons/96 offered bytes per helper. Maxima are cumulative, not additive.'}
if not args.source_only:
    diagnostic_wasm = args.output / 'diagnostic.wasm'
    manifest = json.loads((args.candidate / 'dev/data/dictionary-wasm/manifest.json').read_text())
    target = next(item for item in manifest['targets'] if item['name'] == 'term-bank-parser.wasm')
    compiler, linker = shutil.which('clang-21'), shutil.which('wasm-ld-21')
    assert compiler and linker, 'Pinned compiler/linker are unavailable'
    command = [compiler, '-fuse-ld=' + linker, *target['arguments'], '-Wl,--export=prior_streak_selector_diag_get',
        '-o', str(diagnostic_wasm), str(diagnostic_source), str(args.candidate / target['sources'][1]),
        '-I' + str(args.candidate / 'ext/js/dictionary/wasm')]
    subprocess.run(command, check=True)
    report.update(diagnosticWasmSha256=sha(diagnostic_wasm), command=command,
        compiler=subprocess.check_output([compiler, '--version'], text=True),
        linker=subprocess.check_output([linker, '--version'], text=True))
(args.output / 'diagnostic-build.json').write_text(json.dumps(report, indent=2) + '\n')
print('PRIOR_STREAK_SELECTOR_DIAGNOSTIC_BUILD ' + json.dumps(report, separators=(',', ':')), flush=True)
