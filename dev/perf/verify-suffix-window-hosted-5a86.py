#!/usr/bin/env python3
"""Verify a preserved suffix cohort and source closure; never run imports."""
import argparse
import base64
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import zipfile
import zlib

BASE = '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2'
CAND = '38031a752b26c9b630e5f2f1d45e780786656c74'
TREES = {BASE: 'd99ea4d04658f7ec1c76acdc5f3684594212a471',
         CAND: 'a05ece005d9fb4931cb1fc24f0cb67ceb109a7f5'}
ORIGINAL_AUDITOR = 'd5857d4f14b27941ef657c1f0c2c1c89425caf3491e6f2d4101a4d859667f86d'
PACKAGE_LIMITATION = (
    'The original artifact ZIP and its two product ZIP payloads are not embedded. '
    'All other original members are losslessly retained, together with all package member hashes, '
    'exact changed package members, Git-verified source bytes, and the successful original full-package audit. '
    'Compact verification cannot repeat omitted package-byte checks without the original artifact.'
)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read(path):
    return json.loads(path.read_bytes())


def safe(name):
    path = PurePosixPath(name)
    require(not path.is_absolute() and '..' not in path.parts and path.as_posix() == name, 'Unsafe archive path')


def unpack(path, expected_format, destination):
    wrapper = read(path)
    require(wrapper['format'] == expected_format and wrapper['encoding'] == 'base64', 'Unexpected wrapper')
    manifest = wrapper['manifest']
    require(manifest['baseline'] == BASE and manifest['candidate'] == CAND, 'Changed source commits')
    data = base64.b64decode(wrapper['archive'], validate=True)
    record = manifest['archive']
    require(len(data) == record['bytes'] and sha(data) == record['sha256'], 'Archive identity changed')
    names = []
    total = 0
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:xz') as archive:
        for item in archive:
            safe(item.name)
            require(item.isfile() and item.name not in names and item.name in manifest['members'], 'Invalid archive member')
            require((item.mode, item.uid, item.gid, item.mtime, item.uname, item.gname) ==
                    (0o644, 0, 0, 0, '', ''), 'Archive metadata changed')
            payload = archive.extractfile(item).read()
            expected = manifest['members'][item.name]
            require(len(payload) == item.size == expected['bytes'] and sha(payload) == expected['sha256'], 'Member identity changed')
            output = destination / item.name
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(payload)
            names.append(item.name)
            total += len(payload)
    require(names == sorted(manifest['members']) and len(names) == record['members'], 'Archive coverage changed')
    if 'uncompressedBytes' in record:
        require(total == record['uncompressedBytes'], 'Uncompressed size changed')
    return manifest


def check_git_proof(root, manifest):
    require(manifest['trees'] == TREES, 'Changed source trees')
    require((root / 'HEAD').read_bytes() == b'ref: refs/heads/evidence\n' and
            (root / 'refs/heads/evidence').read_bytes() == CAND.encode() + b'\n' and
            (root / 'config').read_bytes() == b'[core]\n\trepositoryformatversion = 0\n\tbare = true\n', 'Unexpected Git configuration')
    expected = {'HEAD', 'refs/heads/evidence', 'config'}
    for oid, record in manifest['objects'].items():
        require(re.fullmatch('[a-f0-9]{40}', oid) is not None and record['type'] in ('blob', 'tree', 'commit'), 'Invalid Git object')
        name = 'objects/' + oid[:2] + '/' + oid[2:]
        expected.add(name)
        decoded = zlib.decompress((root / name).read_bytes())
        header, data = decoded.split(b'\0', 1)
        require(header == record['type'].encode() + b' ' + str(len(data)).encode() and
                len(data) == record['rawBytes'] and hashlib.sha1(decoded).hexdigest() == oid, 'Git object identity changed')
    require(set(manifest['members']) == expected, 'Unexpected Git proof file')
    # Validate the whole table before handing any manifest field to Git.
    for spec, identity in manifest['files'].items():
        require(isinstance(spec, str) and ':' in spec, 'Invalid Git source specification')
        revision, path = spec.split(':', 1)
        require(revision in TREES and path and '\0' not in path, 'Invalid Git source specification')
        safe(path)
        require(re.fullmatch('[a-f0-9]{40}', identity['blob']) is not None and
                re.fullmatch('[a-f0-9]{64}', identity['sha256']) is not None and
                type(identity['bytes']) is int and identity['bytes'] >= 0, 'Invalid Git source identity')
    for revision, tree in TREES.items():
        actual = subprocess.check_output(['git', 'rev-parse', revision + '^{tree}'], cwd=root).decode().strip()
        require(actual == tree, 'Commit/tree binding failed')
    for spec, identity in manifest['files'].items():
        data = subprocess.check_output(['git', 'show', spec], cwd=root)
        blob = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
        require(len(data) == identity['bytes'] and sha(data) == identity['sha256'] and blob == identity['blob'], 'Git path binding failed')


def check_original_proof(root, manifest, original_artifact):
    proof = read(root / 'original-artifact-proof.json')
    require(manifest['packageLimitation'] == proof['limitation'] == PACKAGE_LIMITATION,
            'Package retention limitation changed')
    metadata = proof['artifactMetadata']
    require(metadata == manifest['originalArtifact'] == read(root / 'review/artifact-metadata.json'), 'Artifact metadata mismatch')
    require(metadata['workflow_run']['id'] == manifest['run'] == 46104813593 and
            metadata['workflow_run']['head_sha'] == CAND, 'Acquisition identity changed')
    prefix = manifest['dictionary'] + '-' + manifest['order']
    require(metadata['name'] == 'suffix-window-' + prefix + '-5a86', 'Artifact cohort changed')
    inventory = proof['originalMembers']
    names = [entry['path'] for entry in inventory]
    require(names == sorted(set(names)), 'Original inventory is not complete and unique')
    omitted = {prefix + '/package-A.zip', prefix + '/package-B.zip'}
    require({entry['path'] for entry in inventory if not entry['retained']} == omitted, 'Unexpected omitted file')
    for entry in inventory:
        safe(entry['path'])
        if entry['retained']:
            data = (root / 'original' / entry['path']).read_bytes()
            require(len(data) == entry['bytes'] and sha(data) == entry['sha256'], 'Original retained member changed')
    actual_originals = {path.relative_to(root / 'original').as_posix() for path in (root / 'original').rglob('*') if path.is_file()}
    require(actual_originals == set(names) - omitted, 'Unregistered original file')
    identities = read(root / 'original' / prefix / 'source-identities.json')
    for arm in ('A', 'B'):
        package = proof['packages'][arm]
        require(package['sha256'] == identities['arms'][arm]['packageSha256'] and
                package['entries'] == identities['arms'][arm]['entries'] and len(package['entries']) == 554, 'Package inventory mismatch')
        for name in identities['changedPackageEntries']:
            data = (root / 'verified-package-source' / arm / name).read_bytes()
            require(sha(data) == package['entries'][name], 'Retained package source changed')
    if original_artifact is not None:
        data = original_artifact.read_bytes()
        require(len(data) == metadata['size_in_bytes'] and 'sha256:' + sha(data) == metadata['digest'], 'Supplied original artifact changed')
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            require(sorted(archive.namelist()) == names, 'Supplied original archive coverage changed')
            for entry in inventory:
                payload = archive.read(entry['path'])
                require(len(payload) == entry['bytes'] and sha(payload) == entry['sha256'], 'Supplied original member changed')
            for arm in ('A', 'B'):
                with zipfile.ZipFile(io.BytesIO(archive.read(prefix + '/package-' + arm + '.zip'))) as package:
                    require(len(package.namelist()) == len(set(package.namelist())), 'Duplicate package member')
                    entries = {name: sha(package.read(name)) for name in package.namelist() if not name.endswith('/')}
                    require(entries == proof['packages'][arm]['entries'], 'Original package bytes changed')
    return proof


def adapted_auditor(root):
    original = (root / 'review/audit-hosted.py').read_bytes()
    require(sha(original) == ORIGINAL_AUDITOR, 'Original auditor changed')
    source = original.decode()

    def replace_once(old, new):
        nonlocal source
        require(source.count(old) == 1, 'Auditor adaptation boundary changed')
        source = source.replace(old, new)

    replace_once("repo=Path('/workspace/scratch/5a86d1e7822a/manabitan')", 'repo=Path(sys.argv[5]).resolve()')
    replace_once("    archive=root/'artifact.zip';assert file_sha(archive)==expected_archive_sha", "    proof=read(root/'original-artifact-proof.json')\n    assert proof['artifactMetadata']['digest']=='sha256:'+expected_archive_sha")
    replace_once("    assert metadata['digest']=='sha256:'+expected_archive_sha and archive.stat().st_size==metadata['size_in_bytes']", "    assert metadata==proof['artifactMetadata'] and metadata['digest']=='sha256:'+expected_archive_sha")
    replace_once('    with zipfile.ZipFile(archive) as z:', '    with RetainedArchive(root,proof) as z:')
    start = source.index("            data=z.read(prefix+f'package-{arm}.zip')")
    end_marker = '                package_entries[arm]=entries'
    end = source.index(end_marker, start) + len(end_marker)
    source = source[:start] + """            package_proof=proof['packages'][arm]
            assert package_proof['sha256']==identity['packageSha256']
            entries=package_proof['entries']
            assert entries==identity['entries']
            for packaged,source_path in [('js/dictionary/wasm/term-bank-parser.c','ext/js/dictionary/wasm/term-bank-parser.c'),('lib/term-bank-parser.wasm','dev/data/dictionary-wasm/term-bank-parser.wasm')]:
                module=(root.parent/'verified-package-source'/arm/packaged).read_bytes()
                source=subprocess.check_output(['git','show',identity['sha']+':'+source_path],cwd=repo)
                assert module==source and sha(module)==entries[packaged],(arm,packaged)
            assert entries['lib/term-bank-parser.wasm']==expected_modules[arm]
            package_entries[arm]=entries""" + source[end:]
    retained_class = """class RetainedArchive:
    def __init__(self,root,proof):self.root=root;self.proof=proof
    def __enter__(self):return self
    def __exit__(self,*args):return False
    def namelist(self):return [entry['path'] for entry in self.proof['originalMembers']]
    def read(self,name):
        entry=next(entry for entry in self.proof['originalMembers'] if entry['path']==name)
        if not entry['retained']:raise ValueError('Original product ZIP is omitted')
        return (self.root/name).read_bytes()

"""
    replace_once("try:\n    proof=read(root/'original-artifact-proof.json')", retained_class + "try:\n    proof=read(root/'original-artifact-proof.json')")
    compile(source, 'adapted-original-auditor', 'exec')
    path = root / 'adapted-original-auditor.py'
    path.write_text(source)
    return path


def main():
    require(__debug__, 'Do not use optimized Python (-O)')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence', type=Path, required=True)
    parser.add_argument('--source-proof', type=Path, required=True)
    parser.add_argument('--original-artifact', type=Path)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='suffix-cohort-audit-', dir=Path.home()) as temporary:
        root = Path(temporary)
        git_root = root / 'git-proof'
        git_manifest = unpack(args.source_proof, 'suffix-git-source-proof-v1', git_root)
        check_git_proof(git_root, git_manifest)
        cohort = root / 'cohort'
        manifest = unpack(args.evidence, 'suffix-cohort-evidence-v1', cohort)
        require(manifest['dictionary'] in ('jmdict', 'jitendex', 'vndb') and manifest['order'] in ('AB', 'BA'), 'Unknown cohort')
        proof = check_original_proof(cohort, manifest, args.original_artifact)
        frozen_identities = read(cohort / 'review/frozen-source-identities.json')
        expected_frozen = {
            'dev/perf/import-memory-20261125-a7f7/' + name for name in
            ('qualification_receipts.py', 'audit_memory.py', 'protocol.py', 'chromium_memory.py')
        } | {'test/perf/dictionaries.lock.json', 'test/chromium/extension-two-dictionary-import.e2e.js',
             'dev/perf/import-qualification-20261125-a7f7.py',
             '.github/workflows/suffix-window-screen-5a86.yml', 'dev/perf/suffix-window-screen-5a86.py'}
        require(set(frozen_identities) == expected_frozen, 'Frozen executable source coverage changed')
        for relative, identity in frozen_identities.items():
            revision = CAND if 'suffix-window-screen' in relative else BASE
            data = (cohort / 'frozen-source' / relative).read_bytes()
            require(len(data) == identity['bytes'] and sha(data) == identity['sha256'] and
                    data == subprocess.check_output(['git', 'show', revision + ':' + relative], cwd=git_root), 'Frozen executable source changed')
        original_root = cohort / 'original'
        verified_source = original_root / 'frozen-source'
        require(not verified_source.exists(), 'Original artifact pre-seeds executable source')
        verified_source.mkdir()
        # Only Git-verified files enter the derived auditor's import path.
        # Extra retained archive members remain data, never importable helpers.
        for relative in sorted(expected_frozen):
            destination = verified_source / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(cohort / 'frozen-source' / relative, destination)
        for name in ('artifact-metadata.json', 'frozen-source-identities.json'):
            shutil.copyfile(cohort / 'review' / name, original_root / name)
        shutil.copyfile(cohort / 'original-artifact-proof.json', original_root / 'original-artifact-proof.json')
        script = adapted_auditor(cohort)
        completed = subprocess.run([sys.executable, '-I', '-B', str(script), str(original_root),
                                    proof['artifactMetadata']['digest'].removeprefix('sha256:'),
                                    manifest['order'], manifest['dictionary'], str(git_root)], capture_output=True, text=True)
        require(completed.returncode == 0, 'Original observation audit failed: ' + completed.stderr)
        reproduced = (original_root / 'independent-audit.json').read_bytes()
        require(reproduced == (cohort / 'review/independent-audit.json').read_bytes() and
                sha(reproduced) == manifest['originalAuditSha256'], 'Original audit result not reproduced')
        audit = json.loads(reproduced)
        print(json.dumps({'status': 'PASS', 'noNewAcquisition': True, 'dictionary': manifest['dictionary'],
                          'order': manifest['order'], 'candidate': CAND, 'baseline': BASE,
                          'semanticReceipts': audit['semanticReceiptCount'], 'rawMemoryScans': audit['memoryRawAudit']['rawScanCount'],
                          'analysis': audit['analysisRecomputed'], 'memory': audit['memoryRawAudit'],
                          'originalAuditSha256': sha(reproduced), 'cohortArchiveSha256': manifest['archive']['sha256'],
                          'sourceObjectClosureSha256': git_manifest['archive']['sha256'],
                          'originalProductZipBytesRechecked': args.original_artifact is not None,
                          'packageLimitation': PACKAGE_LIMITATION,
                          'scope': 'Every original receipt, exact schedule, all timing tails, frozen source/observer path, recorded package member identity, retained native C/WASM bytes, and raw sampled-memory observation are rechecked. Full omitted package bytes require the optional original artifact. No import is run.'}, indent=2))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('FAIL: ' + str(error), file=sys.stderr)
        raise SystemExit(1) from error
