"""Offline verification of the compact original browser-campaign package."""

from collections import Counter
import hashlib
import json
import lzma
from pathlib import Path, PurePosixPath
import statistics
import sys
import tarfile


def sha(data):
    return hashlib.sha256(data).hexdigest()


def schedule(replication):
    rows = [('warmup', 0, arm) for arm in ('AB' if replication == 1 else 'BA')]
    for pair in range(2):
        rows += [('control-before', pair, 'A')] * 2
    for pair in range(8):
        rows += [('candidate', pair, arm) for arm in ('AB' if (pair + replication) % 2 == 1 else 'BA')]
    for pair in range(2):
        rows += [('control-after', pair, 'A')] * 2
    return rows


def verify_transport(root, manifest):
    derivation = json.loads((root / 'transport-derivation.json').read_text())
    if (derivation['schemaVersion'] != 1 or not derivation['rawTarBytesIdentical'] or
            derivation['sourceManifest']['sha256'] != manifest['sourceGzipManifestSha256']):
        raise ValueError('Wrong transport derivation')
    archive = root / derivation['destinationArchive']['path']
    data = archive.read_bytes()
    if (len(data) != derivation['destinationArchive']['bytes'] or
            hashlib.sha256(data).hexdigest() != derivation['destinationArchive']['sha256']):
        raise ValueError('XZ transport identity differs')
    hasher = hashlib.sha256()
    total = 0
    with lzma.open(archive, 'rb') as stream:
        while chunk := stream.read(1024 * 1024):
            total += len(chunk)
            if total > 512 * 1024 * 1024:
                raise ValueError('Unexpected expanded TAR size')
            hasher.update(chunk)
    if (total != derivation['sourceArchive']['uncompressedTarBytes'] or
            total != derivation['destinationArchive']['uncompressedTarBytes'] or
            hasher.hexdigest() != derivation['sourceArchive']['uncompressedTarSha256'] or
            hasher.hexdigest() != derivation['destinationArchive']['uncompressedTarSha256']):
        raise ValueError('Uncompressed TAR differs from frozen gzip source')


def main():
    root = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(__file__).resolve().parents[1]
    manifest = json.loads((root / 'manifest.json').read_text())
    verify_transport(root, manifest)
    assert manifest['runId'] == 45110694360 and len(manifest['cells']) == 24
    for item in manifest['files']:
        data = (root / item['path']).read_bytes()
        assert len(data) == item['bytes'] and sha(data) == item['sha256'], item['path']
    api = json.loads((root / 'provenance/api-final.json').read_text())
    api_artifacts = {item['id']: item for item in api['artifacts']}
    jobs = {item['id']: item for item in api['jobs']}
    expected = {}
    for cell in manifest['cells']:
        receipt = json.loads((root / cell['acquisitionReceipt']).read_text())
        artifact = receipt['artifact']
        assert artifact == api_artifacts[cell['artifactId']]
        assert artifact['workflow_run']['id'] == manifest['runId']
        assert artifact['workflow_run']['head_sha'] == manifest['harness']
        assert artifact['workflow_run']['repository_id'] == artifact['workflow_run']['head_repository_id'] == 1165902460
        assert artifact['digest'] == 'sha256:' + cell['originalZipSha256']
        assert artifact['size_in_bytes'] == cell['originalZipBytes']
        assert jobs[cell['jobId']]['conclusion'] == cell['jobConclusion']
        for member in receipt['members']:
            path = cell['directory'] + '/' + member['path']
            assert path not in expected
            expected[path] = member
    objects = {}
    observed = set()
    expanded_bytes = 0
    with tarfile.open(root / manifest['rawArchive'], 'r:xz') as archive:
        for member in archive:
            path = PurePosixPath(member.name)
            assert member.isfile() and not path.is_absolute() and '..' not in path.parts
            assert member.name not in observed and member.name in expected
            data = archive.extractfile(member).read()
            item = expected[member.name]
            assert len(data) == item['bytes'] and sha(data) == item['sha256'], member.name
            observed.add(member.name)
            expanded_bytes += len(data)
            if member.name.endswith('.json'):
                value = json.loads(data)
                # Keep only verification fields from large duplicate browser
                # reports; every original byte has already been hashed above.
                if member.name.endswith('/summary.json'):
                    value = {key: value[key] for key in ['gitSha', 'source', 'authoritativeTiming', 'traceEnabled', 'importFlags', 'browserVersion', 'runs']}
                    value['runs'] = [{key: run[key] for key in ['packageSha256', 'browserVersion', 'totalImportMs', 'validation']} for run in value['runs']]
                elif member.name.endswith('/run-1.json'):
                    phases = [{'data': {'kind': phase['data']['kind'], 'browserTiming': phase['data']['browserTiming']}} for phase in value['phases'] if isinstance(phase.get('data'), dict) and phase['data'].get('kind') == 'dictionary-import']
                    value = {key: value[key] for key in ['browserVersion', 'packageSha256', 'status', 'skippedVerification', 'benchmark']}
                    value['phases'] = phases
                objects[member.name] = value
    assert observed == set(expected)
    assert len(observed) == manifest['originalMemberCount'] and expanded_bytes == manifest['originalMemberBytes']
    analysis = json.loads((root / 'derived/analysis.json').read_text())
    derived = {row['directory']: row for row in analysis['rows']}
    reference = json.loads((root / 'source/reference-harness-hashes.json').read_text())['files']
    fixture_lock = json.loads((root / 'source/reference-fixtures.json').read_text())['dictionaries']
    observations_checked = 0
    candidates_checked = 0
    memory_runs = 0
    memory_pid_histogram = Counter()
    for cell in manifest['cells']:
        prefix = f"{cell['directory']}/{cell['candidate']}/{cell['dictionary']}/{cell['replication']}/"
        plan = objects[prefix + 'plan.json']
        assert plan['harness'] == manifest['harness']
        rows = objects[prefix + 'observations.json']
        assert len(rows) == 26 and len(cell['observations']) == 26
        expected_schedule = schedule(cell['replication'])
        assert plan['schedule'] == [list(item) for item in expected_schedule]
        identities = {arm: objects[prefix + arm + '-identity.json'] for arm in 'AB'}
        package_members = {arm: objects[prefix + arm + '-package-entries.json'] for arm in 'AB'}
        differences = sorted(name for name in set(package_members['A']) | set(package_members['B']) if package_members['A'].get(name) != package_members['B'].get(name))
        assert differences == sorted(plan['specification']['expectedPackageDifferences']) == objects[prefix + 'package-differences.json']
        digests = set()
        for index, (row, identity) in enumerate(zip(rows, cell['observations'])):
            assert (row['kind'], row['pair'], row['arm']) == expected_schedule[index]
            assert row['index'] == index
            for key in ['index', 'kind', 'pair', 'arm', 'totalImportMs', 'packageSha256']:
                assert identity[key] == row[key]
            summary = objects[identity['summaryMember']]
            report = objects[identity['reportMember']]
            result = summary['runs'][0]
            source_sha = plan['baseline' if row['arm'] == 'A' else 'candidate']
            assert identity['sourceSha'] == summary['gitSha'] == summary['source']['gitSha'] == source_sha
            assert all(summary['source']['sha256'][name] == value for name, value in reference.items())
            assert identities[row['arm']]['sha'] == source_sha
            assert row['packageSha256'] == result['packageSha256'] == report['packageSha256'] == identities[row['arm']]['packageSha256']
            assert report['browserVersion'] == summary['browserVersion'] == result['browserVersion'] == '153.0.8010.12'
            assert summary['authoritativeTiming'] and not summary['traceEnabled'] and summary['importFlags'] is None
            assert report['status'] == 'success' and not report['skippedVerification']
            assert row['totalImportMs'] == result['totalImportMs']
            timings = [phase['data']['browserTiming'] for phase in report['phases'] if isinstance(phase.get('data'), dict) and phase['data'].get('kind') == 'dictionary-import']
            assert len(timings) == 1 and timings[0]['completedAtMs'] - timings[0]['startedAtMs'] == row['totalImportMs']
            assert timings[0]['trigger'] == 'file-input-change' and timings[0]['errorCount'] == 0
            validation = row['validation']
            assert validation == result['validation'] == report['benchmark']['validation']
            assert identity['outputDigestSha256'] == validation['outputDigestSha256']
            assert identity['termRows'] == validation['termRows'] == validation['restart']['termRows'] == fixture_lock[cell['dictionary']]['termRows']
            assert identity['mediaRows'] == validation['mediaRows'] == validation['restart']['mediaRows']
            assert validation['contentReadable'] and validation['restart']['contentReadable']
            assert validation['probeCount'] == validation['restart']['probeCount'] == 12
            digests.add(validation['outputDigestSha256'])
            observations_checked += 1
        qualifies = len(digests) == 1 and cell['jobConclusion'] == 'success'
        assert qualifies == cell['timingGuardsPassed'] == derived[cell['directory']]['qualified']
        assert cell['qualifiedResultsJsonPresent'] == (prefix + 'results.json' in objects)
        if cell['candidate'] == 'owned-shared' and cell['dictionary'] == 'jitendex':
            assert not qualifies and len(digests) == 2 and not cell['qualifiedResultsJsonPresent']
        for kind in ['candidate', 'control-before', 'control-after']:
            changes = []
            faster = 0
            pairs = derived[cell['directory']]['pairs'][kind]['pairs']
            for pair in pairs:
                two = [row for row in rows if row['kind'] == kind and row['pair'] == pair['pair']]
                assert len(two) == 2
                if kind == 'candidate':
                    a = next(row['totalImportMs'] for row in two if row['arm'] == 'A')
                    b = next(row['totalImportMs'] for row in two if row['arm'] == 'B')
                    candidates_checked += 1
                else:
                    a, b = [row['totalImportMs'] for row in two]
                change = 100 * (b / a - 1)
                assert pair['baselineMs'] == a and pair['comparisonMs'] == b and pair['changePercent'] == change
                changes.append(change)
                faster += b < a
            assert statistics.median(changes) == derived[cell['directory']]['pairs'][kind]['medianChangePercent']
            assert faster == derived[cell['directory']]['pairs'][kind]['fasterPairs']
        for name, memory in objects.items():
            if not name.startswith(prefix) or not name.endswith('/chromium-memory.json'):
                continue
            memory_runs += 1
            samples = memory['samples']
            covered = [sample for sample in samples if sample['processes'] and not sample['unavailablePids'] and sample['stableObservedProcessSet']]
            assert len(samples) == memory['sampleCount'] and len(covered) == memory['stableFullyReadSampleCount']
            assert max(sample['pssKiB'] for sample in covered) == memory['maxSampledPssKiB']
            assert max(sample['privateKiB'] for sample in covered) == memory['maxSampledPrivateKiB']
            for sample in samples:
                assert sample['pssKiB'] == sum(process['pssKiB'] for process in sample['processes'])
                assert sample['privateKiB'] == sum(process['privateKiB'] for process in sample['processes'])
                memory_pid_histogram[len(sample['discoveredPids'])] += 1
    assert observations_checked == manifest['observations'] == 624
    assert candidates_checked == 192 and memory_runs == 16
    assert dict(memory_pid_histogram) == {1: 2161, 2: 1, 3: 2}
    assert manifest['timingGuardPassCells'] == 22 and not manifest['memoryCoverageEstablished']
    print(json.dumps({'verified': True, 'cells': 24, 'originalMembers': len(observed),
                      'originalMemberBytes': expanded_bytes, 'observations': observations_checked,
                      'candidatePairs': candidates_checked, 'memoryRuns': memory_runs,
                      'originalDigestFailuresPreserved': 2, 'wholeTreeMemoryClaimRejected': True,
                      'manifestSha256': sha((root / 'manifest.json').read_bytes())}))


if __name__ == '__main__':
    main()
