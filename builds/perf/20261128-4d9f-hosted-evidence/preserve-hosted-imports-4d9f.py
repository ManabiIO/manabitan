#!/usr/bin/env python3
"""Preserve pinned CI artifacts and audit completed current-metadata VN cells.

This performs no import, benchmark, build, package mutation, or cohort retry.
Product ZIP bytes are omitted only after their hash AND every nested member hash
match a complete inventory retained inside the same pinned artifact. Unknown or
unproved ZIPs remain byte-for-byte in the deterministic evidence archive.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile

CORE_SHA256 = '83f6c2eabcd31232dade45596c5df833fe87879e095267cda250aa44780347ee'
VALIDATOR_COMMIT = 'f28c2801fcfd9416f220b46b9cbafeee901c1cb2'
HELPER_HASHES = {
    'audit_memory.py': '871f29b9d87c42468714263a0eda05ee9edd2f76bff269ea9cb6d6d1fe51de7c',
    'protocol.py': 'ea0e7c20bbc1273cbe81891c32ecc72658d70ed1bbf1d57cdcfae5b347d493c7',
    'qualification_receipts.py': '4f7b4eee4f8ff71e821c9162e57524460c48f01f409487f638523a3a27aa8f51',
}
CURRENT_RUN = 46135718522
CURRENT_BASELINE = 'f28c2801fcfd9416f220b46b9cbafeee901c1cb2'
CURRENT_CANDIDATE = '68b29e5a959470e76ff67a93ec8b300cc53f1254'
CURRENT_VN_NAMES = {
    'import-current-implicit-metadata-vndb-AB-currentbase1-4d9f',
    'import-current-implicit-metadata-vndb-BA-currentbase1-4d9f',
}
HEX64 = re.compile(r'[a-f0-9]{64}')
SAFE_NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,180}')


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest_bytes(value):
    return hashlib.sha256(value).hexdigest()


def hash_stream(stream):
    result = hashlib.sha256()
    count = 0
    while block := stream.read(1024 * 1024):
        result.update(block)
        count += len(block)
    return count, result.hexdigest()


def hash_file(path):
    with path.open('rb') as stream:
        return hash_stream(stream)[1]


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + '\n')


def safe_failure(error):
    # Never expose temporary signed download URLs, credentials, or HTTP headers.
    return {'exceptionType': type(error).__name__,
            'httpCode': getattr(error, 'code', None),
            'details': str(error) if isinstance(error, (ValueError, AssertionError)) else None}


def safe_member(name):
    require(isinstance(name, str) and name and '\x00' not in name and '\\' not in name,
            'Invalid archive member name')
    path = PurePosixPath(name)
    require(path.parts and not path.is_absolute() and '..' not in path.parts and
            path.as_posix() == name.rstrip('/'), 'Noncanonical archive member path')
    return name.rstrip('/')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        return None


def download_artifact(repository, artifact, destination, token):
    require(not destination.exists(), 'Refusing to overwrite a downloaded artifact')
    partial = destination.with_suffix('.partial')
    require(not partial.exists(), 'Refusing to overwrite a partial download')
    url = f'https://api.github.com/repos/{repository}/actions/artifacts/{artifact["id"]}/zip'
    request = urllib.request.Request(url, headers={
        'Accept': 'application/vnd.github+json',
        'Authorization': 'Bearer ' + token,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'manabitan-pinned-evidence-preserver',
    })
    try:
        response = urllib.request.build_opener(NoRedirect).open(request, timeout=60)
    except urllib.error.HTTPError as error:
        require(error.code in (301, 302, 303, 307, 308), 'Artifact API did not return a download redirect')
        location = error.headers.get('Location', '')
        parsed = urllib.parse.urlsplit(location)
        require(parsed.scheme == 'https' and parsed.hostname and
                parsed.username is None and parsed.password is None,
                'Artifact API returned an invalid HTTPS download location')
        # Deliberately create a NEW request without the GitHub authorization.
        response = urllib.request.urlopen(location, timeout=60)
    with response, partial.open('xb') as target:
        shutil.copyfileobj(response, target, length=1024 * 1024)
    require(partial.stat().st_size == artifact['size'], 'Downloaded artifact size differs')
    require(hash_file(partial) == artifact['sha256'], 'Downloaded artifact digest differs')
    partial.rename(destination)


def package_proofs(archive):
    """Find existing complete package inventories; never invent an allowlist."""
    proofs = {}

    def visit(value, source):
        if isinstance(value, dict):
            digest = value.get('packageSha256')
            entries = value.get('entries')
            if (isinstance(digest, str) and HEX64.fullmatch(digest) and
                    isinstance(entries, dict) and entries and
                    all(isinstance(k, str) and isinstance(v, str) and HEX64.fullmatch(v)
                        for k, v in entries.items())):
                previous = proofs.get(digest)
                require(previous is None or previous['entries'] == entries,
                        'Conflicting package inventories inside one artifact')
                proofs[digest] = {'entries': entries, 'source': source}
            for nested in value.values():
                visit(nested, source)
        elif isinstance(value, list):
            for nested in value:
                visit(nested, source)

    for info in archive.infolist():
        if (PurePosixPath(info.filename).name in
                ('source-identities.json', 'source-identity.json', 'package-audit.json') and
                not info.is_dir() and info.file_size <= 4 * 1024 * 1024):
            visit(json.loads(archive.read(info)), info.filename)
    return proofs


def verified_package(archive, info, proof):
    """Spool nested ZIP to disk; verify all entries without extracting paths."""
    with tempfile.TemporaryFile() as temporary:
        with archive.open(info) as stream:
            shutil.copyfileobj(stream, temporary, length=1024 * 1024)
        temporary.seek(0)
        with zipfile.ZipFile(temporary) as package:
            all_names = package.namelist()
            require(len(all_names) == len(set(all_names)), 'Duplicate nested ZIP member')
            entries = {}
            for member in package.infolist():
                safe_member(member.filename)
                if not member.is_dir():
                    with package.open(member) as stream:
                        size, digest = hash_stream(stream)
                    require(size == member.file_size, 'Nested ZIP member was clipped')
                    entries[member.filename] = digest
        require(entries == proof['entries'], 'Nested product ZIP differs from its complete inventory')
        return entries


def archive_artifact(zip_path, output, artifact):
    """Archive every original file except independently verified product ZIPs."""
    output.mkdir(parents=True, exist_ok=False)
    inventory = []
    exclusions = []
    with zipfile.ZipFile(zip_path) as archive:
        infos = archive.infolist()
        require(len({info.filename for info in infos}) == len(infos), 'Duplicate artifact ZIP member')
        proofs = package_proofs(archive)
        for info in infos:
            safe_member(info.filename)
            require(not (info.flag_bits & 1), 'Encrypted artifact member is unsupported')
            if info.is_dir():
                inventory.append({'name': info.filename, 'kind': 'directory'})
                continue
            with archive.open(info) as stream:
                size, digest = hash_stream(stream)
            require(size == info.file_size, 'Artifact member was clipped')
            record = {'name': info.filename, 'kind': 'file', 'bytes': size, 'sha256': digest}
            if info.filename.lower().endswith('.zip') and digest in proofs:
                entries = verified_package(archive, info, proofs[digest])
                record['excludedVerifiedProductZip'] = True
                exclusions.append({'name': info.filename, 'bytes': size, 'sha256': digest,
                                   'inventorySource': proofs[digest]['source'], 'entries': entries})
            inventory.append(record)
        kept = {item['name']: item for item in inventory
                if item['kind'] == 'file' and not item.get('excludedVerifiedProductZip', False)}
        target = output / 'verified-evidence.tar.xz'
        with tarfile.open(target, 'w:xz', format=tarfile.PAX_FORMAT, preset=6) as tar:
            for name in sorted(kept):
                item = kept[name]
                header = tarfile.TarInfo(name)
                header.size = item['bytes']
                header.mode = 0o644
                header.uid = header.gid = header.mtime = 0
                header.uname = header.gname = ''
                with archive.open(name) as stream:
                    tar.addfile(header, stream)
    with tarfile.open(target, 'r:xz') as tar:
        members = tar.getmembers()
        require(len(members) == len(kept) and all(item.isfile() for item in members),
                'Preserved archive inventory differs')
        require({item.name for item in members} == set(kept), 'Preserved member names differ')
        for member in members:
            with tar.extractfile(member) as stream:
                size, digest = hash_stream(stream)
            require(size == kept[member.name]['bytes'] and digest == kept[member.name]['sha256'],
                    'Preserved archive member differs from its original artifact')
    write_json(output / 'artifact-members.json', inventory)
    write_json(output / 'verified-product-zips.json', exclusions)
    receipt = {
        'schemaVersion': 1, 'artifact': artifact,
        'archive': target.name, 'archiveBytes': target.stat().st_size,
        'archiveSha256': hash_file(target), 'verifiedFileCount': len(kept),
        'verifiedFileBytes': sum(item['bytes'] for item in kept.values()),
        'excludedVerifiedProductZipCount': len(exclusions),
        'everyPreservedMemberVerified': True, 'deterministicTarMetadata': True,
        'qualification': 'Preservation only; semantic audit status is recorded separately.',
    }
    write_json(output / 'archive-receipt.json', receipt)
    return receipt


def run_current_vn_audit(artifact, downloaded, output, scratch, source_root, audit_helper):
    selected = [{'id': artifact['id'], 'name': artifact['name'],
                 'size_in_bytes': artifact['size'], 'digest': 'sha256:' + artifact['sha256']}]
    manifest = output / 'independent-audit-input.json'
    write_json(manifest, selected)
    extraction = scratch / ('audit-' + str(artifact['id']))
    command = [sys.executable, str(audit_helper), '--source-root', str(source_root),
               '--artifacts', str(downloaded.parent), '--artifact-manifest', str(manifest),
               '--baseline', CURRENT_BASELINE, '--candidate', CURRENT_CANDIDATE,
               '--output', str(extraction)]
    with (output / 'independent-audit.log').open('wb') as log:
        result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT)
    receipt = {'command': command, 'returncode': result.returncode,
               'helperSha256': CORE_SHA256,
               'status': 'audit-passed' if result.returncode == 0 else 'audit-failed'}
    report = extraction / 'independent-audit.json'
    if report.is_file():
        shutil.copy2(report, output / 'independent-audit.json')
        receipt['results'] = json.loads(report.read_text())
        receipt['memoryScreenFailedCells'] = [
            item['artifact']['name'] for item in receipt['results']
            if not item['memory']['passesProspectiveMemoryScreen']]
    if result.returncode == 0:
        require(report.is_file(), 'Successful audit has no final report')
        # The original nonpackage files are already independently archived.
        # Keep all independently derived receipts before reclaiming the duplicate.
        for item in extraction.rglob('*'):
            if item.is_file() and item.name in ('independent-audit.json', 'artifact-members.json'):
                destination = output / 'audit-derived' / item.relative_to(extraction)
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(item, destination)
        shutil.rmtree(extraction)
    write_json(output / 'independent-audit-exit.json', receipt)
    return receipt


def manifest_artifacts(manifest):
    require(manifest.get('schemaVersion') == 1 and manifest.get('repository') == 'ManabiIO/manabitan',
            'Unexpected preservation manifest repository or schema')
    result = []
    for run in manifest['runs']:
        require(type(run['id']) is int and run['id'] > 0, 'Invalid workflow run ID')
        for item in run['artifacts']:
            require(type(item['id']) is int and item['id'] > 0 and
                    isinstance(item['name'], str) and SAFE_NAME.fullmatch(item['name']) and
                    '..' not in item['name'] and type(item['size']) is int and item['size'] > 0 and
                    isinstance(item['sha256'], str) and HEX64.fullmatch(item['sha256']),
                    'Invalid pinned artifact identity')
            result.append({**item, 'runId': run['id']})
    require(result and len({a['id'] for a in result}) == len(result) and
            len({a['name'] for a in result}) == len(result), 'Duplicate or empty artifact manifest')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--manifest-sha256', required=True)
    parser.add_argument('--source-root', type=Path, required=True)
    parser.add_argument('--audit-helper', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--scratch', type=Path, required=True)
    args = parser.parse_args()
    require(__debug__, 'Optimized Python disables frozen audit assertions')
    require(hash_file(args.manifest) == args.manifest_sha256, 'Pinned manifest source differs')
    require(hash_file(args.audit_helper) == CORE_SHA256, 'Frozen generic audit source differs')
    source_root = args.source_root.resolve()
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=source_root, text=True).strip()
    require(head == VALIDATOR_COMMIT, 'Validator checkout must be exact frozen f28')
    for name, wanted in HELPER_HASHES.items():
        require(hash_file(source_root / 'dev/perf/import-memory-20261125-a7f7' / name) == wanted,
                'Frozen qualification helper source differs: ' + name)
    token = os.environ.get('GITHUB_TOKEN') or os.environ.get('GH_TOKEN')
    require(isinstance(token, str) and token, 'A repository-scoped artifact-read token is required')
    manifest = json.loads(args.manifest.read_text())
    artifacts = manifest_artifacts(manifest)
    output = args.output.resolve()
    scratch = args.scratch.resolve()
    output.mkdir(parents=True, exist_ok=False)
    scratch.mkdir(parents=True, exist_ok=False)
    shutil.copy2(args.manifest, output / 'pinned-artifact-manifest.json')
    shutil.copy2(args.audit_helper, output / 'audit-hosted-imports-4d9f.py')
    shutil.copy2(Path(__file__), output / Path(__file__).name)
    write_json(output / 'source-receipt.json', {
        'driverSha256': hash_file(Path(__file__)), 'manifestSha256': args.manifest_sha256,
        'auditHelperSha256': CORE_SHA256, 'validatorCommit': head,
        'qualificationHelperHashes': HELPER_HASHES,
        'newAcquisitions': False,
        'freshIndependentAuditScope': 'Completed current f28/68b VN AB/BA artifacts only.',
        'priorAudits': 'Other source-bound prior audits are not replaced or relabeled by this preservation job.',
    })
    results = []
    failed = False
    for artifact in artifacts:
        entry = output / 'artifacts' / str(artifact['id'])
        downloaded = scratch / (artifact['name'] + '.zip')
        result = {'artifact': artifact}
        try:
            download_artifact(manifest['repository'], artifact, downloaded, token)
            result['preservation'] = archive_artifact(downloaded, entry, artifact)
            if artifact['runId'] == CURRENT_RUN and artifact['name'] in CURRENT_VN_NAMES:
                audit = run_current_vn_audit(artifact, downloaded, entry, scratch,
                                             source_root, args.audit_helper.resolve())
                result['independentAudit'] = audit
                failed |= audit['returncode'] != 0
            else:
                result['independentAudit'] = {'status': 'not-recomputed-preservation-only'}
            downloaded.unlink()
        except Exception as error:
            failed = True
            result['error'] = safe_failure(error)
            partial = downloaded.with_suffix('.partial')
            if partial.is_file():
                result['partialDownload'] = {'bytes': partial.stat().st_size, 'sha256': hash_file(partial)}
        results.append(result)
        write_json(output / 'preservation-index.json', {
            'schemaVersion': 1, 'manifestSha256': args.manifest_sha256,
            'requestedArtifacts': len(artifacts), 'processedArtifacts': len(results),
            'complete': len(results) == len(artifacts) and not failed,
            'pendingSourceAcquisitions': manifest.get('pending', []),
            'qualificationGateFailures': [name for item in results
                for name in item.get('independentAudit', {}).get('memoryScreenFailedCells', [])],
            'results': results,
        })
        print(json.dumps({'artifactId': artifact['id'], 'name': artifact['name'],
                          'preserved': 'preservation' in result,
                          'audit': result.get('independentAudit', {}).get('status'),
                          'memoryScreenFailedCells': result.get('independentAudit', {}).get('memoryScreenFailedCells', []),
                          'failed': 'error' in result}), flush=True)
    raise SystemExit(1 if failed else 0)


if __name__ == '__main__':
    main()
