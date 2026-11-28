#!/usr/bin/env python3
"""Compare every prescribed arm and phase; never discard controls or tails."""
from pathlib import Path
import argparse
import hashlib
import json
import statistics


def profile_totals(observation):
    totals = {}
    for group in observation['groups']:
        for name, value in group['profile'].items():
            if name.endswith('Ms') and isinstance(value, (int, float)):
                totals[name] = totals.get(name, 0) + value
    return totals


def compare(rows, numerator, denominator, field):
    blocks = sorted({row['block'] for row in rows})
    left = [next(row for row in rows if row['block'] == block and row['arm'] == numerator)[field] for block in blocks]
    right = [next(row for row in rows if row['block'] == block and row['arm'] == denominator)[field] for block in blocks]
    ratios = [a / b if b > 0 else None for a, b in zip(left, right)]
    present = [value for value in ratios if value is not None]
    return {
        'pairedRatios': ratios,
        'comparableBlocks': len(present),
        'medianPairedChangePercent': (statistics.median(present) - 1) * 100 if present else None,
        'equalWorkTotalChangePercent': (sum(left) / sum(right) - 1) * 100 if sum(right) > 0 else None,
        'numeratorFasterBlocks': sum(value < 1 for value in present),
    }


def summarize_report(report):
    observations = report['observations']
    orders = report['plan']['orders']
    assert len(orders) == 6 and set(orders) == {'ABC', 'BCA', 'CAB', 'CBA', 'ACB', 'BAC'}
    expected = [(block, arm) for block, order in enumerate(orders) for arm in order]
    assert [(item['block'], item['arm']) for item in observations] == expected
    assert all(item['order'] == orders[item['block']] for item in observations)
    assert all('measurement' in item and item['returnCode'] == 0 for item in observations)
    assert len({item['verificationDigest'] for item in observations}) == 1
    phase_names = sorted({name for item in observations for name in item['measurement']['phaseMs']})
    rows = []
    for item in observations:
        measurement = item['measurement']
        row = {name: measurement[name] for name in ['workerMs', 'cpuMs', 'threadCpuMs']}
        row.update({'block': item['block'], 'arm': item['arm']})
        row.update({f'phase.{name}': measurement['phaseMs'].get(name, 0) for name in phase_names})
        row['workerWallOutsideSourceCrcMs'] = measurement['workerMs'] - measurement['phaseMs'].get('sourceCrcMs', 0)
        rows.append(row)
    fields = ['workerMs', 'cpuMs', 'threadCpuMs', 'workerWallOutsideSourceCrcMs', *[f'phase.{name}' for name in phase_names]]
    return {
        'phaseCaveat': 'Every phase is an internal wall-clock sum, may overlap another phase and is not thread CPU. Do not sum phases. Worker wall outside source CRC is an attribution diagnostic; scheduling, GC and effects across groups can move it. All phases and controls are reported, including zero-work phases.',
        'comparisons': {field: {
            'B_over_A': compare(rows, 'B', 'A', field),
            'B_over_C': compare(rows, 'B', 'C', field),
            'C_over_A_identicalControl': compare(rows, 'C', 'A', field),
        } for field in fields},
        'armMedians': {arm: {field: statistics.median(row[field] for row in rows if row['arm'] == arm) for field in fields} for arm in 'ABC'},
        'perBlock': rows,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--result', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    raw = args.result.read_bytes()
    report = json.loads(raw)
    assert report['complete'], 'Do not summarize a partial acquisition as a completed cohort'
    for item in report['observations']:
        recorded_path = Path(item['rawReport']['path'])
        relocated = args.result.parent / recorded_path.name
        source = relocated if relocated.exists() else recorded_path
        child_raw = source.read_bytes()
        assert hashlib.sha256(child_raw).hexdigest() == item['rawReport']['sha256']
        assert len(child_raw) == item['rawReport']['bytes']
        child = json.loads(child_raw)
        assert child['complete'] and len(child['observations']) == 4
        assert [observation['pass'] for observation in child['observations']] == [0, 1, 2, 3]
        assert [observation['warmup'] for observation in child['observations']] == [True, True, False, False]
        assert [observation['timed'] for observation in child['observations']] == [False, False, True, False]
        assert [observation['verification'] for observation in child['observations']] == [False, False, False, True]
        measured = [observation for observation in child['observations'] if observation['timed']]
        assert len(measured) == 1
        assert child['observations'][3]['digest'] == item['verificationDigest'] == report['digest']
        plan = report['plan']
        assert child['observations'][3]['digest'] == plan.get('expectedDigest', report['digest'])
        expected_module = plan['candidateWasmSha256'] if item['arm'] == 'B' else plan['baselineWasmSha256']
        assert child['injectedWasmSha256'] == expected_module
        assert child['fixture']['sha256'] == plan['fixtureSha256']
        assert child['runnerSha256'] == plan['serverSha256']
        assert child['identity'] == report['sourceIdentity']
        assert child['grouping'] == report['grouping']
        assert child['node'] == item['node'] and child['v8'] == item['v8']
        for name, value in item['measurement'].items():
            if name not in {'phaseMs', 'sourceCrcMs'}:
                assert value == measured[0][name], f'Copied measurement differs: {name}'
        phases = profile_totals(measured[0])
        if 'phaseMs' in item['measurement']:
            assert item['measurement']['phaseMs'] == phases
        assert item['measurement']['sourceCrcMs'] == phases.get('sourceCrcMs', 0)
        item['measurement']['phaseMs'] = phases
    summary = summarize_report(report)
    summary['resultSha256'] = hashlib.sha256(raw).hexdigest()
    summary['scope'] = 'Read-only aggregation of every prescribed completed observation. Does not mutate or replace acquisition records.'
    args.out.write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps({'output': str(args.out), 'resultSha256': summary['resultSha256']}))


if __name__ == '__main__':
    main()
