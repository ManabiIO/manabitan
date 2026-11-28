"""Independent raw acquisition audit and one untimed baseline check per capture."""
import argparse
import ast
import hashlib
import json
import math
import os
import pathlib
import resource
import signal
import statistics
import subprocess
import time
import zipfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--registration', type=pathlib.Path, required=True)
parser.add_argument('--guard', type=pathlib.Path, required=True)
parser.add_argument('--manifest', type=pathlib.Path, required=True)
parser.add_argument('--output', type=pathlib.Path, required=True)
args = parser.parse_args()

def require(value, message):
    if not value:
        raise ValueError(message)

def sha(path):
    result = hashlib.sha256()
    with pathlib.Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()

def load(path):
    return json.loads(pathlib.Path(path).read_text())

def available():
    return next(int(line.split()[1]) * 1024 for line in pathlib.Path('/proc/meminfo').read_text().splitlines()
                if line.startswith('MemAvailable:'))

def temporary_bytes(root):
    total = 0
    for entry in root.rglob('*'):
        require(not entry.is_symlink(), 'Unexpected linked temporary input')
        if entry.is_file():
            total += entry.stat().st_size
    return total

require(not args.output.exists(), 'Never replace or resume an independent audit')
registration = load(args.registration)
temporary_root = pathlib.Path(registration['temporaryRoot']).resolve()
require(args.output.resolve().is_relative_to(temporary_root), 'Audit records must stay in the registered temporary root')
args.output.mkdir()
report_path = args.output / 'independent-acquisition-audit.json'
report = {'schemaVersion': 1, 'status': 'incomplete',
          'scope': 'Read-only raw acquisition/guard audit and untimed baseline-only semantic verification; no candidate load or performance observation',
          'auditHelperSha256': sha(__file__), 'semanticObservations': []}

def save():
    report_path.write_text(json.dumps(report, indent=2, allow_nan=False) + '\n')

save()
try:
    registration_hash = sha(args.registration)
    require(registration_hash == '8aee7f3c605ec0b276b47e38f500800ff046dbaebab01baeb8cc684c02feffd6', 'Unexpected amended registration')
    require(sha(args.guard) == '9519f9c62dc6ccb439a36c75b3bc7741b6cc377dfaf88c8450c8552e8f69576d', 'Unfrozen acquisition guard')
    manifest_hash = sha(args.manifest)
    require(manifest_hash == 'fbdbc376ab1b28963d44c2a193cdeff242965578806fc4c8dcd78fdf565844d6', 'Unfrozen acquisition manifest')
    guard, manifest = load(args.guard), load(args.manifest)
    limits = registration['limits']
    require(guard['registrationSha256'] == manifest['registrationSha256'] == registration_hash, 'Registration binding differs')
    require(guard['limits'] == limits, 'Guard limits changed')
    for key in ['harness', 'watchdog']:
        require(sha(registration[key]['path']) == registration[key]['sha256'], key + ' source changed')
        require(guard[key + 'Sha256'] == registration[key]['sha256'], key + ' guard binding differs')
    require(manifest['harnessSha256'] == registration['harness']['sha256'], 'Capture harness changed')
    require(guard['mode'] == 'acquire' and guard['status'] == 'completed' and guard['stageValid'] is True,
            'Acquisition is not resource-qualified')
    require(guard['exitCode'] == 0 and guard['guardFailure'] is None, 'Acquisition guard failed')
    require(not any(key in guard for key in ['watchdogException', 'cleanupException']), 'Guard exception retained')
    require(guard['preflight']['MemAvailableBytes'] >= limits['minimumAvailableBytes'], 'Memory preflight failed')
    require(guard['preflight']['temporaryFilesystemFreeBytes'] >= limits['minimumTemporaryFreeBytes'], 'Disk preflight failed')
    # The repaired report location is inside the guarded root. Its initial
    # status='running' receipt is written after preflight, before the child
    # receives its independently observed retained-byte count.
    initial_guard_keys = ['schemaVersion', 'mode', 'status', 'registrationSha256', 'harnessSha256',
                          'watchdogSha256', 'limits', 'sampleIntervalSeconds', 'scope', 'samples', 'preflight', 'command']
    initial_guard = {key: guard[key] for key in initial_guard_keys}
    initial_guard.update(status='running', samples=[])
    initial_guard_bytes = len((json.dumps(initial_guard, indent=2) + '\n').encode()) if args.guard.resolve().is_relative_to(temporary_root) else 0
    require(guard['preflight']['retainedTemporaryBytes'] + initial_guard_bytes == manifest['priorRetainedTemporaryBytes'],
            'Prelaunch retained-byte count differs after the initial guard receipt')
    require(guard['elapsedSeconds'] <= limits['timeoutSeconds'], 'Acquisition exceeded registered timeout')
    expected_command = [registration['nodeExecutable'], registration['harness']['path'], 'acquire',
                        str(args.registration.resolve()), registration_hash, str(args.manifest.parent.resolve())]
    require(guard['command'] == expected_command, 'Acquisition command changed')
    pid = guard['ownedPid']
    identity = guard['launchedIdentity']
    require(identity['pid'] == identity['pgrp'] == identity['session'] == pid, 'Launched process identity mismatch')
    require(guard['pidNamespaces']['watchdog'] == guard['pidNamespaces']['launched'], 'PID namespace mismatch')
    identities = {item['pid']: item for item in guard['observedProcessIdentities']}
    require(pid in identities and identities[pid]['starttime'] == identity['starttime'], 'Launched process not covered')
    require(all(item['pgrp'] == item['session'] == pid and item['starttime'] >= identity['starttime']
                for item in identities.values()), 'Unverified owned process identity')
    samples = guard['samples']
    require(bool(samples), 'No acquisition resource samples')
    extra_pids = {pid for sample in samples for pid in sample['ownedPids']} - identities.keys()
    require(len(extra_pids) == 1, 'Expected exactly one independently sampled watchdog process')
    watchdog_pid = next(iter(extra_pids))
    positive = 0
    for sample in samples:
        by_pid = sample['rssByPid']
        require(all(type(value) is int and value >= 0 for value in by_pid.values()), 'Invalid sampled RSS')
        require(sorted(map(int, by_pid)) == sample['ownedPids'], 'Per-PID sample inventory differs')
        require(watchdog_pid in sample['ownedPids'] and set(sample['ownedPids']) <= identities.keys() | {watchdog_pid}, 'Sample includes an unverified process')
        require(sum(by_pid.values()) == sample['rssBytes'], 'RSS sum mismatch')
        require(0 < sample['rssBytes'] <= limits['maxRssBytes'], 'Sampled RSS exceeds limit')
        require(sample['MemAvailableBytes'] >= limits['minimumRuntimeAvailableBytes'], 'Runtime memory floor failed')
        require(sample['temporaryBytes'] <= limits['maxTemporaryBytes'], 'Sampled disk limit failed')
        positive += by_pid.get(str(pid), 0) > 0
    require(positive == guard['positiveLaunchedRssSamples'] and positive > 0, 'Positive root coverage mismatch')
    require(max(item['rssBytes'] for item in samples) == guard['maxSampledRssBytes'], 'Peak RSS summary mismatch')
    require(guard['maxTemporaryBytes'] <= limits['maxTemporaryBytes'], 'Peak disk limit failed')
    require(guard['finalTemporaryBytes'] <= guard['maxTemporaryBytes'], 'Final disk count exceeds recorded peak')
    require(max([sample['temporaryBytes'] for sample in samples] + [guard['finalTemporaryBytes']]) == guard['maxTemporaryBytes'], 'Peak disk summary mismatch')
    require(guard['finalMemAvailableBytes'] >= limits['minimumRuntimeAvailableBytes'], 'Final memory floor failed')
    times = [item['elapsedSeconds'] for item in samples]
    require(all(type(value) in (int, float) and math.isfinite(value) for value in times), 'Invalid sample coordinate')
    require(all(left < right for left, right in zip(times, times[1:])), 'Nonmonotonic resource samples')
    require(0 <= times[0] <= times[-1] <= guard['elapsedSeconds'], 'Resource sample outside stage interval')
    gaps = [right - left for left, right in zip(times, times[1:])]
    report['acquisitionResourceAudit'] = {
        'guardSha256': sha(args.guard), 'sampleCount': len(samples), 'positiveLaunchedSamples': positive,
        'watchdogPid': watchdog_pid,
        'ownedProcessIdentities': list(identities.values()), 'maxSampledRssBytes': guard['maxSampledRssBytes'],
        'preflightRetainedBytes': guard['preflight']['retainedTemporaryBytes'],
        'initialGuardReceiptBytes': initial_guard_bytes, 'manifestPriorRetainedBytes': manifest['priorRetainedTemporaryBytes'],
        'minimumSampledMemAvailableBytes': min(item['MemAvailableBytes'] for item in samples),
        'maxTemporaryBytes': guard['maxTemporaryBytes'], 'finalTemporaryBytes': guard['finalTemporaryBytes'],
        'maximumInterSampleGapSeconds': max(gaps, default=0), 'medianInterSampleGapSeconds': statistics.median(gaps) if gaps else None,
        'firstSampleGapSeconds': times[0], 'lastSampleToReceiptGapSeconds': guard['elapsedSeconds'] - times[-1],
        'scope': 'Recomputed raw process/RSS/resource receipt; sampling gaps are reported without inventing a retrospective threshold'}
    require(manifest['status'] == 'qualified-source-derived-component', 'Incomplete acquisition')
    require(manifest['identities'] == manifest['finalIdentities'], 'Source identities changed during acquisition')
    for arm in ['baseline', 'candidate']:
        expected = registration[arm]
        require(manifest['identities'][arm]['commit'] == expected['commit'], 'Wrong source commit')
        actual_head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=expected['path'], text=True).strip()
        actual_tree = subprocess.check_output(['git', 'rev-parse', 'HEAD^{tree}'], cwd=expected['path'], text=True).strip()
        require(actual_head == expected['commit'] and actual_tree == manifest['identities'][arm]['tree'], 'Current source identity drift')
        subprocess.run(['git', 'diff', '--quiet', 'HEAD', '--'], cwd=expected['path'], check=True)
    for relative, expected in registration['baselineFiles'].items():
        require(sha(pathlib.Path(registration['baseline']['path']) / relative) == expected, 'Baseline source changed: ' + relative)
    fixture = pathlib.Path(registration['fixture']['path'])
    require(sha(fixture) == registration['fixture']['sha256'] == manifest['finalFixtureIdentity']['sha256'], 'Fixture digest mismatch')
    require(fixture.stat().st_size == manifest['finalFixtureIdentity']['sizeBytes'] == 15645766, 'Fixture size mismatch')
    groups, captures = manifest['groups'], manifest['captures']
    require(len(groups) == len(captures) == 12 and manifest['parserWorkers'] == 3, 'Wrong workload geometry')
    require([item['census'] for item in groups] == registration['expectedGroups'], 'Source census differs')
    require([name for group in groups for name in group['sourceFiles']] == [f'term_bank_{index}.json' for index in range(1, 54)], 'Bank ordering/coverage mismatch')
    witnesses = {item['id']: item for item in manifest['sourceGroups']}
    require(len(manifest['sourceGroups']) == len(witnesses) == 12 and set(witnesses) == set(range(1, 13)), 'Source request coverage mismatch')
    raw_base, compressed_total, dense_count = 0, 0, 0
    with zipfile.ZipFile(fixture) as archive:
        for index, (group, capture) in enumerate(zip(groups, captures)):
            census = group['census']
            require(capture['index'] == capture['group'] == index, 'Capture ordering differs')
            require(capture['file'] == f'native-{index:03}.bin.gz', 'Unexpected capture name')
            payload = args.manifest.parent / capture['file']
            require(payload.is_file() and not payload.is_symlink(), 'Missing/linked capture')
            require(payload.stat().st_size == capture['compressedBytes'] and sha(payload) == capture['compressedSha256'], 'Compressed capture mismatch')
            require(0 < capture['memoryBytes'] <= limits['maxArenaBytes'] and capture['memoryBytes'] % 65536 == 0, 'Arena limit/geometry mismatch')
            require(capture['beforeDense'] == dense_count and capture['beforePending'] == 0, 'Dense/pending boundary mismatch')
            require(group['rawBase'] == raw_base and group['nativeCalls'] == 1, 'Raw offset/call count mismatch')
            require(capture['expectedReturn'] == 0 and len(capture['header']) == 7 and len(capture['config']) == 22, 'Native oracle shape mismatch')
            require(capture['config'][11] == dense_count and capture['config'][12] == census['rowCount'], 'Input config census differs')
            require(capture['config'][14] - capture['config'][13] == census['uniqueCount'] and capture['config'][18] == census['ownedContentBytes'], 'Input config work differs')
            require(capture['header'][1] == census['uniqueCount'] and capture['header'][2] == census['pendingContentCount'], 'Output header census differs')
            require(capture['header'][3] == group['exactMatches'] < 4096 and group['nativePendingRows'] == census['pendingContentCount'], 'Exact/pending output mismatch')
            dense_count += census['pendingContentCount']
            require(capture['header'][5] == dense_count, 'Final dense count mismatch')
            source = witnesses[index + 1]
            require(source['files'] == group['sourceFiles'], 'Source request/group binding differs')
            infos = [archive.getinfo(name) for name in source['files']]
            require(sum(item.file_size for item in infos) == source['rawSourceBytes'] == census['sourceBytes'], 'Raw source byte count differs')
            require(sum(item.compress_size for item in infos) == source['transferredBytes'], 'Compressed source byte count differs')
            raw_base += census['ownedContentBytes']
            compressed_total += capture['compressedBytes']
    require(raw_base == manifest['rawBytes'] == 101143985 and compressed_total == manifest['compressedBytes'], 'Payload byte totals differ')
    require(sum(item['census']['rowCount'] for item in groups) == 528299, 'Term row total differs')
    require(sum(item['census']['uniqueCount'] for item in groups) == 366030 and dense_count == 362032, 'Canonical total differs')
    require(sum(item['exactMatches'] for item in groups) == 3998, 'Exact-match total differs')
    require(manifest['nativeStats']['calls'] == 12 and manifest['nativeStats']['fallbacks'] == 0, 'Native fallback/call count differs')
    require(manifest['rawSourceFileRemovedAfterVerifiedAcquisition'] is True and not (args.manifest.parent / 'raw-content.bin').exists(), 'Raw source cleanup incomplete')
    require(not any('replay' in path.name or 'first-use' in path.name or 'block-' in path.name for path in args.manifest.parent.iterdir()), 'Unexpected performance/replay artifact')
    report['corpusAudit'] = {'manifestSha256': manifest_hash, 'captures': 12, 'banks': 53, 'rows': 528299,
        'uniqueRepresentatives': 366030, 'pendingRows': dense_count, 'exactMatches': 3998,
        'rawOwnedBytes': raw_base, 'compressedCaptureBytes': compressed_total, 'sourceIdentities': manifest['identities']}
    helper = pathlib.Path(__file__).with_name('verify-capture-baseline.mjs')
    helper_hash, node_hash = sha(helper), sha(registration['nodeExecutable'])
    require(node_hash == '1bec56ef7cfa9a76f3e0b7c0a87f220eb73f23102b9c0b4c7529a3f7c3ce7c31', 'Node binary identity drift')
    report['semanticVerifier'] = {'helperSha256': helper_hash, 'nodeSha256': node_hash, 'nodeVersion': registration['nodeVersion'],
        'baselineWasmSha256': registration['baseline']['wasmSha256'], 'separateFreshProcessPerCapture': True,
        'nativeClocks': False, 'candidateModuleLoaded': False, 'resourceTimeoutClockOnly': True}
    require(available() >= limits['minimumAvailableBytes'], 'Audit memory preflight failed')
    require(temporary_bytes(temporary_root) <= limits['maxTemporaryBytes'], 'Audit temporary cap failed')
    # Reuse only the reviewed process identity/resource functions, never the
    # watchdog's argument parser, launcher, timings, or acquisition code.
    function_names = {'read_process', 'visible_processes', 'own_group', 'process_tree', 'terminate_owned'}
    tree = ast.parse(pathlib.Path(registration['watchdog']['path']).read_text())
    functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in function_names]
    require({node.name for node in functions} == function_names, 'Frozen resource function set differs')
    resource_code = compile(ast.Module(body=functions, type_ignores=[]), '<frozen-resource-functions>', 'exec')
    deadline = time.monotonic() + limits['timeoutSeconds']
    save()
    for index, capture in enumerate(captures):
        require(sha(helper) == helper_hash, 'Semantic helper changed')
        command = [registration['nodeExecutable'], str(helper), str(args.registration.resolve()), registration_hash,
                   str(args.manifest.resolve()), manifest_hash, str(index)]
        item = {'captureIndex': index, 'command': command, 'status': 'running', 'resourceSamples': []}
        report['semanticObservations'].append(item)
        save()
        stdout_path, stderr_path = args.output / f'capture-{index:03}.json', args.output / f'capture-{index:03}.stderr'
        env = {**os.environ, 'NODE_OPTIONS': '--max-old-space-size=768', 'NODE_DISABLE_COMPILE_CACHE': '1'}
        process = None
        sampler = None
        try:
            with stdout_path.open('xb') as stdout, stderr_path.open('xb') as stderr:
                process = subprocess.Popen(command, stdout=stdout, stderr=stderr, start_new_session=True, env=env)
                sampler = {'pathlib': pathlib, 'os': os, 'time': time, 'signal': signal, 'proc': process,
                           'owner_identity': None, 'observed_identities': {}, 'root_sample_count': 0}
                exec(resource_code, sampler)
                sampler['owner_identity'] = sampler['read_process'](process.pid)
                while process.poll() is None:
                    rss, pids, by_pid = sampler['process_tree']()
                    available_bytes, disk_bytes = available(), temporary_bytes(temporary_root)
                    item['resourceSamples'].append({'rssBytes': rss, 'ownedPids': pids, 'rssByPid': by_pid,
                        'MemAvailableBytes': available_bytes, 'temporaryBytes': disk_bytes})
                    require(rss <= limits['maxRssBytes'], 'Semantic audit process RSS limit exceeded')
                    require(available_bytes >= limits['minimumRuntimeAvailableBytes'], 'Semantic audit memory floor failed')
                    require(disk_bytes <= limits['maxTemporaryBytes'], 'Semantic audit temporary cap exceeded')
                    require(time.monotonic() <= deadline, 'Semantic audit resource timeout')
                    time.sleep(0.05)
                item['exitCode'] = process.wait()
                require(item['exitCode'] == 0, 'Baseline semantic child failed')
            value = load(stdout_path)
            require(value['status'] == 'passed' and value['nativeCalls'] == 1, 'Semantic verifier did not make exactly one successful call')
            require(value['helperSha256'] == helper_hash and value['nodeVersion'] == registration['nodeVersion'], 'Semantic verifier identity differs')
            require(value['baselineWasmSha256'] == registration['baseline']['wasmSha256'], 'Wrong native oracle')
            require(value['captureIndex'] == index and value['manifestSha256'] == manifest_hash, 'Wrong semantic input binding')
            require(value['inputSha256'] == capture['inputSha256'] and value['compressedSha256'] == capture['compressedSha256'], 'Native input digest differs')
            require(value['outputSha256'] == capture['outputSha256'] and value['header'] == capture['header'], 'Native semantic result differs')
            peak_bound = value['processPeakRssBytes'] + resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024
            require(peak_bound <= limits['maxRssBytes'], 'Conservative sum of process peak RSS exceeds cap')
            require(sampler['root_sample_count'] > 0, 'Semantic child lacked a positive RSS observation')
            item.update(status='passed', stdoutSha256=sha(stdout_path), stderrSha256=sha(stderr_path),
                        positiveChildRssSamples=sampler['root_sample_count'], conservativePeakRssBoundBytes=peak_bound,
                        result=value)
        finally:
            if process is not None and sampler is not None:
                sampler['terminate_owned'](process)
            save()
    require(sha(registration['nodeExecutable']) == node_hash and sha(helper) == helper_hash, 'Verifier/runtime changed')
    require(sha(args.manifest) == manifest_hash and sha(args.guard) == report['acquisitionResourceAudit']['guardSha256'], 'Acquisition evidence changed')
    require(all(sha(args.manifest.parent / item['file']) == item['compressedSha256'] for item in captures), 'Captured inputs changed')
    require(temporary_bytes(temporary_root) <= limits['maxTemporaryBytes'], 'Final audit temporary cap failed')
    report.update(status='passed', semanticCalls=12, allCapturesUnchanged=True,
                  replayAuthorized=False, performanceObservations=0)
except BaseException as error:
    report['status'] = 'failed'
    report['failure'] = {'type': type(error).__name__, 'message': str(error)}
    raise
finally:
    save()
    print(json.dumps({key: value for key, value in report.items() if key != 'semanticObservations'}, indent=2))
