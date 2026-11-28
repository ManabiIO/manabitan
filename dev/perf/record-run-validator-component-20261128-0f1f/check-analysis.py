"""Synthetic receipts only; exercise paired arithmetic and rejection of bad inputs."""
import copy
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent
sha = lambda b: hashlib.sha256(b).hexdigest()
source_inventory = json.loads((ROOT / 'source-inventory.json').read_text())
results = []
with tempfile.TemporaryDirectory(prefix='synthetic-no-timing-', dir=ROOT.parent) as temporary:
    repository = Path(temporary) / 'repository'
    tools = repository / 'dev/perf/synthetic-study'
    output = Path(temporary) / 'receipts'
    tools.mkdir(parents=True)
    (output / 'observations').mkdir(parents=True)
    for entry in source_inventory['files']:
        shutil.copyfile(ROOT / entry['path'], tools / entry['path'])
    protocol = json.loads((tools / 'protocol.json').read_text())
    if protocol.get('hostedWorkflow'):
        relative = protocol['hostedWorkflow']['path']
        destination = repository / relative
        destination.parent.mkdir(parents=True)
        shutil.copyfile(ROOT.parents[2] / relative, destination)
    protocol['status'] = 'frozen'
    protocol['syntheticSelfTestOnly'] = True
    (tools / 'protocol.json').write_text(json.dumps(protocol, indent=2) + '\n')
    for entry in source_inventory['files']:
        content = (tools / entry['path']).read_bytes()
        entry['bytes'], entry['sha256'] = len(content), sha(content)
    (tools / 'source-inventory.json').write_text(json.dumps(source_inventory, indent=2) + '\n')
    hashes = {
        'protocolSha256': sha((tools / 'protocol.json').read_bytes()),
        'sourceInventorySha256': sha((tools / 'source-inventory.json').read_bytes()),
        'inputInventorySha256': sha((tools / 'input-inventory.json').read_bytes()),
    }
    inventory = json.loads((tools / 'input-inventory.json').read_text())
    acquisition = {**hashes, 'syntheticSelfTestOnly': True, 'complete': True, 'allSucceeded': True,
                   'finalIdentityCheck': 'passed', 'observations': []}
    for planned in protocol['schedule']:
        native = planned['arm'] == 'B'
        calls = []
        for p in [1, 2]:
            for group in inventory['groups']:
                calls.append({'pass': p, 'group': group['group'], 'rowCount': group['rowCount'],
                    'uniqueCount': group['uniqueCount'], 'result': group['expected'], 'expected': group['expected'],
                    'resultEqual': True, 'inputsUnchanged': True, 'elapsedMs': 1 if native else 2,
                    'heapBytes': 655360 if native else 0,
                    'phase': {'calls': 1, 'fallbackCalls': 0, 'copyInputBytes': group['inputCopyBytes'],
                        'growMs': 0, 'copyMs': 0.1, 'kernelMs': 0.8, 'guardAndResultMs': 0.1} if native else None})
        report = {**hashes, 'syntheticSelfTestOnly': True, 'observation': planned, 'status': 'success',
            'module': {key: (protocol['kernel'] if native else protocol['javascript'])[key] for key in ['id', 'sha256']},
            'browser': {'version': protocol['browser']['version'], 'executableSha256': protocol['browser']['executableSha256']},
            'worker': {'crossOriginIsolated': True}, 'calls': calls,
            'nativeInitializationElapsedMs': 3 if native else 0,
            'initialization': {'moduleCompileMs': 2, 'memoryAndInstantiateMs': 1} if native else None,
            'finalNativeMetrics': {'calls': 24, 'fallbackCalls': 0,
                'copyInputBytes': 2 * inventory['inputCopyBytesPerPass'], 'peakHeapBytes': 655360} if native else None}
        (output / 'observations' / (planned['id'] + '.json')).write_text(json.dumps(report) + '\n')
        acquisition['observations'].append({'id': planned['id'], 'status': 'success',
            'processOutcome': {'code': 0, 'signal': None, 'timedOut': False}})
    (output / 'acquisition.json').write_text(json.dumps(acquisition) + '\n')
    command = ['python3', str(tools / 'analyze.py'), str(output)]
    good = subprocess.run(command, text=True, capture_output=True)
    assert good.returncode == 0, good.stderr
    summary = json.loads((output / 'summary.json').read_text())
    assert len(summary['observations']) == 36
    for metric, expected in [('coldFirstPassIncludingInitializationMs', -37.5), ('firstPassSumMs', -50), ('secondPassSumMs', -50)]:
        value = summary['summaries'][metric]
        assert value['BOverA']['pairedMedianPct'] == expected
        assert value['BOverA']['descriptive95PercentIntervalPct'] == [expected, expected]
        assert value['unchangedSecondOverFirst']['pairedMedianPct'] == 0
        assert value['equalWork']['relativeDeltaPct'] == expected
        assert len(value['pairs']) == 12 and len(value['controls']) == 6
    results.append({'case': 'known-paired-arithmetic', 'result': 'pass'})
    last = output / 'observations' / (protocol['schedule'][-1]['id'] + '.json')
    original = last.read_text()
    def invalid(case):
        assert subprocess.run(command, capture_output=True).returncode != 0
        rejected = json.loads((output / 'summary.json').read_text())
        assert rejected['allObservationsValid'] is False
        assert rejected['metrics'] is None and rejected['summaries'] is None
        assert rejected['errors'] and rejected['originalReportsPreserved'] is True
        results.append({'case': case, 'result': 'pass'})
    corrupted = json.loads(original)
    corrupted['calls'][-1]['inputsUnchanged'] = False
    last.write_text(json.dumps(corrupted))
    invalid('late-parity-failure-rejected')
    assert last.read_text() == json.dumps(corrupted)
    for field in ['id', 'sha256']:
        corrupted = json.loads(original)
        corrupted['module'][field] = 'wrong-binding'
        last.write_text(json.dumps(corrupted))
        invalid('wrong-module-' + field + '-rejected')
    last.write_text(original)
    extra = output / 'observations' / 'unexpected-observation.json'
    extra.write_text('{}\n')
    invalid('extra-observation-rejected')
    assert extra.read_text() == '{}\n'
    extra.unlink()
    acquisition['observations'][-1]['processOutcome']['signal'] = 'SIGTERM'
    (output / 'acquisition.json').write_text(json.dumps(acquisition))
    invalid('dirty-process-signal-rejected')
    acquisition['observations'][-1]['processOutcome']['signal'] = None
    (output / 'acquisition.json').write_text(json.dumps(acquisition))
    last.unlink()
    invalid('missing-observation-rejected')
print(json.dumps({'scope': 'Synthetic self-test only; no browser, native compilation or performance measurement',
    'analyzerSha256': sha((ROOT / 'analyze.py').read_bytes()), 'checks': results}, indent=2))
