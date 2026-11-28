"""Validate every acquisition receipt and report all prospective component metrics."""
import hashlib
import json
import math
from pathlib import Path
import random
import statistics
import sys
import traceback

ROOT = Path(__file__).resolve().parent
OUT = Path(sys.argv[1]).resolve()
sha = lambda b: hashlib.sha256(b).hexdigest()
stage = 'source-bindings'

def analyze():
    global stage
    protocol_bytes = (ROOT / 'protocol.json').read_bytes()
    protocol = json.loads(protocol_bytes)
    assert protocol['status'] == 'frozen'
    inventory_bytes = (ROOT / protocol['inputInventoryFile']).read_bytes()
    inventory = json.loads(inventory_bytes)
    assert sha(inventory_bytes) == protocol['inputInventorySha256']
    sources_bytes = (ROOT / 'source-inventory.json').read_bytes()
    sources = json.loads(sources_bytes)
    for entry in sources['files']:
        contents = (ROOT / entry['path']).read_bytes()
        assert len(contents) == entry['bytes'] and sha(contents) == entry['sha256'], entry['path']
    if protocol.get('hostedWorkflow'):
        workflow = ROOT.parents[2] / protocol['hostedWorkflow']['path']
        assert sha(workflow.read_bytes()) == protocol['hostedWorkflow']['sha256'], 'Hosted workflow binding changed'
    acquisition = json.loads((OUT / 'acquisition.json').read_text())
    assert acquisition['protocolSha256'] == sha(protocol_bytes)
    assert acquisition['sourceInventorySha256'] == sha(sources_bytes)
    assert acquisition['inputInventorySha256'] == sha(inventory_bytes)
    assert acquisition['complete'] and acquisition['allSucceeded']
    assert acquisition['finalIdentityCheck'] == 'passed'
    assert len(acquisition['observations']) == len(protocol['schedule']) == 36
    expected_files = {entry['id'] + '.json' for entry in protocol['schedule']}
    actual_files = {entry.name for entry in (OUT / 'observations').iterdir()}
    assert actual_files == expected_files, 'Observation file set differs from fixed schedule'

    observations = []
    for planned, recorded in zip(protocol['schedule'], acquisition['observations']):
        assert recorded['id'] == planned['id'] and recorded['status'] == 'success'
        stage = 'observation-' + planned['id']
        assert recorded['processOutcome']['code'] == 0 and not recorded['processOutcome']['timedOut']
        assert recorded['processOutcome']['signal'] is None, 'Observation process exited with a signal'
        assert 'error' not in recorded['processOutcome']
        report = json.loads((OUT / 'observations' / (planned['id'] + '.json')).read_text())
        assert report['observation'] == planned and report['status'] == 'success'
        binding = protocol['javascript'] if planned['arm'] == 'A' else protocol['kernel']
        assert report['module'] == {'id': binding['id'], 'sha256': binding['sha256']}, 'Scheduled module binding mismatch'
        assert report['protocolSha256'] == sha(protocol_bytes)
        assert report['sourceInventorySha256'] == sha(sources_bytes)
        assert report['inputInventorySha256'] == sha(inventory_bytes)
        assert report['browser']['version'] == protocol['browser']['version']
        assert report['browser']['executableSha256'] == protocol['browser']['executableSha256']
        assert report['worker']['crossOriginIsolated'] is True
        assert len(report['calls']) == 24
        for i, call in enumerate(report['calls']):
            group = inventory['groups'][i % 12]
            assert (call['pass'], call['group']) == (i // 12 + 1, i % 12 + 1)
            assert call['rowCount'] == group['rowCount'] and call['uniqueCount'] == group['uniqueCount']
            assert call['result'] == group['expected'] == call['expected']
            assert call['resultEqual'] and call['inputsUnchanged'] and 'error' not in call
            assert math.isfinite(call['elapsedMs']) and call['elapsedMs'] > 0
            if planned['arm'] == 'B':
                phase = call['phase']
                assert phase['calls'] == 1 and phase['fallbackCalls'] == 0
                assert phase['copyInputBytes'] == group['inputCopyBytes']
                assert all(math.isfinite(phase[k]) and phase[k] >= 0 for k in ['growMs', 'copyMs', 'kernelMs', 'guardAndResultMs'])
            else:
                assert call['phase'] is None and call['heapBytes'] == 0
        init = report['nativeInitializationElapsedMs']
        assert math.isfinite(init) and init >= 0
        if planned['arm'] == 'A':
            assert init == 0 and report['initialization'] is None and report['finalNativeMetrics'] is None
        else:
            native = report['finalNativeMetrics']
            assert native['calls'] == 24 and native['fallbackCalls'] == 0
            assert native['copyInputBytes'] == 2 * inventory['inputCopyBytesPerPass']
            assert native['peakHeapBytes'] == protocol['checks']['expectedNativePeakHeapBytes']
        first = sum(c['elapsedMs'] for c in report['calls'][:12])
        second = sum(c['elapsedMs'] for c in report['calls'][12:])
        metrics = {
            'coldFirstPassIncludingInitializationMs': first + init,
            'firstPassSumMs': first,
            'firstCallMs': report['calls'][0]['elapsedMs'],
            'remainingFirstPassMs': first - report['calls'][0]['elapsedMs'],
            'secondPassSumMs': second,
            'secondPassFirstCallMs': report['calls'][12]['elapsedMs'],
        }
        phase_totals = None
        if planned['arm'] == 'B':
            phase_totals = {str(p): {
                key: sum(call['phase'][key] for call in report['calls'] if call['pass'] == p)
                for key in ['calls', 'fallbackCalls', 'copyInputBytes', 'growMs', 'copyMs', 'kernelMs', 'guardAndResultMs']
            } for p in [1, 2]}
        observations.append({'planned': planned, 'metrics': metrics, 'initializationMs': init,
            'initializationBreakdown': report['initialization'], 'nativePhaseTotalsByPass': phase_totals,
            'nativePhaseTotals': report['finalNativeMetrics'], 'reportSha256': sha((OUT / 'observations' / (planned['id'] + '.json')).read_bytes())})

    rng = random.Random(protocol['analysis']['bootstrapSeed'])
    def summarize(values):
        draws = sorted(statistics.median(rng.choices(values, k=len(values)))
                       for _ in range(protocol['analysis']['bootstrapReplicates']))
        def percentile(p):
            x = (len(draws) - 1) * p
            lo, hi = math.floor(x), math.ceil(x)
            return draws[lo] + (draws[hi] - draws[lo]) * (x - lo)
        return {'pairedChangesPct': values, 'pairedMedianPct': statistics.median(values),
            'descriptive95PercentIntervalPct': [percentile(0.025), percentile(0.975)],
            'pairsFaster': sum(x < 0 for x in values), 'pairs': len(values)}
    summaries = {}
    for metric in protocol['analysis']['metrics']:
        comparisons = []
        controls = []
        pair_details = []
        control_details = []
        for pair in range(1, 13):
            rows = [o for o in observations if o['planned']['kind'] == 'comparison' and o['planned']['pair'] == pair]
            assert len(rows) == 2
            a = next(o for o in rows if o['planned']['arm'] == 'A')['metrics'][metric]
            b = next(o for o in rows if o['planned']['arm'] == 'B')['metrics'][metric]
            comparisons.append(100 * (b / a - 1))
            pair_details.append({'pair': pair, 'order': ''.join(o['planned']['arm'] for o in sorted(rows, key=lambda o: o['planned']['position'])),
                'baselineMs': a, 'candidateMs': b, 'absoluteDeltaMs': b - a, 'relativeDeltaPct': comparisons[-1]})
        for pair in range(1, 7):
            rows = sorted((o for o in observations if o['planned']['kind'] == 'control' and o['planned']['pair'] == pair), key=lambda o: o['planned']['position'])
            assert len(rows) == 2 and all(o['planned']['arm'] == 'A' for o in rows)
            a, b = rows[0]['metrics'][metric], rows[1]['metrics'][metric]
            controls.append(100 * (b / a - 1))
            control_details.append({'pair': pair, 'firstMs': a, 'secondMs': b, 'absoluteDeltaMs': b - a, 'relativeDeltaPct': controls[-1]})
        baseline_total = sum(p['baselineMs'] for p in pair_details)
        candidate_total = sum(p['candidateMs'] for p in pair_details)
        summaries[metric] = {'BOverA': summarize(comparisons), 'unchangedSecondOverFirst': summarize(controls),
            'pairs': pair_details, 'controls': control_details,
            'equalWork': {'baselineTotalMs': baseline_total, 'candidateTotalMs': candidate_total,
                'absoluteDeltaMs': candidate_total - baseline_total,
                'relativeDeltaPct': 100 * (candidate_total / baseline_total - 1)}}
    return {'scope': protocol['scope'], 'limitations': protocol['measurement'], 'protocolSha256': sha(protocol_bytes),
        'allObservationsValid': True, 'errors': [], 'summaries': summaries, 'observations': observations}

try:
    output = analyze()
except Exception as error:
    output = {
        'scope': 'Invalid prospective component acquisition; no metrics are interpretable',
        'allObservationsValid': False,
        'metrics': None,
        'summaries': None,
        'errors': [{'stage': stage, 'type': type(error).__name__, 'message': str(error), 'traceback': traceback.format_exc()}],
        'originalReportsPreserved': True,
        'observedFiles': sorted(p.name for p in (OUT / 'observations').iterdir()) if (OUT / 'observations').is_dir() else [],
    }
OUT.mkdir(parents=True, exist_ok=True)
(OUT / 'summary.json').write_text(json.dumps(output, indent=2) + '\n')
print(json.dumps({'allObservationsValid': output['allObservationsValid'], 'summary': str(OUT / 'summary.json')}))
if not output['allObservationsValid']:
    sys.exit(1)
