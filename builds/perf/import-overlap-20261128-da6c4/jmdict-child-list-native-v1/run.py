from pathlib import Path
import datetime
import hashlib
import json
import subprocess
import sys

HERE = Path(__file__).resolve().parent
plan_path = Path(sys.argv[1]).resolve()
destination = Path(sys.argv[2]).resolve()
destination.mkdir(exist_ok=False)
plan_bytes = plan_path.read_bytes()
plan = json.loads(plan_bytes)
sha = lambda data: hashlib.sha256(data).hexdigest()
assert plan['scope'] == 'Native component only; no complete-import performance claim'
inputs = json.loads((HERE / 'inputs.json').read_text())
assert sha((HERE / 'inputs.json').read_bytes()) == plan['inputSha256']
for name, expected in plan['harnessSha256'].items():
    assert sha((HERE / name).read_bytes()) == expected, name
report = {'schemaVersion': 1, 'complete': False, 'planSha256': sha(plan_bytes), 'plan': plan, 'startedUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'attempts': [], 'observations': []}
receipt_path = destination / 'observations.json'
def save():
    receipt_path.write_text(json.dumps(report, indent=2) + '\n')
save()
try:
    for block, order in enumerate(plan['schedule']):
        for position, arm in enumerate(order):
            prefix = f'round-{block:02d}-{position}-{arm}'
            output = destination / f'{prefix}.json'
            log_path = destination / f'{prefix}.log'
            command = ['node', '--expose-gc', '--max-old-space-size=512', str(HERE / 'component-arm.mjs'), str(HERE / 'inputs.json'), arm, 'measure', str(output)]
            attempt = {'round': block, 'position': position, 'arm': arm, 'command': command, 'output': output.name, 'log': log_path.name, 'startedUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'exitCode': None}
            report['attempts'].append(attempt)
            save()
            with log_path.open('w') as log:
                completed = subprocess.run(command, cwd=HERE, stdout=log, stderr=subprocess.STDOUT, timeout=120, check=False)
            attempt['exitCode'] = completed.returncode
            attempt['finishedUtc'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            attempt['logSha256'] = sha(log_path.read_bytes())
            save()
            assert completed.returncode == 0, attempt
            raw = output.read_bytes()
            result = json.loads(raw)
            assert result['complete'] and result['arm'] == arm and result['mode'] == 'measure'
            assert result['inputSha256'] == plan['inputSha256']
            assert result['runnerSha256'] == plan['harnessSha256']['component-arm.mjs']
            assert result['moduleSha256'] == inputs['identities']['A' if arm == 'C' else arm]['dev/data/dictionary-wasm/term-bank-parser.wasm']
            assert result['moduleSha256'] != inputs['counterWasm']['sha256']
            assert result['node'] == plan['node']
            assert result['options'] == inputs['options']
            assert result['experiments'] == plan['experimentSnapshot']
            assert result['partitionFunctionSha256'] == plan['partitionFunctionSha256']
            assert result['byteLengthFunctionSha256'] == plan['byteLengthFunctionSha256']
            assert result['groupGeometry'] == plan['groupGeometry']
            assert result['before'] == result['after'] == inputs['identities']['A' if arm == 'C' else arm]
            assert len(result['warmups']) == 2
            for sweep in [*result['warmups'], result['measured']]:
                assert sweep['rows'] == 528299 and sweep['nativeCalls'] == 12 and len(sweep['groups']) == 12
                assert all(group['profile']['fusedParseAttempts'] == 1 and group['profile']['fusedParseFallbacks'] == 0 and group['owned'] for group in sweep['groups'])
            for index, group in enumerate(result['measured']['groups']):
                assert group['output'] == plan['outputOracle'][index], (block, arm, index)
                assert group['counters'] is None
            observation = {'round': block, 'position': position, 'arm': arm, 'nativeFusedMs': result['measured']['nativeFusedMs'], 'fullGroupMs': result['measured']['fullGroupMs'], 'rawFile': output.name, 'rawSha256': sha(raw), 'maxRssKiB': result['maxRssKiB']}
            report['observations'].append(observation)
            save()
            print(json.dumps(observation), flush=True)
    assert len(report['observations']) == 36
    for name, expected in plan['harnessSha256'].items():
        assert sha((HERE / name).read_bytes()) == expected, name
    report['complete'] = True
except BaseException as error:
    report['error'] = {'name': type(error).__name__, 'message': str(error)}
    raise
finally:
    report['finishedUtc'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    save()
