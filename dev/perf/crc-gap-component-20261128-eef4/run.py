#!/usr/bin/env python3
from pathlib import Path
import argparse
import datetime
import hashlib
import json
import statistics
import subprocess
import sys
from summarize import profile_totals, summarize_report


parser = argparse.ArgumentParser(description='Execute the fixed fresh-child CRC component cohort without replacing observations')
parser.add_argument('--plan', type=Path, required=True)
parser.add_argument('--check-only', action='store_true')
args = parser.parse_args()
plan_bytes = args.plan.read_bytes()
plan = json.loads(plan_bytes)
root = args.plan.resolve().parent
node = Path(plan['nodeExecutable'])
runner = Path(plan['serverPath'])
result_path = root / 'result.json'
assert not result_path.exists(), 'Do not overwrite or resume a partially completed cohort'
assert hashlib.sha256(runner.read_bytes()).hexdigest() == plan['serverSha256']
assert hashlib.sha256(Path(__file__).read_bytes()).hexdigest() == plan['controllerSha256']
assert hashlib.sha256(node.read_bytes()).hexdigest() == plan['nodeExecutableSha256']
assert len(plan['orders']) == 6 and set(plan['orders']) == {'ABC', 'BCA', 'CAB', 'CBA', 'ACB', 'BAC'}
assert plan['warmupsPerChild'] == 2 and plan['timedPassesPerChild'] == 1 and plan['verificationPassesPerChild'] == 1
if args.check_only:
    subprocess.run([str(node), '--check', str(runner)], check=True)
    print(json.dumps({'planValid': True, 'orders': plan['orders'], 'serverSha256': plan['serverSha256']}))
    sys.exit(0)
report = {
    'schema': 2,
    'complete': False,
    'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'plan': plan,
    'planSha256': hashlib.sha256(plan_bytes).hexdigest(),
    'controllerSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    'observations': [],
}
identity = None
digest = None
grouping = None


def save():
    result_path.write_text(json.dumps(report, indent=2) + '\n')




save()
try:
    for block, order in enumerate(plan['orders']):
        for arm in order:
            label = f'block-{block + 1}-{arm}'
            output = root / f'{label}.json'
            command = [str(node), str(runner),
                '--source-root', plan['baselineRoot'],
                '--cache-dir', plan['cacheDir'],
                '--dictionary', 'vndb', '--parser-workers', '3',
                '--warmups', '2', '--runs', '1', '--out', str(output)]
            if arm == 'B':
                command.extend(['--variant-root', plan['variantRoot']])
            item = {'block': block, 'order': order, 'arm': arm, 'command': command,
                'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
            report['observations'].append(item)
            save()
            with (root / f'{label}.log').open('w') as log:
                child = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT)
            item['returnCode'] = child.returncode
            item['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            if output.exists():
                raw = output.read_bytes()
                item['rawReport'] = {'path': str(output), 'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw)}
            save()
            assert child.returncode == 0, f'{label} child failed with exit code {child.returncode}; retain this failed acquisition'
            assert output.is_file(), f'{label} child exited without its own report'
            raw = output.read_bytes()
            assert hashlib.sha256(raw).hexdigest() == item['rawReport']['sha256']
            value = json.loads(raw)
            assert value['complete'] and len(value['observations']) == 4
            warmups = [observation for observation in value['observations'] if observation['warmup']]
            timed = [observation for observation in value['observations'] if observation['timed']]
            verification = [observation for observation in value['observations'] if observation['verification']]
            assert len(warmups) == 2 and len(timed) == 1 and len(verification) == 1
            assert [observation['pass'] for observation in value['observations']] == [0, 1, 2, 3]
            assert verification[0]['pass'] > timed[0]['pass']
            assert all(observation['rows'] == 6648310 for observation in value['observations'])
            expected_wasm = plan['candidateWasmSha256'] if arm == 'B' else plan['baselineWasmSha256']
            assert value['injectedWasmSha256'] == expected_wasm
            if arm == 'B':
                assert value['diagnosticNativeOverride']['sourceSha256'] == plan['candidateSourceSha256']
            else:
                assert value['diagnosticNativeOverride'] is None
            assert value['fixture']['sha256'] == plan['fixtureSha256']
            assert value['runnerSha256'] == plan['serverSha256']
            assert value['node'] == plan['nodeVersion']
            assert value['grouping']['workerCountPolicy'] == plan['workerCountPolicy']
            if identity is None:
                identity = value['identity']
                report['sourceIdentity'] = identity
                grouping = value['grouping']
                report['grouping'] = grouping
            assert value['identity'] == identity
            assert value['grouping'] == grouping
            assert verification[0]['digest'] == plan['expectedDigest']
            if digest is None:
                digest = verification[0]['digest']
                report['digest'] = digest
            assert verification[0]['digest'] == digest
            observation = timed[0]
            item['measurement'] = {key: observation[key] for key in [
                'workerMs', 'cpuMs', 'cpuUserMs', 'cpuSystemMs', 'threadCpuMs', 'threadCpuUserMs',
                'threadCpuSystemMs', 'rows', 'transferBytes', 'workCounts', 'memory', 'maxRSSKiB',
            ]}
            item['measurement']['phaseMs'] = profile_totals(observation)
            item['measurement']['sourceCrcMs'] = item['measurement']['phaseMs'].get('sourceCrcMs', 0)
            item['verificationDigest'] = verification[0]['digest']
            item['node'] = value['node']
            item['v8'] = value['v8']
            item['host'] = value['host']
            save()
            print(json.dumps({'block': block, 'arm': arm,
                'workerMs': observation['workerMs'], 'cpuMs': observation['cpuMs'],
                'threadCpuMs': observation['threadCpuMs'], 'sourceCrcMs': item['measurement']['sourceCrcMs'],
                'digest': verification[0]['digest'], 'maxRSSKiB': observation['maxRSSKiB']}), flush=True)
    report.update(summarize_report(report))
    report['complete'] = True
    report['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    save()
    print(json.dumps({'complete': True, 'digest': digest, 'comparisons': report['comparisons'], 'armMedians': report['armMedians']}), flush=True)
except BaseException as error:
    report['error'] = {'type': type(error).__name__, 'message': str(error)}
    report['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    save()
    raise
