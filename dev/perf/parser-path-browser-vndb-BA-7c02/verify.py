"""Verify saved bytes/completeness only. Never execute archived product code."""
from pathlib import Path
import hashlib
import io
import json
import zipfile

HERE = Path(__file__).resolve().parent
CONFIG = json.loads((HERE / 'cohort.json').read_bytes())


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    index = json.loads((HERE / 'index.json').read_bytes())
    assert sha(Path(__file__).read_bytes()) == index['verifierSha256']
    assert sha((HERE / 'cohort.json').read_bytes()) == index['configurationSha256']
    assert sha((HERE / 'build.py').read_bytes()) == index['builderSha256']
    privacy_bytes = (HERE / 'privacy-scan.json').read_bytes()
    assert sha(privacy_bytes) == index['privacyScanSha256']
    privacy = json.loads(privacy_bytes)
    assert privacy['matchingPaths'] == []
    parts = []
    for ordinal, entry in enumerate(index['parts'], 1):
        assert entry['path'] == f'cohort-evidence.part-{ordinal:03d}'
        data = (HERE / entry['path']).read_bytes()
        assert 0 < len(data) == entry['size'] <= 256 * 1024
        assert sha(data) == entry['sha256']
        assert hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest() == entry['gitBlobSha1']
        parts.append(data)
    archive = b''.join(parts)
    assert len(archive) == index['archive']['size']
    assert sha(archive) == index['archive']['sha256']
    with zipfile.ZipFile(io.BytesIO(archive)) as z:
        assert z.testzip() is None
        manifest_bytes = z.read('manifest.json')
        assert sha(manifest_bytes) == index['archive']['manifestSha256']
        manifest = json.loads(manifest_bytes)
        listed = {entry['path']: entry for entry in manifest['files']}
        assert len(listed) == len(manifest['files'])
        assert set(z.namelist()) == {'manifest.json', *listed}
        assert len(z.namelist()) == len(listed) + 1
        for name, entry in listed.items():
            assert not name.startswith('/') and '..' not in Path(name).parts
            data = z.read(name)
            assert len(data) == entry['size'] and sha(data) == entry['sha256'], name
        original_bytes = z.read('metadata/original-preservation.json')
        metadata_bytes = z.read('metadata/artifact.json')
        assert sha(original_bytes) == CONFIG['preservationSha256']
        assert sha(metadata_bytes) == CONFIG['metadataSha256']
        original = json.loads(original_bytes)
        metadata = json.loads(metadata_bytes)
        members = {entry['name']: entry for entry in original['members']}
        assert len(members) == len(original['members']) == 317
        assert original['crcPassed'] is True
        assert original['artifactId'] == metadata['id'] == manifest['artifactId'] == index['artifactId'] == CONFIG['artifactId']
        assert original['runId'] == metadata['workflow_run']['id'] == manifest['runId'] == 46113567719
        assert original['jobId'] == manifest['jobId'] == CONFIG['jobId']
        assert original['zipBytes'] == metadata['size_in_bytes'] == manifest['originalArtifact']['size'] == CONFIG['originalZip']['size']
        assert original['zipSha256'] == manifest['originalArtifact']['sha256'] == metadata['digest'][7:]
        assert original['zipSha256'] == CONFIG['originalZip']['sha256']
        omitted = {entry['name']: entry for entry in manifest['omitted']}
        assert set(omitted) == {'result/package-A.zip', 'result/package-B.zip'}
        retained = {name[len('artifact/'):]: entry for name, entry in listed.items() if name.startswith('artifact/')}
        assert set(retained) == set(members) - set(omitted)
        for name, original_entry in members.items():
            actual = omitted[name] if name in omitted else retained[name]
            size = actual['bytes'] if name in omitted else actual['size']
            assert size == original_entry['bytes'] and actual['sha256'] == original_entry['sha256'], name
        assert len(retained) == index['retainedArtifactFiles'] == 315
        assert sum(x['size'] for x in retained.values()) == index['retainedArtifactBytes'] == CONFIG['retainedArtifactBytes']
        assert sum(x['bytes'] for x in omitted.values()) == index['omittedPayloadBytes'] == CONFIG['omittedPackageBytes']
        assert sum(x['bytes'] for x in members.values()) == manifest['originalArtifact']['extractedBytes'] == CONFIG['extractedBytes']
        identities = json.loads(z.read('artifact/result/source-identities.json'))
        for name, entry in omitted.items():
            arm = entry['identityArm']
            assert entry['sha256'] == identities['arms'][arm]['packageSha256']
            assert entry['entryCount'] == len(identities['arms'][arm]['entries']) == 554
        plan = json.loads(z.read('artifact/result/registered-plan.json'))
        observations = json.loads(z.read('artifact/result/observations.json'))
        assert [(x['id'], x['kind'], x['pair'], x['arm']) for x in observations] == [(x['id'], x['kind'], x['pair'], x['arm']) for x in plan['schedule']]
        assert len(observations) == 36
        assert plan['dictionary'] == CONFIG['dictionary'] and plan['initialOrder'] == CONFIG['initialOrder']
        ordinary = ('summary.json', 'run-1.json', 'run-1.html', 'canonical-receipt.json', 'run.log', 'host-before.json', 'host-after.json')
        for observation in observations:
            for filename in ordinary:
                assert f"result/{observation['id']}/{filename}" in retained
        for arm in ('A', 'B'):
            for filename in ordinary[:5]:
                assert f'result/exhaustive-media-{arm}/{filename}' in retained
        memory_plan = json.loads(z.read('artifact/result/memory/plan.json'))
        expected_memory = ['A1', 'B1', 'B2', 'A2'] if CONFIG['initialOrder'] == 'AB' else ['B1', 'A1', 'A2', 'B2']
        assert [x['name'] for x in memory_plan['schedule']] == expected_memory
        scan_counts = {}
        for observation in memory_plan['schedule']:
            name = observation['name']
            for filename in (*ordinary[:5], 'memory.json', 'markers.jsonl'):
                assert f'result/memory/{name}/{filename}' in retained
            memory = json.loads(z.read(f'artifact/result/memory/{name}/memory.json'))
            scan_counts[name] = len(memory['samples'])
        assert privacy['scannedFiles'] == len(listed) == 318
    return {
        'status': 'passed', 'scope': 'Saved-byte integrity and complete non-package artifact preservation only; no numerical qualification or product execution',
        'artifactId': CONFIG['artifactId'], 'archiveSha256': sha(archive), 'retainedArtifactFiles': 315,
        'retainedArtifactBytes': CONFIG['retainedArtifactBytes'], 'extraMetadataFiles': 3, 'explicitOmittedPackageFiles': 2,
        'ordinarySlotDirectories': 36, 'exhaustiveMediaDirectories': 2, 'memorySlotDirectories': 4,
        'rawMemoryScanCounts': scan_counts, 'allOriginalNonPackageBytesPreserved': True,
        'originalInputsRequiredToVerifyThisBundle': False,
    }


if __name__ == '__main__':
    print(json.dumps(main(), indent=2))
