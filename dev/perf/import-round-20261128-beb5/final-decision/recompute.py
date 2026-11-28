#!/usr/bin/env python3
"""Recompute summaries from completed frozen audits; never runs an import."""

import argparse
import hashlib
import json
import math
from pathlib import Path
import statistics
import zipfile

ROOT = Path('/tmp/manabitan-beb5/current-browser-artifacts')
OUT = Path(__file__).resolve().parent
BASELINE = 'dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16'
SPECS = {
    'crc': {
        'runtime': '19db774b564064a7e339d3c3a79ea8da04ab48b5',
        'tree': '6f6c0ba610392f6ae6aa6df5c826e3d677f6f1af',
        'study': '477fb271ef25fac533fb1faf737a5dab898190e3',
        'run': 46127721419,
        'phase': 'parserSourceInflateMs',
        'startOrder': 'AB',
        'packageChanges': ['js/dictionary/wasm/term-bank-parser.c', 'lib/term-bank-parser.wasm'],
    },
    'canonical': {
        'runtime': 'dcbbab6d1bfcebede50969f6d4b23e4f09561aa3',
        'tree': 'fc90894e914a29de988753bbe4b062bb2f617f93',
        'study': '07307bed49e6fd80ec28c37e0313a6bff402b66f',
        'run': 46128439514,
        'phase': 'termRecordWriteMs',
        'startOrder': 'BA',
        'packageChanges': [
            'js/dictionary/dictionary-database.js',
            'js/dictionary/term-content-canonical-layout.js',
            'js/dictionary/term-content-canonical-scan.js',
            'js/dictionary/term-record-opfs-store.js',
            'js/dictionary/wasm/term-content-canonical-scan-v1.c',
            'lib/term-content-canonical-scan-v1.wasm',
        ],
    },
}


def same_number(actual, expected):
    assert math.isclose(actual, expected, rel_tol=1e-12, abs_tol=1e-10), (actual, expected)


def summarize(observations, kind, metric):
    second_arm = 'B' if kind == 'candidate' else 'C'
    count = 12 if kind == 'candidate' else 4
    selected = [x for x in observations if x['kind'] == kind]
    assert len(selected) == count * 2
    pairs = []
    for pair in range(1, count + 1):
        items = [x for x in selected if x['pair'] == pair]
        assert len(items) == 2
        by_arm = {x['arm']: x for x in items}
        assert set(by_arm) == {'A', second_arm}
        def value(item):
            result = item['totalImportMs'] if metric == 'totalImportMs' else item['phases'][metric]
            assert isinstance(result, (float, int)) and math.isfinite(result) and result > 0
            return result
        a, b = value(by_arm['A']), value(by_arm[second_arm])
        pairs.append({
            'pair': pair,
            'baselineId': by_arm['A']['id'],
            'secondId': by_arm[second_arm]['id'],
            'baselineMs': a,
            'secondMs': b,
            'ratio': b / a,
            'changePercent': (b / a - 1) * 100,
            'differenceMs': b - a,
        })
    ratios = [x['ratio'] for x in pairs]
    differences = [x['differenceMs'] for x in pairs]
    return {
        'metric': metric,
        'pairs': pairs,
        'count': count,
        'medianPairedChangePercent': (statistics.median(ratios) - 1) * 100,
        'equalWorkChangePercent': (sum(x['secondMs'] for x in pairs) / sum(x['baselineMs'] for x in pairs) - 1) * 100,
        'fasterPairs': sum(x < 1 for x in ratios),
        'medianPairedDifferenceMs': statistics.median(differences),
        'meanPairedDifferenceMs': statistics.mean(differences),
        'sumPairedDifferenceMs': sum(differences),
        'minimumPairedDifferenceMs': min(differences),
        'maximumPairedDifferenceMs': max(differences),
    }


def verify_summary(calculated, reported):
    for key in ['count', 'fasterPairs']:
        assert calculated[key] == reported[key]
    for key in ['medianPairedChangePercent', 'equalWorkChangePercent']:
        same_number(calculated[key], reported[key])
    for pair, expected in zip(calculated['pairs'], reported['ratios'], strict=True):
        same_number(pair['ratio'], expected)
    calculated['descriptiveBootstrap95PercentFromFrozenAuditor'] = reported['descriptiveBootstrap95Percent']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input-root', type=Path, default=ROOT)
    parser.add_argument('--out', type=Path, default=OUT / 'recomputed-inputs.json')
    args = parser.parse_args()
    def input_path(name, dictionary):
        flat = args.input_root / f'{name}-{dictionary}' / 'local-independent-audit.json'
        return flat if flat.is_file() else args.input_root / name / dictionary / 'local-independent-audit.json'
    # Require every final corpus. Missing or partial input never yields a decision report.
    inputs = [(name, dictionary, input_path(name, dictionary))
              for name in SPECS for dictionary in ['jmdict', 'jitendex', 'vndb']]
    for _, _, path in inputs:
        assert path.is_file(), f'Final raw audit not available: {path}'
    report = {
        'schemaVersion': 1,
        'complete': False,
        'baseline': BASELINE,
        'scope': 'Independent arithmetic and decision inputs from six completed raw-artifact audits; no timing execution or new corpus qualification.',
        'method': {
            'median': '100 * (median(second/baseline per pair) - 1)',
            'equalWork': '100 * (sum(second elapsed time) / sum(baseline elapsed time) - 1)',
            'absolute': 'Per-pair second elapsed time minus baseline elapsed time; all pairs retained.',
            'interval': 'Copied from the frozen independently rerun source auditor, not newly bootstrapped here.',
            'controls': 'Same-code A/C pairs are separately recomputed, never subtracted.',
            'scope': 'Ordinary complete import and nested or overlapping owning-phase counters remain separate.',
        },
        'candidates': {},
    }
    for name, dictionary, path in inputs:
        spec = SPECS[name]
        raw = path.read_bytes()
        d = json.loads(raw)
        original_audit_path = path.parent / 'independent-audit.json'
        if original_audit_path.is_file():
            original_audit = json.loads(original_audit_path.read_bytes())
        else:
            retained_names = ['original-members-without-packages.zip', 'original-without-packages.zip']
            retained = [path.parent / name for name in retained_names if (path.parent / name).is_file()]
            assert len(retained) == 1, f'Expected one retained original-member archive beside {path}'
            with zipfile.ZipFile(retained[0]) as archive:
                original_audit = json.loads(archive.read('independent-audit.json'))
        assert d == original_audit
        assert d['complete'] is True and d['dictionary'] == dictionary
        assert d['baseline'] == BASELINE
        assert d['candidateSourceCommit'] == spec['runtime']
        assert d['candidateRuntimeTree'] == spec['tree']
        assert d['validatedObservationCount'] == 42 and len(d['validatedObservations']) == 42
        assert d['actualWorkersAllObservations'] == 3
        assert d['changedEntries'] == spec['packageChanges'] and d['addedEntries'] == []
        assert d['memoryAudit']['observations'] == 4
        ordinary = d['ordinaryObservations']
        assert len(ordinary) == 36
        assert len({x['id'] for x in ordinary}) == 36
        assert sum(x['kind'] == 'warmup' for x in ordinary) == 4
        assert set(x['kind'] for x in ordinary) == {'candidate', 'control', 'warmup'}
        whole = {kind: summarize(ordinary, kind, 'totalImportMs') for kind in ['candidate', 'control']}
        phase = {kind: summarize(ordinary, kind, spec['phase']) for kind in ['candidate', 'control']}
        for kind in whole:
            verify_summary(whole[kind], d[kind])
            verify_summary(phase[kind], d['phaseComparisons'][spec['phase']][kind])
        entry = {
            'inputAudit': {
                'path': str(path),
                'repositoryRelativePath': f'../current-browser/{name}/{dictionary}/local-independent-audit.json',
                'sha256': hashlib.sha256(raw).hexdigest(),
                'bytes': len(raw),
            },
            'independentAuditDeepEqualsOriginalCI': True,
            'validatedObservations': 42,
            'wholeImport': whole,
            'owningPhaseDiagnostic': phase,
            'phaseScope': d['phaseScope'],
            'memory': {
                'passed': d['memoryPassed'],
                'audit': d['memoryAudit'],
                'pairs': d['memoryPairs'],
                'receiptFailures': d['memoryReceiptFailures'],
            },
            'packagedChangedEntries': d['changedEntries'],
            'packagedAddedEntries': d['addedEntries'],
            'storageBytes': d['storage']['bytes'],
            'exhaustiveMedia': d['exhaustiveMedia'],
        }
        target = report['candidates'].setdefault(name, {**spec, 'corpora': {}})
        target['corpora'][dictionary] = entry
    report['complete'] = True
    report['recomputeSourceSha256'] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    destination = args.out
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'complete': True, 'path': str(destination), 'sha256': hashlib.sha256(destination.read_bytes()).hexdigest(), 'corpora': len(inputs)}))


if __name__ == '__main__':
    main()
