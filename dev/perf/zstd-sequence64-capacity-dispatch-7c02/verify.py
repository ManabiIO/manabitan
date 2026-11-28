#!/usr/bin/env python3
"""Verify archived bytes and saved-result arithmetic; never execute native/WASM code."""
import argparse
import hashlib
import io
import json
import math
from pathlib import Path, PurePosixPath
import zipfile


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def git_blob(raw):
    return hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()


def safe_name(name):
    path = PurePosixPath(name)
    assert not path.is_absolute() and '..' not in path.parts
    assert path.as_posix() == name and '\\' not in name
    return name


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--extract', type=Path, help='Restore logical files into a new directory')
args = parser.parse_args()
root = Path(__file__).resolve().parent
index = json.loads((root / 'index.json').read_text())
parts = []
for number, entry in enumerate(index['parts'], 1):
    assert entry['name'] == f'sequence64-design-b.part-{number:03d}'
    raw = (root / safe_name(entry['name'])).read_bytes()
    assert len(raw) == entry['bytes'] <= 256 * 1024
    assert sha(raw) == entry['sha256'] and git_blob(raw) == entry['gitBlobSha1']
    parts.append(raw)
raw = b''.join(parts)
assert len(raw) == index['archiveBytes'] and sha(raw) == index['archiveSha256']

with zipfile.ZipFile(io.BytesIO(raw)) as archive:
    manifest_raw = archive.read('manifest.json')
    assert sha(manifest_raw) == index['manifestSha256']
    manifest = json.loads(manifest_raw)
    assert manifest['files'] == index['files']
    assert manifest['omittedFiles'] == index['omittedFiles']
    assert manifest['fileCount'] == len(manifest['files']) == index['fileCount']
    expected_members = {'manifest.json'} | {'blobs/' + value['sha256'] for value in manifest['files'].values()}
    assert len(archive.namelist()) == len(set(archive.namelist()))
    assert set(archive.namelist()) == expected_members
    blobs = {}
    for name, entry in manifest['files'].items():
        safe_name(name)
        digest = entry['sha256']
        if digest not in blobs:
            value = archive.read('blobs/' + digest)
            assert sha(value) == digest
            blobs[digest] = value
        assert len(blobs[digest]) == entry['bytes']
    assert len(blobs) == index['uniqueBlobCount']
    assert sum(len(value) for value in blobs.values()) == index['uniqueRawBytes']
    assert sum(entry['bytes'] for entry in manifest['files'].values()) == index['rawBytes']

    def read(name):
        return blobs[manifest['files'][name]['sha256']]

    def doc(name):
        return json.loads(read(name))

    def bound(name, digest):
        assert sha(read(name)) == digest, name

    for name in ['verify.py', 'README.md', 'RESULT.md', 'build-archive.py', 'investigation-ledger-snapshot.json', 'privacy-scan.json']:
        assert (root / name).read_bytes() == read(name), name
    privacy = doc('privacy-scan.json')
    assert privacy['status'] == 'passed' and privacy['matchedPaths'] == []
    assert set(privacy['files']) == set(manifest['files']) - {'privacy-scan.json'}
    for name, identity in privacy['files'].items():
        assert identity['bytes'] == manifest['files'][name]['bytes']
        assert identity['sha256'] == manifest['files'][name]['sha256']
    bound('investigation-ledger-snapshot.json', 'a97cdcc29a6ab0b724b79f08d1c8c5dab96196166b9c61a3c194dd1fe878dafd')
    bound('design-b-result/manifest.json', '60fe61a338106d9fbb529fc2cd5322887d19c5400f0db0b9e4cae9146750cd98')
    bound('design-b-component-screen.json', 'dcfab744040a3f66619e20ef3757103aca96e1b9d819d97d6049042b2cd6dbf7')
    bound('design-b-component-termination.json', '5b53396035ddc3f5b310407493be68689f4aca17432d0877c2d13042f9b6213c')
    bound('design-b-execution-freeze.json', '61d55a8e1007d4ed67205c1db2b96322d89d485c2778596f3245538f737bd9dc')

    corpus = doc('canonical-jmdict-1m/manifest.json')
    bound('canonical-jmdict-1m/manifest.json', '5ff31df0d8c069c0da248198a399879524d5bc4dff3ab48d96c5227afa578de0')
    blocks = corpus['blocks']
    assert len(blocks) == 103 and corpus['blockTargetBytes'] == 1048576
    assert corpus['unique'] == 362032 and corpus['persistedBytes'] == 100300626

    # Recompute baseline census ownership and eligibility from every raw call row.
    census_build = doc('capacity-census-result/manifest.json')
    census = doc('capacity-census-result/census.json')
    assert census_build['census'] == census
    for value in [census_build, census]:
        assert value['status'] == 'passed' and value['postIdentity'] == 'passed'
    assert census['failures'] == [] and census_build['performanceObservations'] is False
    assert census_build['rejectedChecked64Applied'] is False
    calls, frames = census['calls'], census['frames']
    assert len(calls) == 772 and len(frames) == len(blocks)
    cursor = 0
    for frame_index, (frame, block) in enumerate(zip(frames, blocks)):
        assert frame['frameIndex'] == frame_index and frame['frameName'] == block['name']
        assert frame['startCall'] == cursor
        assert frame['endCall'] - cursor == frame['calls']
        for key in ['group', 'localBlockIndex', 'contextIndex']:
            assert frame[key] == block[key]
        assert frame['contextIndex'] == frame['localBlockIndex'] % 4
        assert frame['logicalOutputCapacity'] == census['logicalOutputCapacities'][frame_index]
        for call_index in range(cursor, frame['endCall']):
            row = calls[call_index]
            assert row['callIndex'] == call_index
            for key in ['frameIndex', 'frameName', 'group', 'localBlockIndex', 'contextIndex', 'logicalOutputCapacity']:
                assert row[key] == frame[key]
            n, capacity = row['n'], row['destinationCapacity']
            assert type(n) is int and type(capacity) is int and n >= 1 and capacity >= 0
            assert row['eligible'] is (capacity >= 8 and n <= (capacity - 8) // 12)
            assert row['longOffsets'] == 0
        cursor = frame['endCall']
    assert cursor == len(calls)
    total_sequences = sum(row['n'] for row in calls)
    eligible = [row for row in calls if row['eligible']]
    eligible_sequences = sum(row['n'] for row in eligible)
    aggregate = {'calls': len(calls), 'eligibleCalls': len(eligible), 'sequences': total_sequences,
        'eligibleSequences': eligible_sequences, 'sequencesPerCall': total_sequences / len(calls),
        'callWeightedEligibilityPercent': 100 * len(eligible) / len(calls),
        'sequenceWeightedEligibilityPercent': 100 * eligible_sequences / total_sequences}
    for key, value in aggregate.items():
        assert math.isclose(value, census['aggregate'][key], rel_tol=0, abs_tol=1e-9), key
    assert total_sequences == eligible_sequences == 2574603
    assert census['eligibilityGate']['minimumPercent'] == 90
    assert census['eligibilityGate']['passed'] is (100 * eligible_sequences >= 90 * total_sequences)
    assert census['canonical']['P'] == census['canonical']['I']
    assert sum(frame['bytes'] for frame in frames) == census['canonical']['P']['bytes'] == 12324804

    # Bind exact product artifacts and the separate frozen source packages.
    build = doc('design-b-result/manifest.json')
    assert build['status'] == build['postIdentity'] == 'passed'
    assert build['performanceObservations'] is False and build['rejectedChecked64Applied'] is False
    assert build['artifactRole'] == 'exact-production-command' and build['diagnosticSymbolMapFlagUsed'] is False
    assert build['productCommandArmNames'] == {'P': 'P', 'A': 'A0', 'B': 'B1', 'C': 'C0'}
    assert all('--emit-symbol-map' not in row['argv'] for row in build['commands'])
    assert build['baselineArtifactReuse']['arms'] == ['P', 'A0', 'C0']
    prior = doc('design-b-result/inputs/prior-product-manifest.json')
    bound('design-b-result/inputs/prior-product-manifest.json', build['baselineArtifactReuse']['manifestSha256'])
    for label, arm in build['arms'].items():
        for name, identity in arm['files'].items():
            data = read(f"design-b-result/arms/{arm.get('productName', label)}/{name}")
            assert len(data) == identity['bytes'] and sha(data) == identity['sha256']
    for label in ['P', 'A', 'C']:
        for name in ['zstd-simd-module.wasm', 'zstd-simd-module.js']:
            assert build['arms'][label]['files'][name] == prior['arms'][label]['files'][name]
    bound('design-b-result/arms/B1/zstd-simd-module.wasm', 'f2656e2f6d575847ca93d5a981e3c569986bbfc048809173beb3c77f5308d4e1')
    for prefix, receipt in [('design-b-result', build), ('capacity-census-result', census_build)]:
        bound(prefix + '/inputs/source-files.json', receipt['frozenResearchManifestSha256'])
        for name, digest in receipt['researchFiles'].items():
            bound(prefix + '/inputs/' + name, digest)
    for name, identity in census_build['instrumentedFiles'].items():
        bound('capacity-census-result/arms/instrumented/' + name, identity['sha256'])

    # Independently count every reported probe/capacity slot and route.
    probes = doc('design-b-result/sequence-probe-qualification.json')
    assert probes == build['sequenceProbes'] and probes['status'] == 'passed' and probes['failures'] == []
    assert (len(probes['primitiveCases']), len(probes['sequenceCases']), len(probes['predicateCases']), len(probes['invalidDispatchCases'])) == (337, 340, 22, 2)
    fixture_calls = 0
    candidate_routes = {'0': 2, '32': 0, '64': 2}  # Two explicit valid priming calls precede invalid calls.
    for collection in ['primitiveCases', 'sequenceCases']:
        old = {row['name']: row for row in prior['sequenceProbes'][collection]}
        assert len(old) == len(probes[collection])
        for row in probes[collection]:
            for key in ['name', 'count', 'mode', 'longOffsets', 'inputSha256', 'outputBytes', 'outputSha256']:
                assert row[key] == old[row['name']][key], (collection, row['name'], key)
            thresholds = [12 * row['count'] + extra for extra in [7, 8, 9]] if collection == 'sequenceCases' else []
            assert row['thresholdCapacities'] == thresholds
            expected_capacities = len(set(range(row['outputBytes'] + 17)) | set(thresholds))
            assert row['capacities'] == expected_capacities and row['placements'] == 9
            slots = row['capacities'] * row['placements']
            assert row['successes'] + row['errors'] == slots
            assert sum(row['candidateRoutes'].values()) == slots
            assert row['spaciousCandidateRoute'] == 64
            for route in ['32', '64']:
                assert row['candidateRoutes'][route] > 0
                candidate_routes[route] += row['candidateRoutes'][route]
            candidate_routes['64'] += 1
            fixture_calls += slots + 1
    assert probes['checks'] == 2 * (fixture_calls + 4) == 818274
    assert probes['routing'] == {'A': {'0': 2, '32': fixture_calls + 2, '64': 0}, 'B': candidate_routes}
    for row in probes['predicateCases']:
        n, cap = row['count'], row['capacity']
        expected = n > 0 and cap >= 8 and n <= (cap - 8) // 12
        assert row['eligible'] is expected and row['A'] == 0 and row['B'] == int(expected) and row['route'] == 0
    for row in probes['invalidDispatchCases']:
        assert row['count'] in [0, 129] and row['route'] == 0 and row['noDestinationWrites'] is True
        assert row['outcomes']['A'] == row['outcomes']['B'] and 'error' in row['outcomes']['A']
    capacities = doc('design-b-result/small-capacity-qualification.json')
    assert capacities == build['smallCapacities'] and capacities['status'] == 'passed' and capacities['failures'] == []
    assert capacities['postArtifactIdentity'] == 'passed' and len(capacities['cases']) == 55
    expected_checks = 0
    for row in capacities['cases']:
        assert row['alignments'] == [0, 1, 3, 7]
        slots = len(row['capacities']) * len(row['alignments'])
        assert row['successfulSlots'] + row['errorSlots'] == slots
        assert ('error' in row['spacious']) is row['expectError']
        assert sum(row['successfulFrameVariants'].values()) == row['successfulSlots']
        expected_checks += 4 * (slots + 1)
    assert expected_checks == capacities['checks'] == 163772

    # Saved per-frame equality, source identities, context mapping and totals.
    qualified = doc('design-b-result/qualification.json')
    reference = doc('design-b-result/inputs/reference-manifest.json')['qualification']
    assert qualified == build['qualification'] and qualified['status'] == qualified['postIdentity'] == 'passed'
    assert qualified['failures'] == [] and len(qualified['canonicalFrames']) == 103 and len(qualified['syntheticCases']) == 79
    assert qualified['logicalOutputCapacities'] == census['logicalOutputCapacities'] == reference['logicalOutputCapacities']
    for number, (row, ref, block, frame) in enumerate(zip(qualified['canonicalFrames'], reference['canonicalFrames'], blocks, frames)):
        assert row == ref
        assert row['name'] == block['name'] and row['sourceSha256'] == block['sha256']
        assert row['sourceBytes'] == block['bytes']
        for key in ['group', 'localBlockIndex', 'contextIndex', 'groupEntryStart', 'groupEntryEnd', 'canonicalByteOffset']:
            assert row[key] == block[key]
        assert row['worker'] == row['contextIndex'] == row['localBlockIndex'] % 4
        assert row['logicalOutputCapacity'] == qualified['logicalOutputCapacities'][number]
        assert all(value == row['arms']['P'] for value in row['arms'].values())
        for key in ['bytes', 'frameSha256', 'envelopeSha256']:
            assert row['arms']['P'][key] == frame[key]
    # The new report adds only an explicit logical capacity field to these old cases.
    for row, old in zip(qualified['syntheticCases'], prior['qualification']['syntheticCases']):
        assert row['logicalOutputCapacity'] == 4210689
        assert {key: value for key, value in row.items() if key != 'logicalOutputCapacity'} == old
    assert qualified['wrongDictionary'] == prior['qualification']['wrongDictionary']
    for row in qualified['syntheticCases']:
        assert all(value == row['arms']['P'] for value in row['arms'].values())
    canonical = qualified['canonical']
    assert canonical['successfulFrames'] == dict.fromkeys(['P', 'A', 'B', 'C'], 103)
    assert sum(row['sourceBytes'] for row in qualified['canonicalFrames']) == canonical['inputBytes'] == 100300626
    for arm in ['P', 'A', 'B', 'C']:
        assert sum(row['arms'][arm]['bytes'] for row in qualified['canonicalFrames']) == canonical['frameBytes'][arm] == 12324804
        assert canonical['frameSha256'][arm] == census['canonical']['P']['frameSha256']
        assert canonical['envelopeSha256'][arm] == census['canonical']['P']['envelopeSha256']

    # Independently reproduce exact binary isolation without loading WebAssembly.
    def uint(data, offset):
        value = shift = 0
        while True:
            byte = data[offset]
            offset += 1
            value |= (byte & 127) << shift
            if byte < 128:
                return value, offset
            shift += 7
            assert shift <= 35

    def sections(data):
        assert data[:8] == b'\0asm\x01\0\0\0'
        output, offset = [], 8
        while offset < len(data):
            start, kind = offset, data[offset]
            size, payload = uint(data, offset + 1)
            offset = payload + size
            assert offset <= len(data)
            output.append((kind, data[start:offset], data[payload:offset]))
        return output

    def bodies(payload):
        count, offset = uint(payload, 0)
        output = []
        for _ in range(count):
            size, start = uint(payload, offset)
            offset = start + size
            output.append(payload[start:offset])
        assert offset == len(payload)
        return output

    product = read('design-b-result/arms/P/zstd-simd-module.wasm')
    candidate = read('design-b-result/arms/B1/zstd-simd-module.wasm')
    old_sections, new_sections = sections(product), sections(candidate)
    assert [row[0] for row in old_sections] == [row[0] for row in new_sections]
    assert [old[0] for old, new in zip(old_sections, new_sections) if old[1] != new[1]] == [10]
    old_bodies = bodies(next(row[2] for row in old_sections if row[0] == 10))
    new_bodies = bodies(next(row[2] for row in new_sections if row[0] == 10))
    assert len(old_bodies) == len(new_bodies) == 200
    assert [number for number, pair in enumerate(zip(old_bodies, new_bodies)) if pair[0] != pair[1]] == [101]
    assert (len(old_bodies[101]), len(new_bodies[101])) == (1705, 3148)
    assert len(candidate) - len(product) == 1443

    # No timing result or causal claim can be manufactured from the partial receipt.
    partial = doc('design-b-component-screen.json')
    termination = doc('design-b-component-termination.json')
    freeze = doc('design-b-execution-freeze.json')
    timer_manifest = doc('design-b-timing-prototype/timing-source-files.json')
    bound('design-b-timing-prototype/timing-source-files.json', partial['timingSourceManifestSha256'])
    for name, identity in timer_manifest['files'].items():
        bound('design-b-timing-prototype/' + name, identity['sha256'])
    assert partial['status'] == 'started' and partial['observations'] == []
    assert not any(key in partial for key in ['gates', 'comparisons', 'preOracle', 'postOracle', 'postIdentity'])
    assert partial['failures'] == [] and read('design-b-component-screen.log') == b''
    assert termination['exitCode'] == 137
    assert partial['buildManifestSha256'] == freeze['qualifiedArtifactManifestSha256'] == sha(read('design-b-result/manifest.json'))
    assert partial['timingSourceManifestSha256'] == freeze['timingSourceManifestSha256']
    assert partial['nodeRuntime'] == freeze['nodeRuntime'] == build['nodeRuntime']
    assert [''.join(row) for row in partial['schedule']] == freeze['schedule'] == ['PABC', 'ABCP', 'BCPA', 'CPAB', 'CBAP', 'PCBA', 'APCB', 'BAPC']
    assert partial['warmupCorpusPassesPerArm'] == freeze['warmupsPerArm'] == 2 and freeze['observations'] == 32
    audit = doc('production-workload-audit/independent-design-b-incomplete-screen-audit.json')
    assert audit['recordedObservations'] == 0 and audit['requiredObservations'] == 32
    assert audit['recordedGates'] is False and audit['recordedComparisons'] is False
    result_text = read('RESULT.md').decode()
    assert 'The exact termination phase is unknown.' in result_text
    assert 'establishes neither a speed improvement nor a regression' in result_text

    if args.extract:
        args.extract.mkdir(parents=True, exist_ok=False)
        for name, entry in manifest['files'].items():
            destination = args.extract / safe_name(name)
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(blobs[entry['sha256']])

print(json.dumps({'integrity': 'passed', 'files': len(manifest['files']), 'uniqueBlobs': len(blobs),
    'censusArithmetic': 'passed', 'censusCalls': len(calls), 'censusSequences': total_sequences,
    'sequenceWeightedEligibilityPercent': aggregate['sequenceWeightedEligibilityPercent'],
    'savedCorrectnessCounts': 'passed', 'sequenceChecks': probes['checks'], 'apiCapacityChecks': capacities['checks'],
    'canonicalFramesPerArm': 103, 'syntheticCases': 79, 'recordedTimingObservations': 0,
    'performanceDisposition': 'incomplete; no gain, regression or memory-regression conclusion',
    'terminationPhase': 'unknown; no observation was recorded',
    'nativeExecution': False, 'extracted': str(args.extract) if args.extract else None}, indent=2))
