from pathlib import Path
import csv
import json
import random
import statistics

root = Path(__file__).resolve().parent
rng = random.Random(20261119)

def percentile(values, fraction):
    values = sorted(values)
    at = (len(values) - 1) * fraction
    lo = int(at)
    hi = min(lo + 1, len(values) - 1)
    return values[lo] + (values[hi] - values[lo]) * (at - lo)

def metric(before, after):
    differences = [b - a for a, b in zip(before, after)]
    total = None if sum(before) == 0 else 100 * (sum(after) / sum(before) - 1)
    result = {'baselineMedianMs': statistics.median(before), 'candidateMedianMs': statistics.median(after), 'equalWorkChangePercent': total, 'fasterPairs': sum(b < a for a, b in zip(before, after)), 'pairs': len(before), 'pairedDifferenceMs': differences}
    if all(value > 0 for value in before):
        changes = [100 * (b / a - 1) for a, b in zip(before, after)]
        samples = [statistics.median(rng.choices(changes, k=len(changes))) for _ in range(10000)]
        result.update({'pairedChangesPercent': changes, 'medianPairedChangePercent': statistics.median(changes), 'pairedRangePercent': [min(changes), max(changes)], 'descriptivePairedBootstrap95Percent': [percentile(samples, .025), percentile(samples, .975)]})
    return result

records = []
for path in sorted(root.rglob('*.json')):
    if path.relative_to(root).parts[0] == 'validation':
        continue
    if path.name in ['summary.json', 'evidence-manifest.json']:
        continue
    try:
        report = json.loads(path.read_text())
    except (ValueError, UnicodeError):
        continue
    if not isinstance(report, dict) or not isinstance(report.get('observations'), list):
        continue
    count = report.get('pairs', report.get('plan', {}).get('pairs'))
    complete = report.get('complete') is True or (bool(report.get('completedAt')) and not report.get('failures'))
    record = {'path': path.relative_to(root).as_posix(), 'complete': complete, 'observationCount': len(report['observations']), 'plannedPairs': count, 'error': report.get('error'), 'failures': report.get('failures', []), 'metrics': {}}
    if not complete or not count or len(report['observations']) != count * 2:
        records.append(record)
        continue
    pairs = []
    for pair in range(count):
        a = next(o['result'] for o in report['observations'] if o['pair'] == pair and o['arm'] == 'A')
        b = next(o['result'] for o in report['observations'] if o['pair'] == pair and o['arm'] == 'B')
        pairs.append((a, b))
    sample = pairs[0][0]
    if 'resolver' in sample:
        record['scope'] = sample['scope']
        record['dictionary'] = sample['dictionary']
        record['cacheBudgetBytes'] = sample['recentSourceCacheBudgetBytes']
        record['counters'] = sample['counters']
        for phase in ['resolver', 'exact', 'publication']:
            for measure in ['wallMs', 'cpuMs']:
                record['metrics'][phase + '.' + measure] = metric([a[phase][measure] for a, b in pairs], [b[phase][measure] for a, b in pairs])
    elif 'passes' in sample:
        record['scope'] = report['plan']['scope']
        record['lane'] = report['plan']['lane']
        for measure in ['elapsedMs', 'cpuMs']:
            record['metrics'][measure] = metric([statistics.mean(p[measure] for p in a['passes']) for a, b in pairs], [statistics.mean(p[measure] for p in b['passes']) for a, b in pairs])
    else:
        record['scope'] = sample.get('scope')
        record['dictionary'] = sample['dictionary']
        record['rows'] = sample['rows']
        record['maxWasmHeapBytes'] = {'A': sorted({a['maxWasmHeapBytes'] for a, b in pairs}), 'B': sorted({b['maxWasmHeapBytes'] for a, b in pairs})}
        for measure in ['elapsedMs', 'cpuMs', 'lookupMs']:
            record['metrics'][measure] = metric([a[measure] for a, b in pairs], [b[measure] for a, b in pairs])
    records.append(record)

summary = {'method': 'Each A/B pair is one observation. All measured passes within a child are averaged; no samples are dropped. Bootstrap resamples complete paired ratios with replacement, 10000 replicates, deterministic seed20261119. Intervals are descriptive: shared-host dependence and eight-pair cohorts do not establish production or whole-import qualification.', 'cohorts': records}
(root / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
with (root / 'summary.csv').open('w', newline='') as stream:
    writer = csv.writer(stream)
    writer.writerow(['cohort','complete','metric','pairs','baselineMedianMs','candidateMedianMs','medianPairedChangePercent','equalWorkChangePercent','fasterPairs','bootstrapLowPercent','bootstrapHighPercent'])
    for record in records:
        for name, result in record['metrics'].items():
            interval = result.get('descriptivePairedBootstrap95Percent', [None, None])
            writer.writerow([record['path'],record['complete'],name,result['pairs'],result['baselineMedianMs'],result['candidateMedianMs'],result.get('medianPairedChangePercent'),result['equalWorkChangePercent'],result['fasterPairs'],*interval])
print(json.dumps({'completeCohorts': sum(r['complete'] for r in records), 'incompleteCohorts': sum(not r['complete'] for r in records), 'completeObservations': sum(r['observationCount'] for r in records if r['complete'])}))
