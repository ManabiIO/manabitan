"""Independently bind downloaded complete-import receipts and recompute ratios."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import random
import statistics
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'dev/perf/import-memory-20261125-a7f7'))
from qualification_receipts import validate_import_summary, require_matching_receipts
from audit_memory import audit_cell

BASELINE = '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2'
CANDIDATE = '570ccc3968046269cb00d2053e49d3c32367031a'
CHANGED = {'lib/term-content-canonical-scan-v1.wasm', 'js/dictionary/term-record-opfs-store.js', 'js/dictionary/wasm/term-content-canonical-scan-v1.c', 'js/dictionary/dictionary-database.js', 'js/dictionary/term-content-canonical-scan.js', 'js/dictionary/term-content-canonical-layout.js'}
ADDED = set()
CANDIDATE_BLOBS = {'js/dictionary/dictionary-database.js': '722f0a0056aec03fa2eec9f8cedc4843afcfc3ea', 'js/dictionary/term-content-canonical-layout.js': 'f3e1299fa99117950dd72fad5e5d1fd8784e3fdb', 'js/dictionary/term-content-canonical-scan.js': '743eb745d0de53b37c1feb6025acb183b436f20c', 'js/dictionary/term-record-opfs-store.js': '205311563fc991a76388d600b817e6b883a91ceb', 'js/dictionary/wasm/term-content-canonical-scan-v1.c': '49789ee1ce89102e4ca9ef143cc5131b8b37dd32', 'lib/term-content-canonical-scan-v1.wasm': '44ec5ff2b33c23b8bf31460c9933e9e66f63f273'}



def read(path):
    return json.loads(path.read_text())


def sha(data):
    return hashlib.sha256(data).hexdigest()


def git_blob(data):
    return hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()


def same(a, b, label):
    assert json.dumps(a, sort_keys=True, allow_nan=False) == json.dumps(b, sort_keys=True, allow_nan=False), label


def close(a, b, label):
    assert math.isclose(a, b, abs_tol=1e-8, rel_tol=1e-12), f'{label}: {a} != {b}'


def expected_schedule():
    rows = []
    for pair, arms in enumerate(['AB', 'BA'], 1):
        for arm in arms:
            rows.append({'id': f'warmup-{pair}-{arm}', 'kind': 'warmup', 'pair': pair, 'arm': arm})
    for pair in range(1, 13):
        for arm in 'AB' if pair % 2 else 'BA':
            rows.append({'id': f'pair-{pair:02d}-{arm}', 'kind': 'candidate', 'pair': pair, 'arm': arm})
        if pair % 3 == 0:
            control = pair // 3
            for arm in 'AC' if control % 2 else 'CA':
                rows.append({'id': f'control-{control:02d}-{arm}', 'kind': 'control', 'pair': control, 'arm': arm})
    return rows


def paired(rows, kind, field='totalImportMs'):
    pairs = {}
    other = 'B' if kind == 'candidate' else 'C'
    for row in rows:
        if row['kind'] == kind:
            pairs.setdefault(row['pair'], {})[row['arm']] = row[field]
    assert all(set(pair) == {'A', other} for pair in pairs.values()), 'Incomplete observed pair'
    ordered = [pairs[key] for key in sorted(pairs)]
    ratios = [pair[other] / pair['A'] for pair in ordered]
    rng = random.Random(897)
    bootstrap = sorted(statistics.median(rng.choices(ratios, k=len(ratios))) for _ in range(10000))
    return {
        'count': len(ordered), 'ratios': ratios,
        'medianPairedChangePercent': (statistics.median(ratios) - 1) * 100,
        'equalWorkChangePercent': (sum(pair[other] for pair in ordered) / sum(pair['A'] for pair in ordered) - 1) * 100,
        'worstPairChangePercent': (max(ratios) - 1) * 100,
        'descriptiveBootstrap95Percent': [(bootstrap[i] - 1) * 100 for i in [249, 9749]],
        'fasterPairs': sum(ratio < 1 for ratio in ratios),
    }


def phase_metrics(run):
    result = {}
    for phase in run['importDebug']['importerPhaseTimings']:
        for key, value in phase.get('details', {}).items():
            if key.endswith('Ms') and isinstance(value, (int, float)):
                result[key] = result.get(key, 0) + value
    for key, value in run['step4Breakdown']['dictionaries'][0].items():
        if key.endswith('Ms'):
            result['step4.' + key] = value
    return result


def audit(location):
    identity = read(location / 'source-identities.json')
    plan = read(location / 'registered-plan.json')
    browser = read(location / 'browser-identity.json')
    dictionary = plan['dictionary']
    fixture = read(ROOT / 'test/perf/dictionaries.lock.json')['dictionaries'][dictionary]
    assert plan['baseline'] == BASELINE and plan['candidate'] == CANDIDATE
    assert plan['initialOrder'] == 'AB' and plan['pairs'] == 12 and plan['flags'] == {}
    assert plan['expectedWorkers'] == 3
    same(plan['schedule'], expected_schedule(), 'Prospective ordinary schedule differs')
    assert set(plan['expectedPackageEntries']) == CHANGED
    assert set(plan.get('expectedAddedPackageEntries', [])) == ADDED
    assert browser['version'] == '153.0.8010.12'
    assert len(browser['sha256']) == 64
    sah = (37, 37) if dictionary == 'vndb' else None
    if sah:
        assert plan['vndbSahAllocationPolicy']['rangeUnits'] == list(sah)
        assert plan['vndbSahAllocationPolicy']['origin'] == 'explicit'

    entries = {}
    packages = {}
    for arm, expected_source in [('A', BASELINE), ('B', CANDIDATE)]:
        source = identity['arms'][arm]
        assert source['sha'] == expected_source
        data = (location / f'package-{arm}.zip').read_bytes()
        assert sha(data) == source['packageSha256'], f'{arm} package digest'
        with zipfile.ZipFile(location / f'package-{arm}.zip') as package:
            names = [item.filename for item in package.infolist()]
            assert len(names) == len(set(names)), 'Duplicate archive member'
            entry_hashes = {item.filename: sha(package.read(item)) for item in package.infolist() if not item.is_dir()}
            if arm == 'B':
                for name, expected in CANDIDATE_BLOBS.items():
                    assert git_blob(package.read(name)) == expected, f'Frozen remote source blob: {name}'
        same(entry_hashes, source['entries'], f'{arm} per-member package receipt')
        assert source['lockSha256'] == sha((ROOT / 'package-lock.json').read_bytes())
        assert source['fixtureLockSha256'] == sha((ROOT / 'test/perf/dictionaries.lock.json').read_bytes())
        entries[arm] = entry_hashes
        packages[arm] = {'sha256': sha(data), 'bytes': len(data), 'members': len(entry_hashes)}
    assert set(entries['A']) <= set(entries['B'])
    assert set(entries['B']) - set(entries['A']) == ADDED
    actual_changed = {name for name in entries['A'] if entries['A'][name] != entries['B'][name]}
    assert actual_changed == CHANGED
    assert set(identity['changedPackageEntries']) == CHANGED
    assert set(identity.get('addedPackageEntries', [])) == ADDED and identity.get('removedPackageEntries', []) == []

    validated = []
    reference = None
    ordinary = []
    snapshots = {}

    def receipt(directory, arm, media='sample', overlay=None):
        source = identity['arms'][arm]
        summary = read(directory / 'summary.json')
        report = read(directory / 'run-1.json')
        hashes = source['sourceHashes'].copy()
        if overlay is not None:
            hashes['test/chromium/extension-two-dictionary-import.e2e.js'] = sha(overlay)
        checked = validate_import_summary(
            summary, report, dictionary=dictionary, fixture=fixture, source_sha=source['sha'],
            package_sha256=source['packageSha256'], browser_version=browser['version'],
            import_flags=None, source_hashes=hashes, source_dirty=overlay is not None,
            media_check=media, vndb_sah_allocation_units=sah,
        )
        same(checked, read(directory / 'canonical-receipt.json'), f'{directory.name}: canonical receipt')
        run = summary['runs'][0]
        assert run['step4Breakdown']['dictionaries'][0]['parserWorkerCount'] == 3
        validated.append(directory.relative_to(location).as_posix())
        return run, checked

    recorded = read(location / 'observations.json')
    same([{key: row[key] for key in ['id', 'kind', 'pair', 'arm']} for row in recorded], expected_schedule(), 'Observed complete schedule')
    for item in recorded:
        run, checked = receipt(location / item['id'], 'B' if item['arm'] == 'B' else 'A')
        close(run['totalImportMs'], item['totalImportMs'], 'Recorded vs raw full duration')
        if reference is None:
            reference = checked
        require_matching_receipts(reference, checked)
        ordinary.append({**item, 'phases': phase_metrics(run)})
        snapshots[item['id']] = run
    media_reference = None
    for arm in ['A', 'B']:
        _, checked = receipt(location / f'exhaustive-media-{arm}', arm, media='all')
        require_matching_receipts(reference, checked, compare_media=False)
        if media_reference is None:
            media_reference = checked
        require_matching_receipts(media_reference, checked)

    memory_root = location / 'memory'
    memory_plan = read(memory_root / 'plan.json')
    assert [row['name'] for row in memory_plan['schedule']] == ['A1', 'B1', 'B2', 'A2']
    assert memory_plan['authoritativeTiming'] is False
    overlay = (memory_root / 'harness-instrumented.js').read_bytes()
    assert sha(overlay) == memory_plan['overlaySha256']
    memory_receipt_failures = []
    for item in memory_plan['schedule']:
        try:
            _, checked = receipt(memory_root / item['name'], item['arm'], overlay=overlay)
            require_matching_receipts(reference, checked)
        except Exception as error:
            memory_receipt_failures.append({'name': item['name'], 'error': str(error), 'type': type(error).__name__})
    memory_recomputed = audit_cell(memory_root)
    memory_recorded = read(memory_root / 'memory-comparison.json')
    expected_memory_pass = memory_recomputed['passesProspectiveMemoryScreen'] and not memory_receipt_failures

    analysis = read(location / 'analysis.json')
    timing = paired(ordinary, 'candidate')
    control = paired(ordinary, 'control')
    same(timing, analysis['candidateVsBaseline'], 'Full-duration candidate arithmetic')
    same(control, analysis['identicalCodeControl'], 'Full-duration control arithmetic')
    assert analysis['memoryPassed'] == expected_memory_pass
    phase_comparisons = {}
    wanted = ['termRecordFieldEncodeMs', 'termRecordValidationMs', 'termRecordEncodeMs', 'termRecordWriteMs',
              'termRecordEndImportSessionMs', 'termRecordEndImportSessionCloseWritableMs',
              'step4.termParseMs', 'step4.bulkAddTermsMs']
    for metric in wanted:
        if all(type(row['phases'].get(metric)) in (int, float) and row['phases'][metric] > 0 for row in ordinary if row['kind'] != 'warmup'):
            rows = [{**row, 'phase': row['phases'][metric]} for row in ordinary]
            phase_comparisons[metric] = {'candidate': paired(rows, 'candidate', 'phase'), 'control': paired(rows, 'control', 'phase')}
    return {
        'complete': True, 'dictionary': dictionary, 'baseline': BASELINE, 'candidate': CANDIDATE,
        'attribution': 'Root-owned canonical sidecar checksum full-import study; no host or prior-candidate pooling',
        'candidateRuntimeTree': 'f68db2831a11dc0b733287f109f08c5ec0a34fde',
        'actualWorkersAllObservations': 3,
        'packages': packages, 'changedEntries': sorted(CHANGED), 'addedEntries': sorted(ADDED),
        'validatedObservationCount': len(validated), 'validatedObservations': validated,
        'ordinaryObservations': ordinary, 'candidate': timing, 'control': control,
        'phaseComparisons': phase_comparisons,
        'memoryAudit': memory_recomputed, 'memoryReceiptFailures': memory_receipt_failures,
        'memoryPassed': expected_memory_pass, 'memoryPairs': memory_recorded['pairs'],
        'storage': reference['common']['validation']['storage'], 'exhaustiveMedia': media_reference['media'],
        'limits': 'One AB-start host only; ordinary elapsed clocks and overlapping diagnostic phase counters are reported separately. No host pooling, control subtraction, partial-schedule replacement or memory-coverage imputation.',
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('artifact_directory', type=Path)
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args()
    try:
        result = audit(args.artifact_directory)
    except Exception as error:
        result = {'complete': False, 'type': type(error).__name__, 'error': str(error)}
        args.out.write_text(json.dumps(result, indent=2) + '\n')
        raise
    args.out.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({key: result[key] for key in ['complete', 'dictionary', 'validatedObservationCount', 'candidate', 'control', 'memoryPassed', 'memoryAudit']}))
