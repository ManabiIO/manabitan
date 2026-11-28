#!/usr/bin/env python3
"""Frozen dictionary component cohort: four candidate and four adjacent A/A pairs."""
import argparse
import json
import pathlib
from cohort_tools import assert_expected, check_diagnostic, checked_sources, child, identity, paired_summaries, runtime_receipt, schedule, sha, tooling_receipt

parser = argparse.ArgumentParser()
parser.add_argument('dictionary', choices=['jmdict', 'jitendex', 'vndb'])
for name in ['baseline', 'candidate', 'cache', 'output']:
    parser.add_argument(name, type=pathlib.Path)
args = parser.parse_args()
for name in ['baseline', 'candidate', 'cache', 'output']:
    setattr(args, name, getattr(args, name).resolve())
args.output.mkdir(parents=True, exist_ok=True)
here = pathlib.Path(__file__).resolve().parent
baseline_identity, candidate_identity = checked_sources(args.baseline, args.candidate)
tooling = tooling_receipt(here)
runtime = runtime_receipt()
expected = json.loads((here / 'expected-mechanics.json').read_text())
plan = {'schema': 1, 'dictionary': args.dictionary, 'variant': 'Prior exact-content streak, pure bounded key predicate and first matching header-prefix glossary selector; baseline late interner unchanged',
    'scope': 'Sequential native compressed-source inflate+CRC+strict parse+completed lookup component only. This is not complete browser import, storage, compression, memory or release qualification. Rebuilt candidate tracked generated changes are intentional and recorded.',
    'optionsScope': 'Production-default component options; VNDB explicitly enables the native escaped-key route',
    'timing': 'Fresh Node child per arm; two excluded complete corpus warmups; one measured complete corpus pass with full output/dedup/media/index digests after each group clock stops, before memory reuse',
    'schedule': schedule(), 'baseline': baseline_identity, 'candidate': candidate_identity,
    'runtime': runtime, 'tooling': tooling, 'expectedMechanics': expected,
    'observations': [], 'diagnostic': None, 'complete': False}
report_path = args.output / 'result.json'
assert not report_path.exists(), 'A fixed cell cannot resume or overwrite a prior acquisition'
def save():
    report_path.write_text(json.dumps(plan, indent=2) + '\n')
def run_observation(label, root, diagnostic=False):
    assert identity(args.baseline) == baseline_identity and identity(args.candidate) == candidate_identity
    assert tooling_receipt(here) == tooling
    command = ['node', '--expose-gc', '--max-old-space-size=512', str(here / 'screen.mjs'), args.dictionary,
        '--source-root', str(root), '--cache-dir', str(args.cache)]
    if diagnostic:
        command.extend(['--diagnostic-wasm', str(args.output / 'diagnostic.wasm')])
    data = child(command, args.output / label, emit_receipt=True)
    selected = candidate_identity if root == args.candidate else baseline_identity
    assert data['sourceRoot'] == str(root) and data['gitHead'] == selected['head'] and data['gitTree'] == selected['tree']
    assert data['dictionary'] == args.dictionary and data['validateGlossaryTypes'] is True
    assert data['node'] == runtime['node'] and data['runnerSha256'] == tooling['hashes']['screen.mjs']
    assert data['diagnosticFieldsSha256'] == tooling['hashes']['diagnostic-fields.json']
    assert data['wasmSha256'] == (sha(args.output / 'diagnostic.wasm') if diagnostic else selected['wasmSha256'])
    expected_fused_attempts = 0
    for group in data['groupReceipts']:
        expected = 1 if len(group['banks']) > 1 else 0
        assert group['fusedAttempts'] == expected and group['fusedFallbacks'] == 0, group['group']
        expected_fused_attempts += expected
    assert data['fusedFallbacks'] == 0 and data['fusedAttempts'] == expected_fused_attempts
    assert data['warmupPasses'] == (0 if diagnostic else 2)
    return data
save()
print('PRIOR_STREAK_SELECTOR_PLAN ' + json.dumps({k: v for k, v in plan.items() if k != 'observations'}, separators=(',', ':')), flush=True)
try:
    # Mechanics are a separate untimed preflight, never one of the 16 timing children.
    diagnostic = run_observation('diagnostic', args.candidate, True)
    check_diagnostic(diagnostic['diagnostic'])
    if args.dictionary == 'jmdict':
        assert diagnostic['archiveSha256'] == expected['archiveSha256']
        assert_expected(diagnostic['diagnostic'], expected['jmdict']['total'], 'JMdict all groups')
        assert len(diagnostic['groupReceipts']) == len(expected['jmdict']['groups'])
        for actual, expected_group in zip(diagnostic['groupReceipts'], expected['jmdict']['groups']):
            assert actual['group'] == expected_group['group']
            before, after = actual['diagnosticBefore'] or {}, actual['diagnosticAfter']
            for key, value in expected_group['expected'].items():
                if key.startswith('max'):
                    assert after[key] == max(before.get(key, 0), value), (actual['group'], key)
                else:
                    assert after[key] - before.get(key, 0) == value, (actual['group'], key)
    plan['diagnostic'] = diagnostic
    save()
    print('PRIOR_STREAK_SELECTOR_DIAGNOSTIC ' + json.dumps({'dictionary': args.dictionary, 'mechanicalCounts': diagnostic['diagnostic'], 'rows': diagnostic['rows'], 'digest': diagnostic['digest']}, separators=(',', ':')), flush=True)
    for step in plan['schedule']:
        arm, pair = step['arm'], step['pair']
        root = args.candidate if arm == 'B' else args.baseline
        data = run_observation(f'pair-{pair}-{arm}', root)
        for key in ['rows', 'digest', 'indexBytes', 'archiveSha256', 'lockSha256', 'flags', 'filesPerGroup', 'recentContentDedupHitCount']:
            assert data[key] == diagnostic[key], f'{arm} pair{pair}: output/workload mismatch: {key}'
        expected_reuses = diagnostic['diagnostic']['totalGlossaryReuses' if arm == 'B' else 'originalGlossaryReuses']
        assert data['glossaryReuseCount'] == expected_reuses
        assert len(data['groupReceipts']) == len(diagnostic['groupReceipts'])
        for actual, reference in zip(data['groupReceipts'], diagnostic['groupReceipts']):
            for key in ['group', 'banks', 'rows', 'fusedAttempts', 'fusedFallbacks', 'recentContentDedupHitCount']:
                assert actual[key] == reference[key], (pair, arm, key)
            before = reference['diagnosticBefore'] or {}
            name = 'totalGlossaryReuses' if arm == 'B' else 'originalGlossaryReuses'
            assert actual['glossaryReuseCount'] == reference['diagnosticAfter'][name] - before.get(name, 0)
        plan['observations'].append({**step, 'result': data})
        save()
        print('PRIOR_STREAK_SELECTOR_OBSERVATION ' + json.dumps({'dictionary': args.dictionary, **step,
            **{key: data[key] for key in ['rows', 'digest', 'elapsedMs', 'cpuMs', 'inflateMs', 'inflateCpuMs', 'parseMs', 'lookupMs', 'nativeParseMs', 'fusedAttempts', 'fusedFallbacks', 'glossaryReuseCount', 'maxWasmHeapBytes']}}, separators=(',', ':')), flush=True)
    plan['summary'] = paired_summaries(plan['observations'], ['elapsedMs', 'cpuMs', 'parseMs', 'nativeParseMs', 'lookupMs'])
    plan['complete'] = True
    save()
    print('PRIOR_STREAK_SELECTOR_RESULT ' + json.dumps({'dictionary': args.dictionary, 'complete': True, 'scope': plan['scope'],
        'summary': plan['summary'], 'mechanicalCounts': diagnostic['diagnostic'], 'rows': diagnostic['rows'], 'digest': diagnostic['digest']}, separators=(',', ':')), flush=True)
except Exception as error:
    plan['error'] = str(error)
    save()
    print('PRIOR_STREAK_SELECTOR_FAILED ' + json.dumps({'dictionary': args.dictionary, 'complete': False,
        'completedObservations': len(plan['observations']), 'error': str(error)}, separators=(',', ':')), flush=True)
    raise
