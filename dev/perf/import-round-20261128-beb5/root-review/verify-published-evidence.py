import hashlib
import io
import json
import posixpath
import re
import subprocess
import sys
import zipfile
from pathlib import Path


expected_path, output_path = map(Path, sys.argv[1:3])
expected = json.loads(expected_path.read_text())
repo = Path('/tmp/manabitan-beb5/final-evidence-readback.git')


def git(*args):
    return subprocess.check_output(['git', *args], cwd=repo)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def blob_sha(data):
    return hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()


commit = expected['commit']
assert git('rev-parse', commit + '^{tree}').decode().strip() == expected['tree']
assert git('rev-parse', commit + '^').decode().strip() == expected['parent']
nodes = expected['nodes']
assert len({n['path'] for n in nodes}) == len(nodes)
paths = {n['path'] for n in nodes}
diff_base = expected.get('diffBase', expected['parent'])
changed = git('diff-tree', '--no-commit-id', '--name-only', '-r', diff_base, commit).decode().splitlines()
assert set(changed) <= paths, sorted(set(changed) - paths)
assert all(p.startswith('dev/perf/import-round-20261128-beb5/') for p in changed)
for node in nodes:
    assert node['mode'] == '100644' and node['type'] == 'blob'
    assert git('rev-parse', commit + ':' + node['path']).decode().strip() == node['sha'], node['path']

files = []
archives = []
links = []
for item in expected['files']:
    local = Path(item['localPath']).read_bytes()
    digest = item.get('sha') or item.get('gitBlobSha')
    assert len(local) == item['bytes'], item['path']
    assert sha256(local) == item['sha256'], item['path']
    assert blob_sha(local) == digest, item['path']
    remote = git('show', commit + ':' + item['path'])
    assert remote == local, item['path']
    files.append({'path': item['path'], 'bytes': len(remote), 'sha256': sha256(remote), 'gitBlob': digest})
    if item['path'].endswith('.md'):
        text = remote.decode()
        for target in re.findall(r'\[[^\]]*\]\(([^)]+)\)', text):
            target = target.split(' ', 1)[0].split('#', 1)[0]
            if not target or re.match(r'^[a-zA-Z][a-zA-Z0-9+.-]*:', target):
                continue
            destination = posixpath.normpath(posixpath.join(posixpath.dirname(item['path']), target))
            git('cat-file', '-e', commit + ':' + destination)
            links.append({'source': item['path'], 'target': destination})
    original_meta = item.get('derivesFromOriginalArchive')
    if original_meta:
        original_bytes = Path(original_meta['localPath']).read_bytes()
        assert len(original_bytes) == original_meta['bytes'], original_meta['localPath']
        assert sha256(original_bytes) == original_meta['sha256'], original_meta['localPath']
        with zipfile.ZipFile(io.BytesIO(original_bytes)) as original, zipfile.ZipFile(io.BytesIO(remote)) as retained:
            original_names = original.namelist()
            retained_names = retained.namelist()
            assert len(set(original_names)) == len(original_names)
            assert len(set(retained_names)) == len(retained_names)
            omitted = {'package-A.zip', 'package-B.zip'}
            assert omitted <= set(original_names)
            assert set(retained_names) == set(original_names) - omitted
            member_bytes = 0
            for name in retained_names:
                data = original.read(name)
                assert retained.read(name) == data, (item['path'], name)
                member_bytes += len(data)
            packages = [{'name': name, 'bytes': len(original.read(name)), 'sha256': sha256(original.read(name))} for name in sorted(omitted)]
            original_audit = json.loads(original.read('independent-audit.json'))
            local_audit_path = posixpath.join(posixpath.dirname(item['path']), 'local-independent-audit.json')
            local_audit = json.loads(git('show', commit + ':' + local_audit_path))
            assert original_audit == local_audit, item['path']
            archives.append({'path': item['path'], 'originalArtifactId': original_meta['artifactId'], 'originalBytes': len(original_bytes), 'originalSha256': sha256(original_bytes), 'originalMembers': len(original_names), 'retainedMembers': len(retained_names), 'retainedMemberBytes': member_bytes, 'omittedPackages': packages, 'allRetainedOriginalMemberBytesEqual': True, 'localAuditDeepEqualsOriginalHostedAudit': True})

result = {
    'scope': 'Independent root readback from fetched immutable Git objects. Every listed local file is byte-identical to its remote blob. Each compact browser ZIP retains every original member byte except the two explicitly omitted package ZIPs; complete originals are independently rehashed. No timing was rerun.',
    'limits': 'Compact archives cannot alone reproduce the complete package audit because the package payloads are omitted. Original complete ZIPs were used locally for this verification. The two complete hosted source/unit logs without localPath are bound by the connector-created expected Git blob IDs.',
    'expectedManifestSha256': sha256(expected_path.read_bytes()),
    'verificationScriptSha256': sha256(Path(__file__).read_bytes()),
    'commit': commit,
    'tree': expected['tree'],
    'parent': expected['parent'],
    'diffBase': diff_base,
    'changedPaths': changed,
    'verifiedTreeNodes': len(nodes),
    'verifiedLocalFiles': files,
    'archives': archives,
    'relativeLinks': links,
    'passed': True,
}
output_path.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'passed': True, 'commit': commit, 'nodes': len(nodes), 'localFiles': len(files), 'archives': len(archives), 'retainedMembers': sum(a['retainedMembers'] for a in archives), 'relativeLinks': len(links), 'receipt': str(output_path), 'receiptSha256': sha256(output_path.read_bytes())}))
