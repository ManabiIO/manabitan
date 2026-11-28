"""Audit the completed fixed guarded codec screen without executing a benchmark."""
from pathlib import Path
import hashlib
import json
import statistics

ROOT = Path(__file__).resolve().parent
COHORT = ROOT / 'cohort-01'
PLAN_SHA = '4dab9c657ec2ca96ea92f239d50f1bbc30995842dd3e4b3e8fc46f09f05985fc'
WRAPPER_SHA = 'd125be9413f064e4cba1c33c6e87bc3f76610e78e0a94b0cb7268d806b4ea9c4'
sha = lambda data: hashlib.sha256(data).hexdigest()
read = lambda path: json.loads(path.read_bytes())
plan = read(COHORT / 'proposed-plan.json')
execution = read(COHORT / 'execution.json')
commands = read(COHORT / 'commands.json')
assert sha((COHORT / 'proposed-plan.json').read_bytes()) == PLAN_SHA
assert sha((COHORT / 'run-fixed-screen.py').read_bytes()) == execution['wrapperSha256'] == WRAPPER_SHA
assert execution['complete'] and execution['status'] == 'complete'
assert len(execution['children']) == execution['completedChildren'] == len(commands) == 19
assert execution['measuredCorpusPasses'] == 50 and execution['excludedWarmupCorpusPasses'] == 8
assert read(COHORT / 'root-release.json')['planSha256'] == PLAN_SHA
assert read(COHORT / 'orchestration-review.json')['wrapperSha256'] == WRAPPER_SHA
parity = read(Path(plan['parityReceipt']['path']))
assert sha(Path(plan['parityReceipt']['path']).read_bytes()) == plan['parityReceipt']['sha256']
assert parity['candidate'] == 'count16guarded' and parity['parity']['blocks'] == 103
assert parity['parity']['wrappedBytesExact'] is True and parity['measurements'] == []
identities = read(COHORT / 'input-identities.json')
for item in identities['verified']:
    path = Path(item['path'])
    with path.open('rb') as stream:
        actual = hashlib.file_digest(stream, 'sha256').hexdigest()
    assert actual == item['sha256'] and path.stat().st_size == item['bytes'], str(path)
permutations = plan['fixedProtocol']['cold']['permutations']
warm_orders = plan['fixedProtocol']['warm']['roundSchedules']
expected = [('warm', None, None)] + [('cold', pair, arm) for pair, arms in enumerate(permutations) for arm in arms]
assert [(row['mode'], row['pair'], row['arm']) for row in commands] == expected
assert all(row['argv'][1:3] == ['--expose-gc', plan['screen']['path']] for row in commands)
assert all(row['argv'][3:6] == [plan['baselineRoot'], plan['captureDirectory'], plan['moduleRoot']] for row in commands)
children = []
warm = None
cold = []
for index, (command, record) in enumerate(zip(commands, execution['children'])):
    assert record['ordinal'] == index and record['argv'] == command['argv'] and record['exitCode'] == 0 and record['status'] == 'complete'
    output = Path(command['output'])
    assert output.parent == COHORT and sha(output.read_bytes()) == record['resultSha256']
    assert sha(Path(command['log']).read_bytes()) == record['logSha256']
    result = read(output)
    assert result['node'] == 'v24.22.3' and result['order'] == 'AB' and result['mode'] == command['mode'] and result['candidate'] == command['kind']
    for key in ('captureReportSha256', 'wrapperSha256', 'databaseSourceSha256', 'plannerSourceSha256', 'blockTargetBytes', 'level', 'dictionarySha256', 'captureInputs'):
        assert result[key] == parity[key], key
    for key in ('blocks', 'inputBytes', 'compressedBytes'):
        assert result['parity'][key] == parity['parity'][key]
    rows = result['measurements']
    assert all(row['bytes'] == parity['parity']['compressedBytes'] for row in rows)
    if result['mode'] == 'warm':
        assert [(row['round'], row['arm']) for row in rows] == [(r, arm) for r, arms in enumerate(warm_orders) for arm in arms]
        assert len(result['initialization']) == 4
        warm = result
    else:
        assert len(rows) == len(result['initialization']) == 1 and rows[0]['arm'] == 'K' and rows[0]['round'] == 0
        cold.append({'pair': command['pair'], 'arm': command['arm'], 'kind': command['kind'],
                     'initializationMs': result['initialization'][0]['initializationMs'], **rows[0], 'arm': command['arm']})
    children.append({'file': output.name, 'sha256': record['resultSha256'], 'logSha256': record['logSha256'], 'measuredPasses': len(rows)})
assert warm is not None and len(cold) == 18 and sum(row['measuredPasses'] for row in children) == 50
median = statistics.median

def compare(changed, baseline):
    differences = [b - a for b, a in zip(changed, baseline)]
    ratios = [b / a for b, a in zip(changed, baseline)]
    return {'count': len(changed), 'changedMs': changed, 'baselineMs': baseline, 'changesMs': differences, 'ratios': ratios,
            'medianChangeMs': median(differences), 'medianChangePercent': (median(ratios) - 1) * 100,
            'faster': sum(change < 0 for change in differences),
            'equalWorkChangePercent': (sum(changed) / sum(baseline) - 1) * 100}

warm_values = {arm: [next(row['wallMs'] for row in warm['measurements'] if row['round'] == r and row['arm'] == arm) for r in range(8)] for arm in 'ABCD'}
cold_values = {arm: [next(row['wallMs'] for row in cold if row['pair'] == pair and row['arm'] == arm) for pair in range(6)] for arm in 'ABC'}
initialization = {arm: [next(row['initializationMs'] for row in cold if row['pair'] == pair and row['arm'] == arm) for pair in range(6)] for arm in 'ABC'}
warm_comparisons = {f'{b}/{a}': compare(warm_values[b], warm_values[a]) for b, a in [('B','A'),('B','C'),('D','A'),('D','C'),('C','A'),('D','B')]}
warm_comparisons['mean(B,D)/mean(A,C)'] = compare([(b+d)/2 for b,d in zip(warm_values['B'],warm_values['D'])], [(a+c)/2 for a,c in zip(warm_values['A'],warm_values['C'])])
cold_comparisons = {f'{b}/{a}': compare(cold_values[b], cold_values[a]) for b, a in [('B','A'),('B','C'),('C','A')]}
cold_comparisons['B/mean(A,C)'] = compare(cold_values['B'], [(a+c)/2 for a,c in zip(cold_values['A'],cold_values['C'])])
cold_totals = {arm: [a+b for a,b in zip(cold_values[arm],initialization[arm])] for arm in 'ABC'}
initialization_comparisons = {f'{b}/{a}': compare(initialization[b], initialization[a]) for b,a in [('B','A'),('B','C'),('C','A')]}
total_comparisons = {f'{b}/{a}': compare(cold_totals[b], cold_totals[a]) for b,a in [('B','A'),('B','C'),('C','A')]}
total_comparisons['B/mean(A,C)'] = compare(cold_totals['B'],[(a+c)/2 for a,c in zip(cold_totals['A'],cold_totals['C'])])
result = {
    'complete': True, 'status': 'Inconclusive shared-host diagnostic; closed after the single authorized cohort. No follow-up.',
    'scope': 'Exact corrected-binary Node codec component only; not isolated-host or browser/full-import qualification.',
    'candidateCommit': plan['candidateCommit'], 'baselineCommit': plan['baselineCommit'],
    'candidateWasmSha256': plan['modules']['count16guarded']['zstd-simd-module.wasm']['sha256'],
    'candidateWasmBytes': plan['modules']['count16guarded']['zstd-simd-module.wasm']['bytes'],
    'baselineWasmSha256': plan['modules']['baseline']['zstd-simd-module.wasm']['sha256'],
    'planSha256': PLAN_SHA, 'wrapperSha256': WRAPPER_SHA, 'auditorSha256': sha(Path(__file__).read_bytes()),
    'executionSha256': sha((COHORT/'execution.json').read_bytes()), 'commandsSha256': sha((COHORT/'commands.json').read_bytes()),
    'children': children, 'measurementChildren': 19, 'measuredCorpusPasses': 50, 'excludedWarmupPasses': 8, 'totalCorpusPasses': 58,
    'blocksPerPass': 103, 'totalBlockCompressions': 5974,
    'warmupEvidence': 'Eight complete warmup passes are prescribed by the unchanged child source and execute its byte-count assertion; individual warmup durations are not recorded by that frozen protocol.',
    'byteParityScope': 'The separately preserved corrected-binary parity receipt checks every compressed byte for all103 blocks. Timed passes assert identical aggregate compressed-byte counts; they do not hash each block inside the timed region.',
    'warm': {'rawMeasurements': warm['measurements'], 'initialization': warm['initialization'], 'armMedians': warm['summary'],
             'retainedBufferCapacities': warm['retainedBufferCapacities'], 'comparisons': warm_comparisons},
    'cold': {'permutations': permutations, 'rawMeasurements': cold, 'wrapperComparisons': cold_comparisons,
             'initializationComparisons': initialization_comparisons, 'initializationAndWrapperComparisons': total_comparisons},
    'resourceContext': {'hostBefore': execution['hostBeforeLock'], 'hostAfter': execution['hostAfter'],
                        'minimumBeforeChildMemAvailableKiB': min(row['hostBefore']['memory']['MemAvailableKiB'] for row in execution['children']),
                        'orchestrationWallSeconds': execution['orchestrationWallSeconds']},
    'disposition': 'Warm B/A improves about9.35ms while identical-code C/A improves10.35ms; B/C is mixed and D/C loses. Cold B/A improves7.34ms but B/C loses1.86ms, and equal-work totals lose. The304.65ms candidate tail, all controls and every observation remain included. This does not establish a corrected-binary gain or justify another local cohort.',
    'hostedQualification': {'runId': 46109596112, 'statusAtLocalClosure': 'Separate prospective full-import qualification is running. Its outcomes are not inferred from this local screen.'},
    'supersededCandidate': {'wasmSha256': '97d501650796ba7080b6242d9d2aa49c7c05c84c7d8c5107d7796c25b5599afe',
                            'status': 'Invalid reversed-limit implementation; no old timing is reused or rehabilitated.'}
}
out=ROOT/'analysis.json'
with out.open('x') as stream:
    json.dump(result,stream,indent=2);stream.write('\n')
print(json.dumps({'complete':True,'analysis':str(out),'sha256':sha(out.read_bytes()),'children':19,'passes':58,
                  'warmBA':warm_comparisons['B/A'],'warmCA':warm_comparisons['C/A'],
                  'coldBC':cold_comparisons['B/C']},indent=2))
