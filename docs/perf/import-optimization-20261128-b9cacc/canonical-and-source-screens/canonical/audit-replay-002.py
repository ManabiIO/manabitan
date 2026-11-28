"""Read-only independent audit of the single completed frozen canonical cohort."""
import hashlib
import json
import math
import pathlib
import statistics
import subprocess

BASE = pathlib.Path('/workspace/scratch/b9cacc3542c2/analysis/canonical-combined')
TEMP = pathlib.Path('/home/agent/.cache/manabitan-b9cacc/canonical-combined-resumed-20261128')
DATA = TEMP / 'acquisition-005'
OUTPUT = BASE / 'replay-002-independent-audit'
EXPECTED = {
    'acquisition-005/replay-analysis.json': 'e960a8d392f9222d32e1105251628744bd60cf8e6c5bf6d1c4bf08e44ced5e5a',
    'acquisition-005/observations.jsonl': '57adea39ac5af30b9609d429d9d2a431781e3f3ec7eed988acb0a1b302763fb8',
    'acquisition-005/replay-registration.json': 'ed4d8b811c98da272d3d766c4f4d8ef16b3684ec072cf43726998f4b0e7decd3',
    'acquisition-005/first-use-observations.jsonl': '4b2bd148c34592a81aa3eceb9a1d6eefddec863059d0d6f1bada578030c88e58',
    'acquisition-005/blocks.jsonl': 'eb23efaf2de1c7d0be6f6c1065755088eeecd52b79e8a04af9c358d4b5cdbcb8',
    'acquisition-005/capture-manifest.json': 'fbdbc376ab1b28963d44c2a193cdeff242965578806fc4c8dcd78fdf565844d6',
    'evidence/replay-002-guard.json': 'c0022add32b64758763ddaf9f50c780d430b9bcd0ddefd6daef12a84607fab8b',
    'evidence/replay-002-console.log': 'b4ac3b7b4ee4394bca13e220e9afdf08fda1999e0848ad500a0478af2167921b',
    'evidence/replay-002-guard.child.log': '51cdb01fd94651375cd7bcff8efcf19dddc462fbcdca9fc015763570ed310505',
    'evidence/replay-001-guard.json': '9601eed915d01ca131dcd744e81538278680e6c2a8ececc4fd3364f82a81f757',
}

def require(value, message):
    if not value:
        raise ValueError(message)

def digest(path):
    result = hashlib.sha256()
    with pathlib.Path(path).open('rb') as stream:
        for part in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(part)
    return result.hexdigest()

def read(path):
    return json.loads(pathlib.Path(path).read_text())

def lines(path):
    raw = pathlib.Path(path).read_bytes()
    require(raw.endswith(b'\n') and all(raw.splitlines()), 'Incomplete JSONL record')
    return [json.loads(line) for line in raw.splitlines()]

def finite(value):
    return type(value) in (int, float) and math.isfinite(value)

def same_numbers(actual, expected, label):
    if isinstance(actual, dict):
        require(isinstance(expected, dict) and actual.keys() == expected.keys(), label + ': keys differ')
        for key in actual:
            same_numbers(actual[key], expected[key], label + '.' + key)
    elif isinstance(actual, list):
        require(isinstance(expected, list) and len(actual) == len(expected), label + ': length differs')
        for index, (left, right) in enumerate(zip(actual, expected)):
            same_numbers(left, right, label + '.' + str(index))
    elif type(actual) in (int, float):
        require(finite(actual) and finite(expected) and math.isclose(actual, expected, rel_tol=1e-12, abs_tol=1e-12), label + ': arithmetic differs')
    else:
        require(actual == expected, label + ': value differs')

require(not OUTPUT.exists(), 'Never replace an earlier independent audit')
OUTPUT.mkdir()
report = {'schemaVersion': 1, 'status': 'incomplete', 'auditHelperSha256': digest(__file__),
          'scope': 'Independent read-only raw arithmetic, schedule, semantic-receipt and resource audit; no new native execution or observation',
          'files': {}, 'nativeExecutionsByReviewer': 0}
try:
    for relative, expected in EXPECTED.items():
        source = TEMP / relative
        require(digest(source) == expected, 'Frozen input changed: ' + relative)
        destination = OUTPUT / 'raw' / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(source.read_bytes())
        report['files'][relative] = {'sha256': expected, 'bytes': source.stat().st_size}
    reg_path = BASE / 'registration-resumed-home.json'
    reg_hash = digest(reg_path)
    require(reg_hash == '8aee7f3c605ec0b276b47e38f500800ff046dbaebab01baeb8cc684c02feffd6', 'Registration changed')
    reg = read(reg_path)
    plan, analysis, manifest = (read(DATA / name) for name in ['replay-registration.json', 'replay-analysis.json', 'capture-manifest.json'])
    guard, blocked = read(TEMP / 'evidence/replay-002-guard.json'), read(TEMP / 'evidence/replay-001-guard.json')
    first, observations, blocks = (lines(DATA / name) for name in ['first-use-observations.jsonl', 'observations.jsonl', 'blocks.jsonl'])
    require(plan['schedule'] == reg['schedule'], 'Schedule changed')
    schedule_hash = hashlib.sha256(json.dumps(plan['schedule'], sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    require(schedule_hash == reg['scheduleSha256'] == '4fca181d615f994bb3a266609a0919b7084f8099dd055dfdf8707437d6c646c9', 'Schedule hash changed')
    for value in [plan, analysis, guard, blocked, manifest]:
        require(value['registrationSha256'] == reg_hash, 'Record registration binding differs')
    manifest_hash = EXPECTED['acquisition-005/capture-manifest.json']
    require(plan['manifestSha256'] == analysis['manifestSha256'] == manifest_hash, 'Manifest binding differs')
    require(analysis['status'] == 'complete' and analysis['stage3Authorized'] is False and analysis['fullImportGainClaim'] is False, 'Unexpected analysis authority')
    require(plan['stage3Authorized'] is False, 'Unexpected stage3 authorization')
    require(plan['identities'] == analysis['finalIdentities'] == manifest['identities'] == manifest['finalIdentities'], 'Source/tree identity mismatch')
    for name in ['harness', 'watchdog']:
        require(digest(reg[name]['path']) == reg[name]['sha256'], 'Source helper changed: ' + name)
        require(guard[name + 'Sha256'] == blocked[name + 'Sha256'] == reg[name]['sha256'], 'Guard source binding differs')
    require(plan['harnessSha256'] == reg['harness']['sha256'], 'Replay harness binding differs')
    for label in ['baseline', 'candidate']:
        source = reg[label]
        head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=source['path'], text=True).strip()
        tree = subprocess.check_output(['git', 'rev-parse', 'HEAD^{tree}'], cwd=source['path'], text=True).strip()
        require(head == source['commit'] and {'commit': head, 'tree': tree} == plan['identities'][label], 'Current product identity changed')
        subprocess.run(['git', 'diff', '--quiet', 'HEAD', '--'], cwd=source['path'], check=True)
        require(digest(pathlib.Path(source['path']) / 'dev/data/dictionary-wasm/term-content-canonical-scan-v1.wasm') == source['wasmSha256'], 'Kernel bytes changed')
    require(all(digest(pathlib.Path(reg['baseline']['path']) / path) == expected for path, expected in reg['baselineFiles'].items()), 'Baseline dependency changed')
    require(digest(reg['fixture']['path']) == reg['fixture']['sha256'], 'Locked fixture changed')
    require(digest(reg['nodeExecutable']) == '1bec56ef7cfa9a76f3e0b7c0a87f220eb73f23102b9c0b4c7529a3f7c3ce7c31', 'Verified Node22 binary changed')
    require(all(digest(DATA / capture['file']) == capture['compressedSha256'] for capture in manifest['captures']), 'Captured input changed')
    require(not (DATA / 'failures.jsonl').exists(), 'Retained native failure')
    require(len(first) == 9 and first == analysis['firstUseObservations'], 'First-use record count/copy differs')
    require([(item['block'], item['arm']) for item in first] == [(index, arm) for index, order in enumerate(reg['schedule']['firstUseOrders']) for arm in order], 'First-use ordering differs')
    for item in first:
        require(item['manifestSha256'] == manifest_hash and item['returned'] == manifest['captures'][0]['expectedReturn'], 'First-use semantic binding differs')
        require(item['verified'] is True and 'exception' not in item, 'First-use verification failed')
        require(all(finite(item[key]) and item[key] >= 0 for key in ['compileMs', 'instantiateMs', 'kernelMs']), 'Invalid first-use timer')
    first_summary = {arm: {key: {'values': [item[key] for item in first if item['arm'] == arm],
                               'median': statistics.median(item[key] for item in first if item['arm'] == arm)}
                          for key in ['compileMs', 'instantiateMs', 'kernelMs']} for arm in 'ABC'}
    schedule = [(order, True) for order in reg['schedule']['warmupOrders']] + [(order, False) for order in reg['schedule']['measuredOrders']]
    require(len(schedule) == len(blocks) == 15 and len(observations) == 540 and len(manifest['captures']) == 12, 'Incomplete corpus cohort')
    recomputed_blocks = []
    cursor = 0
    for index, (order, warmup) in enumerate(schedule):
        totals = dict.fromkeys('ABC', 0.0)
        for capture in manifest['captures']:
            for arm in order:
                item = observations[cursor]
                require((item['block'], item['warmup'], item['order'], item['capture'], item['arm']) ==
                        (index, warmup, order, capture['index'], arm), 'Raw native observation order differs at ' + str(cursor))
                require(item['verified'] is True and item['returned'] == capture['expectedReturn'] and 'exception' not in item, 'Raw native semantic verification failed')
                require(finite(item['elapsedMs']) and item['elapsedMs'] >= 0, 'Invalid native elapsed value')
                totals[arm] += item['elapsedMs']
                cursor += 1
        value = {'index': index, 'order': order, 'warmup': warmup, 'totalsMs': totals, 'calls': 36}
        require(all(total > 0 for total in totals.values()), 'Nonpositive corpus kernel total')
        same_numbers(value, blocks[index], 'raw block ' + str(index))
        recomputed_blocks.append(value)
    same_numbers(recomputed_blocks, analysis['blocks'], 'analysis blocks')
    measured = [item for item in recomputed_blocks if not item['warmup']]
    comparisons = {}
    for arm in ['A', 'C']:
        savings = [item['totalsMs'][arm] - item['totalsMs']['B'] for item in measured]
        changes = [100 * (item['totalsMs']['B'] / item['totalsMs'][arm] - 1) for item in measured]
        comparisons[arm] = {'medianSavingsMs': statistics.median(savings), 'medianPairedChangePercent': statistics.median(changes),
                            'fasterBlocks': sum(value > 0 for value in savings), 'savingsMs': savings, 'changesPercent': changes}
    control_savings = [item['totalsMs']['A'] - item['totalsMs']['C'] for item in measured]
    control_changes = [100 * (item['totalsMs']['C'] / item['totalsMs']['A'] - 1) for item in measured]
    control = {'medianSavingsMs': statistics.median(control_savings), 'medianPairedChangePercent': statistics.median(control_changes),
               'savingsMs': control_savings, 'changesPercent': control_changes}
    medians = {arm: statistics.median(item['totalsMs'][arm] for item in measured) for arm in 'ABC'}
    same_numbers(comparisons, analysis['candidateVsControl'], 'candidate comparisons')
    same_numbers(control, analysis['identicalCodeControl'], 'identical controls')
    same_numbers(medians, analysis['medianCorpusKernelMs'], 'corpus medians')
    gate = reg['continuationGate']
    criteria = {arm: {
        'absoluteSavings': comparisons[arm]['medianSavingsMs'] >= gate['minimumMedianSavingsMsVersusBothControls'],
        'percentageSavings': comparisons[arm]['medianPairedChangePercent'] <= -gate['minimumMedianPairedReductionPercentVersusBothControls'],
        'fasterBlocks': comparisons[arm]['fasterBlocks'] >= gate['minimumFasterBlocksVersusEachControl']}
        for arm in ['A', 'C']}
    minimum_saving = min(item['medianSavingsMs'] for item in comparisons.values())
    minimum_percent = min(-item['medianPairedChangePercent'] for item in comparisons.values())
    fraction = gate['maximumAbsoluteMedianControlDriftFractionOfMinimumEffect']
    criteria['control'] = {'milliseconds': abs(control['medianSavingsMs']) < fraction * minimum_saving,
                           'percentage': abs(control['medianPairedChangePercent']) < fraction * minimum_percent}
    passed_gate = all(value for group in criteria.values() for value in group.values())
    require(passed_gate == analysis['passesRegisteredContinuationGate'], 'Continuation gate arithmetic differs')
    require(guard['mode'] == 'replay' and guard['status'] == 'completed' and guard['stageValid'] is True and guard['exitCode'] == 0 and guard['guardFailure'] is None, 'Replay resource receipt failed')
    require(not any(key in guard for key in ['watchdogException', 'cleanupException']), 'Guard/cleanup exception')
    limits = reg['limits']
    require(guard['limits'] == blocked['limits'] == limits, 'Resource limits changed')
    require(guard['preflight']['aggregateCpuBusyFraction'] <= limits['maximumPreflightCpuBusyFraction'], 'Replay CPU preflight failed')
    require(guard['preflight']['MemAvailableBytes'] >= limits['minimumAvailableBytes'] and guard['preflight']['temporaryFilesystemFreeBytes'] >= limits['minimumTemporaryFreeBytes'], 'Replay resource preflight failed')
    require(guard['command'] == [reg['nodeExecutable'], reg['harness']['path'], 'replay', str(reg_path), reg_hash, str(DATA)], 'Replay command changed')
    require(guard['elapsedSeconds'] <= limits['timeoutSeconds'], 'Resource timeout exceeded')
    identity = guard['launchedIdentity']
    pid = guard['ownedPid']
    require(identity['pid'] == identity['pgrp'] == identity['session'] == pid, 'Invalid launched group/session')
    require(guard['pidNamespaces']['watchdog'] == guard['pidNamespaces']['launched'], 'PID namespace drift')
    identities = {item['pid']: item for item in guard['observedProcessIdentities']}
    require(pid in identities and identities[pid]['starttime'] == identity['starttime'], 'Launched identity not sampled')
    require(all(item['pgrp'] == item['session'] == pid and item['starttime'] >= identity['starttime'] for item in identities.values()), 'Invalid owned descendant')
    samples = guard['samples']
    require(bool(samples), 'No resource samples')
    extra = {pid for sample in samples for pid in sample['ownedPids']} - identities.keys()
    require(len(extra) == 1, 'Ambiguous watchdog sample identity')
    watchdog_pid = next(iter(extra))
    positive = 0
    for sample in samples:
        rss = sample['rssByPid']
        require(all(type(value) is int and value >= 0 for value in rss.values()), 'Invalid per-PID RSS')
        require(sorted(map(int, rss)) == sample['ownedPids'] and watchdog_pid in sample['ownedPids'], 'Resource inventory mismatch')
        require(sum(rss.values()) == sample['rssBytes'] <= limits['maxRssBytes'], 'RSS sum/limit mismatch')
        require(sample['MemAvailableBytes'] >= limits['minimumRuntimeAvailableBytes'] and sample['temporaryBytes'] <= limits['maxTemporaryBytes'], 'Runtime resource limit failed')
        positive += rss.get(str(pid), 0) > 0
    require(positive == guard['positiveLaunchedRssSamples'] and positive > 0, 'Launched RSS coverage mismatch')
    require(max(sample['rssBytes'] for sample in samples) == guard['maxSampledRssBytes'], 'RSS peak differs')
    require(max([sample['temporaryBytes'] for sample in samples] + [guard['finalTemporaryBytes']]) == guard['maxTemporaryBytes'] <= limits['maxTemporaryBytes'], 'Disk peak differs')
    require(guard['finalMemAvailableBytes'] >= limits['minimumRuntimeAvailableBytes'], 'Final memory floor failed')
    times = [sample['elapsedSeconds'] for sample in samples]
    require(all(finite(value) for value in times) and all(a < b for a, b in zip(times, times[1:])) and 0 <= times[0] <= times[-1] <= guard['elapsedSeconds'], 'Invalid sampling coordinates')
    gaps = [b - a for a, b in zip(times, times[1:])]
    require(blocked['status'] == 'preflight-blocked' and not blocked['samples'] and 'command' not in blocked and 'ownedPid' not in blocked,
            'Earlier eligibility attempt contained child execution')
    require(blocked['failures'] == ['Aggregate CPU preflight is not quiet'] and blocked['preflight']['aggregateCpuBusyFraction'] > limits['maximumPreflightCpuBusyFraction'], 'Earlier CPU block misclassified')
    console = read(TEMP / 'evidence/replay-002-console.log')
    require(console == {key: guard[key] for key in console}, 'Guard console differs')
    child_blocks = [json.loads(line) for line in (TEMP / 'evidence/replay-002-guard.child.log').read_text().splitlines() if line.startswith('{')]
    require(child_blocks == [{'event': 'completed-block', **block} for block in blocks], 'Child log block sequence differs')
    actual_temp_bytes = sum(path.stat().st_size for path in TEMP.rglob('*') if path.is_file())
    require(actual_temp_bytes <= limits['maxTemporaryBytes'], 'Post-receipt retained temporary cap failed')
    require(all(digest(TEMP / relative) == expected for relative, expected in EXPECTED.items()), 'Audit mutated an input')
    report.update(status='passed', registrationSha256=reg_hash, scheduleSha256=schedule_hash,
        firstUse={'count': 9, 'orders': reg['schedule']['firstUseOrders'], 'separateOnly': True,
                  'scope': first[0]['scope'], 'perArm': first_summary},
        cohort={'firstUseCalls': 9, 'warmupBlocks': 3, 'warmupCalls': 108, 'measuredBlocks': 12, 'measuredCalls': 432,
                'allReceiptsVerified': True, 'timedOutputMemoryReexecutionByReviewer': False,
                'semanticEvidenceScope': 'Every raw returned/verified receipt matched the frozen harness and manifest; the 12 baseline oracle snapshots were independently recomputed before replay'},
        medianCorpusKernelMs=medians, candidateVsControl=comparisons, identicalCodeControl=control,
        criteria=criteria, passesRegisteredContinuationGate=passed_gate,
        resource={'sampleCount': len(samples), 'positiveLaunchedSamples': positive, 'observedOwnedProcesses': len(identities),
                  'preflightCpuBusyFraction': guard['preflight']['aggregateCpuBusyFraction'],
                  'maximumInterSampleGapSeconds': max(gaps), 'medianInterSampleGapSeconds': statistics.median(gaps),
                  'firstSampleGapSeconds': times[0], 'lastSampleToReceiptGapSeconds': guard['elapsedSeconds'] - times[-1],
                  'maxSampledRssBytes': guard['maxSampledRssBytes'], 'minimumSampledMemAvailableBytes': min(sample['MemAvailableBytes'] for sample in samples),
                  'maxTemporaryBytes': guard['maxTemporaryBytes'], 'actualPostReceiptTemporaryBytes': actual_temp_bytes,
                  'scope': 'Stage resource monitoring only; this is not a browser memory or complete-import timing observation'},
        earlierEligibility={'status': blocked['status'], 'cpuBusyFraction': blocked['preflight']['aggregateCpuBusyFraction'], 'childLaunched': False, 'timingObservations': 0},
        allRawInputsUnchanged=True, stage3Authorized=False,
        conclusion='Registered continuation screen failed; no stage3, full-import gain claim, or PR is supported by this cohort' if not passed_gate else 'Continuation screen passed; further work still requires root approval')
except BaseException as error:
    report['status'] = 'failed'
    report['failure'] = {'type': type(error).__name__, 'message': str(error)}
    raise
finally:
    (OUTPUT / 'audit.json').write_text(json.dumps(report, indent=2, allow_nan=False) + '\n')
    print(json.dumps({key: value for key, value in report.items() if key not in ['files', 'firstUse', 'candidateVsControl', 'identicalCodeControl']}, indent=2))
