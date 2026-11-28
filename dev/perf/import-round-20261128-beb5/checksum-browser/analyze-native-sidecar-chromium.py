from pathlib import Path
import hashlib
import json
import math
import statistics
import struct

ROOT = Path('/workspace/scratch/beb5caac0497')
REPO = ROOT / 'native-sidecar-hash'
RESULTS = ROOT / 'results/native-sidecar-chromium-hosted'
SOURCE = '7de62b7f5888e8d40f0f0c48778a33a5c0407b84'
TREE = 'fa6c438551e995af4bc295d3bff6b68fb3b02caf'
WASM = '04401e56da4ed009ca67def777e7c51e87251529b92eceb6951980907efbf75e'
BROWSER = '8c599d43aec53f2460a31ae2f4af6bd863f8258b34ff519564bc5d4726bfaa1e'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def close(a, b):
    assert math.isclose(a, b, rel_tol=1e-11, abs_tol=1e-8), (a, b)


def load(path):
    return json.loads(path.read_bytes())


def metric(pairs, name):
    a = [pair['baseline'][name] for pair in pairs]
    b = [pair['candidate'][name] for pair in pairs]
    ratios = [y / x for x, y in zip(a, b) if x != 0]
    deltas = [y - x for x, y in zip(a, b)]
    return dict(
        baselineMedianMs=statistics.median(a), candidateMedianMs=statistics.median(b),
        baselineSumMs=sum(a), candidateSumMs=sum(b),
        medianRatio=statistics.median(ratios) if ratios else None,
        equalWorkRatio=sum(b) / sum(a) if sum(a) else None,
        ratioRange=[min(ratios), max(ratios)] if ratios else None,
        medianDeltaMs=statistics.median(deltas), deltaRangeMs=[min(deltas), max(deltas)],
        wins=sum(y < x for x, y in zip(a, b)), pairs=len(pairs),
    )


receipt_path = ROOT / 'results/native-sidecar-chromium-artifacts.json'
receipts = load(receipt_path)
lock_bytes = (REPO / 'test/perf/dictionaries.lock.json').read_bytes()
lock = json.loads(lock_bytes)['dictionaries']
report = {
    'runId': 46105941620, 'source': SOURCE, 'tree': TREE,
    'scope': 'Independently checked fresh Chromium checksum component; every pair and outlier retained. This is not an import wall-time result.',
    'captureCorrection': 'Frozen capture omits actual content-dictionary run splitting and projected/escaped-key worker options. Actual VNDB group 23 has Int32 scores where this synchronous capture had Float64. See native-sidecar-capture-scope-correction.md.',
    'startupScope': 'Includes helper load and native HTTP WASM read/compile/instantiate; excludes browser/worker launch, fixture HTTP I/O, SHA checks, input reconstruction and post-call expected-value checks.',
    'dictionaries': [],
}
for dictionary in ['jmdict', 'jitendex', 'vndb']:
    directory = RESULTS / dictionary / dictionary
    if not (directory / 'first-pass/campaign.json').exists():
        continue
    artifact = receipts[dictionary]
    assert sha((RESULTS / f'{dictionary}.zip').read_bytes()) == artifact['zipSha256']
    data = load(directory / 'first-pass/campaign.json')
    registration = load(directory / 'first-pass/registration.json')
    capture_bytes = (directory / 'capture-manifest.json').read_bytes()
    capture = json.loads(capture_bytes)
    identity = data['identities']
    assert data['complete'] and not data['failures']
    assert data['dictionary'] == dictionary and data['pairs'] == 8 and data['samples'] == 32
    assert len(data['cases']) == 16
    assert identity == registration['identities']
    assert identity['source'] == (directory / 'source-sha.txt').read_text().strip() == SOURCE
    assert identity['tree'] == (directory / 'source-tree.txt').read_text().strip() == TREE
    assert identity['lockSha256'] == capture['lockSha256'] == sha(lock_bytes)
    assert identity['inputManifestSha256'] == sha(capture_bytes)
    assert identity['fixtureSha256'] == lock[dictionary]['sha256']
    assert identity['wasmSha256'] == WASM
    assert identity['browserExecutableSha256'] == BROWSER
    assert identity['playwrightVersion'] == '1.63.0'
    assert identity['browserRevision'] == '1243'
    assert identity['expectedBrowserVersion'] == '153.0.8010.12'
    for filename, digest in identity['sourceFiles'].items():
        assert sha((REPO / filename).read_bytes()) == digest, filename
    assert identity['workerSha256'] == sha((REPO / 'dev/perf/native-sidecar-hash-chromium/worker.mjs').read_bytes())
    assert identity['campaignSha256'] == sha((REPO / 'dev/perf/native-sidecar-hash-chromium/campaign.mjs').read_bytes())
    assert identity['packageLockSha256'] == sha((REPO / 'package-lock.json').read_bytes())
    inputs = [span for group in capture['dictionaries'] for span in group['inputs']]
    expected_output = sha(b''.join(struct.pack('<I', span['xxh32']) for span in inputs))
    assert identity['expectedOutputSha256'] == expected_output
    assert sum(group['rows'] for group in capture['dictionaries']) == lock[dictionary]['termRows']
    assert registration['expectedBytes'] == sum(span['bytes'] for span in inputs)
    assert registration['expectedSectionHashCount'] == len(inputs)
    assert all(group['archiveSha256'] == lock[dictionary]['sha256'] for group in capture['dictionaries'])
    schedule = []
    for pair in range(8):
        for scenario in (['triple', 'control'] if pair % 2 == 0 else ['control', 'triple']):
            schedule.append(dict(pair=pair, scenario=scenario, order=['baseline', 'candidate'] if pair % 2 == 0 else ['candidate', 'baseline']))
    assert schedule == registration['schedule']
    pairs = []
    for case, scheduled in zip(data['cases'], schedule):
        assert {key: case[key] for key in scheduled} == scheduled
        pair = dict(scheduled)
        for label in scheduled['order']:
            sample = case['samples'][label]
            sample_file = directory / f'first-pass/{case["pair"] + 1:02}-{case["scenario"]}-{label}.json'
            assert sample == load(sample_file)
            assert sample['complete'] and sample['identities'] == identity
            assert sample['arm'] == ('triple' if case['scenario'] == 'triple' and label == 'candidate' else 'js')
            assert sample['browserVersion'] == '153.0.8010.12'
            assert sample['cdpVersion']['jsVersion'] == '15.3.76.4'
            assert sample['crossOriginIsolated'] is True
            assert sample['rows'] == lock[dictionary]['termRows']
            assert sample['inputBytes'] == registration['expectedBytes']
            assert sample['sectionHashCount'] == len(inputs)
            assert sample['outputHashesSha256'] == expected_output
            assert sample['warmupCalls'] == 0 and sample['repetitions'] == 1
            assert sample['memoryBytes'] == (65536 if sample['arm'] == 'triple' else 0)
            assert sample['wasmSha256'] == (WASM if sample['arm'] == 'triple' else None)
            assert len(sample['groups']) == len(capture['dictionaries'])
            for actual, expected in zip(sample['groups'], capture['dictionaries']):
                assert actual['groupIndex'] == expected['groupIndex']
                assert actual['rows'] == expected['rows']
                assert actual['sections'] == len(expected['inputs'])
                assert actual['bytes'] == sum(span['bytes'] for span in expected['inputs'])
                assert actual['hashMs'] >= 0
            close(sample['hashMs'], sum(group['hashMs'] for group in sample['groups']))
            close(sample['totalMs'], sample['initializationMs'] + sample['hashMs'])
            pair[label] = {key: sample[key] for key in ['initializationMs', 'helperLoadMs', 'moduleReadMs', 'compileAndInitializeMs', 'hashMs', 'totalMs']}
            pair[label]['firstGroupMs'] = sample['groups'][0]['hashMs']
            pair[label]['laterGroupMs'] = sample['hashMs'] - sample['groups'][0]['hashMs']
        a, b = pair['baseline'], pair['candidate']
        close(case['hashRatio'], b['hashMs'] / a['hashMs'])
        close(case['totalRatio'], b['totalMs'] / a['totalMs'])
        close(case['hashDeltaMs'], b['hashMs'] - a['hashMs'])
        close(case['totalDeltaMs'], b['totalMs'] - a['totalMs'])
        pairs.append(pair)
    summaries = []
    for scenario in ['triple', 'control']:
        selected = [pair for pair in pairs if pair['scenario'] == scenario]
        summary = dict(scenario=scenario, metrics={name: metric(selected, name) for name in selected[0]['baseline']})
        recorded = next(entry for entry in data['summaries'] if entry['scenario'] == scenario)
        close(summary['metrics']['hashMs']['medianRatio'], recorded['medianHashRatio'])
        close(summary['metrics']['totalMs']['medianRatio'], recorded['medianTotalRatio'])
        close(summary['metrics']['hashMs']['medianDeltaMs'], recorded['medianHashDeltaMs'])
        close(summary['metrics']['totalMs']['medianDeltaMs'], recorded['medianTotalDeltaMs'])
        assert summary['metrics']['totalMs']['wins'] == recorded['totalWins']
        summaries.append(summary)
    report['dictionaries'].append(dict(dictionary=dictionary, verifiedSamples=32,
        identities=identity, artifact=artifact, host=load(directory / 'host.json'),
        rows=lock[dictionary]['termRows'], groups=len(capture['dictionaries']),
        inputBytes=registration['expectedBytes'], sectionHashCount=len(inputs), summaries=summaries, pairs=pairs))
report['allThreeDictionaries'] = len(report['dictionaries']) == 3
report['analysisSha256'] = sha(Path(__file__).read_bytes())
output = ROOT / 'results/native-sidecar-chromium-study-summary.json'
output.write_text(json.dumps(report, indent=2) + '\n')
for dictionary in report['dictionaries']:
    print(dictionary['dictionary'], dictionary['host']['cpuModel'])
    for scenario in dictionary['summaries']:
        print(scenario['scenario'], json.dumps({key: scenario['metrics'][key] for key in ['hashMs', 'totalMs', 'firstGroupMs', 'laterGroupMs']}))
print(output)
