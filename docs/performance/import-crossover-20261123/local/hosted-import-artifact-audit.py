import argparse
import hashlib
import json
import math
from pathlib import Path
import random
import statistics
import subprocess
import zipfile

parser = argparse.ArgumentParser(description='Independently audit a frozen full-dictionary import screen')
parser.add_argument('--artifact', required=True, type=Path)
parser.add_argument('--extracted', required=True, type=Path)
parser.add_argument('--sha256', required=True)
parser.add_argument('--dictionary', required=True, choices=['jmdict', 'jitendex', 'vndb'])
parser.add_argument('--baseline', required=True)
parser.add_argument('--candidate', required=True)
parser.add_argument('--kind', required=True, choices=['record-runs', 'pack-dispatch'])
parser.add_argument('--output', required=True, type=Path)
args = parser.parse_args()
TASK = Path('/workspace/scratch/0a1757ac2970')
ARTIFACT, ROOT, EXPECTED_ZIP = args.artifact, args.extracted, args.sha256
REPO = TASK / 'jmdict-stacked'
EXPECTED_SOURCE_CHANGES = {
    'record-runs': ['ext/js/dictionary/term-record-opfs-store.js', 'test/term-record-encoding-runs.test.js'],
    'pack-dispatch': ['ext/js/dictionary/term-content-block-store.js', 'ext/js/dictionary/zstd-term-content.js',
                      'test/term-content-block-store.test.js', 'test/zstd-term-content-packed-dispatch.test.js'],
}[args.kind]
EXPECTED_PACKAGE_CHANGES = [name.removeprefix('ext/') for name in EXPECTED_SOURCE_CHANGES if name.startswith('ext/')]

def read(name):
    return json.loads((ROOT / name).read_text())

def digest(data):
    return hashlib.sha256(data).hexdigest()

def git(*args):
    return subprocess.check_output(['git', '-C', str(REPO), *args])

assert digest(ARTIFACT.read_bytes()) == EXPECTED_ZIP
with zipfile.ZipFile(ARTIFACT) as archive:
    archived_files = [entry for entry in archive.infolist() if not entry.is_dir()]
    for entry in archived_files:
        assert archive.read(entry) == (ROOT / entry.filename).read_bytes(), entry.filename

protocol = read('protocol.json')
observations = read('observations.json')
analysis = read('analysis.json')
state = read('state.json')
packages = {arm: read(f'package-{arm}.json') for arm in 'ABC'}
identities = protocol['sourceIdentities']
tooling = protocol['toolingCommit']
assert protocol['stage'] == 'screen' and protocol['dictionary'] == args.dictionary
assert protocol['plannedBlocks'] == 6 and protocol['warmupsExcluded'] == 0
assert protocol['harnessOverlay'] is None
assert protocol['orders'] == ['ABC', 'CBA', 'BAC', 'CAB', 'BCA', 'ACB']
assert identities['A'] == identities['C']
assert identities['A']['commit'] == args.baseline
assert identities['B']['commit'] == args.candidate
for identity in identities.values():
    assert git('rev-parse', identity['commit'] + '^{tree}').decode().strip() == identity['tree']
for name in ['source-status-A.txt', 'source-status-B.txt', 'tooling-status.txt']:
    assert not (ROOT / name).read_text().strip()
assert (ROOT / 'tooling-sha.txt').read_text().strip() == tooling
assert digest((ROOT / 'runner.py').read_bytes()) == protocol['runnerSha256']
assert (ROOT / 'runner.py').read_bytes() == git('show', f'{tooling}:dev/perf/import-runtime-next.py')
assert (ROOT / 'workflow.yml').read_bytes() == git('show', f'{tooling}:.github/workflows/import-runtime-next.yml')
harness = protocol['unchangedHarnessSha256']
for revision in [identities['A']['commit'], identities['B']['commit'], tooling]:
    for name, expected in harness.items():
        assert digest(git('show', f'{revision}:{name}')) == expected, (revision, name)

assert packages['A']['entries'] == packages['C']['entries']
assert packages['A']['archiveSha256'] == packages['C']['archiveSha256']
assert packages['C']['identicalArchiveFromArm'] == 'A'
assert len(packages['A']['entries']) == len(packages['B']['entries']) == 550
assert packages['A']['entries'].keys() == packages['B']['entries'].keys()
package_changes = sorted(name for name in packages['A']['entries']
                         if packages['A']['entries'][name] != packages['B']['entries'][name])
assert package_changes == read('package-differences.json') == EXPECTED_PACKAGE_CHANGES
for arm in 'AB':
    assert packages[arm]['source'] == identities[arm]
    for name in package_changes:
        assert digest(git('show', f"{identities[arm]['commit']}:ext/{name}")) == packages[arm]['entries'][name]
source_changes = git('diff', '--name-only', identities['A']['commit'], identities['B']['commit']).decode().splitlines()
assert source_changes == EXPECTED_SOURCE_CHANGES

fixture = protocol['fixture']
fixture_record = read('fixture.json')
assert fixture_record['fixture'] == fixture
assert fixture_record['sizeBytes'] == fixture['sizeBytes']
assert fixture_record['sha256'] == fixture['sha256']
lock = json.loads(git('show', f"{identities['A']['commit']}:test/perf/dictionaries.lock.json"))['dictionaries']
assert lock[args.dictionary] == fixture
for dictionary, record in read('setup-fixtures.json').items():
    assert record['fixture'] == lock[dictionary]
    assert record['sha256'] == lock[dictionary]['sha256']
    assert record['sizeBytes'] == lock[dictionary]['sizeBytes']
fixture_path = Path('/workspace/scratch/72c24f1e7bc9/manabitan/builds/e2e-dictionary-cache') / fixture['cacheFile']
assert fixture_path.stat().st_size == fixture['sizeBytes']
with fixture_path.open('rb') as fixture_stream:
    assert hashlib.file_digest(fixture_stream, 'sha256').hexdigest() == fixture['sha256']

expected_names = [f'block-{block:02d}-{position}-{arm}'
                  for block, order in enumerate(protocol['orders'], 1)
                  for position, arm in enumerate(order, 1)] + ['diagnostic-A', 'diagnostic-B']
assert [entry['name'] for entry in observations] == expected_names
assert sorted(path.parent.name for path in ROOT.glob('*/run-1.json')) == sorted(expected_names)
assert len(list(ROOT.glob('*/summary.json'))) == 20
assert len(observations) == state['attemptedObservations'] == 20
assert state['status'] == 'success' and state['timedObservations'] == 18
assert state['exhaustiveDiagnostics'] == 2
raw_rows = []
common_lookup = None
common_digest = None
common_storage = None
common_defaults = None
common_media = {}
all_browser_versions = set()
all_node_versions = set()
for entry in observations:
    name, arm = entry['name'], entry['arm']
    assert entry['status'] == 'success'
    assert entry['source'] == identities[arm]
    summary = read(name + '/summary.json')
    raw = read(name + '/run-1.json')
    assert summary['schemaVersion'] == 3 and summary['dictionary'] == args.dictionary
    assert summary['fixture'] == fixture and summary['buildTarget'] == 'chrome'
    assert summary['authoritativeTiming'] and not summary['traceEnabled']
    assert summary['importFlags'] is None and len(summary['runs']) == 1
    assert summary['gitSha'] == summary['source']['gitSha'] == identities[arm]['commit']
    assert summary['source']['dirty'] is False
    run = summary['runs'][0]
    assert run['packageSha256'] == raw['packageSha256'] == packages[arm]['archiveSha256']
    assert summary['source']['sha256']['builds/manabitan-chrome.zip'] == packages[arm]['archiveSha256']
    for filename, expected in summary['source']['sha256'].items():
        if filename in harness:
            assert expected == harness[filename]
    assert raw['status'] == 'success' and not raw['failureReason']
    assert raw['skippedVerification'] is False and not raw['skipReason']
    assert raw['phaseCount'] == len(raw['phases'])
    benchmark = raw['benchmark']
    assert benchmark['pinnedDictionaries'] and benchmark['productionImportDefaults']
    for flag in ['traceEnabled', 'phaseProfiling', 'phaseScreenshots', 'processSampling']:
        assert benchmark[flag] is False
    assert benchmark['authoritativeTiming'] and benchmark['importFlags'] is None
    assert benchmark['mediaCheck'] == summary['mediaCheck'] == entry['mediaCheck']
    assert raw['runtimeDiagnostics']['openStorageMode'] == 'opfs-sahpool'
    assert raw['runtimeDiagnostics']['startupDiagnosticsSnapshot']['dictionaryUsesFallbackStorage'] is False
    phase = next(p for p in raw['phases'] if p['name'] == fixture['label'] + ': total import')
    clock = phase['data']['browserTiming']
    assert clock['trigger'] == 'file-input-change' and clock['errorCount'] == 0
    assert clock['sequence'] == clock['sequenceBefore'] + 1
    duration = clock['completedAtMs'] - clock['startedAtMs']
    assert math.isfinite(duration) and duration > 0
    assert duration == run['totalImportMs'] == entry['totalImportMs']
    debug = phase['data']['importDebug']
    assert debug['errorCount'] == debug['addSettingsErrorCount'] == 0
    assert debug['usesFallbackStorage'] is False
    finalization = next(p['details'] for p in debug['importerPhaseTimings'] if p['phase'] == 'bulk-finalization')
    assert finalization['ok'] and finalization['published'] and not finalization['housekeepingErrors']
    defaults = finalization['compressionExperiments']
    if common_defaults is None: common_defaults = defaults
    assert defaults == common_defaults
    validation = raw['benchmark']['validation']
    assert validation['termRows'] == validation['restart']['termRows'] == fixture['termRows']
    assert validation['title'] == validation['restart']['title'] == fixture['expectedTitle']
    assert validation['revision'] == validation['restart']['revision'] == fixture['revision']
    assert validation['contentReadable'] and validation['restart']['contentReadable']
    assert validation['probeCount'] == validation['restart']['probeCount'] == 12
    assert validation['restart']['mediaFiles'] == fixture['mediaFiles']
    lookup = validation['lookup']['observations']
    assert len(lookup) == 72 and sorted({row['pass'] for row in lookup}) == list(range(6))
    assert all(row['results'] > 0 and row['hasExactHeadwordMatch'] for row in lookup)
    identity = sorted((row['pass'], row['term'], row['results'], row['sha256']) for row in lookup)
    if common_lookup is None: common_lookup = identity
    assert identity == common_lookup
    output_digest = validation['outputDigestSha256']
    if common_digest is None: common_digest = output_digest
    assert output_digest == common_digest
    storage = validation['storage']['bytes']
    assert storage == sum(file['bytes'] for file in validation['storage']['files'])
    if common_storage is None: common_storage = storage
    assert storage == common_storage == entry['storageBytes']
    media = validation['media']
    assert media['mode'] == entry['mediaCheck']
    assert media['totalFiles'] == fixture['mediaFiles'] and media['totalBytes'] == fixture['mediaBytes']
    assert 0 <= media['files'] <= media['totalFiles'] and 0 <= media['bytes'] <= media['totalBytes']
    if entry['mediaCheck'] == 'all':
        assert media['files'] == media['totalFiles'] and media['bytes'] == media['totalBytes']
    else:
        assert media['files'] == min(64, media['totalFiles'])
    if media['totalFiles'] == 0:
        assert media['sha256'] == digest(b'')
    else:
        assert media['files'] > 0 and media['bytes'] > 0
    assert len(media['sha256']) == 64
    media_identity = {key: media[key] for key in ['mode', 'totalFiles', 'totalBytes', 'files', 'bytes', 'sha256']}
    if entry['mediaCheck'] not in common_media:
        common_media[entry['mediaCheck']] = media_identity
    assert media_identity == common_media[entry['mediaCheck']]
    assert validation == {**run['validation'], 'restart': validation['restart']}
    assert raw['browserVersion'] == run['browserVersion'] == summary['browserVersion']
    all_browser_versions.add(raw['browserVersion'])
    all_node_versions.add(raw['hostEnvironment']['nodeVersion'])
    assert summary['hostEnvironment']['nodeVersion'] == 'v22.22.0'
    for suffix in ['host-before.json', 'host-after.json']:
        assert read(name + '/' + suffix)['nodeVersion'] == 'v22.22.0'
    raw_rows.append({'name': name, 'cohort': entry['cohort'], 'block': entry['block'],
                     'position': entry['position'], 'arm': arm, 'totalImportMs': duration})
assert all_browser_versions == {analysis['browserVersion']} == {'153.0.8010.12'}
assert all_node_versions == {'v22.22.0'}
assert read('correctness.json')['status'] == 'passed'
for mode, receipt in common_media.items():
    assert receipt == read('correctness.json')['identicalReceipts']['media-' + mode]

values = {arm: [row['totalImportMs'] for row in raw_rows if row['cohort'] == 'timed' and row['arm'] == arm]
          for arm in 'ABC'}
assert values == analysis['allTimingsMs']
comparisons = {}
for name, numerator, denominator, analysis_key in [
    ('B/A', 'B', 'A', 'candidate'), ('B/C', 'B', 'C', 'candidateVsSecondBaseline'),
    ('C/A', 'C', 'A', 'identicalProductControl')]:
    deltas = [100 * (b / a - 1) for a, b in zip(values[denominator], values[numerator], strict=True)]
    randomizer = random.Random(20261123)
    resampled = sorted(statistics.median([deltas[index] for index in randomizer.choices(range(6), k=6)])
                       for _ in range(10000))
    calculated = {
        'pairs': 6, 'fasterPairs': sum(delta < 0 for delta in deltas),
        'pairedChangesPercent': deltas, 'pairedMedianPercent': statistics.median(deltas),
        'pairedMedianBootstrap95Percent': [resampled[249], resampled[9749]],
        'equalWorkPercent': 100 * (sum(values[numerator]) / sum(values[denominator]) - 1),
        'baselineMedianMs': statistics.median(values[denominator]),
        'candidateMedianMs': statistics.median(values[numerator]),
    }
    for key, actual in calculated.items():
        assert actual == analysis[analysis_key][key], (name, key)
    comparisons[name] = calculated

result = {
    'status': 'passed', 'dictionary': args.dictionary, 'kind': args.kind, 'artifactSha256': EXPECTED_ZIP,
    'artifact': str(ARTIFACT), 'verifiedExtractedFiles': len(archived_files),
    'sourceIdentities': identities, 'toolingCommit': tooling,
    'runnerSha256': protocol['runnerSha256'], 'harnessFilesVerifiedAgainstAllThreeGitTrees': len(harness),
    'packageEntriesPerArm': 550, 'identicalControlManifestAndArchiveHash': True,
    'packageDifferences': package_changes, 'sourceDifferences': source_changes,
    'productArchiveVerificationLimit': 'Product ZIP bytes are not included in this artifact. Verified package-entry manifests, per-run recorded archive hashes, and changed runtime file hashes against exact source commits; did not independently rebuild product ZIPs.',
    'fixture': fixture_record, 'rawObservations': len(raw_rows), 'timedObservations': 18,
    'diagnosticObservationsExcludedFromTiming': 2, 'failedOrSkippedObservations': 0,
    'orders': protocol['orders'], 'browserVersion': next(iter(all_browser_versions)),
    'nodeVersion': next(iter(all_node_versions)),
    'correctness': {'fullInventoryRowsPerRun': fixture['termRows'], 'restartCheckedRuns': 20,
                    'matchingLookupReceiptsPerRun': 72, 'matchingLookupReceiptTotal': 1440,
                    'persistedStorageBytesPerRun': common_storage, 'mediaFiles': fixture['mediaFiles'],
                    'mediaBytes': fixture['mediaBytes'], 'matchingMediaReceipts': common_media, 'strictOpfsRuns': 20, 'productionDefaultRuns': 20},
    'allTimingsMsFromRawBrowserClock': values, 'comparisons': comparisons,
    'intervalMethod': 'Descriptive percentile bootstrap of six paired block changes; 10000 resamples, seed 20261123, indices249 and9749; no multiple-comparison correction.',
    'scopeLimit': 'Six-block exploratory screen, not independent qualification. No full persisted semantic corpus equivalence claim: full inventory count, restart, strict OPFS, sampled lookup receipts and source-equal sampled/exhaustive media receipts are checked separately. Assess candidate comparisons together with identical-code control drift.',
}
out = args.output
out.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'status': result['status'], 'output': str(out), 'rawObservations': len(raw_rows),
                  'comparisons': comparisons}, indent=2))
