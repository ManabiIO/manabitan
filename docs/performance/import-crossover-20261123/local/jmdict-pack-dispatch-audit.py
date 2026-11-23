import hashlib
import json
import math
from pathlib import Path
import random
import statistics
import subprocess
import zipfile

TASK = Path('/workspace/scratch/0a1757ac2970')
ARTIFACT = TASK / 'artifacts/pack-dispatch-screen-jmdict.zip'
ROOT = TASK / 'artifacts/screen/pack-dispatch-jmdict'
REPO = TASK / 'jmdict-stacked'
EXPECTED_ZIP = '5ec6b05f6ff4603bc1d77c4c7775adc416206db43e02f4fb33d0522bfae6e621'

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
assert protocol['stage'] == 'screen' and protocol['dictionary'] == 'jmdict'
assert protocol['plannedBlocks'] == 6 and protocol['warmupsExcluded'] == 0
assert protocol['harnessOverlay'] is None
assert protocol['orders'] == ['ABC', 'CBA', 'BAC', 'CAB', 'BCA', 'ACB']
assert identities['A'] == identities['C']
assert identities['A']['commit'] == '3d65e403c644b9a5a6be3128d72f9d30050b70e0'
assert identities['B']['commit'] == '78a2adcfba8d72d8cba070319b53d4b2b354a8f9'
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
assert package_changes == read('package-differences.json') == [
    'js/dictionary/term-content-block-store.js', 'js/dictionary/zstd-term-content.js']
for arm in 'AB':
    assert packages[arm]['source'] == identities[arm]
    for name in package_changes:
        assert digest(git('show', f"{identities[arm]['commit']}:ext/{name}")) == packages[arm]['entries'][name]
source_changes = git('diff', '--name-only', identities['A']['commit'], identities['B']['commit']).decode().splitlines()
assert source_changes == [
    'ext/js/dictionary/term-content-block-store.js',
    'ext/js/dictionary/zstd-term-content.js',
    'test/term-content-block-store.test.js',
    'test/zstd-term-content-packed-dispatch.test.js',
]

fixture = protocol['fixture']
fixture_record = read('fixture.json')
assert fixture_record['fixture'] == fixture
assert fixture_record['sizeBytes'] == fixture['sizeBytes']
assert fixture_record['sha256'] == fixture['sha256']
lock = json.loads(git('show', f"{identities['A']['commit']}:test/perf/dictionaries.lock.json"))['dictionaries']
assert lock['jmdict'] == fixture
for dictionary, record in read('setup-fixtures.json').items():
    assert record['fixture'] == lock[dictionary]
    assert record['sha256'] == lock[dictionary]['sha256']
    assert record['sizeBytes'] == lock[dictionary]['sizeBytes']
fixture_path = Path('/workspace/scratch/72c24f1e7bc9/manabitan/builds/e2e-dictionary-cache/JMdict.zip')
assert fixture_path.stat().st_size == fixture['sizeBytes']
assert digest(fixture_path.read_bytes()) == fixture['sha256']

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
all_browser_versions = set()
all_node_versions = set()
for entry in observations:
    name, arm = entry['name'], entry['arm']
    assert entry['status'] == 'success'
    assert entry['source'] == identities[arm]
    summary = read(name + '/summary.json')
    raw = read(name + '/run-1.json')
    assert summary['schemaVersion'] == 3 and summary['dictionary'] == 'jmdict'
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
    phase = next(p for p in raw['phases'] if p['name'] == 'JMdict: total import')
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
    assert validation['termRows'] == validation['restart']['termRows'] == fixture['termRows'] == 528299
    assert validation['title'] == validation['restart']['title'] == fixture['expectedTitle']
    assert validation['revision'] == validation['restart']['revision'] == fixture['revision']
    assert validation['contentReadable'] and validation['restart']['contentReadable']
    assert validation['probeCount'] == validation['restart']['probeCount'] == 12
    assert validation['restart']['mediaFiles'] == 0
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
    assert storage == common_storage == entry['storageBytes'] == 43520477
    media = validation['media']
    assert media['mode'] == entry['mediaCheck']
    assert all(media[key] == 0 for key in ['totalFiles', 'totalBytes', 'files', 'bytes'])
    assert media['sha256'] == digest(b'')
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
    'status': 'passed', 'artifactSha256': EXPECTED_ZIP,
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
    'correctness': {'fullInventoryRowsPerRun': 528299, 'restartCheckedRuns': 20,
                    'matchingLookupReceiptsPerRun': 72, 'matchingLookupReceiptTotal': 1440,
                    'persistedStorageBytesPerRun': common_storage, 'mediaFiles': 0,
                    'mediaBytes': 0, 'strictOpfsRuns': 20, 'productionDefaultRuns': 20},
    'allTimingsMsFromRawBrowserClock': values, 'comparisons': comparisons,
    'intervalMethod': 'Descriptive percentile bootstrap of six paired block changes; 10000 resamples, seed 20261123, indices249 and9749; no multiple-comparison correction.',
    'conclusion': 'No established JMdict speedup. B/A median is -2.706%, with a broad interval whose upper endpoint is only -0.073%; B/C is -1.824% with an interval crossing zero. Identical-product C/A median is -1.642% with broad drift. This six-block exploratory screen is not an independent qualification.',
}
out = TASK / 'jmdict-pack-dispatch-audit.json'
out.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'status': result['status'], 'output': str(out), 'rawObservations': len(raw_rows),
                  'comparisons': comparisons}, indent=2))
