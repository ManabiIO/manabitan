#!/usr/bin/env python3
"""Verify a compact research archive and reconstruct its source trees.

No worktree or real index is changed. With --repo, new objects may be written to
that repository's object database; no refs are created or moved. The repository
must already contain the recorded baseline and its tree/blob dependencies.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import tarfile
import tempfile


if not __debug__:
    raise RuntimeError('Assertions are required for archive verification')


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def git(repo: Path, *args: str, data: bytes | None = None, env=None) -> bytes:
    options = {**os.environ, 'GIT_NO_LAZY_FETCH': '1', 'GIT_TERMINAL_PROMPT': '0'}
    if env:
        options.update(env)
    result = subprocess.run(
        ['git', '-C', str(repo), '-c', 'core.sparseCheckout=false',
         '-c', 'core.sparseCheckoutCone=false', '-c', 'index.sparse=false', *args],
        input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        env=options, timeout=30,
    )
    if result.returncode:
        raise RuntimeError(f'Git command failed ({args!r}): {result.stderr.decode(errors="replace")}')
    return result.stdout


def reconstruct_sources(repo: Path, manifest: dict, load) -> dict:
    repo = repo.resolve()
    baseline = manifest['baseline']
    assert git(repo, 'rev-parse', baseline['commit'] + '^{tree}').decode().strip() == baseline['tree']
    assert git(repo, 'rev-parse', '--show-object-format').decode().strip() == 'sha1'
    index_path = Path(git(repo, 'rev-parse', '--git-path', 'index').decode().strip())
    if not index_path.is_absolute():
        index_path = repo / index_path
    index_before = sha256(index_path.read_bytes()) if index_path.exists() else None
    known = {baseline['commit']}
    observations = []
    with tempfile.TemporaryDirectory(prefix='import-archive-index-') as temporary:
        for number, item in enumerate(manifest['sourceCommitPatches']):
            commit, parent = item['commit'], item['parent']
            assert parent in known, f'Missing parent closure before {commit}: {parent}'
            raw = load(item['rawCommitPath'])
            patch = load(item['patchPath'])
            assert sha256(raw) == item['rawCommitSha256']
            assert sha256(patch) == item['patchSha256'] and len(patch) == item['patchBytes']
            object_id = hashlib.sha1(b'commit ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()
            assert object_id == commit
            header = raw.split(b'\n\n', 1)[0].decode().splitlines()
            assert header[0] == 'tree ' + item['tree']
            assert [line[7:] for line in header if line.startswith('parent ')] == [parent]
            index = Path(temporary) / f'{number:03d}-{commit}.index'
            environment = {'GIT_INDEX_FILE': str(index)}
            git(repo, 'read-tree', parent, env=environment)
            if patch:
                git(repo, 'apply', '--cached', '--binary', '-', data=patch, env=environment)
            tree = git(repo, 'write-tree', env=environment).decode().strip()
            assert tree == item['tree'], f'Tree mismatch for {commit}: {tree}'
            written_commit = git(repo, 'hash-object', '-w', '-t', 'commit', '--stdin',
                                 data=raw, env=environment).decode().strip()
            assert written_commit == commit
            observations.append({
                'commit': commit, 'parent': parent, 'expectedTree': item['tree'],
                'reconstructedTree': tree, 'rawCommitObjectVerified': True,
                'binaryPatchAppliedToSeparateTemporaryIndex': True,
            })
            known.add(commit)
            index.unlink()
    index_after = sha256(index_path.read_bytes()) if index_path.exists() else None
    assert index_before == index_after, 'The real repository index changed during verification'
    return {
        'status': 'passed', 'baseline': baseline, 'commitCount': len(observations),
        'allParentsIncludedInDependencyOrder': True, 'realIndexUnchanged': True,
        'realIndexSha256': index_before, 'worktreesModified': False,
        'refsCreatedOrMoved': False, 'observations': observations,
    }


def inspect_archive(path: Path, repo: Path | None = None) -> dict:
    with tarfile.open(path, 'r:gz') as archive:
        members = archive.getmembers()
        assert len({m.name for m in members}) == len(members), 'Duplicate archive member'
        for member in members:
            name = PurePosixPath(member.name)
            assert member.isfile() and not name.is_absolute() and '..' not in name.parts
        manifest_bytes = archive.extractfile('manifest.json').read()
        manifest = json.loads(manifest_bytes)
        expected = {item['archivePath']: item for item in manifest['files']}
        assert set(expected) | {'manifest.json'} == {m.name for m in members}
        retained_source = {}
        total = 0
        for member in members:
            if member.name == 'manifest.json':
                continue
            data = archive.extractfile(member).read()
            item = expected[member.name]
            assert len(data) == item['bytes'] and sha256(data) == item['sha256'], member.name
            total += len(data)
            if member.name.startswith(('source-patches/', 'commit-objects/')):
                retained_source[member.name] = data
        result = {
            'status': 'passed', 'manifestSha256': sha256(manifest_bytes),
            'memberCount': len(members), 'payloadFileBytes': total,
            'allMemberPathsSafeAndRegular': True, 'allFileHashesVerified': True,
        }
        result['nestedArchives'] = []
        for nested in manifest.get('nestedArchives', []):
            raw = archive.extractfile(nested['archivePath']).read()
            assert sha256(raw) == nested['sha256']
            with tarfile.open(fileobj=io.BytesIO(raw), mode='r:gz') as inner:
                inner_members = inner.getmembers()
                assert len({m.name for m in inner_members}) == len(inner_members)
                inner_manifest_bytes = inner.extractfile('manifest.json').read()
                assert sha256(inner_manifest_bytes) == nested['manifestSha256']
                inner_manifest = json.loads(inner_manifest_bytes)
                inner_expected = {item['archivePath']: item for item in inner_manifest['files']}
                assert set(inner_expected) | {'manifest.json'} == {m.name for m in inner_members}
                for member in inner_members:
                    name = PurePosixPath(member.name)
                    assert member.isfile() and not name.is_absolute() and '..' not in name.parts
                    if member.name == 'manifest.json':
                        continue
                    data = inner.extractfile(member).read()
                    identity = inner_expected[member.name]
                    assert len(data) == identity['bytes'] and sha256(data) == identity['sha256']
                result['nestedArchives'].append({'archivePath': nested['archivePath'],
                    'sha256': sha256(raw), 'manifestSha256': sha256(inner_manifest_bytes),
                    'memberCount': len(inner_members), 'allMemberPathsSafeAndRegular': True,
                    'allFileHashesVerified': True})
        if repo:
            result['sourceReconstruction'] = reconstruct_sources(repo, manifest, retained_source.__getitem__)
    hasher = hashlib.sha256()
    with path.open('rb') as stream:
        for data in iter(lambda: stream.read(1024 * 1024), b''):
            hasher.update(data)
    result['archiveSha256'] = hasher.hexdigest()
    result['archiveBytes'] = path.stat().st_size
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    parser.add_argument('--repo', type=Path,
                        help='Optional existing Git repository containing the exact baseline')
    arguments = parser.parse_args()
    print(json.dumps(inspect_archive(arguments.archive, arguments.repo), indent=2))
