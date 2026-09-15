#!/usr/bin/env python3
"""One fixed source-revision A/B cell. Never combines measurements across hosts."""
from pathlib import Path
import hashlib
import json
import os
import shutil
import signal
import subprocess
import time
import zipfile

BASE = '30ffb604e0a87f0aa252bd4331bc54668062b1e1'
variant = os.environ['CANDIDATE']
dictionary = os.environ['DICTIONARY']
root = Path.cwd()
candidate = Path(os.environ['RUNNER_TEMP']) / 'native-candidate'
output = root / 'builds' / 'source-screen'
output.mkdir(parents=True, exist_ok=True)
source_path = Path('ext/js/dictionary/wasm/term-bank-parser.c')
expected = {
    'join-bulk': '9be72ee642106131ca57be11dc3131463bea4da1176548735ea2607d622f7920',
    'key-reuse': 'd776fef637635875b0c86e28167069984eb72b85765e4a698b364448266f6a7f',
    'lookup-init': '5bf85549664d67fbc7a6bd4792b28e401ed5d5119e65886679d7b4dc6bfcd14a',
    'crc-unroll': 'da0a47d532d40bf35c35f516d40fc0bd27f7c21e304487ed5935ce6e174478e1',
}
assert variant in expected and dictionary in ['jmdict', 'jitendex']

def run(args, cwd=root):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()

def sha(path):
    with open(path, 'rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def replace_once(text, before, after):
    assert text.count(before) == 1
    return text.replace(before, after)

assert run(['git', 'rev-parse', 'HEAD']) == BASE
s = (root / source_path).read_text()
if variant == 'join-bulk':
    s = replace_once(s, '''        for (uint32_t j = 0u; j < content_length; ++j) {
            output[cursor + j] = inflated[start + j];
        }''', '''        /* The interiors can overlap while shifting left. Later compact banks
         * are already in place after the comma replaces their opening bracket. */
        if (output + cursor != inflated + start) {
            __builtin_memmove(output + cursor, inflated + start, content_length);
        }''')
elif variant == 'key-reuse':
    s = replace_once(s, '''            const uint32_t token_length = token_lengths[field];
            const uint8_t* value_source = src;''', '''            const uint32_t token_length = token_lengths[field];
            /* Only a fully equal, already validated token can reuse a key ID. */
            if (row_count > 0u) {
                const TermRowMeta* previous = &rows[row_count - 1u];
                const uint32_t previous_start = field == 0u ?
                    previous->expression_start : previous->reading_start;
                const uint32_t previous_length = field == 0u ?
                    previous->expression_length : previous->reading_length;
                if (token_length == previous_length &&
                    content_bytes_equal(src, token_start, previous_start, token_length)) {
                    string_indexes[field] = field == 0u ?
                        expression_indexes[row_count - 1u] : reading_indexes[row_count - 1u];
                    continue;
                }
            }
            const uint8_t* value_source = src;''')
elif variant == 'lookup-init':
    start = s.index('int32_t encode_term_lookup_index(')
    end = s.index('__attribute__((visibility("default")))', start)
    p = s[start:end]
    p = replace_once(p, '    memset(output, 0, output_length);',
        '    /* Initialize only reserved bytes, alignment padding, and posting counters. */')
    p = replace_once(p, '    base_header[5] = reading_posting_count;', '''    base_header[5] = reading_posting_count;
    base_header[6] = 0u;
    base_header[7] = 0u;
    memset(base + TERM_LOOKUP_BASE_HEADER_BYTES + strings_length, 0,
        aligned_string_length - strings_length);''')
    p = replace_once(p, '    cursor = align4(cursor);', '''    memset(base + cursor, 0, align4(cursor) - cursor);
    cursor = align4(cursor);''')
    p = replace_once(p, '    memset(key_heads, 0xff, key_slot_count * sizeof(uint16_t));', '''    memset(derived + cursor, 0, derived_length - cursor);
    memset(expression_offsets, 0, (key_count + 1u) * sizeof(uint16_t));
    memset(reading_offsets, 0, (key_count + 1u) * sizeof(uint16_t));
    memset(sequence_offsets, 0, (sequence_key_count + 1u) * sizeof(uint16_t));
    memset(key_heads, 0xff, key_slot_count * sizeof(uint16_t));''')
    s = s[:start] + p + s[end:]
else:
    start = s.index('    while (length - offset >= 8u) {')
    end = s.index('    while (offset < length)', start)
    body = s[start:end].split('\n', 1)[1].rsplit('    }', 1)[0]
    s = s[:start] + '    while (length - offset >= 16u) {\n        {\n' + body + '        }\n        {\n' + body + '        }\n    }\n' + s[start:]
assert hashlib.sha256(s.encode()).hexdigest() == expected[variant]
run(['git', 'worktree', 'add', '--detach', str(candidate), BASE])
(candidate / 'node_modules').symlink_to(root / 'node_modules', target_is_directory=True)
exclude = root / '.git/info/exclude'
with exclude.open('a') as stream:
    stream.write('\n# Local benchmark dependency symlink\n/node_modules\n')
shutil.copytree(root / 'ext/lib', candidate / 'ext/lib', dirs_exist_ok=True)
(candidate / 'builds').mkdir(exist_ok=True)
(candidate / 'builds/e2e-dictionary-cache').symlink_to(root / 'builds/e2e-dictionary-cache', target_is_directory=True)
(candidate / source_path).write_text(s)
run(['git', 'add', str(source_path)], cwd=candidate)
run(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Manabitan contributors', '-c', 'user.email=contributors@manabi.io', 'commit', '-m', f'Isolated screening candidate: {variant}'], cwd=candidate)
(output / 'candidate.patch').write_text(run(['git', 'diff', BASE, 'HEAD', '--', str(source_path)], cwd=candidate) + '\n')
exports = ['wasm_reset_heap', 'wasm_alloc', 'wasm_get_last_parse_capacity', 'wasm_get_last_content_capacity',
    'inflate_and_join_term_banks', 'parse_term_bank', 'parse_term_bank_with_media_hints',
    'parse_and_encode_term_bank_token_binary_dedup', 'build_term_string_plan', 'encode_term_lookup_index',
    'compact_term_lookup_keys', 'encode_term_content', 'encode_term_content_no_hash',
    'encode_term_content_token_binary', 'encode_term_content_token_binary_dedup']
run(['clang', '--target=wasm32-freestanding', '-O3', '-matomics', '-mbulk-memory', '-msimd128', '-nostdlib',
    '-Wl,--no-entry', '-Wl,--shared-memory', '-Wl,--max-memory=4294967296',
    *[f'-Wl,--export={name}' for name in exports], '-Wl,--strip-all', '-o',
    str(candidate / 'ext/lib/term-bank-parser.wasm'), str(candidate / source_path)])
# A controlled package changes exactly the compiled candidate and its shipped C
# source. This avoids worktree-dependent esbuild path comments/source maps.
package = Path('builds/manabitan-chrome-dev.zip')
replacements = {'lib/term-bank-parser.wasm', 'js/dictionary/wasm/term-bank-parser.c'}
with zipfile.ZipFile(root / package) as baseline, zipfile.ZipFile(candidate / package, 'w') as result:
    for member in baseline.infolist():
        data = (candidate / 'ext' / member.filename).read_bytes() if member.filename in replacements else baseline.read(member.filename)
        result.writestr(member, data)
with zipfile.ZipFile(root / package) as a, zipfile.ZipFile(candidate / package) as b:
    assert a.namelist() == b.namelist()
    assert {n for n in a.namelist() if a.read(n) != b.read(n)} == replacements

roots = {'A': root, 'B': candidate}
def identity(directory):
    return {'commit': run(['git', 'rev-parse', 'HEAD'], cwd=directory),
        'tree': run(['git', 'rev-parse', 'HEAD^{tree}'], cwd=directory),
        'status': run(['git', 'status', '--porcelain'], cwd=directory),
        'source': sha(directory / source_path), 'wasm': sha(directory / 'ext/lib/term-bank-parser.wasm'),
        'package': sha(directory / package), 'lock': sha(directory / 'test/perf/dictionaries.lock.json'),
        'harness': sha(directory / 'test/chromium/extension-two-dictionary-import.e2e.js')}
identities = {arm: identity(directory) for arm, directory in roots.items()}
assert all(not item['status'] for item in identities.values())
plan = [{'kind': 'warmup', 'pair': 0, 'arm': arm, 'binary': arm} for arm in 'AB']
for pair in range(1, 7):
    plan.extend({'kind': 'measured', 'pair': pair, 'arm': arm, 'binary': arm} for arm in ('AB' if pair % 2 else 'BA'))
    if pair % 2 == 0:
        plan.extend({'kind': 'aa', 'pair': pair // 2, 'arm': arm, 'binary': 'A'} for arm in ('BA' if pair == 4 else 'AB'))
(output / 'plan.json').write_text(json.dumps({'baseline': BASE, 'candidate': variant, 'dictionary': dictionary,
    'identities': identities, 'compiler': run(['clang', '--version']), 'plan': plan,
    'noRetries': True, 'noOutlierRemoval': True, 'flags': {}, 'purpose': 'Exploratory six-pair source screening, not release qualification'}, indent=2))
observations = []
for ordinal, item in enumerate(plan, 1):
    directory = roots[item['binary']]
    assert identity(directory) == identities[item['binary']]
    destination = output / f"{ordinal:02}-{item['kind']}-{item['pair']}-{item['arm']}"
    started = time.monotonic()
    with Path(str(destination) + '.log').open('w') as log:
        process = subprocess.Popen(['node', 'dev/perf/import-benchmark.js', dictionary, '--runs', '1', '--no-build',
            '--flags', '{}', '--output', str(destination)], cwd=directory, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            status = process.wait(timeout=240)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            raise
    assert status == 0, f'Failed observation {ordinal}, retained logs and partial report'
    summary = json.loads((destination / 'summary.json').read_text())
    report = json.loads((destination / 'run-1.json').read_text())
    assert report['status'] == 'success' and report['skippedVerification'] is False
    assert summary['source']['dirty'] is False
    assert summary['source']['sha256']['builds/manabitan-chrome-dev.zip'] == identities[item['binary']]['package']
    measurement = summary['runs'][0]
    observations.append({**item, 'ordinal': ordinal, 'ms': measurement['totalImportMs'],
        'workerMs': measurement['workerImportMs'], 'validation': measurement['validation'],
        'browser': summary['browserVersion'], 'wallSeconds': time.monotonic() - started})
    (output / 'observations.json').write_text(json.dumps(observations, indent=2))
    print(json.dumps(observations[-1]), flush=True)
for arm, directory in roots.items():
    assert identity(directory) == identities[arm]
(output / 'complete.json').write_text(json.dumps({'completed': len(observations), 'planned': len(plan)}, indent=2))
