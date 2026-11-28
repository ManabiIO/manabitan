#!/usr/bin/env python3
"""Audit separately corrected prefix component artifacts; never acquire timing or change inputs."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('dictionary', choices=['jmdict', 'vndb'])
parser.add_argument('evidence', type=Path)
args = parser.parse_args()
root = args.evidence.resolve()
base = Path('/workspace/scratch/c563d487c718/manabitan')
experiments = base.parent / 'experiments'
tooling = experiments / 'jmdict-prefix-selector/hosted'
first = experiments / 'jmdict-prefix-selector-evidence/jmdict'
baseline = '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2'
head = '59530bb6db9320063c955d0a42219690bcabb47d'
c_path = 'ext/js/dictionary/wasm/term-bank-parser.c'
wasm_path = 'dev/data/dictionary-wasm/term-bank-parser.wasm'
manifest_path = 'dev/data/dictionary-wasm/manifest.json'
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
read = lambda p: json.loads(p.read_text())
expected_path = experiments / 'jmdict-prefix-selector-corrected-audit/independent-prefix-corrected-expected.json'
assert sha(expected_path) == '1965e8ede2ffbf30819f8bb9f3c8a1d6b458e14413d92ab019817a3812a752fa'
expected_publication = read(expected_path)
assert expected_publication['toolingHead'] == head and expected_publication['runId'] == 46119683668
source_audit = read(first / 'independent-preflight-audit.json')
assert sha(first / 'independent-preflight-audit.json') == 'c699d570792f790661266efee765deaf15afb7a0a7f70e76b3efdb7303dfb808'
assert sha(root / 'rebuilt-candidate.diff') == source_audit['sourceDiffSha256']
for name, digest in source_audit['productFiles'].items():
    assert sha(first / 'reconstructed-product' / name) == digest
report = read(root / 'result.json')
assert report['complete'] and report['dictionary'] == args.dictionary
assert report['tooling']['head'] == head
assert report['tooling']['hashes'] == expected_publication['toolingHashes']
runtime = report['runtime']
assert runtime['node'] == 'v22.22.0' and runtime['browser'] is None
assert '21.1.8' in runtime['compiler'] and '21.1.8' in runtime['linker']
lock_bytes = subprocess.check_output(['git', 'show', baseline + ':test/perf/dictionaries.lock.json'], cwd=base)
lock_sha = hashlib.sha256(lock_bytes).hexdigest()
fixture = json.loads(lock_bytes)['dictionaries'][args.dictionary]
assert report['tooling']['fixtureLockSha256'] == lock_sha
for arm in ['baseline', 'candidate']:
    identity = report[arm]
    assert identity['head'] == baseline and identity['tree'] == 'd99ea4d04658f7ec1c76acdc5f3684594212a471'
    assert identity['trackedWasmSha256'] == identity['wasmSha256']
    for field, file in [('cSha256', c_path), ('wasmSha256', wasm_path), ('manifestSha256', manifest_path), ('dependencyLockSha256', 'package-lock.json')]:
        expected = source_audit['productFiles'][file] if arm == 'candidate' and file != 'package-lock.json' else hashlib.sha256(subprocess.check_output(['git', 'show', baseline + ':' + file], cwd=base)).hexdigest()
        assert identity[field] == expected, (arm, field)
    expected_changes = {c_path, wasm_path, manifest_path} if arm == 'candidate' else set()
    assert {line.strip()[2:] for line in identity['trackedChanges'].splitlines()} == expected_changes
assert sha(root / 'diagnostic.wasm') == source_audit['diagnosticWasmSha256']
assert sha(root / 'diagnostic-source.c') == source_audit['diagnosticSourceSha256']
assert read(root / 'diagnostic-build.json')['productSourceSha256'] == source_audit['productFiles'][c_path]

def raw_child(label, embedded):
    raw = read(root / (label + '.stdout.json'))
    expected = dict(embedded)
    started = expected.pop('observationStartedEpoch')
    assert raw == expected, label
    status = read(root / (label + '.child-status.json'))
    assert status['status'] == 'completed' and status['exitCode'] == 0
    assert status['startedEpoch'] == started and status['finishedEpoch'] >= started
    assert not (root / (label + '.stderr.log')).read_text(), label
    return raw, started

smokes = read(root / 'smoke-report.json')
assert smokes['complete'] and len(smokes['arms']) == 6
first_smokes = read(first / 'smoke-report.json')
for current, reference in zip(smokes['arms'], first_smokes['arms']):
    assert current['name'] == reference['name']
    raw, _ = raw_child('smoke-' + current['name'], current['result'])
    assert raw['fixtureHash'] == '181c7b9ac922735b67ac962d019298f43320514d7e6bfacef6eddccdd5556f7b'
    for key in ['complete', 'sourceHash', 'wasmHash', 'harnessHash', 'validCases', 'malformedCases', 'fallbackCases', 'results', 'nativeDiagnostics']:
        assert raw[key] == reference['result'][key], (current['name'], key)

diagnostic, _ = raw_child('diagnostic', report['diagnostic'])
c = diagnostic['diagnostic']
assert c['admissions'] == c['selected'] + c['noPrefixCandidate']
assert c['selected'] == sum(c[n] for n in ['boundsRejected', 'openerRejected', 'tailRejected', 'middleRejected', 'fullRejected', 'hits'])
assert c['candidateRecordsInspected'] == sum(c[n] for n in ['definitionLengthRejected', 'rulesLengthRejected', 'definitionSignatureRejected', 'rulesSignatureRejected', 'selected'])
assert c['selected'] == sum(c[f'selectedDistance{i}'] for i in range(1, 5))
assert c['hits'] == sum(c[f'hitDistance{i}'] for i in range(1, 5))
assert c['fullBytesOffered'] == c['hitBytes'] + c['failedFullBytesOffered']
assert c['totalGlossaryReuses'] == c['originalGlossaryReuses'] + c['hits']
assert c['selected'] <= c['admissions'] <= c['keyIdentityRows'] <= c['originalLookbackZeroRows']
assert diagnostic['warmupPasses'] == 0 and diagnostic['wasmSha256'] == source_audit['diagnosticWasmSha256']
assert diagnostic['rows'] == fixture['termRows']
assert c['rows'] == sum(g['rows'] for g in diagnostic['groupReceipts'] if len(g['banks']) > 1)
assert diagnostic['fusedAttempts'] == sum(len(g['banks']) > 1 for g in diagnostic['groupReceipts'])
assert diagnostic['fusedFallbacks'] == 0
for g in diagnostic['groupReceipts']:
    assert g['fusedAttempts'] == int(len(g['banks']) > 1) and g['fusedFallbacks'] == 0
    if len(g['banks']) == 1:
        assert g['diagnosticBefore'] == g['diagnosticAfter']
if args.dictionary == 'jmdict':
    frozen_mechanics = read(tooling / 'expected-mechanics.json')['jmdict']
    for key, value in frozen_mechanics['total'].items():
        assert c[key] == value, ('prospective total', key)
    assert len(diagnostic['groupReceipts']) == len(frozen_mechanics['groups']) == 8
    for actual, wanted in zip(diagnostic['groupReceipts'], frozen_mechanics['groups']):
        assert actual['group'] == wanted['group']
        before, after = actual['diagnosticBefore'] or {}, actual['diagnosticAfter']
        for key, value in wanted['expected'].items():
            if key.startswith('max'):
                assert after[key] == max(before.get(key, 0), value), ('prospective group', actual['group'], key)
            else:
                assert after[key] - before.get(key, 0) == value, ('prospective group', actual['group'], key)
    lint = read(root / 'scoped-eslint.json')
    assert len(lint) == 2 and all(item['errorCount'] == item['warningCount'] == item['fatalErrorCount'] == 0 for item in lint)
reference_baseline = read(experiments / f'row-suffix-numeric-corrected-evidence/{args.dictionary}/pair-0-A.stdout.json')
for key in ['rows', 'digest', 'indexBytes', 'archiveSha256', 'lockSha256', 'flags', 'filesPerGroup']:
    assert diagnostic[key] == reference_baseline[key], ('prior baseline output', key)
expected_schedule = [{'pair': i, 'arm': arm} for i in range(4) for arm in ('ABCD' if i % 2 == 0 else 'DCBA')]
assert report['schedule'] == expected_schedule and len(report['observations']) == 16
assert len(list(root.glob('pair-*.stdout.json'))) == 16
raw = {}
starts = []
for step, observation in zip(expected_schedule, report['observations']):
    assert {k: observation[k] for k in ['pair', 'arm']} == step
    label = f"pair-{step['pair']}-{step['arm']}"
    data, start = raw_child(label, observation['result'])
    starts.append(start)
    identity = report['candidate' if step['arm'] == 'B' else 'baseline']
    assert data['sourceRoot'] == identity['root'] and data['gitHead'] == baseline and data['gitTree'] == identity['tree']
    assert data['trackedChanges'] == identity['trackedChanges'] and data['wasmSha256'] == identity['wasmSha256']
    assert data['sourceHashes'][c_path] == identity['cSha256'] and data['sourceHashes'][manifest_path] == identity['manifestSha256']
    for name, digest in data['sourceHashes'].items():
        if name not in [c_path, manifest_path]:
            assert digest == hashlib.sha256(subprocess.check_output(['git', 'show', baseline + ':' + name], cwd=base)).hexdigest(), name
    assert data['node'] == 'v22.22.0' and data['warmupPasses'] == 2
    assert data['diagnostic'] is None and data['diagnosticWasm'] is None
    assert data['runnerSha256'] == sha(tooling / 'screen.mjs') and data['diagnosticFieldsSha256'] == sha(tooling / 'diagnostic-fields.json')
    assert data['dictionary'] == args.dictionary and data['validateGlossaryTypes'] is True
    assert data['flags'] == ({'experimentalNativeEscapedKeys': True} if args.dictionary == 'vndb' else {})
    assert data['filesPerGroup'] == {'jmdict': 7, 'jitendex': 10, 'vndb': 4}[args.dictionary]
    assert data['archiveSha256'] == fixture['sha256'] and data['lockSha256'] == lock_sha
    assert data['rows'] == fixture['termRows'] and data['fusedFallbacks'] == 0
    assert data['fusedAttempts'] == sum(len(g['banks']) > 1 for g in data['groupReceipts'])
    for g in data['groupReceipts']:
        assert g['fusedAttempts'] == int(len(g['banks']) > 1) and g['fusedFallbacks'] == 0
    for key in ['rows', 'digest', 'indexBytes', 'nativeSegments', 'ownedCompactExpressionRows', 'directArenaSegments', 'validationPasses', 'recentContentDedupHitCount']:
        assert data[key] == diagnostic[key], key
    counter = 'totalGlossaryReuses' if step['arm'] == 'B' else 'originalGlossaryReuses'
    assert data['glossaryReuseCount'] == c[counter]
    assert len(data['groupReceipts']) == len(diagnostic['groupReceipts'])
    for g, reference in zip(data['groupReceipts'], diagnostic['groupReceipts']):
        for key in ['group', 'banks', 'rows', 'fusedAttempts', 'fusedFallbacks', 'recentContentDedupHitCount']:
            assert g[key] == reference[key], key
        assert g['glossaryReuseCount'] == reference['diagnosticAfter'][counter] - (reference['diagnosticBefore'] or {}).get(counter, 0)
    raw[(step['pair'], step['arm'])] = data
assert all(a < b for a, b in zip(starts, starts[1:]))

oracle_root = root / 'native-oracle'
oracle = read(oracle_root / 'native-oracle.json')
assert oracle['complete'] and oracle['failures'] == [] and oracle['dictionary'] == args.dictionary
assert oracle['node'] == 'v22.22.0' and oracle['oracleSha256'] == sha(tooling / 'native-oracle.mjs')
assert oracle['fixtureLockSha256'] == lock_sha and oracle['archiveSha256'] == fixture['sha256']
assert oracle['synthetic']['cases'] == 1112 and oracle['synthetic']['exportComparisons'] == 2224
for arm, value in oracle['sources'].items():
    assert value['wasmSha256'] == report[arm]['wasmSha256'] and value['sourceSha256'] == report[arm]['cSha256']
records_path = oracle_root / 'native-oracle-records.jsonl'
assert sha(records_path) == oracle['recordsSha256']
records = [json.loads(line) for line in records_path.read_text().splitlines()]
counts = {name: {'banks': 0, 'rows': 0} for name in ['parse_term_bank', 'parse_term_bank_with_media_hints']}
synthetic = 0
for record in records:
    assert record['baseline'] == record['candidate'] and 'firstDifference' not in record
    attempts = record['baseline']
    assert len(attempts) >= 1 and attempts[-1]['result'] != -2
    for attempt in attempts:
        assert attempt['words'] == 17 * (attempt['result'] if attempt['result'] >= 0 else attempt['capacity'])
    if record['kind'] == 'synthetic':
        synthetic += 1
    else:
        assert record['kind'] == 'lockedBank' and attempts[-1]['result'] >= 0
        counts[record['exportName']]['banks'] += 1
        counts[record['exportName']]['rows'] += attempts[-1]['result']
assert synthetic == 2224
for name, count in counts.items():
    assert count['rows'] == fixture['termRows']
    for key, value in count.items():
        assert oracle['corpus'][name][key] == value

metrics = {}
for metric in ['elapsedMs', 'cpuMs', 'parseMs', 'nativeParseMs', 'lookupMs']:
    for label, a, b in [('candidate', 'A', 'B'), ('identicalControl', 'C', 'D')]:
        left = [raw[(i, a)][metric] for i in range(4)]
        right = [raw[(i, b)][metric] for i in range(4)]
        changes = [(y - x) / x * 100 for x, y in zip(left, right)]
        ordered = sorted(changes)
        actual = {'pairedChangesPercent': changes, 'medianPairedChangePercent': (ordered[1] + ordered[2]) / 2,
                  'equalWorkChangePercent': (sum(right) - sum(left)) / sum(left) * 100, 'fasterPairs': sum(y < x for x, y in zip(left, right))}
        expected = report['summary'][label + '.' + metric]
        for key, value in actual.items():
            l, r = (value, expected[key]) if isinstance(value, list) else ([value], [expected[key]])
            assert len(l) == len(r) and all(math.isclose(x, y, abs_tol=1e-9) for x, y in zip(l, r))
        metrics[label + '.' + metric] = {'baselineValues': left, 'comparisonValues': right, **actual}
result = {'completeAudit': True, 'dictionary': args.dictionary, 'scope': 'Independent separately corrected artifact/source/smoke/raw native metadata and component receipt audit; original failures and Jitendex cell remain separate, no browser or full-import claim',
          'toolingHead': head, 'run': 46119683668, 'frozenExpectedPublicationSha256': sha(expected_path), 'observations': 16, 'rowsPerObservation': fixture['termRows'],
          'digest': diagnostic['digest'], 'productFiles': source_audit['productFiles'], 'wasmBytes': source_audit['wasmBytes'],
          'nativeOracle': {'syntheticCases': 1112, 'syntheticExportComparisons': synthetic, 'corpus': oracle['corpus'], 'recordsSha256': oracle['recordsSha256'], 'comparisons': len(records)},
          'smokeModes': 6, 'mechanicalCounts': c, 'metrics': metrics,
          'maxWasmHeapBytesByArm': {arm: sorted({v['maxWasmHeapBytes'] for (pair, a), v in raw.items() if a == arm}) for arm in 'ABCD'},
          'rawReportSha256': sha(root / 'result.json'), 'auditScriptSha256': sha(Path(__file__))}
(root / 'independent-artifact-audit.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'completeAudit': True, 'dictionary': args.dictionary, 'observations': 16, 'digest': diagnostic['digest'], 'auditSha256': sha(root / 'independent-artifact-audit.json'), 'metrics': metrics}, separators=(',', ':')))
