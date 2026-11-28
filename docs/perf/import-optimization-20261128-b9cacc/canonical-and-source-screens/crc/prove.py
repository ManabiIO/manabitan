"""Read-only byte comparison of the already published CRC experiment modules."""
import hashlib
import importlib.util
import json
import pathlib
import subprocess
import sys

sys.dont_write_bytecode = True
ROOT = pathlib.Path('/workspace/scratch/b9cacc3542c2')
REPO = ROOT / 'manabitan'
OUTPUT = pathlib.Path(__file__).parent / 'binary-proof.json'
PARSER = ROOT / 'analysis/native-symbol-map-b9cacc/symbol_map.py'
BASELINE = '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2'
CANDIDATE = '83912e61edb0bf4c8148ef3db309ed944f9babaf'
MODULE = 'dev/data/dictionary-wasm/term-bank-parser.wasm'

def digest(data):
    return hashlib.sha256(data).hexdigest()

def read_git(commit, path):
    return subprocess.check_output(['git', 'show', commit + ':' + path], cwd=REPO, timeout=30)

if OUTPUT.exists():
    raise ValueError('Do not replace an earlier proof')
receipt = {'schemaVersion': 1, 'status': 'failed', 'baseline': BASELINE,
           'candidate': CANDIDATE, 'module': MODULE,
           'scope': 'Read-only comparison of published module bytes; no native rebuild, test execution, import, or timing.',
           'parserSourceSha256': digest(PARSER.read_bytes()),
           'proofScriptSha256': digest(pathlib.Path(__file__).read_bytes())}
try:
    spec = importlib.util.spec_from_file_location('existing_symbol_map', PARSER)
    parser = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(parser)
    baseline, candidate = read_git(BASELINE, MODULE), read_git(CANDIDATE, MODULE)
    assert digest(baseline) == '8ae00698649c5a3e41039b13c5ffe1dff2d4e69948cba2e3c063f381250031ee'
    assert digest(candidate) == 'b362d9b0106c28e9cb495d66c650463c771e165cb8ebadc4a66adda973466fd9'
    receipt['modules'] = {'baseline': {'sha256': digest(baseline), 'bytes': len(baseline)},
                          'candidate': {'sha256': digest(candidate), 'bytes': len(candidate)}}
    sections_a, sections_b = parser.sections(baseline), parser.sections(candidate)
    assert [section['id'] for section in sections_a] == [section['id'] for section in sections_b]
    receipt['sections'] = [{'id': a['id'], 'equal': a['raw'] == b['raw'],
                            'baselineBytes': len(a['raw']), 'candidateBytes': len(b['raw']),
                            'baselineSha256': digest(a['raw']), 'candidateSha256': digest(b['raw'])}
                           for a, b in zip(sections_a, sections_b)]
    assert all(row['equal'] for row in receipt['sections'] if row['id'] != 10)
    rows_a = parser.function_metadata(baseline, require_names=False)
    rows_b = parser.function_metadata(candidate, require_names=False)
    assert len(rows_a) == len(rows_b) == 51
    assert [{k: v for k, v in row.items() if k not in {'bodyBytes', 'bodySha256'}} for row in rows_a] == [
        {k: v for k, v in row.items() if k not in {'bodyBytes', 'bodySha256'}} for row in rows_b]
    changed = [{'index': a['index'], 'baseline': a, 'candidate': b}
               for a, b in zip(rows_a, rows_b) if a['bodySha256'] != b['bodySha256']]
    assert [row['index'] for row in changed] == [5]
    assert all('term_bank_crc32_gap_test' not in row['exports'] for row in rows_b)
    receipt.update({'functionCount': len(rows_a), 'changedFunctions': changed,
                    'nonCodeSectionsByteIdentical': True, 'functionTypesAndExportsIdentical': True,
                    'testExportAbsent': True, 'moduleSizeDeltaBytes': len(candidate) - len(baseline),
                    'status': 'passed'})
except Exception as error:
    receipt['failure'] = {'type': type(error).__name__, 'message': str(error)}
finally:
    with OUTPUT.open('x') as stream:
        json.dump(receipt, stream, indent=2)
        stream.write('\n')
    print(json.dumps(receipt, indent=2))
sys.exit(0 if receipt['status'] == 'passed' else 1)
