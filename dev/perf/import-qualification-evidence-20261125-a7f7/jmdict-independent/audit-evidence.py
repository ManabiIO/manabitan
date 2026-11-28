# SPDX-License-Identifier: GPL-3.0-or-later
"""Check retained evidence integrity and recompute its reported work counts."""

import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parent


def read(name):
    return json.loads((root / 'receipts' / (name + '.txt')).read_text())


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


manifest = {}
for line in (root / 'SHA256SUMS').read_text().splitlines():
    expected, name = line.split('  ', 1)
    assert name not in manifest
    manifest[name] = expected
    assert sha(root / name) == expected, name
assert set(manifest) == {
    str(path.relative_to(root)) for path in root.rglob('*')
    if path.is_file() and path.name != 'SHA256SUMS'
}

review = read('review.json')
assert review['base'] == '7d1643e6147a10cb2165e9744cf0e63b59e46632'
assert review['head'] == '475d351ff07c1b5cfc5651d7f59c624629e4fdc5'
assert sha(root / 'sources/record-split-origin-replay.mjs.txt') == review['replayHarnessSha256']
summaries = {}
for name, workers, group_count, runs, avoided in [
    ('jmdict-two-workers.json', 2, 8, 18, 2089794),
    ('jmdict-three-workers.json', 3, 12, 12, 0),
]:
    result = read(name)
    assert result['complete'] and result['error'] is None
    assert result['node'] == 'v22.22.0'
    assert result['fixture']['sha256'] == '3a614c92cfa747946de8422fc408d6d93926ba76541df66e434b24976a10160f'
    assert result['fixture']['termRows'] == 528299
    assert len(result['groups']) == group_count
    assert len(result['profiles']) == 1
    assert result['profiles'][0]['parallelWorkerCount'] == workers
    assert result['profiles'][0]['parallelGroupCount'] == group_count
    groups = result['groups']
    before = sum(group['parentCopies']['u32'] + group['parentCopies']['u16'] for group in groups)
    after = sum(group['candidateCopies']['u32'] + group['candidateCopies']['u16'] for group in groups)
    rows = sum(group['rows'] for group in groups)
    run_count = sum(len(group['runRows']) for group in groups)
    affected = sum(group['rows'] for group in groups if len(group['runRows']) > 1)
    assert rows == 528299 and run_count == runs
    assert before - after == avoided == affected * 6
    assert result['summary'] == {
        'rows': rows, 'runs': runs, 'parentCopyBytes': before,
        'candidateCopyBytes': after, 'copyBytesAvoided': avoided,
    }
    summaries[workers] = {'rows': rows, 'groups': group_count, 'runs': runs,
                          'affectedRows': affected, 'copyBytesAvoided': avoided}

original = read('focused-tests.json')
adapted = read('focused-tests-adapted.json')
assert (original['numPassedTests'], original['numFailedTests']) == (74, 1)
assert (adapted['numPassedTests'], adapted['numFailedTests']) == (75, 0)
assert not original['success'] and adapted['success']
assert len(original['testResults']) == len(adapted['testResults']) == 4
failures = [case for suite in original['testResults'] for case in suite['assertionResults'] if case['status'] == 'failed']
assert len(failures) == 1 and 'score-accessor' in failures[0]['fullName']
adaptation = read('independent-test-adaptation.json')
assert sha(root / 'sources/original-independent.test.js.txt') == adaptation['originalIndependentTestSha256']
assert sha(root / 'sources/adapted-independent.test.js.txt') == adaptation['adaptedIndependentTestSha256']

packages = read('package-entries.json')
before = packages['baseline']['entries']
after = packages['candidate']['entries']
assert before.keys() == after.keys() and len(before) == 551
changed = [name for name in before if before[name] != after[name]]
assert changed == packages['changedEntries'] == ['js/dictionary/term-record-opfs-store.js']
wasm = [name for name in before if name.endswith('.wasm')]
assert len(wasm) == 5 and all(before[name] == after[name] for name in wasm)
assert packages['candidate']['sizeBytes'] - packages['baseline']['sizeBytes'] == packages['packageGrowthBytes'] == 467

print(json.dumps({'integrityFiles': len(manifest), 'replay': summaries,
                  'originalTests': '74 passed / 1 staging-expectation failure',
                  'adaptedTests': '75 passed', 'changedPackageEntries': changed,
                  'scope': 'Retained receipt and work-count audit; no new import or latency measurement.'}, indent=2))
