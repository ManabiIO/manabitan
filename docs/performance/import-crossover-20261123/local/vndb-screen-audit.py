"""Independently check frozen VNDB screen packets and reproduce source media receipts."""
from collections import Counter
from pathlib import Path
import hashlib
import json
import math
import random
import statistics
import subprocess
import zipfile

ROOT = Path('/workspace/scratch/0a1757ac2970')
REPO = ROOT / 'manabitan'
FIXTURES = Path('/workspace/scratch/72c24f1e7bc9/manabitan/builds/e2e-dictionary-cache')
BASE = '3d65e403c644b9a5a6be3128d72f9d30050b70e0'
TREE = 'c540375466fc921ab05a5526a6130bc2d48010d5'
TOOLING = '462c4e1e079f4bf7a0c858b004e14bb9356f11d5'
EXTENSIONS = {'.apng', '.avif', '.bmp', '.gif', '.ico', '.cur', '.jpg', '.jpeg', '.jfif', '.pjpeg', '.pjp', '.png', '.svg', '.tif', '.tiff', '.webp'}

def load(path):
    return json.loads(path.read_text())

def sha(data):
    return hashlib.sha256(data).hexdigest()

lock = load(REPO / 'test/perf/dictionaries.lock.json')['dictionaries']
CANDIDATES = {
    'pack-dispatch': {'commit': '78a2adcfba8d72d8cba070319b53d4b2b354a8f9', 'tree': '5c074e07c8964e8435987b954987b4fba95d7fdb', 'local': 'jitendex', 'files': ['js/dictionary/term-content-block-store.js', 'js/dictionary/zstd-term-content.js']},
    'media-path': {'commit': '32c13e05c1a7fda88fd531dab40648c1978565f2', 'tree': '2c4048a4f2be1dac76f16ec9f10efc93c1d966c4', 'local': 'vndb', 'files': ['js/dictionary/dictionary-generation-media-store.js']},
}
ORDERS = ['ABC', 'CBA', 'BAC', 'CAB', 'BCA', 'ACB']

def comparison(first, second):
    changes = [(b / a - 1) * 100 for a, b in zip(first, second, strict=True)]
    rng = random.Random(20261123)
    boot = sorted(statistics.median(rng.choices(changes, k=len(changes))) for _ in range(10000))
    return {'pairs': len(changes), 'fasterPairs': sum(value < 0 for value in changes), 'pairedChangesPercent': changes,
            'pairedMedianPercent': statistics.median(changes), 'pairedMedianBootstrap95Percent': [boot[249], boot[9749]],
            'equalWorkPercent': (sum(second) / sum(first) - 1) * 100,
            'baselineMedianMs': statistics.median(first), 'candidateMedianMs': statistics.median(second)}

def compare_numeric(actual, expected):
    if isinstance(actual, list):
        assert len(actual) == len(expected)
        for a, b in zip(actual, expected, strict=True): compare_numeric(a, b)
    else:
        assert math.isclose(actual, expected, rel_tol=1e-12, abs_tol=1e-8), (actual, expected)

label = 'vndb'
for candidate, candidate_spec in CANDIDATES.items():
    path = ROOT / 'artifacts/screen' / (candidate + '-vndb')
    if not (path / 'state.json').is_file():
        print(json.dumps({'candidate': candidate, 'audit': 'not downloaded'}))
        continue
    protocol = load(path / 'protocol.json')
    state = load(path / 'state.json')
    observations = load(path / 'observations.json')
    correctness = load(path / 'correctness.json')
    package = load(path / 'package-A.json')
    candidate_package = load(path / 'package-B.json')
    packages = {'A': package, 'B': candidate_package, 'C': package}
    control = load(path / 'package-C.json')
    fixture = load(path / 'fixture.json')
    spec = lock[label]
    assert protocol['stage'] == 'screen'
    assert protocol['github']['GITHUB_RUN_ID'] == '45262916933'
    assert protocol['toolingCommit'] == protocol['github']['GITHUB_SHA'] == TOOLING
    assert protocol['sourceIdentities'] == {'A': {'commit': BASE, 'tree': TREE}, 'B': {key: candidate_spec[key] for key in ('commit', 'tree')}, 'C': {'commit': BASE, 'tree': TREE}}
    for identity in protocol['sourceIdentities'].values():
        assert subprocess.check_output(['git', 'rev-parse', identity['commit'] + '^{tree}'], cwd=REPO, text=True).strip() == identity['tree']
    assert protocol['baselineSnapshotRuns'] == 0 and protocol['plannedBlocks'] == 6 and protocol['orders'] == ORDERS and protocol['warmupsExcluded'] == 0
    assert protocol['diagnosticArms'] == ['A', 'B'] and protocol['diagnosticMediaCheck'] == 'all'
    assert sha((path / 'runner.py').read_bytes()) == protocol['runnerSha256']
    for saved, source_name in [('runner.py', 'dev/perf/import-runtime-next.py'), ('workflow.yml', '.github/workflows/import-runtime-next.yml')]:
        assert (path / saved).read_bytes() == subprocess.check_output(['git', 'show', TOOLING + ':' + source_name], cwd=REPO)
    for filename, digest in protocol['unchangedHarnessSha256'].items():
        source = subprocess.check_output(['git', 'show', BASE + ':' + filename], cwd=REPO)
        assert sha(source) == digest, filename
    assert state['status'] == 'success' and state['attemptedObservations'] == 20 and state['timedObservations'] == 18 and state['exhaustiveDiagnostics'] == 2
    names = [f'block-{block:02d}-{position}-{arm}' for block, order in enumerate(ORDERS, start=1) for position, arm in enumerate(order, start=1)] + ['diagnostic-A', 'diagnostic-B']
    assert [item['name'] for item in observations] == names
    assert control.pop('identicalArchiveFromArm') == 'A' and control == package
    assert package['source'] == protocol['sourceIdentities']['A']
    assert len(package['entries']) == 550 and package['entries'] == load(ROOT / 'artifacts/baseline/vndb/package-A.json')['entries']
    assert candidate_package['source'] == protocol['sourceIdentities']['B']
    changed_files = sorted(name for name in set(package['entries']) | set(candidate_package['entries']) if package['entries'].get(name) != candidate_package['entries'].get(name))
    assert changed_files == sorted(candidate_spec['files']), changed_files
    for filename in changed_files:
        assert candidate_package['entries'][filename] == sha((ROOT / candidate_spec['local'] / 'ext' / filename).read_bytes())
    assert candidate_package['archiveSha256'] != package['archiveSha256']
    assert fixture['fixture'] == protocol['fixture'] == spec
    assert fixture['sha256'] == spec['sha256'] and fixture['sizeBytes'] == spec['sizeBytes']
    assert correctness['status'] == 'passed'
    baseline_receipts = load(ROOT / 'artifacts/baseline/vndb/correctness.json')['identicalReceipts']
    assert correctness['identicalReceipts'] == baseline_receipts
    archive = FIXTURES / spec['cacheFile']
    assert archive.stat().st_size == spec['sizeBytes'] and sha(archive.read_bytes()) == spec['sha256']
    media_expected = {}
    with zipfile.ZipFile(archive) as source:
        images = sorted((entry for entry in source.infolist() if not entry.is_dir() and Path(entry.filename).suffix.lower() in EXTENSIONS), key=lambda entry: entry.filename.encode('utf-16-be'))
        names = {entry.filename for entry in images}
        unused = set(spec.get('unreferencedMediaPaths', []))
        assert len(names) == len(images) and unused <= names
        images = [entry for entry in images if entry.filename not in unused]
        assert len(images) == spec['mediaFiles'] and sum(entry.file_size for entry in images) == spec['mediaBytes']
        source_rows = [(entry.filename, entry.file_size, sha(source.read(entry))) for entry in images]
        for mode in ('sample', 'all'):
            selected = source_rows if mode == 'all' or len(images) <= 64 else [source_rows[math.floor(i * (len(images) - 1) / 63)] for i in range(64)]
            digest = hashlib.sha256()
            for row in selected:
                digest.update((json.dumps(row, ensure_ascii=False, separators=(',', ':')) + '\n').encode())
            media_expected[mode] = {'mode': mode, 'totalFiles': len(images), 'totalBytes': spec['mediaBytes'], 'files': len(selected), 'bytes': sum(row[1] for row in selected), 'sha256': digest.hexdigest()}
            assert correctness['identicalReceipts']['media-' + mode] == media_expected[mode]
    output_digests = set()
    summaries = []
    raw_timings = {arm: [None] * 6 for arm in 'ABC'}
    for observation in observations:
        run_path = path / observation['name']
        for filename in ('summary.json', 'run-1.json', 'run-1.html', 'host-before.json', 'host-after.json', 'command.log', 'phase-counters.json'):
            assert (run_path / filename).is_file() and (run_path / filename).stat().st_size > 0
        summary = load(run_path / 'summary.json')
        raw = load(run_path / 'run-1.json')
        assert summary['schemaVersion'] == 3 and len(summary['runs']) == 1 and summary['dictionary'] == label and summary['fixture'] == spec
        run = summary['runs'][0]
        validation = run['validation']
        arm = observation['arm']
        expected_source = protocol['sourceIdentities'][arm]
        expected_package = packages[arm]
        assert observation['status'] == 'success' and observation['source'] == expected_source
        assert summary['gitSha'] == summary['source']['gitSha'] == expected_source['commit'] and summary['source']['dirty'] is False
        assert run['packageSha256'] == raw['packageSha256'] == expected_package['archiveSha256'] == summary['source']['sha256']['builds/manabitan-chrome.zip']
        assert summary['browserVersion'] == run['browserVersion'] == raw['browserVersion'] == state['browserVersion'] == '153.0.8010.12'
        assert summary['hostEnvironment']['nodeVersion'] == raw['hostEnvironment']['nodeVersion'] == 'v22.22.0'
        for filename, digest in summary['source']['sha256'].items():
            if filename in protocol['unchangedHarnessSha256']:
                assert digest == protocol['unchangedHarnessSha256'][filename]
        assert raw['status'] == 'success' and raw['failureReason'] == '' and raw['skippedVerification'] is False
        flags = raw['benchmark']
        assert flags['dictionary'] == label and flags['productionImportDefaults'] is True and flags['pinnedDictionaries'] is True and flags['authoritativeTiming'] is True
        assert all(flags[key] is False for key in ('traceEnabled', 'phaseProfiling', 'phaseScreenshots', 'processSampling')) and flags['importFlags'] is None
        assert summary['authoritativeTiming'] is True and summary['traceEnabled'] is False and summary['importFlags'] is None and summary['buildTarget'] == 'chrome'
        assert raw['runtimeDiagnostics']['openStorageMode'] == 'opfs-sahpool' and raw['runtimeDiagnostics']['hasBackendCreateSyncAccessHandle'] is True
        assert validation['title'] == spec['expectedTitle'] and validation['revision'] == spec['revision'] and validation['termRows'] == spec['termRows'] and validation['contentReadable'] is True
        assert validation['probeCount'] == len(validation['probeTerms']) == len(set(validation['probeTerms'])) == 12
        restart = validation['restart']
        assert restart['title'] == spec['expectedTitle'] and restart['revision'] == spec['revision'] and restart['termRows'] == spec['termRows'] and restart['mediaFiles'] == spec['mediaFiles'] and restart['contentReadable'] is True and restart['probeCount'] == 12
        lookups = validation['lookup']['observations']
        assert len(lookups) == 72 and Counter(row['pass'] for row in lookups) == Counter({index: 12 for index in range(6)})
        for pass_id in range(6):
            assert {row['term'] for row in lookups if row['pass'] == pass_id} == set(validation['probeTerms'])
        assert all(row['results'] > 0 and row['hasExactHeadwordMatch'] is True and len(row['sha256']) == 64 for row in lookups)
        assert sorted([[row['pass'], row['term'], row['results'], row['sha256']] for row in lookups]) == correctness['identicalReceipts']['lookup']
        assert validation['storage']['bytes'] == sum(file['bytes'] for file in validation['storage']['files']) == observation['storageBytes'] == correctness['identicalReceipts']['storageBytes']
        mode = observation['mediaCheck']
        assert summary['mediaCheck'] == flags['mediaCheck'] == mode and validation['media'] == media_expected[mode] and flags['validation'] == validation
        phase = next(phase['data'] for phase in raw['phases'] if isinstance(phase.get('data'), dict) and 'browserTiming' in phase['data'])
        timing = phase['browserTiming']
        assert timing['trigger'] == 'file-input-change' and timing['errorCount'] == 0 and timing['sequence'] > timing['sequenceBefore']
        duration = timing['completedAtMs'] - timing['startedAtMs']
        assert abs(duration - run['totalImportMs']) < 1e-6 and run['totalImportMs'] == observation['totalImportMs'] and duration > 0
        expected_phases = [{'phase': phase['phase'], 'elapsedMs': phase.get('elapsedMs'), 'details': phase.get('details')} for phase in run['importDebug']['importerPhaseTimings'] if phase['phase'] in ('import-data-banks', 'bulk-finalization') or phase['phase'].startswith('term-file-fast-path:')]
        assert load(run_path / 'phase-counters.json') == expected_phases
        if observation['cohort'] == 'timed':
            block, position = observation['block'], observation['position']
            assert 1 <= block <= 6 and 1 <= position <= 3 and ORDERS[block - 1][position - 1] == arm and mode == 'sample'
            assert raw_timings[arm][block - 1] is None
            raw_timings[arm][block - 1] = duration
        else:
            assert observation['cohort'] == 'exhaustive-diagnostic' and observation['name'] in ('diagnostic-A', 'diagnostic-B') and mode == 'all'
            assert observation['block'] is None and observation['position'] is None
        output_digests.add(validation['outputDigestSha256'])
        summaries.append({'name': observation['name'], 'totalImportMs': round(duration, 1), 'lookupReceipts': len(lookups), 'mediaFiles': validation['media']['files'], 'mediaBytes': validation['media']['bytes']})
    assert len(output_digests) == 1
    assert output_digests == {'230a48feb02e7586ecff364ae58aac25d63de213cdf5047f24629857f0a08094'}
    packet = ROOT / 'artifacts' / (candidate + '-screen-vndb.zip')
    with zipfile.ZipFile(packet) as archive:
        assert archive.testzip() is None
        files = [entry for entry in archive.infolist() if not entry.is_dir()]
        assert len(files) == 164
        for entry in files:
            assert sha((path / entry.filename).read_bytes()) == sha(archive.read(entry)), entry.filename
    saved_analysis = load(path / 'analysis.json')
    assert saved_analysis['status'] == 'complete' and saved_analysis['screeningOnly'] is True and saved_analysis['independentQualificationRequired'] is True
    assert all(all(value is not None for value in values) for values in raw_timings.values())
    for arm in 'ABC': compare_numeric(raw_timings[arm], saved_analysis['allTimingsMs'][arm])
    comparisons = {'candidate': comparison(raw_timings['A'], raw_timings['B']),
                   'candidateVsSecondBaseline': comparison(raw_timings['C'], raw_timings['B']),
                   'identicalProductControl': comparison(raw_timings['A'], raw_timings['C'])}
    for name, stats in comparisons.items():
        for key, value in stats.items(): compare_numeric(value, saved_analysis[name][key])
    result = {'dictionary': label, 'candidate': candidate, 'audit': 'passed', 'sourceIdentities': protocol['sourceIdentities'],
              'observations': summaries, 'completeMedia': media_expected['all'], 'storageBytes': correctness['identicalReceipts']['storageBytes'],
              'packageHashes': {arm: packages[arm]['archiveSha256'] for arm in 'ABC'}, 'changedPackageFiles': changed_files,
              'harnessFilesVerified': len(protocol['unchangedHarnessSha256']), 'artifactFilesVerified': len(files),
              'runnerSha256': protocol['runnerSha256'], 'baselinePackageEntryCount': len(package['entries']),
              'artifactZipSha256': sha(packet.read_bytes()), 'rawBrowserTimingsMs': raw_timings, 'recomputedComparisons': comparisons,
              'scope': 'Six-block exploratory screen;18timed observations and2separate exhaustive diagnostics. Independent qualification required.'}
    print(json.dumps(result))
