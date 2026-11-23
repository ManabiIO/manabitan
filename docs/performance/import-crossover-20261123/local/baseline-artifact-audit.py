"""Independently check frozen baseline packets and reproduce source media receipts."""
from collections import Counter
from pathlib import Path
import hashlib
import json
import math
import subprocess
import zipfile

ROOT = Path('/workspace/scratch/0a1757ac2970')
REPO = ROOT / 'manabitan'
FIXTURES = Path('/workspace/scratch/72c24f1e7bc9/manabitan/builds/e2e-dictionary-cache')
BASE = '3d65e403c644b9a5a6be3128d72f9d30050b70e0'
TREE = 'c540375466fc921ab05a5526a6130bc2d48010d5'
EXTENSIONS = {'.apng', '.avif', '.bmp', '.gif', '.ico', '.cur', '.jpg', '.jpeg', '.jfif', '.pjpeg', '.pjp', '.png', '.svg', '.tif', '.tiff', '.webp'}

def load(path):
    return json.loads(path.read_text())

def sha(data):
    return hashlib.sha256(data).hexdigest()

lock = load(REPO / 'test/perf/dictionaries.lock.json')['dictionaries']
package_entries = None
for label in ('jmdict', 'jitendex', 'vndb'):
    path = ROOT / 'artifacts/baseline' / label
    protocol = load(path / 'protocol.json')
    state = load(path / 'state.json')
    observations = load(path / 'observations.json')
    correctness = load(path / 'correctness.json')
    package = load(path / 'package-A.json')
    control = load(path / 'package-C.json')
    fixture = load(path / 'fixture.json')
    spec = lock[label]
    assert protocol['stage'] == 'baseline'
    assert protocol['sourceIdentities'] == {'A': {'commit': BASE, 'tree': TREE}, 'C': {'commit': BASE, 'tree': TREE}}
    assert protocol['baselineSnapshotRuns'] == 3 and protocol['plannedBlocks'] == 0 and protocol['orders'] == []
    assert protocol['diagnosticArms'] == ['A'] and protocol['diagnosticMediaCheck'] == 'all'
    assert sha((path / 'runner.py').read_bytes()) == protocol['runnerSha256']
    for filename, digest in protocol['unchangedHarnessSha256'].items():
        source = subprocess.check_output(['git', 'show', BASE + ':' + filename], cwd=REPO)
        assert sha(source) == digest, filename
    assert state['status'] == 'success' and state['attemptedObservations'] == 4 and state['timedObservations'] == 0 and state['exhaustiveDiagnostics'] == 1
    assert [item['name'] for item in observations] == ['baseline-01-A', 'baseline-02-A', 'baseline-03-A', 'diagnostic-A']
    assert control.pop('identicalArchiveFromArm') == 'A' and control == package
    assert package['source'] == protocol['sourceIdentities']['A']
    assert package_entries is None or package_entries == package['entries']
    package_entries = package['entries']
    assert fixture['fixture'] == protocol['fixture'] == spec
    assert fixture['sha256'] == spec['sha256'] and fixture['sizeBytes'] == spec['sizeBytes']
    assert correctness['status'] == 'passed'
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
    for observation in observations:
        run_path = path / observation['name']
        for filename in ('summary.json', 'run-1.json', 'run-1.html', 'host-before.json', 'host-after.json', 'command.log', 'phase-counters.json'):
            assert (run_path / filename).is_file() and (run_path / filename).stat().st_size > 0
        summary = load(run_path / 'summary.json')
        raw = load(run_path / 'run-1.json')
        assert summary['schemaVersion'] == 3 and len(summary['runs']) == 1 and summary['dictionary'] == label and summary['fixture'] == spec
        run = summary['runs'][0]
        validation = run['validation']
        assert observation['status'] == 'success' and observation['source'] == protocol['sourceIdentities']['A']
        assert summary['gitSha'] == summary['source']['gitSha'] == BASE and summary['source']['dirty'] is False
        assert run['packageSha256'] == raw['packageSha256'] == package['archiveSha256'] == summary['source']['sha256']['builds/manabitan-chrome.zip']
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
        output_digests.add(validation['outputDigestSha256'])
        summaries.append({'name': observation['name'], 'totalImportMs': round(duration, 1), 'lookupReceipts': len(lookups), 'mediaFiles': validation['media']['files'], 'mediaBytes': validation['media']['bytes']})
    assert len(output_digests) == 1
    packet = ROOT / 'artifacts' / ('baseline-' + label + '.zip')
    with zipfile.ZipFile(packet) as archive:
        assert archive.testzip() is None
        files = [entry for entry in archive.infolist() if not entry.is_dir()]
        assert len(files) == 45
        for entry in files:
            assert sha((path / entry.filename).read_bytes()) == sha(archive.read(entry)), entry.filename
    print(json.dumps({'dictionary': label, 'audit': 'passed', 'observations': summaries, 'sourceRows': spec['termRows'], 'completeMedia': media_expected['all'], 'storageBytes': correctness['identicalReceipts']['storageBytes'], 'packageHash': package['archiveSha256'], 'harnessFilesVerified': len(protocol['unchangedHarnessSha256']), 'packageEntriesCompared': len(package_entries), 'artifactFilesVerified': len(files), 'scope': 'Baseline snapshot; inventory, sampled term lookups, and exhaustive media. No candidate performance claim.'}))
