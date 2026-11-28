#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Transport every member of one frozen import evidence cell without rerunning it.

The original Actions artifact is read through the normal gh API credential on
the runner. Its complete byte stream is hashed before ZIP inspection. Only the
explicit sibling source checkout is excluded; all cell evidence, packages and
failed observations are retained byte-for-byte in a smaller transport ZIP.
"""

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import time
import zipfile


CHUNK_BYTES = 1024 * 1024
MAX_API_BYTES = 8 * 1024 * 1024
MAX_TRANSPORT_BYTES = 500 * 1024 * 1024
ARTIFACT_CONNECTOR_LIMIT_BYTES = 512 * 1024 * 1024


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as source:
        for chunk in iter(lambda: source.read(CHUNK_BYTES), b''):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path, value):
    with Path(path).open('x') as target:
        json.dump(value, target, indent=2, sort_keys=True, allow_nan=False)
        target.write('\n')


def emit(event, value):
    print(event + ' ' + json.dumps(value, sort_keys=True, allow_nan=False), flush=True)


def require_equal(actual, expected, label):
    if type(actual) is not type(expected) or actual != expected:
        raise ValueError(f'{label} differs from its explicit frozen value')


def gh_environment():
    environment = os.environ.copy()
    environment.pop('GH_DEBUG', None)
    environment['GH_PROMPT_DISABLED'] = '1'
    return environment


def stream_api(endpoint, destination, *, limit, stderr_path, expected_size=None):
    """Stream one GET exactly once; do not inspect or print its credential."""
    command = ['gh', 'api', '--method', 'GET', endpoint]
    digest = hashlib.sha256()
    count = 0
    reported = 0
    started = time.monotonic()
    with Path(destination).open('xb') as output, Path(stderr_path).open('xb') as errors:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=errors, env=gh_environment())
        try:
            while True:
                chunk = process.stdout.read(CHUNK_BYTES)
                if not chunk:
                    break
                count += len(chunk)
                if count > limit:
                    raise ValueError('GET response exceeds its explicit byte bound')
                output.write(chunk)
                digest.update(chunk)
                if count - reported >= 64 * CHUNK_BYTES:
                    emit('TRANSPORT_DOWNLOAD_PROGRESS', {'bytes': count})
                    reported = count
            code = process.wait(timeout=60)
            if code != 0:
                raise RuntimeError(f'gh API GET failed with exit {code}; original stderr retained')
        except BaseException:
            process.kill()
            process.wait()
            raise
        finally:
            process.stdout.close()
    if expected_size is not None:
        require_equal(count, expected_size, 'Downloaded archive byte count')
    return {'bytes': count, 'sha256': digest.hexdigest(), 'seconds': time.monotonic()-started}


def fetch_json(endpoint, output, name):
    destination = output / name
    receipt = stream_api(endpoint, destination, limit=MAX_API_BYTES,
                         stderr_path=output/(name+'.stderr.log'))
    return json.loads(destination.read_text()), receipt


def validate_provider(artifact, run, args):
    for field, expected in (
        ('id', args.artifact_id), ('name', args.artifact_name),
        ('size_in_bytes', args.expected_size), ('digest', 'sha256:'+args.expected_sha256),
        ('expired', False),
    ):
        require_equal(artifact.get(field), expected, 'Artifact '+field)
    workflow = artifact.get('workflow_run')
    if type(workflow) is not dict:
        raise ValueError('Artifact has no workflow-run identity')
    require_equal(workflow.get('id'), args.run_id, 'Artifact workflow run')
    require_equal(workflow.get('head_sha'), args.expected_run_head, 'Artifact source workflow head')
    require_equal(run.get('id'), args.run_id, 'Workflow run ID')
    require_equal(run.get('head_sha'), args.expected_run_head, 'Workflow run head')
    require_equal(run.get('run_attempt'), args.expected_run_attempt, 'Workflow run attempt')
    require_equal(run.get('repository', {}).get('full_name'), args.repository, 'Workflow repository')
    require_equal(run.get('path'), '.github/workflows/import-qualification-88711ca9.yml', 'Original qualification workflow')


def checked_path(name):
    path = PurePosixPath(name)
    if not name or path.is_absolute() or '..' in path.parts or '\\' in name or '\x00' in name:
        raise ValueError(f'Unsupported archive member path: {name!r}')
    if path.as_posix() != name.rstrip('/'):
        raise ValueError(f'Noncanonical archive member path: {name!r}')
    return path


def select_cell(archive, host):
    items = archive.infolist()
    names = [item.filename for item in items]
    if len(names) != len(set(names)):
        raise ValueError('Original archive has duplicate member names')
    roots = set()
    for item in items:
        path = checked_path(item.filename)
        if host in path.parts:
            index = path.parts.index(host)
            roots.add('/'.join(path.parts[:index+1])+'/')
    if len(roots) != 1:
        raise ValueError('Expected exactly one original evidence root for the requested host')
    prefix = roots.pop()
    parent = prefix[:-len(host)-1]
    excluded_prefix = parent+host+'-sources/'
    selected = []
    excluded = []
    for item in items:
        name = item.filename
        if name.startswith(prefix):
            mode = stat.S_IFMT(item.external_attr >> 16)
            if mode not in (0, stat.S_IFREG, stat.S_IFDIR):
                raise ValueError('Cell evidence contains an unsupported nonregular member')
            if item.is_dir() and item.file_size != 0:
                raise ValueError('Nonempty directory evidence cannot be transported as an empty directory')
            if item.flag_bits & 1:
                raise ValueError('Encrypted cell evidence is unsupported')
            selected.append(item)
        elif name.startswith(excluded_prefix):
            excluded.append(item)
        elif item.is_dir() and (prefix.startswith(name) or excluded_prefix.startswith(name)):
            # Ancestor directory entries have no payload and are implicit in
            # the retained cell path, rather than omitted evidence files.
            continue
        else:
            raise ValueError(f'Unexpected member outside the cell and its sole sibling source checkout: {name!r}')
    files = [item for item in selected if not item.is_dir()]
    if not files:
        raise ValueError('Requested evidence cell has no payload files')
    return prefix, selected, excluded, {
        'originalMemberCount': len(items),
        'originalUncompressedBytes': sum(item.file_size for item in items),
        'evidencePrefix': prefix,
        'selectedMemberCount': len(selected),
        'selectedFileCount': len(files),
        'selectedUncompressedBytes': sum(item.file_size for item in selected),
        'selectedOriginalCompressedBytes': sum(item.compress_size for item in selected),
        'excludedPrefix': excluded_prefix,
        'excludedMemberCount': len(excluded),
        'excludedUncompressedBytes': sum(item.file_size for item in excluded),
        'excludedOriginalCompressedBytes': sum(item.compress_size for item in excluded),
        'exclusionPolicy': 'Only the exact sibling source checkout, including its dependencies; every original cell member retained',
    }


def transport_cell(original, target, host, limit=MAX_TRANSPORT_BYTES):
    manifest = []
    with zipfile.ZipFile(original) as archive:
        prefix, selected, _, inventory = select_cell(archive, host)
        with zipfile.ZipFile(target, mode='x', compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as output:
            for item in selected:
                relative = item.filename[len(prefix):]
                transported = host+'/'+relative
                if not relative:
                    transported = host+'/'
                info = zipfile.ZipInfo(transported, date_time=(1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.create_system = 3
                info.external_attr = ((stat.S_IFDIR | 0o755) if item.is_dir() else (stat.S_IFREG | 0o644)) << 16
                if item.is_dir():
                    output.writestr(info, b'')
                    manifest.append({'originalPath': item.filename, 'path': transported, 'directory': True, 'bytes': 0})
                    continue
                digest = hashlib.sha256()
                copied = 0
                with archive.open(item) as source, output.open(info, mode='w', force_zip64=True) as destination:
                    while True:
                        chunk = source.read(CHUNK_BYTES)
                        if not chunk:
                            break
                        copied += len(chunk)
                        digest.update(chunk)
                        destination.write(chunk)
                        if output.fp.tell() > limit:
                            raise ValueError('Complete cell exceeds bounded transport size; deterministic chunked transport is required')
                require_equal(copied, item.file_size, 'Original member length')
                manifest.append({'originalPath': item.filename, 'path': transported, 'directory': False,
                                 'bytes': copied, 'sha256': digest.hexdigest(), 'originalCrc32': item.CRC,
                                 'originalCompressedBytes': item.compress_size})
        if target.stat().st_size > limit:
            raise ValueError('Complete cell exceeds bounded transport size; deterministic chunked transport is required')
    # Read every transported member again, checking ZIP CRC and the exact
    # per-file digest. Neither a successful ZIP write nor metadata is enough.
    with zipfile.ZipFile(target) as check:
        require_equal(check.namelist(), [item['path'] for item in manifest], 'Complete transport member order')
        for item in manifest:
            if item['directory']:
                continue
            digest = hashlib.sha256()
            length = 0
            with check.open(item['path']) as source:
                for chunk in iter(lambda: source.read(CHUNK_BYTES), b''):
                    length += len(chunk)
                    digest.update(chunk)
            require_equal(length, item['bytes'], 'Transported member length')
            require_equal(digest.hexdigest(), item['sha256'], 'Transported member digest')
    return inventory, manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repository', required=True)
    parser.add_argument('--run-id', type=int, required=True)
    parser.add_argument('--artifact-id', type=int, required=True)
    parser.add_argument('--artifact-name', required=True)
    parser.add_argument('--host', required=True, choices=[f'{d}-{o}' for d in ('jmdict','jitendex','vndb') for o in ('AB','BA')])
    parser.add_argument('--expected-run-head', required=True)
    parser.add_argument('--expected-run-attempt', type=int, default=1)
    parser.add_argument('--expected-size', type=int, required=True)
    parser.add_argument('--expected-sha256', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--work', type=Path, required=True)
    args = parser.parse_args()
    if re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', args.repository) is None:
        parser.error('Repository must be one explicit owner/name')
    if re.fullmatch(r'[a-f0-9]{40}', args.expected_run_head) is None or re.fullmatch(r'[a-f0-9]{64}', args.expected_sha256) is None:
        parser.error('Expected run and artifact digests must be complete lowercase hashes')
    if min(args.run_id, args.artifact_id, args.expected_size, args.expected_run_attempt) <= 0:
        parser.error('Expected IDs, attempt and size must be positive')
    require_equal(args.artifact_name, 'import-qualification-88711ca9-'+args.host, 'Explicit artifact host name')
    output = args.output.resolve()
    work = args.work.resolve()
    if output == work or output in work.parents or work in output.parents:
        parser.error('Upload output and original-archive work directories must be separate siblings')
    output.mkdir(parents=True, exist_ok=False)
    work.mkdir(parents=True, exist_ok=False)
    receipt = {
        'schemaVersion': 1, 'startedAt': timestamp(), 'status': 'started',
        'repository': args.repository, 'sourceRunId': args.run_id,
        'sourceRunHead': args.expected_run_head, 'sourceRunAttempt': args.expected_run_attempt,
        'artifactId': args.artifact_id, 'artifactName': args.artifact_name, 'host': args.host,
        'expectedOriginalBytes': args.expected_size, 'expectedOriginalSha256': args.expected_sha256,
        'helperSha256': sha256_file(__file__),
        'transportWorkflow': {key:os.environ.get(key) for key in
            ('GITHUB_REPOSITORY','GITHUB_SHA','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','GITHUB_WORKFLOW_REF')},
        'payloadLimitBytes': MAX_TRANSPORT_BYTES,
        'connectorLimitBytes': ARTIFACT_CONNECTOR_LIMIT_BYTES,
        'originalArtifactMutation': 'None; original provider artifact remains untouched',
        'measurementPolicy': 'No imports, benchmarks, receipt rewrites, replacements or retries; exact original evidence only',
    }
    try:
        base = 'repos/'+args.repository+'/actions/'
        artifact, metadata_receipt = fetch_json(base+f'artifacts/{args.artifact_id}', output, 'original-artifact-metadata.json')
        run, run_receipt = fetch_json(base+f'runs/{args.run_id}', output, 'original-run-metadata.json')
        validate_provider(artifact, run, args)
        receipt['providerMetadata'] = metadata_receipt
        receipt['sourceRunMetadata'] = run_receipt
        if shutil.disk_usage(work).free < args.expected_size + MAX_TRANSPORT_BYTES + 64*CHUNK_BYTES:
            raise ValueError('Insufficient runner disk for bounded original plus complete transport')
        original = work/f'original-{args.artifact_id}.zip'
        download = stream_api(base+f'artifacts/{args.artifact_id}/zip', original,
                              limit=args.expected_size, expected_size=args.expected_size,
                              stderr_path=output/'original-download.stderr.log')
        receipt['originalDownload'] = download
        require_equal(download['sha256'], args.expected_sha256, 'Complete original archive SHA-256')
        receipt['independentOriginalSha256Verified'] = True
        emit('TRANSPORT_ORIGINAL_VERIFIED', download)
        candidate = work/f'{args.host}.evidence.zip'
        inventory, manifest = transport_cell(original, candidate, args.host)
        receipt['originalArchiveInventory'] = inventory
        manifest_path = output/'original-cell-members.json'
        write_json(manifest_path, {'schemaVersion':1, 'originalArchiveSha256':download['sha256'],
                                   'host':args.host, 'inventory':inventory, 'members':manifest})
        receipt['memberManifestSha256'] = sha256_file(manifest_path)
        receipt['transportZip'] = {'name':candidate.name, 'sha256':sha256_file(candidate),
                                   'bytes':candidate.stat().st_size,
                                   'files':sum(not item['directory'] for item in manifest),
                                   'allOriginalCellMembersRetained':True,
                                   'readbackAllMemberSha256AndCrcPassed':True}
        existing = sum(path.stat().st_size for path in output.iterdir() if path.is_file())
        # Reserve one MiB for the final receipt and service ZIP envelope, in
        # addition to the twelve-MiB margin below the connector's hard limit.
        if existing + candidate.stat().st_size + CHUNK_BYTES > MAX_TRANSPORT_BYTES:
            raise ValueError('Complete transport payload exceeds bound; deterministic chunked transport is required')
        candidate.rename(output/candidate.name)
        receipt['status'] = 'complete'
        receipt['finishedAt'] = timestamp()
        write_json(output/'transport-receipt.json', receipt)
        total = sum(path.stat().st_size for path in output.iterdir() if path.is_file())
        if total >= MAX_TRANSPORT_BYTES:
            raise ValueError('Final transport payload exceeds its strict bound')
        emit('TRANSPORT_COMPLETE', {'host':args.host, 'artifactId':args.artifact_id,
                                   'originalSha256':download['sha256'], 'payloadBytes':total,
                                   'files':receipt['transportZip']['files'],
                                   'transportZip':receipt['transportZip']})
    except Exception as error:
        receipt['status'] = 'failed'
        receipt['finishedAt'] = timestamp()
        receipt['failure'] = {'type':type(error).__name__, 'message':str(error),
                              'retried':False, 'originalArtifactUnchanged':True}
        write_json(output/'transport-failure.json', receipt)
        emit('TRANSPORT_FAILED', receipt['failure'])
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
