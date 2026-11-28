#!/usr/bin/env python3
"""Recover and verify the frozen post-acquisition archive from one original job log."""
import argparse
import base64
import datetime
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import sys
import traceback
import zipfile


PREFIX = 'MANABITAN_EVIDENCE_ARCHIVE_'
TAG = re.compile(r'^(?:\d{4}-\d{2}-\d{2}T\S+Z\s+)?' + PREFIX + r'([A-Z]+) (.*)$')
SCOPE = ('Lossless post-acquisition archive. Every original regular evidence member is included '
         'except exactly the two root release-package copies.')
REASON = 'Reproducible release-package copy; complete source/package-entry maps remain included'
HELPER_SHA256 = 'c667e543855dc082d5e0adcabb5ad1a92d9e1dadbe6b64e039d0965158863b1f'
RUN_ID = 46130093248
WORKFLOW_COMMIT = 'faf6d9d9c282b2da46a7c8ee05835f4db0827039'
JOBS = {
    ('jmdict', 'AB'): 140933489138, ('jmdict', 'BA'): 140933489203,
    ('jitendex', 'AB'): 140933489159, ('jitendex', 'BA'): 140933489153,
    ('vndb', 'AB'): 140933489168, ('vndb', 'BA'): 140933489131,
}


def sha_file(path, algorithm='sha256'):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, algorithm).hexdigest()


def unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate JSON key: ' + key)
        result[key] = value
    return result


def parse_json(text):
    def reject_constant(value):
        raise ValueError('Non-finite JSON number: ' + value)
    return json.loads(text, object_pairs_hook=unique_pairs, parse_constant=reject_constant)


def integer(value, minimum=0):
    assert type(value) is int and value >= minimum, value
    return value


def hex_digest(value, length):
    assert isinstance(value, str) and re.fullmatch('[0-9a-f]{' + str(length) + '}', value), value
    return value


def member(value, excluded=False):
    keys = {'path', 'bytes', 'sha256'} | ({'reason'} if excluded else set())
    assert set(value) == keys
    path = value['path']
    assert isinstance(path, str) and path and '\\' not in path
    normalized = PurePosixPath(path)
    assert not normalized.is_absolute() and '..' not in normalized.parts
    assert str(normalized) == path and not path.endswith('/')
    result = {'path': path, 'bytes': integer(value['bytes']), 'sha256': hex_digest(value['sha256'], 64)}
    if excluded:
        assert value['reason'] == REASON
        result['reason'] = value['reason']
    return result


def archive_identity(value):
    assert set(value) == {'bytes', 'sha256', 'gitBlobSha1'}
    return {'bytes': integer(value['bytes'], 1), 'sha256': hex_digest(value['sha256'], 64),
            'gitBlobSha1': hex_digest(value['gitBlobSha1'], 40)}


def recover(args):
    root = args.output.resolve()
    root.mkdir(parents=True, exist_ok=True)
    paths = {name: root / name for name in ('raw-evidence.zip', 'raw-evidence.zip.partial',
              'raw-evidence-manifest.json', 'raw-evidence-member-hashes.json', 'raw-archive-recovery.json')}
    assert all(not path.exists() for path in paths.values()), 'Never overwrite recovery evidence'
    assert args.job_id == JOBS[(args.dictionary, args.order)]
    source_name = f'numeric-suffix-972-c563d487-{args.dictionary}-{args.order}'
    phase = 'before-start'
    header = complete = None
    members, excluded, tag_lines = [], [], []
    chunk_count = 0
    bytes_written = 0
    content_hash = hashlib.sha256()
    with args.log.open(encoding='utf-8') as source, paths['raw-evidence.zip.partial'].open('xb') as target:
        for number, line in enumerate(source, 1):
            match = TAG.fullmatch(line.rstrip('\r\n'))
            if not match:
                continue
            kind, raw = match.groups()
            value = parse_json(raw)
            tag_lines.append({'line': number, 'kind': kind})
            assert isinstance(value, dict)
            if kind == 'FAILED':
                raise ValueError('Original archive producer reported failure: ' + json.dumps(value, sort_keys=True))
            if kind == 'START':
                assert phase == 'before-start'
                assert set(value) == {'schemaVersion', 'complete', 'scope', 'sourceDirectory', 'archiveFile',
                                     'archive', 'memberCount', 'excludedNames', 'chunkBytes', 'chunkCount',
                                     'acquisitionOrObservationsChanged', 'manifestSha256'}
                assert value['schemaVersion'] == 1 and value['complete'] is True
                assert value['scope'] == SCOPE
                assert value['sourceDirectory'] == source_name
                assert value['archiveFile'] == source_name + '.raw-evidence.zip'
                assert value['excludedNames'] == ['package-A.zip', 'package-B.zip']
                assert value['chunkBytes'] == 6144 and type(value['chunkBytes']) is int
                assert value['acquisitionOrObservationsChanged'] is False
                archive = archive_identity(value['archive'])
                integer(value['memberCount'], 1)
                integer(value['chunkCount'], 1)
                assert value['chunkCount'] == (archive['bytes'] + 6143) // 6144
                hex_digest(value['manifestSha256'], 64)
                header = value
                phase = 'members'
            elif kind == 'MEMBER':
                assert phase == 'members' and len(members) < header['memberCount']
                record = member(value)
                assert record['path'] not in header['excludedNames']
                assert not members or PurePosixPath(record['path']) > PurePosixPath(members[-1]['path'])
                members.append(record)
            elif kind == 'EXCLUDED':
                assert phase in ('members', 'excluded') and len(members) == header['memberCount']
                phase = 'excluded'
                record = member(value, excluded=True)
                assert len(excluded) < 2 and record['path'] == header['excludedNames'][len(excluded)]
                excluded.append(record)
            elif kind == 'CHUNK':
                assert phase in ('excluded', 'chunks') and len(excluded) == 2
                assert set(value) == {'index', 'data'} and integer(value['index']) == chunk_count
                assert chunk_count < header['chunkCount'] and isinstance(value['data'], str)
                block = base64.b64decode(value['data'], validate=True)
                assert base64.b64encode(block).decode('ascii') == value['data']
                expected_bytes = min(6144, archive['bytes'] - bytes_written)
                assert len(block) == expected_bytes and expected_bytes > 0
                target.write(block)
                content_hash.update(block)
                bytes_written += len(block)
                chunk_count += 1
                phase = 'chunks'
            elif kind == 'COMPLETE':
                assert phase == 'chunks' and chunk_count == header['chunkCount']
                expected = {'complete': True, 'archive': header['archive'], 'chunkCount': chunk_count,
                            'memberCount': len(members), 'excludedCount': len(excluded),
                            'manifestSha256': header['manifestSha256'], 'acquisitionOrObservationsChanged': False}
                assert value == expected
                complete = value
                phase = 'complete'
            else:
                raise ValueError('Unknown original archive tag: ' + kind)
    assert phase == 'complete' and complete is not None
    assert bytes_written == archive['bytes'] and content_hash.hexdigest() == archive['sha256']
    blob = hashlib.sha1(b'blob ' + str(bytes_written).encode('ascii') + b'\0')
    with paths['raw-evidence.zip.partial'].open('rb') as source:
        for block in iter(lambda: source.read(1048576), b''):
            blob.update(block)
    assert blob.hexdigest() == archive['gitBlobSha1']
    # The producer's key order is part of its exact indented manifest bytes.
    manifest = {'schemaVersion': 1, 'complete': True, 'scope': SCOPE, 'sourceDirectory': source_name,
                'archiveFile': source_name + '.raw-evidence.zip', 'archive': archive,
                'members': members, 'excluded': excluded, 'memberCount': len(members),
                'excludedNames': ['package-A.zip', 'package-B.zip'], 'chunkBytes': 6144,
                'chunkCount': chunk_count, 'acquisitionOrObservationsChanged': False}
    manifest_bytes = (json.dumps(manifest, indent=2, allow_nan=False) + '\n').encode()
    assert hashlib.sha256(manifest_bytes).hexdigest() == header['manifestSha256']
    hashes = {}
    with zipfile.ZipFile(paths['raw-evidence.zip.partial']) as source:
        assert source.namelist() == [row['path'] for row in members]
        for info, expected in zip(source.infolist(), members):
            assert not info.is_dir() and info.file_size == expected['bytes']
            assert info.date_time == (1980, 1, 1, 0, 0, 0)
            assert info.compress_type == zipfile.ZIP_DEFLATED
            assert info.external_attr == 0o100644 << 16
            total, digest = 0, hashlib.sha256()
            with source.open(info) as stream:
                for block in iter(lambda: stream.read(1048576), b''):
                    total += len(block)
                    digest.update(block)
            assert total == expected['bytes'] and digest.hexdigest() == expected['sha256']
            hashes[info.filename] = {'bytes': total, 'sha256': digest.hexdigest(),
                                     'compressedBytes': info.compress_size, 'crc32': info.CRC}
    paths['raw-evidence-manifest.json'].write_bytes(manifest_bytes)
    paths['raw-evidence-member-hashes.json'].write_text(json.dumps(hashes, indent=2) + '\n')
    paths['raw-evidence.zip.partial'].rename(paths['raw-evidence.zip'])
    result = {'schemaVersion': 1, 'complete': True, 'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'scope': 'Original log chunks and every non-package ZIP member; no acquisition or benchmark execution',
              'runId': RUN_ID, 'jobId': args.job_id, 'workflowCommit': WORKFLOW_COMMIT,
              'dictionary': args.dictionary, 'order': args.order,
              'originalJobLog': {'path': str(args.log.resolve()), 'bytes': args.log.stat().st_size,
                                 'sha256': sha_file(args.log)},
              'producerSha256': HELPER_SHA256, 'recoverySourceSha256': sha_file(Path(__file__)),
              'archive': archive, 'manifestSha256': header['manifestSha256'],
              'memberHashManifestSha256': sha_file(paths['raw-evidence-member-hashes.json']),
              'memberCount': len(members), 'uncompressedMemberBytes': sum(row['bytes'] for row in members),
              'excluded': excluded, 'chunkCount': chunk_count, 'tagLines': tag_lines,
              'allChunkOrderLengthsAndBytesVerified': True, 'allMemberSha256SizeAndCrcVerified': True,
              'noOuterArtifactOrReleasePackagesDownloaded': True,
              'acquisitionOrObservationsChanged': False}
    paths['raw-archive-recovery.json'].write_text(json.dumps(result, indent=2) + '\n')
    return {'recoveryReceiptSha256': sha_file(paths['raw-archive-recovery.json']),
            'archive': archive, 'memberCount': len(members), 'chunkCount': chunk_count}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--log', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--dictionary', choices=('jmdict', 'jitendex', 'vndb'), required=True)
    parser.add_argument('--order', choices=('AB', 'BA'), required=True)
    parser.add_argument('--job-id', type=int, required=True)
    args = parser.parse_args()
    try:
        result = recover(args)
    except BaseException as error:
        args.output.mkdir(parents=True, exist_ok=True)
        receipt = {'complete': False, 'type': type(error).__name__, 'message': str(error),
                   'traceback': traceback.format_exc(), 'sourceSha256': sha_file(Path(__file__)),
                   'originalJobLogSha256': sha_file(args.log), 'acquisitionOrObservationsChanged': False}
        failure = args.output / ('raw-archive-recovery-failure-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%f') + '.json')
        failure.write_text(json.dumps(receipt, indent=2) + '\n')
        raise
    print(json.dumps(result, indent=2))
