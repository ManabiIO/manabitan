#!/usr/bin/env python3
"""Replay the one completed excluded child; never launch or repeat the corpus."""
from pathlib import Path
import datetime
import hashlib
import json

root = Path(__file__).resolve().parent
experiments = root.parent
hosted = experiments / 'jmdict-prefix-selector/hosted'
def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

failed_path = root / 'result.json'
raw_path = root / 'diagnostic.stdout.json'
expected_path = hosted / 'expected-mechanics.json'
reference_path = experiments / 'row-suffix-numeric-corrected-evidence/jmdict/pair-0-A.stdout.json'
assert sha(failed_path) == '9063cc5a6ce784359636def109f778af7fd9e2ba82d803dadac303886f8808fc'
assert sha(raw_path) == 'e81a9517eea7dd22fb01254f9f01dd6cae6757de9f80ace9714f633279ee3301'
assert sha(expected_path) == '83df64e419d9e72f4af1d799b326b6ee0acf9497bcb4837c2f6d6ee86cee4e83'
receipt = json.loads(failed_path.read_text())
data = json.loads(raw_path.read_text())
expected = json.loads(expected_path.read_text())
reference = json.loads(reference_path.read_text())
assert receipt['exitCode'] == 0 and receipt['error']['type'] == 'KeyError'
assert receipt['error']['message'] == "'recentContentDedupHitCount'"
assert sha(reference_path) == receipt['baselineComparisonReceiptSha256']
assert sha(Path(receipt['sourceRoot']) / 'ext/js/dictionary/wasm/term-bank-parser.c') == receipt['baselineCMetadataSha256']
assert sha(Path(receipt['command'][-1])) == receipt['externalDiagnosticWasmSha256']
assert data['node'] == 'v22.22.0' and data['gitHead'] == receipt['sourceCommit'] and data['trackedChanges'] == ''
assert data['sourceRoot'] == receipt['sourceRoot']
assert data['wasmSha256'] == receipt['externalDiagnosticWasmSha256']
assert data['sourceHashes']['ext/js/dictionary/wasm/term-bank-parser.c'] == receipt['baselineCMetadataSha256']
for key in ['runnerSha256', 'diagnosticFieldsSha256', 'archiveSha256', 'lockSha256']:
    assert data[key] == receipt[key], key
assert data['warmupPasses'] == 0 and data['flags'] == {} and data['validateGlossaryTypes'] is True
assert data['dictionary'] == 'jmdict' and data['filesPerGroup'] == 7
assert data['rows'] == 528299 and data['fusedAttempts'] == 8 and data['fusedFallbacks'] == 0
parity_keys = ['rows', 'digest', 'indexBytes', 'archiveSha256', 'lockSha256', 'flags', 'filesPerGroup']
for key in parity_keys:
    assert data[key] == reference[key], ('baseline parity', key)
assert data['sourceHashes'] == reference['sourceHashes']

def check(c):
    assert c['admissions'] == c['noPrefixCandidate'] + c['selected']
    assert c['candidateRecordsInspected'] == sum(c[name] for name in ['definitionLengthRejected', 'rulesLengthRejected', 'definitionSignatureRejected', 'rulesSignatureRejected', 'selected'])
    assert c['selected'] == sum(c[name] for name in ['boundsRejected', 'openerRejected', 'tailRejected', 'middleRejected', 'fullRejected', 'hits'])
    assert c['selected'] == sum(c[f'selectedDistance{i}'] for i in range(1, 5))
    assert c['hits'] == sum(c[f'hitDistance{i}'] for i in range(1, 5))
    assert c['fullBytesOffered'] == c['hitBytes'] + c['failedFullBytesOffered']
    assert c['totalGlossaryReuses'] == c['originalGlossaryReuses'] + c['hits']
    assert c['selected'] <= c['admissions'] <= c['keyIdentityRows'] <= c['originalLookbackZeroRows']

c = data['diagnostic']
check(c)
for key, value in expected['jmdict']['total'].items():
    assert c[key] == value, ('total', key, c[key], value)
assert data['recentContentDedupHitCount'] == c['recentContentHits'] == 154413
assert data['glossaryReuseCount'] == c['totalGlossaryReuses'] == 134731
assert reference['glossaryReuseCount'] == c['originalGlossaryReuses'] == 54629
assert len(data['groupReceipts']) == len(expected['jmdict']['groups']) == 8
groups = []
for actual, wanted in zip(data['groupReceipts'], expected['jmdict']['groups']):
    group = actual['group']
    assert group == wanted['group']
    expected_bank_count = 7 if group < 7 else 4
    assert actual['banks'] == [f'term_bank_{group * 7 + i + 1}.json' for i in range(expected_bank_count)]
    assert actual['rows'] == wanted['expected']['rows']
    assert actual['fusedAttempts'] == 1 and actual['fusedFallbacks'] == 0
    before, after = actual['diagnosticBefore'] or {}, actual['diagnosticAfter']
    check(after)
    for key, value in wanted['expected'].items():
        if key.startswith('max'):
            assert after[key] == max(before.get(key, 0), value), (group, key)
        else:
            assert after[key] - before.get(key, 0) == value, (group, key)
    assert actual['glossaryReuseCount'] == after['totalGlossaryReuses'] - before.get('totalGlossaryReuses', 0)
    assert actual['recentContentDedupHitCount'] == after['recentContentHits'] - before.get('recentContentHits', 0)
    groups.append({'group': group, 'banks': actual['banks'], 'rows': actual['rows'], 'allExpectedMechanicsMatch': True,
                   'expectedFieldsChecked': len(wanted['expected'])})
assert sum(item['rows'] for item in groups) == data['rows']
assert sum(len(item['banks']) for item in groups) == 53
report = {
    'schema': 1, 'complete': True,
    'scope': receipt['scope'], 'timingPolicy': receipt['timingPolicy'],
    'recordedAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'acquisitionCount': 1, 'measuredObservations': 0, 'childExitCode': 0,
    'originalDriverFailure': {'type': 'postprocessing schema mismatch', 'message': receipt['error']['message'],
        'reason': 'The earlier numeric component receipt does not contain per-group or recent-content counters. Its all-row semantic/index/dedup/media digest and supported workload fields still provide the unchanged baseline oracle. Every new diagnostic total and group is checked against the frozen prospective observer values.',
        'receipt': str(failed_path), 'sha256': sha(failed_path), 'driverSha256': receipt['driverSha256'], 'preservedUnchanged': True},
    'rawReceipt': str(raw_path), 'rawReceiptSha256': sha(raw_path), 'rawStderrSha256': receipt['stderrSha256'],
    'auditorSha256': sha(Path(__file__)),
    'sourceRoot': receipt['sourceRoot'], 'sourceCommit': receipt['sourceCommit'],
    'baselineCMetadataSha256': receipt['baselineCMetadataSha256'],
    'externalDiagnosticWasmSha256': receipt['externalDiagnosticWasmSha256'],
    'externalDiagnosticProductCSourceSha256': receipt['externalDiagnosticProductCSourceSha256'],
    'externalDiagnosticInstrumentedCSourceSha256': receipt['externalDiagnosticInstrumentedCSourceSha256'],
    'runnerSha256': receipt['runnerSha256'], 'expectedMechanicsSha256': receipt['expectedMechanicsSha256'],
    'archiveSha256': receipt['archiveSha256'], 'archiveBytes': receipt['archiveBytes'],
    'lockSha256': receipt['lockSha256'], 'diagnosticFieldsSha256': receipt['diagnosticFieldsSha256'],
    'baselineComparisonReceipt': str(reference_path), 'baselineComparisonReceiptSha256': sha(reference_path),
    'nodeSha256': receipt['nodeSha256'], 'heapMiB': receipt['heapMiB'],
    'rows': data['rows'], 'digest': data['digest'], 'fullOutputBaselineParity': True,
    'baselineParityFields': parity_keys, 'sourceHashMapMatchesBaseline': True,
    'allFrozenExpectedMechanicsMatch': True, 'expectedTotalFieldsChecked': len(expected['jmdict']['total']),
    'mechanicalCounts': c, 'groups': groups,
}
target = root / 'audit.json'
assert not target.exists()
target.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'complete': True, 'rows': data['rows'], 'groups': len(groups), 'expectedFieldsChecked': len(expected['jmdict']['total']),
                  'hits': c['hits'], 'originalGlossaryReuses': c['originalGlossaryReuses'], 'totalGlossaryReuses': c['totalGlossaryReuses'],
                  'digest': data['digest'], 'measuredObservations': 0, 'auditSha256': sha(target)}))
