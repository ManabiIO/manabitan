#!/usr/bin/env python3
"""Recalculate phase/control summaries from compact evidence; no measurements."""
import json
import statistics
import sys
from pathlib import Path

METRICS = [
    'browserImportMs', 'archiveAndIndexMs', 'importDataBanksMs',
    'termFileFastPathMs', 'bulkFinalizationMs', 'parserParseBankMs',
    'parserParallelWorkerWallMs', 'parserSourceInflateMs',
    'dedupRecentSourceCacheMs', 'contentMetadataIndexPublishMs',
    'contentMetadataIndexPublishExclusiveMs', 'contentCompressMs',
    'dedupCanonicalScanMs', 'contentAppendMs',
]


def summarize(source, base):
    data = json.loads(source.read_text())
    result = {'source': str(source.relative_to(base)), 'run': data['run']}
    if not data['timingCohort']['complete']:
        return {**result, 'complete': False, 'reason': 'Incomplete cohort; no phase effect estimate.'}
    rows = []
    for observation in data['observations']:
        if observation['kind'] == 'trace':
            continue
        assert observation.get('importRuns'), observation['id']
        phases = {p['phase']: p for p in observation['importRuns'][0]['importerPhaseTimings']}
        fast = next(p for name, p in phases.items() if name.startswith('term-file-fast-path'))
        row = dict(fast['details'])
        row.update({
            'browserImportMs': observation['result']['totalImportMs'],
            'archiveAndIndexMs': phases['archive-and-index']['elapsedMs'],
            'importDataBanksMs': phases['import-data-banks']['elapsedMs'],
            'termFileFastPathMs': fast['elapsedMs'],
            'bulkFinalizationMs': phases['bulk-finalization']['elapsedMs'],
        })
        row['contentMetadataIndexPublishExclusiveMs'] = row['contentMetadataIndexPublishMs'] - row['dedupRecentSourceCacheMs']
        rows.append({
            'id': observation['id'], 'kind': observation['kind'], 'arm': observation['arm'],
            'metrics': {key: row.get(key) for key in METRICS},
        })
    result.update({'complete': True, 'controls': {}, 'pairedPhaseSummary': {}})
    for kind in ['control-pre', 'control-post']:
        control = [r for r in rows if r['kind'] == kind]
        assert len(control) == 2, (source, kind)
        changes = {}
        for key in METRICS:
            a, b = [r['metrics'][key] for r in control]
            changes[key] = (b / a - 1) * 100 if isinstance(a, (int, float)) and a and isinstance(b, (int, float)) else None
        result['controls'][kind] = {'first': control[0], 'second': control[1], 'changePercent': changes}
    pairs = {}
    for row in rows:
        if row['id'].startswith('pair-'):
            pairs.setdefault(row['id'].rsplit('-', 1)[0], {})[row['arm']] = row
    assert all(set(pair) == {'A', 'B'} for pair in pairs.values())
    for key in METRICS:
        values = [(p['A']['metrics'][key], p['B']['metrics'][key]) for p in pairs.values()]
        if not all(isinstance(a, (int, float)) and isinstance(b, (int, float)) for a, b in values):
            continue
        total_a = sum(a for a, b in values)
        result['pairedPhaseSummary'][key] = {
            'pairCount': len(values),
            'medianDifferenceMs': statistics.median(b - a for a, b in values),
            'medianChangePercent': statistics.median((b / a - 1) * 100 for a, b in values if a) if any(a for a, b in values) else None,
            'fasterPairs': sum(b < a for a, b in values),
            'equalWorkChangePercent': (sum(b for a, b in values) / total_a - 1) * 100 if total_a else None,
        }
    return result


def main(base):
    base = Path(base)
    result = {
        'schemaVersion': 1,
        'purpose': 'Ordinary same-code controls for the targeted and critical-path phase metrics; all figures are recalculated from preserved full phase metrics, without traces or new timings. Positive change means slower. Exclusive index publication subtracts cache time within each observation before pairing. Controls are sparse noise diagnostics, not precise confidence bounds.',
        'cohorts': {p.stem: summarize(p, base) for p in sorted((base / 'cohorts').glob('*.json'))},
    }
    output = base / 'cohort-phase-controls.json'
    output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'output': str(output), 'cohorts': len(result['cohorts'])}))


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).parent)
