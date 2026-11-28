#!/usr/bin/env python3
"""One prospective fixed negative cell; the serial workflow calls cases1..6 once."""
import argparse
import json
import pathlib
from cohort_tools import CANDIDATE_C, PATCH_SHA, assert_expected, check_diagnostic, checked_sources, child, identity, paired_summaries, runtime_receipt, schedule, sha, tooling_receipt

parser = argparse.ArgumentParser()
for name in ['baseline', 'candidate', 'fixtures', 'output']:
    parser.add_argument(name, type=pathlib.Path)
parser.add_argument('case_id', type=int, choices=range(1, 7))
args = parser.parse_args()
for name in ['baseline', 'candidate', 'fixtures', 'output']:
    setattr(args, name, getattr(args, name).resolve())
args.output.mkdir(parents=True, exist_ok=True)
here = pathlib.Path(__file__).resolve().parent
baseline_identity, candidate_identity = checked_sources(args.baseline, args.candidate)
tooling = tooling_receipt(here)
runtime = runtime_receipt()
manifest_path = args.fixtures / 'manifest.json'
manifest_hash = sha(manifest_path)
manifest = json.loads(manifest_path.read_text())
protocol = json.loads((here / 'negative-protocol.json').read_text())
assert protocol['source']['candidateCSourceSha256'] == CANDIDATE_C
assert protocol['source']['candidatePatchSha256'] == PATCH_SHA
assert protocol['rejection']['minimumSlowdownPercentExclusive'] == 3
assert protocol['casesOrder'] == [1, 2, 3, 4, 5, 6]
assert manifest['generatorSha256'] == tooling['hashes']['negative-fixtures.mjs']
for name, digest in manifest['sourceHashes'].items():
    assert digest == tooling['hashes'][name], name
assert manifest['node'] == runtime['node']
assert [case['id'] for case in manifest['cases']] == protocol['casesOrder']
assert sha(args.fixtures / 'state-model-result.json') == manifest['modelReceiptSha256']
model = json.loads((args.fixtures / 'state-model-result.json').read_text())
assert model['complete'] and len(model['cases']) == 6
expected = json.loads((here / 'expected-counts.json').read_text())
fixture = next(case for case in manifest['cases'] if case['id'] == args.case_id)
target = next(case for case in expected['cases'] if case['id'] == args.case_id)
assert fixture['rows'] == 20000 and len(fixture['banks']) == 2
for key in ['expectedUniqueCount', 'expectedMechanics', 'expectedPublic', 'expectedShadow']:
    assert fixture[key] == target[key], key
for bank in fixture['banks']:
    assert sha(args.fixtures / bank['rawFile']) == bank['rawSha256']
    assert sha(args.fixtures / bank['compressedFile']) == bank['compressedSha256']
diagnostic_hash = sha(args.output / 'diagnostic.wasm')

plan = {'schema': 2, 'scope': 'Separate successor synthetic failure-overhead cell; no concurrent experiment commands in this job; external host contention is uncontrolled and assessed with same-code controls; not complete-import or equivalence qualification',
    'pairedUnit': 'Sum of16 enclosing-component elapsed/CPU repetitions within one fresh Node child;2 complete excluded warmups; repetitions are not independent paired observations',
    'studyCasesOrder': protocol['casesOrder'], 'caseId': args.case_id, 'schedulePerCase': schedule(), 'measuredObservationCount': 16,
    'excludedPreflights': 'One excluded baseline output-verification child and one excluded instrumented candidate child; no warmups',
    'baseline': baseline_identity, 'candidate': candidate_identity, 'runtime': runtime, 'tooling': tooling,
    'fixtureManifestSha256': manifest_hash, 'fixtureManifest': manifest, 'prospectiveProtocol': protocol,
    'diagnosticWasmSha256': diagnostic_hash,
    'cases': [], 'complete': False}
report_path = args.output / 'negative-result.json'
assert not report_path.exists(), 'A fixed cell cannot resume or overwrite a prior acquisition'

def save():
    report_path.write_text(json.dumps(plan, indent=2) + '\n')

def run_observation(label, root, diagnostic=False, verify_only=False):
    assert identity(args.baseline) == baseline_identity and identity(args.candidate) == candidate_identity
    assert tooling_receipt(here) == tooling and sha(manifest_path) == manifest_hash
    assert sha(args.output / 'diagnostic.wasm') == diagnostic_hash
    command = ['node', '--expose-gc', '--max-old-space-size=512', str(here / 'negative-screen.mjs'), str(args.case_id),
        '--source-root', str(root), '--fixtures-dir', str(args.fixtures)]
    if diagnostic:
        command.extend(['--diagnostic-wasm', str(args.output / 'diagnostic.wasm')])
    if verify_only:
        command.append('--verify-only')
    data = child(command, args.output / f'negative-case-{args.case_id}-{label}', emit_receipt=True)
    selected = candidate_identity if root == args.candidate else baseline_identity
    assert data['sourceRoot'] == str(root) and data['gitHead'] == selected['head'] and data['gitTree'] == selected['tree']
    assert data['caseId'] == args.case_id and data['node'] == runtime['node'] and data['complete']
    assert data['fixtureManifestSha256'] == manifest_hash and data['generatorSha256'] == manifest['generatorSha256']
    assert data['runnerSha256'] == tooling['hashes']['negative-screen.mjs']
    assert data['outputDigestSha256'] == tooling['hashes']['output-digest.mjs']
    assert data['diagnosticFieldsSha256'] == tooling['hashes']['diagnostic-fields.json']
    assert data['wasmSha256'] == (diagnostic_hash if diagnostic else selected['wasmSha256'])
    excluded = diagnostic or verify_only
    assert data['excludedOnly'] == excluded and data['warmupPasses'] == (0 if excluded else 2)
    assert data['measuredRepetitions'] == (0 if excluded else 16)
    assert len(data['repetitions']) == (1 if excluded else 16) and len(data['warmups']) == (0 if excluded else 2)
    assert data['flags'] == {} and data['validateGlossaryTypes'] is True
    assert data['perPassRows'] == 20000 and data['rows'] == 20000 * len(data['repetitions'])
    assert data['perPassUniqueCount'] == fixture['expectedUniqueCount']
    for key in ['elapsedMs', 'cpuMs', 'inflateMs', 'inflateCpuMs', 'parseMs', 'lookupMs', 'nativeParseMs', 'rows', 'indexBytes']:
        sequential_total = 0.0
        for item in data['repetitions']:
            sequential_total += item[key]
        assert data[key] == sequential_total, key
    for item in data['repetitions'] + data['warmups']:
        assert item['rows'] == 20000 and item['uniqueCount'] == fixture['expectedUniqueCount']
        for key, expected_value in fixture['expectedPublic'].items():
            assert item[key] == expected_value, (key, item[key], expected_value)
        assert item['crcReusedBytes'] == 0
        assert item['crcVerifiedBytes'] == sum(bank['uncompressedSize'] for bank in fixture['banks'])
        assert item['digest'] == data['digest'] and item['indexBytes'] == data['perPassIndexBytes']
    return data

save()
print('PREFIX_NEGATIVE_PLAN ' + json.dumps({k: v for k, v in plan.items() if k != 'cases'}, separators=(',', ':')), flush=True)
try:
    record = {'id': args.case_id, 'name': fixture['name'], 'observations': [], 'complete': False}
    plan['cases'].append(record)
    save()
    baseline = run_observation('baseline-verification', args.baseline, verify_only=True)
    record['baselineVerification'] = baseline
    save()
    diagnostic = run_observation('diagnostic', args.candidate, diagnostic=True)
    check_diagnostic(diagnostic['diagnostic'])
    assert set(diagnostic['diagnostic']) == set(fixture['expectedMechanics'])
    assert_expected(diagnostic['diagnostic'], fixture['expectedMechanics'], f'Negative case{args.case_id}')
    parity_keys = ['digest', 'perPassRows', 'perPassUniqueCount', 'perPassIndexBytes', 'bankIdentities', 'flags']
    for key in parity_keys:
        assert diagnostic[key] == baseline[key], (args.case_id, key)
    record['diagnostic'] = diagnostic
    save()
    print('PREFIX_NEGATIVE_DIAGNOSTIC ' + json.dumps({'caseId': args.case_id, 'digest': diagnostic['digest'], 'counts': diagnostic['diagnostic']}, separators=(',', ':')), flush=True)
    for step in plan['schedulePerCase']:
        arm, pair = step['arm'], step['pair']
        data = run_observation(f'pair-{pair}-{arm}', args.candidate if arm == 'B' else args.baseline)
        for key in parity_keys:
            assert data[key] == baseline[key], (args.case_id, pair, arm, key)
        record['observations'].append({**step, 'result': data})
        save()
        print('PREFIX_NEGATIVE_OBSERVATION ' + json.dumps({'caseId': args.case_id, **step,
            **{key: data[key] for key in ['rows', 'digest', 'perPassUniqueCount', 'measuredRepetitions', 'elapsedMs', 'cpuMs', 'inflateMs', 'parseMs', 'lookupMs', 'nativeParseMs', 'maxWasmHeapBytes']}}, separators=(',', ':')), flush=True)
    summary = paired_summaries(record['observations'], ['elapsedMs', 'cpuMs', 'parseMs', 'nativeParseMs', 'lookupMs'])
    candidate = summary['candidate.elapsedMs']
    control = summary['identicalControl.elapsedMs']
    largest_control = max(abs(change) for change in control['pairedChangesPercent'])
    clear_slowdown = (candidate['medianPairedChangePercent'] > 3 and
        all(change > 0 for change in candidate['pairedChangesPercent']) and
        candidate['medianPairedChangePercent'] > largest_control)
    record.update(summary=summary, complete=True, prospectiveNegativeAssessment={
        'clearSlowdownRuleTriggered': clear_slowdown, 'largestAbsoluteControlChangePercent': largest_control,
        'decision': 'Hold/reject this exact candidate' if clear_slowdown else 'No clear rule-triggered slowdown; equivalence remains unqualified and ambiguous negatives remain a hold/limitation',
        'cpuRole': 'Descriptive corroboration only'})
    assert len(record['observations']) == 16
    plan['complete'] = True
    save()
    print('PREFIX_NEGATIVE_RESULT ' + json.dumps({'complete': True, 'caseId': args.case_id, 'observations': 16,
        'summary': summary, 'assessment': record['prospectiveNegativeAssessment']}, separators=(',', ':')), flush=True)
except Exception as error:
    plan['error'] = str(error)
    save()
    print('PREFIX_NEGATIVE_FAILED ' + json.dumps({'caseId': args.case_id, 'complete': False,
        'completedObservations': sum(len(case['observations']) for case in plan['cases']), 'error': str(error)}, separators=(',', ':')), flush=True)
    raise
