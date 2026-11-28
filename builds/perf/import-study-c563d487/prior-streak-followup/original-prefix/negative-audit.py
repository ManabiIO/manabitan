#!/usr/bin/env python3
"""Read-only audit of the corrected ORIGINAL-prefix negative artifact; no acquisition."""
import argparse
import hashlib
import json
import math
import pathlib
import subprocess
import zipfile
import zlib

parser = argparse.ArgumentParser()
parser.add_argument('evidence', type=pathlib.Path)
args = parser.parse_args()
root = args.evidence.resolve()
base = pathlib.Path('/workspace/scratch/c563d487c718')
experiments = base / 'experiments'
original = experiments / 'jmdict-prefix-selector-evidence/jmdict'
tooling = experiments / 'jmdict-prefix-selector/hosted'
read = lambda p: json.loads(p.read_text())
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
source = read(original / 'independent-preflight-audit.json')
assert sha(original / 'independent-preflight-audit.json') == 'c699d570792f790661266efee765deaf15afb7a0a7f70e76b3efdb7303dfb808'
expected_path = experiments / 'jmdict-prefix-selector-corrected-audit/independent-prefix-corrected-expected.json'
assert sha(expected_path) == '1965e8ede2ffbf30819f8bb9f3c8a1d6b458e14413d92ab019817a3812a752fa'
expected_publication = read(expected_path)
head = '59530bb6db9320063c955d0a42219690bcabb47d'
baseline = '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2'
assert expected_publication['toolingHead'] == head and expected_publication['runId'] == 46119683668
assert sha(root / 'rebuilt-candidate.diff') == source['sourceDiffSha256']
assert sha(root / 'diagnostic.wasm') == source['diagnosticWasmSha256']
assert sha(root / 'diagnostic-source.c') == source['diagnosticSourceSha256']
report = read(root / 'negative-result.json')
assert report['complete'] and 'error' not in report
assert report['tooling']['head'] == head and report['tooling']['hashes'] == expected_publication['toolingHashes']
assert report['runtime']['node'] == 'v22.22.0' and report['runtime']['browser'] is None
assert '21.1.8' in report['runtime']['compiler'] and '21.1.8' in report['runtime']['linker']
assert report['measuredObservationCount'] == 48 and report['casesOrder'] == [1, 2, 3]
assert [record['id'] for record in report['cases']] == [1, 2, 3]
schedule = [{'pair': i, 'arm': arm} for i in range(4) for arm in ('ABCD' if i % 2 == 0 else 'DCBA')]
assert report['schedulePerCase'] == schedule
assert report['prospectiveReview']['rejection']['minimumSlowdownPercentExclusive'] == 3
source_files = {}
def baseline_hash(name):
    if name not in source_files:
        source_files[name] = hashlib.sha256(subprocess.check_output(['git', 'show', baseline + ':' + name], cwd=base / 'manabitan')).hexdigest()
    return source_files[name]
c_path = 'ext/js/dictionary/wasm/term-bank-parser.c'
wasm_path = 'dev/data/dictionary-wasm/term-bank-parser.wasm'
manifest_path = 'dev/data/dictionary-wasm/manifest.json'
for arm in ['baseline', 'candidate']:
    identity = report[arm]
    assert identity['head'] == baseline and identity['tree'] == 'd99ea4d04658f7ec1c76acdc5f3684594212a471'
    assert identity['trackedWasmSha256'] == identity['wasmSha256']
    for field, name in [('cSha256', c_path), ('wasmSha256', wasm_path), ('manifestSha256', manifest_path), ('dependencyLockSha256', 'package-lock.json')]:
        expected = source['productFiles'][name] if arm == 'candidate' and name != 'package-lock.json' else baseline_hash(name)
        assert identity[field] == expected, (arm, field)
    changed = {line.strip()[2:] for line in identity['trackedChanges'].splitlines()}
    assert changed == ({c_path, wasm_path, manifest_path} if arm == 'candidate' else set())

manifest_file = root / 'negative-fixtures/manifest.json'
manifest = read(manifest_file)
assert sha(manifest_file) == report['fixtureManifestSha256'] == 'c41ac6611de35dc5ccf74f6705ac59dc3fabb4a5a14450ffb2996740c7679af1'
assert manifest == report['fixtureManifest']
assert manifest['generatorSha256'] == report['tooling']['hashes']['negative-fixtures.mjs']
fixture_receipts = []
with zipfile.ZipFile(root.parent / 'negative.zip') as archive:
    assert hashlib.sha256(archive.read('negative-fixtures/generator-source.mjs')).hexdigest() == manifest['generatorSha256']
    for case in manifest['cases']:
        assert case['rows'] == 20000 and len(case['banks']) == 2
        for bank in case['banks']:
            raw_hash, raw_crc, raw_size = hashlib.sha256(), 0, 0
            with archive.open('negative-fixtures/' + bank['rawFile']) as stream:
                for block in iter(lambda: stream.read(1048576), b''):
                    raw_hash.update(block); raw_crc = zlib.crc32(block, raw_crc); raw_size += len(block)
            compressed_hash, inflated_hash = hashlib.sha256(), hashlib.sha256()
            compressed_size, inflated_size = 0, 0
            inflater = zlib.decompressobj(-15)
            with archive.open('negative-fixtures/' + bank['compressedFile']) as stream:
                for block in iter(lambda: stream.read(1024), b''):
                    compressed_hash.update(block); compressed_size += len(block)
                    output = inflater.decompress(block)
                    inflated_hash.update(output); inflated_size += len(output)
            output = inflater.flush(); inflated_hash.update(output); inflated_size += len(output)
            assert inflater.eof and not inflater.unused_data
            assert raw_hash.hexdigest() == inflated_hash.hexdigest() == bank['rawSha256']
            assert raw_size == inflated_size == bank['uncompressedSize'] and raw_crc == bank['signature']
            assert compressed_hash.hexdigest() == bank['compressedSha256'] and compressed_size == bank['compressedSize']
            fixture_receipts.append({'case': case['id'], 'bank': bank['rawFile'], 'rawSha256': raw_hash.hexdigest(),
                'compressedSha256': compressed_hash.hexdigest(), 'rawBytes': raw_size, 'compressedBytes': compressed_size, 'crc32': raw_crc})

smoke = read(root / 'smoke-report.json')
reference_smoke = read(original / 'smoke-report.json')
assert smoke['complete'] and len(smoke['arms']) == 6
for current, reference in zip(smoke['arms'], reference_smoke['arms']):
    assert current['name'] == reference['name']
    assert current['result']['fixtureHash'] == '181c7b9ac922735b67ac962d019298f43320514d7e6bfacef6eddccdd5556f7b'
    for key in ['complete', 'sourceHash', 'wasmHash', 'harnessHash', 'validCases', 'malformedCases', 'fallbackCases', 'results', 'nativeDiagnostics']:
        assert current['result'][key] == reference['result'][key], (current['name'], key)
    label = 'smoke-' + current['name']
    raw = read(root / (label + '.stdout.json'))
    embedded = dict(current['result']); started = embedded.pop('observationStartedEpoch')
    assert raw == embedded
    status = read(root / (label + '.child-status.json'))
    assert status['status'] == 'completed' and status['exitCode'] == 0 and status['startedEpoch'] == started

oracle = read(root / 'native-oracle/native-oracle.json')
assert oracle['complete'] and oracle['failures'] == [] and oracle['synthetic']['exportComparisons'] == 2224
assert oracle['dictionary'] is None and oracle['oracleSha256'] == report['tooling']['hashes']['native-oracle.mjs']
records_file = root / 'native-oracle/native-oracle-records.jsonl'
assert sha(records_file) == oracle['recordsSha256']
records = [json.loads(line) for line in records_file.read_text().splitlines()]
assert len(records) == 2224
for record in records:
    assert record['kind'] == 'synthetic' and record['baseline'] == record['candidate'] and 'firstDifference' not in record
    assert record['baseline'][-1]['result'] != -2
    for attempt in record['baseline']:
        assert attempt['words'] == 17 * (attempt['result'] if attempt['result'] >= 0 else attempt['capacity'])
for arm, value in oracle['sources'].items():
    assert value['wasmSha256'] == report[arm]['wasmSha256'] and value['sourceSha256'] == report[arm]['cSha256']

all_metrics = ['elapsedMs', 'cpuMs', 'inflateMs', 'inflateCpuMs', 'parseMs', 'lookupMs', 'nativeParseMs', 'rows', 'indexBytes']
starts = []
raw_receipts = []
def audit_child(case, label, embedded, arm, diagnostic=False, excluded=False):
    raw_file = root / (label + '.stdout.json')
    data = read(raw_file)
    expected = dict(embedded); started = expected.pop('observationStartedEpoch')
    assert data == expected, label
    status = read(root / (label + '.child-status.json'))
    assert status['status'] == 'completed' and status['exitCode'] == 0
    assert status['startedEpoch'] == started and status['finishedEpoch'] >= started
    starts.append(started)
    identity = report[arm]
    assert data['complete'] and data['caseId'] == case['id'] and data['flags'] == {} and data['validateGlossaryTypes'] is True
    assert data['node'] == 'v22.22.0' and data['sourceRoot'] == identity['root']
    assert data['gitHead'] == baseline and data['gitTree'] == identity['tree'] and data['trackedChanges'] == identity['trackedChanges']
    assert data['wasmSha256'] == (source['diagnosticWasmSha256'] if diagnostic else identity['wasmSha256'])
    for name, digest in data['sourceHashes'].items():
        expected_digest = identity['cSha256'] if name == c_path else identity['manifestSha256'] if name == manifest_path else baseline_hash(name)
        assert digest == expected_digest, (label, name)
    assert data['fixtureManifestSha256'] == sha(manifest_file) and data['generatorSha256'] == manifest['generatorSha256']
    for field, name in [('runnerSha256', 'negative-screen.mjs'), ('outputDigestSha256', 'output-digest.mjs'), ('diagnosticFieldsSha256', 'diagnostic-fields.json')]:
        assert data[field] == report['tooling']['hashes'][name]
    assert data['excludedOnly'] == excluded and data['warmupPasses'] == (0 if excluded else 2)
    assert data['measuredRepetitions'] == (0 if excluded else 16)
    assert len(data['warmups']) == (0 if excluded else 2) and len(data['repetitions']) == (1 if excluded else 16)
    assert data['bankIdentities'] == case['banks']
    assert data['perPassRows'] == 20000
    for key in all_metrics:
        total = 0.0
        for item in data['repetitions']:
            assert type(item[key]) in (int, float) and math.isfinite(item[key]), (label, key)
            total += item[key]
        assert data[key] == total, (label, key)
    for item in data['warmups'] + data['repetitions']:
        assert item['rows'] == 20000 and item['fusedAttempts'] == 1 and item['fusedFallbacks'] == 0
        assert item['glossaryReuseCount'] == item['recentContentDedupHitCount'] == item['crcReusedBytes'] == 0
        assert item['crcVerifiedBytes'] == sum(bank['uncompressedSize'] for bank in case['banks'])
        assert item['digest'] == data['digest'] and item['indexBytes'] == data['perPassIndexBytes']
    assert data['maxWasmHeapBytes'] == max(item['maxWasmHeapBytes'] for item in data['repetitions'])
    if diagnostic:
        assert data['diagnostic'] == case['expectedMechanics']
    else:
        assert data['diagnostic'] is None
    progress = []
    start_receipts = []
    other_stderr = []
    for line in (root / (label + '.stderr.log')).read_text().splitlines():
        if line.startswith('PREFIX_NEGATIVE_PASS '): progress.append(json.loads(line.partition(' ')[2]))
        elif line.startswith('PREFIX_NEGATIVE_CHILD_START '): start_receipts.append(json.loads(line.partition(' ')[2]))
        else: other_stderr.append(line)
    assert len(start_receipts) == 1
    assert start_receipts[0]['sourceHashes'] == data['sourceHashes'] and start_receipts[0]['wasmSha256'] == data['wasmSha256']
    expected_progress = [dict(caseId=case['id'], phase='warmup', **item) for item in data['warmups']]
    expected_progress += [dict(caseId=case['id'], phase='untimed-verification' if excluded else 'measured', **item) for item in data['repetitions']]
    assert progress == expected_progress, label
    raw_receipts.append({'label': label, 'rawSha256': sha(raw_file), 'statusSha256': sha(root / (label + '.child-status.json')),
        'excluded': excluded, 'measuredRepetitions': data['measuredRepetitions'], 'retainedPassReceipts': len(progress), 'otherStderr': other_stderr})
    return data

audited_cases = []
for case, record in zip(manifest['cases'], report['cases']):
    assert record['complete'] and len(record['observations']) == 16
    case_id = case['id']
    base_data = audit_child(case, f'negative-case-{case_id}-baseline-verification', record['baselineVerification'], 'baseline', excluded=True)
    diagnostic = audit_child(case, f'negative-case-{case_id}-diagnostic', record['diagnostic'], 'candidate', diagnostic=True, excluded=True)
    parity = ['digest', 'perPassRows', 'perPassIndexBytes', 'bankIdentities', 'flags']
    assert all(diagnostic[key] == base_data[key] for key in parity)
    raw = {}
    for step, observation in zip(schedule, record['observations']):
        assert {key: observation[key] for key in ['pair', 'arm']} == step
        arm = step['arm']
        label = f"negative-case-{case_id}-pair-{step['pair']}-{arm}"
        data = audit_child(case, label, observation['result'], 'candidate' if arm == 'B' else 'baseline')
        assert all(data[key] == base_data[key] for key in parity)
        raw[(step['pair'], arm)] = data
    summaries = {}
    for metric in ['elapsedMs', 'cpuMs', 'parseMs', 'nativeParseMs', 'lookupMs']:
        for label, a, b in [('candidate', 'A', 'B'), ('identicalControl', 'C', 'D')]:
            first = [raw[(i, a)][metric] for i in range(4)]
            second = [raw[(i, b)][metric] for i in range(4)]
            changes = [(y - x) / x * 100 for x, y in zip(first, second)]
            ordered = sorted(changes)
            actual = {'pairedChangesPercent': changes, 'medianPairedChangePercent': (ordered[1] + ordered[2]) / 2,
                'equalWorkChangePercent': (sum(second) - sum(first)) / sum(first) * 100, 'fasterPairs': sum(y < x for x, y in zip(first, second))}
            reported = record['summary'][label + '.' + metric]
            for key, value in actual.items():
                left, right = (value, reported[key]) if isinstance(value, list) else ([value], [reported[key]])
                assert len(left) == len(right) and all(math.isclose(x, y, abs_tol=1e-9) for x, y in zip(left, right))
            summaries[label + '.' + metric] = {'baselineValues': first, 'comparisonValues': second, **actual}
    candidate = summaries['candidate.elapsedMs']; control = summaries['identicalControl.elapsedMs']
    max_control = max(abs(value) for value in control['pairedChangesPercent'])
    triggered = candidate['medianPairedChangePercent'] > 3 and all(value > 0 for value in candidate['pairedChangesPercent']) and candidate['medianPairedChangePercent'] > max_control
    assert record['prospectiveNegativeAssessment']['clearSlowdownRuleTriggered'] == triggered
    assert math.isclose(record['prospectiveNegativeAssessment']['largestAbsoluteControlChangePercent'], max_control, abs_tol=1e-9)
    audited_cases.append({'id': case_id, 'name': case['name'], 'digest': base_data['digest'], 'observations': 16,
        'mechanicalCounts': diagnostic['diagnostic'], 'summaries': summaries, 'clearSlowdownRuleTriggered': triggered,
        'largestAbsoluteControlChangePercent': max_control,
        'maxWasmHeapBytesByArm': {arm: sorted({data['maxWasmHeapBytes'] for (_, a), data in raw.items() if a == arm}) for arm in 'ABCD'}})
assert len(raw_receipts) == 54 and sum(not item['excluded'] for item in raw_receipts) == 48
assert len(list(root.glob('negative-case-*-pair-*.stdout.json'))) == 48
assert all(a < b for a, b in zip(starts, starts[1:]))
audit = {'completeAudit': True, 'cohortComplete': True, 'run': 46119683668, 'jobId': 140901220379,
    'scope': 'Independent raw original-prefix corrected synthetic component audit; successor negatives and original failed preflight remain separate; no full-import claim',
    'toolingHead': head, 'observations': 48, 'excludedChildren': 6, 'measuredRepetitionsPerChild': 16,
    'excludedWarmupsPerMeasuredChild': 2, 'retainedPassReceipts': sum(item['retainedPassReceipts'] for item in raw_receipts),
    'productFiles': source['productFiles'], 'wasmBytes': source['wasmBytes'], 'smokeModes': 6,
    'nativeSyntheticCases': 1112, 'nativeSyntheticComparisons': 2224, 'fixtureManifestSha256': sha(manifest_file),
    'fixtureByteVerification': fixture_receipts, 'rawChildren': raw_receipts, 'cases': audited_cases,
    'rawReportSha256': sha(root / 'negative-result.json'), 'auditScriptSha256': sha(pathlib.Path(__file__))}
(root / 'independent-artifact-audit.json').write_text(json.dumps(audit, indent=2) + '\n')
print(json.dumps({'completeAudit': True, 'observations': 48, 'auditSha256': sha(root / 'independent-artifact-audit.json'),
    'cases': [{'id': case['id'], 'candidateElapsed': case['summaries']['candidate.elapsedMs'],
        'controlElapsed': case['summaries']['identicalControl.elapsedMs'], 'candidateCpu': case['summaries']['candidate.cpuMs'],
        'clearSlowdownRuleTriggered': case['clearSlowdownRuleTriggered']} for case in audited_cases]}, separators=(',', ':')))
