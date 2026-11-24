#!/usr/bin/env python3
"""Summarize retained untraced phase aggregates; these are not additive wall time."""
import argparse
import json
from pathlib import Path
import statistics

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('root', type=Path)
parser.add_argument('output', type=Path)
args = parser.parse_args()
keys = [
    'contentPackMs', 'contentCompressMs', 'contentMetadataMs',
    'termRecordBuildMs', 'termRecordEncodeMs', 'termRecordWriteMs',
    'termLookupIndexEncodeMs', 'parserLookupIndexEncodeMs',
    'parserResultCopyMs', 'parserOrderedSinkWaitMs', 'importerChunkSinkMs',
    'dedupMs', 'dedupHashMs',
]
result = {
    'note': 'Diagnostic aggregates overlap and may sum work across concurrent workers. '
            'Do not add them as a wall-time budget or infer a timing win from one component. '
            'termLookupIndexEncodeMs includes prepared parserLookupIndexEncodeMs. '
            'All six timed runs are retained per arm; warmups and exhaustive diagnostics excluded.',
    'dictionaries': {},
}
for corpus in ['jmdict', 'jitendex', 'vndb']:
    reports = sorted(args.root.glob('**/' + corpus + '/block-*-*/summary.json'))
    if not reports:
        continue
    groups = {arm: [] for arm in 'ABC'}
    for path in reports:
        arm = path.parent.name[-1]
        run = json.loads(path.read_text())['runs'][0]
        phases = run['importDebug']['importerPhaseTimings']
        details = [phase.get('details', {}) for phase in phases
                   if phase['phase'].startswith('term-file-fast-path:')]
        values = {
            key: sum(row.get(key, 0) for row in details)
            if any(key in row for row in details) else None
            for key in keys
        }
        values['totalImportMs'] = run['totalImportMs']
        values['bulkFinalizationMs'] = sum(phase['elapsedMs'] for phase in phases
                                           if phase['phase'] == 'bulk-finalization')
        groups[arm].append(values)
    assert all(len(values) == 6 for values in groups.values()), corpus
    result['dictionaries'][corpus] = {
        arm: {
            key: statistics.median(row[key] for row in values)
            if all(row[key] is not None for row in values) else None
            for key in values[0]
        }
        for arm, values in groups.items()
    }
args.output.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
