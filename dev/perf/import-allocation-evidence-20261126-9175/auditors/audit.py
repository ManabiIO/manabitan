#!/usr/bin/env python3
"""Independently audit one retained frozen import-screen artifact."""
import hashlib
import io
import json
import math
from pathlib import Path
import statistics
import subprocess
import sys
import zipfile

BASE = '0143e9596cd8f790d5e166d4ba6a2425fbc57f14'
HEADS = {
    'scratch': '400d4375a89cdf93805cc9566da2068a741dc059',
    'media': 'bdb9c74874e2612fbb8741f4d36ed4397e4eaf57',
}
ALLOWED = {
    'scratch': ['js/dictionary/dictionary-database.js', 'js/dictionary/term-bank-wasm-parser.js', 'js/dictionary/term-content-plan-resolution.js'],
    'media': ['js/dictionary/dense-zip-file-map.js', 'js/dictionary/dictionary-importer.js'],
}
REPO = Path(__file__).resolve().parent.parent / 'manabitan'
SCRIPT = Path(__file__).resolve().parent / 'frozen-screen.py'

def digest(value):
    return hashlib.sha256(value).hexdigest()

def source(relative):
    return subprocess.check_output(['git', 'show', f'{BASE}:{relative}'], cwd=REPO)

def canonical(validation):
    return {
        'title': validation['title'], 'revision': validation['revision'],
        'termRows': validation['termRows'], 'probeTerms': validation['probeTerms'],
        'outputDigestSha256': validation['outputDigestSha256'],
        'media': {key: validation['media'][key] for key in ('mode', 'totalFiles', 'totalBytes', 'files', 'bytes', 'sha256')},
        'lookup': sorted([{key: row[key] for key in ('pass', 'term', 'results', 'sha256')} for row in validation['lookup']['observations']], key=lambda row: (row['pass'], row['term'])),
    }

def audit(artifact):
    with zipfile.ZipFile(artifact) as archive:
        schedules = [name for name in archive.namelist() if name.endswith('schedule.json')]
        assert len(schedules) == 1, schedules
        prefix = schedules[0][:-len('schedule.json')]
        def read(name):
            return archive.read(prefix + name)
        def data(name):
            return json.loads(read(name))
        schedule = data('schedule.json')
        kind = next(kind for kind, sha in HEADS.items() if sha == schedule['candidate'])
        dictionary = schedule['dictionary']
        fixture = json.loads(source('test/perf/dictionaries.lock.json'))['dictionaries'][dictionary]
        assert schedule['baseline'] == BASE
        assert schedule['schedule'] == ['A1', 'B1', 'B2', 'A2']
        assert schedule['allowedPackageChanges'] == sorted(ALLOWED[kind])
        assert schedule['scriptSha256'] == digest(SCRIPT.read_bytes())
        package_hashes, members = {}, {}
        for label in ('A', 'B'):
            package = read(f'{label}-manabitan-chrome.zip')
            package_hashes[label] = digest(package)
            with zipfile.ZipFile(io.BytesIO(package)) as product:
                members[label] = {entry.filename: digest(product.read(entry)) for entry in product.infolist() if not entry.is_dir()}
            assert members[label] == data(f'{label}-package-members.json')
            for relative, expected in data(f'{label}-shared-source.json').items():
                assert digest(source(relative)) == expected, (label, relative)
        changed = sorted(name for name in members['A'].keys() | members['B'].keys() if members['A'].get(name) != members['B'].get(name))
        assert changed == sorted(ALLOWED[kind]), changed
        assert data('package-comparison.json') == {'sha256': package_hashes, 'changedEntries': changed}
        expected = None
        browser = None
        rows = []
        for observation in schedule['schedule']:
            label = observation[0]
            summary = data(f'{observation}/summary.json')
            raw = data(f'{observation}/run-1.json')
            assert summary['gitSha'] == (BASE if label == 'A' else HEADS[kind])
            assert summary['fixture'] == fixture
            assert summary['buildTarget'] == 'chrome' and summary['mediaCheck'] == 'all'
            assert summary['hostEnvironment']['nodeVersion'] == 'v22.22.0'
            assert summary['traceEnabled'] is False and summary['importFlags'] is None
            assert len(summary['runs']) == 1
            sample = summary['runs'][0]
            assert sample['packageSha256'] == package_hashes[label] == raw['packageSha256']
            assert isinstance(sample['browserVersion'], str) and sample['browserVersion']
            if browser is None:
                browser = sample['browserVersion']
            assert sample['browserVersion'] == browser == raw['browserVersion']
            assert raw['status'] == 'success' and raw['skippedVerification'] is False
            benchmark = raw['benchmark']
            assert benchmark['dictionary'] == dictionary and benchmark['pinnedDictionaries'] is True
            assert benchmark['productionImportDefaults'] is True and benchmark['importFlags'] is None
            assert benchmark['authoritativeTiming'] is True and benchmark['mediaCheck'] == 'all'
            for key in ('traceEnabled', 'phaseProfiling', 'phaseScreenshots', 'processSampling'):
                assert benchmark[key] is False, key
            validation = benchmark['validation']
            assert sample['validation'] == validation
            assert validation['title'] == fixture['expectedTitle'] and validation['revision'] == fixture['revision']
            assert validation['termRows'] == fixture['termRows'] and validation['contentReadable'] is True
            assert validation['probeCount'] == len(set(validation['probeTerms'])) == 12
            assert validation['restart']['termRows'] == fixture['termRows']
            assert validation['restart']['mediaFiles'] == fixture['mediaFiles']
            assert validation['restart']['contentReadable'] is True and validation['restart']['probeCount'] == 12
            assert len(validation['lookup']['observations']) == 72
            media = validation['media']
            assert media['mode'] == 'all'
            assert media['files'] == media['totalFiles'] == fixture['mediaFiles']
            assert media['bytes'] == media['totalBytes'] == fixture['mediaBytes']
            current = canonical(validation)
            assert current == data(f'{observation}/semantic-receipt.json')
            if expected is None:
                expected = current
            assert current == expected, f'Semantic mismatch at {observation}'
            phases = [p for p in raw['phases'] if p['name'] == fixture['label'] + ': total import']
            assert len(phases) == 1
            timing = phases[0]['data']['browserTiming']
            assert timing['trigger'] == 'file-input-change' and timing['errorCount'] == 0
            elapsed = timing['completedAtMs'] - timing['startedAtMs']
            assert elapsed > 0 and math.isclose(elapsed, sample['totalImportMs'], abs_tol=1e-7)
            rows.append({'id': observation, 'totalImportMs': elapsed, 'workerImportMs': sample['workerImportMs'], 'storageBytes': validation['storage']['bytes']})
        result = data('result.json')
        values = {row['id']: row['totalImportMs'] for row in rows}
        deltas = [(values[f'B{n}'] / values[f'A{n}'] - 1) * 100 for n in (1, 2)]
        assert result['complete'] is True and result['matchedSemanticReceipts'] == 4
        assert all(math.isclose(a, b, abs_tol=1e-8) for a, b in zip(deltas, result['pairedChangePercent']))
        assert math.isclose(statistics.median(deltas), result['medianPairedChangePercent'], abs_tol=1e-8)
        return {'artifact': str(artifact), 'artifactSha256': digest(artifact.read_bytes()), 'kind': kind, 'dictionary': dictionary, 'baseline': BASE, 'candidate': HEADS[kind], 'browserVersion': browser, 'matchedSemanticReceipts': 4, 'termRows': fixture['termRows'], 'mediaFiles': fixture['mediaFiles'], 'mediaBytes': fixture['mediaBytes'], 'packageSha256': package_hashes, 'changedEntries': changed, 'observations': rows, 'pairedChangePercent': deltas, 'medianPairedChangePercent': statistics.median(deltas), 'scope': 'One-host four-import screen; no whole-import speed or peak-memory qualification'}

if __name__ == '__main__':
    artifact = Path(sys.argv[1]).resolve()
    result = audit(artifact)
    target = artifact.with_suffix('.audit.json')
    target.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))
