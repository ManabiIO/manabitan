#!/usr/bin/env python3
"""Create deterministic, independently verifiable diagnostic/failure bundles."""
import hashlib
import io
import json
import lzma
from pathlib import Path
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parent
OUT = ROOT / 'bundles-current'
WORKSPACE = ROOT.parent
RUN = 45458402415

def digest(data):
    return hashlib.sha256(data).hexdigest()

def pack(name, members, metadata):
    stream = io.BytesIO()
    files = []
    with tarfile.open(fileobj=stream, mode='w', format=tarfile.USTAR_FORMAT) as archive:
        for path, data in sorted(members.items()):
            assert not Path(path).is_absolute() and '..' not in Path(path).parts
            info = tarfile.TarInfo(path)
            info.size = len(data)
            info.mode = 0o644
            info.mtime = 0
            archive.addfile(info, io.BytesIO(data))
            files.append({'path': path, 'bytes': len(data), 'sha256': digest(data)})
    payload = lzma.compress(stream.getvalue(), preset=6)
    filename = name + '.tar.xz'
    (OUT / filename).write_bytes(payload)
    archive_meta = {'path': filename, 'bytes': len(payload), 'sha256': digest(payload)}
    receipt = {'schemaVersion': 1, **metadata, 'archive': archive_meta, 'files': files}
    manifest = name + '.manifest.json'
    (OUT / manifest).write_text(json.dumps(receipt, indent=2) + '\n')
    with tarfile.open(OUT / filename, 'r:xz') as archive:
        assert set(archive.getnames()) == set(members)
        for item in files:
            data = archive.extractfile(item['path']).read()
            assert len(data) == item['bytes'] and digest(data) == item['sha256']
    return {'manifest': manifest, 'archive': archive_meta, **metadata}

def main():
    OUT.mkdir(exist_ok=True)
    artifacts = json.loads((ROOT / 'current-profile/artifacts.json').read_text())
    bundles = []
    for dictionary in ('jmdict', 'jitendex', 'vndb'):
        artifact = next(a for a in artifacts if a['name'] == f'critical-path-{dictionary}-{RUN}')
        original = ROOT / 'current-profile' / (artifact['name'] + '.zip')
        assert 'sha256:' + digest(original.read_bytes()) == artifact['digest']
        directory = ROOT / 'current-profile' / artifact['name']
        members = {}
        with zipfile.ZipFile(original) as archive:
            for name in ('source.json', 'summary.json', 'run-1.json', 'run-1.trace.json'):
                data = (directory / name).read_bytes()
                assert archive.read(name) == data
                members[f'diagnostics/{dictionary}/{name}'] = data
        source = json.loads(members[f'diagnostics/{dictionary}/source.json'])
        bundles.append(pack(f'baseline-profile-{dictionary}-{RUN}', members, {
            'kind': 'diagnostic-profile', 'dictionary': dictionary, 'diagnosticOnly': True,
            'baseline': source['base'], 'studyCommit': source['commit'],
            'originalArtifact': artifact, 'originalZipSha256Verified': True,
        }))
    analysis_members = {}
    for name in ('README.md', 'analyze_traces.py', 'jmdict-profile-analysis.json',
                 'jitendex-profile-analysis.json', 'vndb-profile-analysis.json', 'artifacts.json'):
        analysis_members['analysis/' + name] = (ROOT / 'current-profile' / name).read_bytes()
    analysis_members['analysis/runtime-verification.json'] = (WORKSPACE / 'toolchains/profile-runtime/verification.json').read_bytes()
    bundles.append(pack(f'baseline-profile-analysis-{RUN}', analysis_members, {
        'kind': 'diagnostic-analysis', 'diagnosticOnly': True, 'run': RUN,
        'note': 'Derived tables are separate from the exact raw reports and traces.',
    }))
    failure = WORKSPACE / 'study-20261124/builds/import-screen-20261124/sidecar-worker-20261124/vndb'
    state = json.loads((failure / 'summary.json').read_text())
    assert state['status'] == 'failed' and len(state['observations']) == 0
    failure_members = {'local-failure/' + path.relative_to(failure).as_posix(): path.read_bytes()
                       for path in failure.rglob('*') if path.is_file()}
    bundles.append(pack('local-sidecar-warmup-failure-20261124', failure_members, {
        'kind': 'retained-local-failure', 'status': state['status'], 'observations': 0,
        'baseline': state['baseline'], 'candidate': state['candidate'], 'studyCommit': state['studyCommit'],
        'reason': 'Chromium process-singleton AF_UNIX socket EPERM before first baseline import.',
        'note': 'All local failure files retained byte-for-byte; no timing observation was produced.',
    }))
    (OUT / 'index.json').write_text(json.dumps({'schemaVersion': 1, 'bundles': bundles}, indent=2) + '\n')
    print(json.dumps([{'kind': b['kind'], **b['archive']} for b in bundles], indent=2))

if __name__ == '__main__':
    main()

