#!/usr/bin/env python3
"""Independently compare the finished tar's bytes with all original evidence."""

import contextlib
import datetime
import hashlib
import json
from pathlib import Path
import tarfile
import traceback
import zipfile


ORIGINALS = {
    'chromium-forward': (14627490223, 3989429, 'f718a067d6dfc4c823b9c25c76659b4e34bcf59853fe0b6fc76a7af32500b3b0', 732),
    'chromium-reverse': (14626318108, 3979720, '6b931369e3e10896bc0b33e4cfe76cba260a49ef1e32643567829180e583c6da', 732),
    'firefox-forward': (14627208758, 2402097, '08527d3626a5adabb723add442c7c1cfb4d0dd57a959ed2bdc94b048aceaf868', 630),
    'firefox-reverse': (14627972249, 2398251, 'f106b58ec22a995fb712fe91d5fea63a0443bcf48e068480c688216d788aa604', 630),
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def file_sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    output = Path(__file__).resolve().parent
    workspace = output.parents[3]
    destination = output / 'independent-packing-review.json'
    assert not destination.exists(), 'Refusing to replace an independent review'
    receipt = {
        'schemaVersion': 1,
        'startedAt': datetime.datetime.now(datetime.UTC).isoformat(),
        'scriptSha256': file_sha(Path(__file__)),
        'scope': 'Read-only independent archive review. Compare every actual tar payload byte-for-byte with the original ZIP member or selected source file; verify index, receipts and complete member sets. No evidence download, extraction, modification, timing or control pooling.',
    }
    try:
        archive_path = output / 'native-evidence.tar.xz'
        fixed_paths = [archive_path, output / 'native-evidence.tar.xz.json', output / 'artifact-coverage.json', output / 'packing-receipt.json', output / 'pack-evidence.py']
        before = {path.name: {'bytes': path.stat().st_size, 'sha256': file_sha(path)} for path in fixed_paths}
        sidecar = json.loads((output / 'native-evidence.tar.xz.json').read_text())
        coverage = json.loads((output / 'artifact-coverage.json').read_text())
        packing = json.loads((output / 'packing-receipt.json').read_text())
        assert sidecar == packing['archiveReceipt']
        assert before[archive_path.name]['sha256'] == sidecar['archiveSha256'] == coverage['archiveSha256']
        assert before[archive_path.name]['bytes'] == sidecar['archiveBytes']
        assert packing['recipeSha256'] == before['pack-evidence.py']['sha256']
        assert packing['coverageSha256'] == before['artifact-coverage.json']['sha256']
        assert packing['packExitCode'] == packing['verifyExitCode'] == 0 and packing['allInputIdentitiesUnchangedAfter'] is True
        assert packing['measuredToolingCommit'] == '72b8ab5471fc68e369a54d884efbbea933699d7c'
        assert packing['measuredToolingTree'] == 'e50ac7c7f7cf892a0e8dc666f5176f97e8800455'
        assert packing['manifestSha256'] == '66062489217d31a117ee7892c4f51190ccb51b837886f2c1cdaef857e6b2afa7'
        assert packing['workflowRunId'] == 44729808376
        coverage_cells = {record['cell']: record for record in coverage['cells']}
        assert set(coverage_cells) == set(ORIGINALS)
        sidecar_zips = {record['prefix']: record for record in sidecar['sourceZips']}
        assert set(sidecar_zips) == set(ORIGINALS)
        supplemental = {name: data for name, data in packing['inputIdentitiesBefore'].items() if not name.startswith('original-zip/')}
        original_inputs = {name.removeprefix('original-zip/'): data for name, data in packing['inputIdentitiesBefore'].items() if name.startswith('original-zip/')}
        assert set(original_inputs) == set(ORIGINALS)
        expected_members = {}
        verified_by_cell = {cell: 0 for cell in ORIGINALS}
        with contextlib.ExitStack() as stack:
            zip_archives = {}
            for cell, (artifact_id, byte_count, expected_hash, expected_count) in ORIGINALS.items():
                path = workspace / 'round5-browser' / cell / f'original-{artifact_id}.zip'
                assert path.stat().st_size == byte_count and file_sha(path) == expected_hash
                original_record = original_inputs[cell]
                assert Path(original_record['path']) == path and original_record['bytes'] == byte_count and original_record['sha256'] == expected_hash
                sidecar_record = sidecar_zips[cell]
                assert sidecar_record['path'] == str(path) and sidecar_record['bytes'] == byte_count and sidecar_record['sha256'] == expected_hash
                coverage_record = coverage_cells[cell]
                assert coverage_record['artifactId'] == artifact_id and coverage_record['archiveSha256'] == expected_hash and coverage_record['archiveBytes'] == byte_count
                assert coverage_record['originalFilePayloads'] == coverage_record['matchingPackedPayloads'] == expected_count
                assert coverage_record['missing'] == coverage_record['extra'] == coverage_record['changed'] == []
                archive = stack.enter_context(zipfile.ZipFile(path))
                zip_archives[cell] = archive
                all_members = archive.infolist()
                assert len(all_members) == len({member.filename for member in all_members})
                files = [member for member in all_members if not member.is_dir()]
                assert len(files) == expected_count
                for member in files:
                    logical = cell + '/' + member.filename
                    assert logical not in expected_members
                    expected_members[logical] = (cell, member)
            assert len(expected_members) == coverage['originalZipPayloads'] == coverage['matchedOriginalZipPayloads'] == 2724
            assert not set(expected_members) & set(supplemental)
            with tarfile.open(archive_path, 'r:xz') as packed:
                members = packed.getmembers()
                assert len(members) == len({member.name for member in members}) and all(member.isfile() for member in members)
                index = json.load(packed.extractfile('evidence-index.json'))
                assert set(index['files']) == set(expected_members) | set(supplemental)
                assert {member.name for member in members} == set(index['files']) | {'evidence-index.json'}
                assert len(index['files']) == sidecar['payloadFiles']
                payload_bytes = 0
                for member in members:
                    if member.name == 'evidence-index.json':
                        continue
                    assert not member.name.startswith('/') and all(part not in ('', '.', '..') for part in member.name.split('/'))
                    data = packed.extractfile(member).read()
                    indexed = index['files'][member.name]
                    assert len(data) == member.size == indexed['bytes'] and sha(data) == indexed['sha256']
                    payload_bytes += len(data)
                    if member.name in expected_members:
                        cell, original_member = expected_members[member.name]
                        assert data == zip_archives[cell].read(original_member), 'Original ZIP payload bytes differ: ' + member.name
                        assert indexed['source'] == {'zip': cell, 'entry': original_member.filename, 'crc32': original_member.CRC}
                        verified_by_cell[cell] += 1
                    else:
                        source = supplemental[member.name]
                        source_path = Path(source['path'])
                        assert source_path.is_file() and not source_path.is_symlink()
                        assert data == source_path.read_bytes(), 'Supplement bytes differ: ' + member.name
                        assert len(data) == source['bytes'] and sha(data) == source['sha256']
                assert payload_bytes == sidecar['payloadBytes']
                assert all(verified_by_cell[cell] == ORIGINALS[cell][3] for cell in ORIGINALS)
                receipt['packedPayloadFiles'] = len(index['files'])
                receipt['packedPayloadBytes'] = payload_bytes
                receipt['supplementalFilesComparedByteForByte'] = len(supplemental)
        for cell, (artifact_id, byte_count, expected_hash, _) in ORIGINALS.items():
            path = workspace / 'round5-browser' / cell / f'original-{artifact_id}.zip'
            assert path.stat().st_size == byte_count and file_sha(path) == expected_hash
        after = {path.name: {'bytes': path.stat().st_size, 'sha256': file_sha(path)} for path in fixed_paths}
        assert before == after, 'Archive or packing receipts changed during review'
        prior = output.parent / '20261120-native-config-study/failed-v1-evidence.tar.xz'
        assert prior.stat().st_size == 428276 and file_sha(prior) == '955c27d3037370dfb8e8ee27252467a5dcc4ec31105dc4dab299c84f74c5749f'
        receipt.update({'ok': True, 'archiveAndReceipts': before, 'originalZipPayloadsComparedByteForByte': sum(verified_by_cell.values()), 'perCellPayloadsComparedByteForByte': verified_by_cell, 'allExpectedMemberSetsExact': True, 'allOriginalZipsUnchangedAfter': True, 'archiveAndReceiptsUnchangedAfter': True, 'separateFailedV1ArchiveUnchanged': True})
    except Exception as error:
        receipt.update({'ok': False, 'error': str(error), 'traceback': traceback.format_exc()})
        raise
    finally:
        receipt['endedAt'] = datetime.datetime.now(datetime.UTC).isoformat()
        with destination.open('x') as stream:
            stream.write(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'ok': True, 'receipt': str(destination), 'receiptSha256': file_sha(destination), 'originalZipPayloadsComparedByteForByte': receipt['originalZipPayloadsComparedByteForByte'], 'packedPayloadFiles': receipt['packedPayloadFiles'], 'supplementalFilesComparedByteForByte': receipt['supplementalFilesComparedByteForByte']}, indent=2))


if __name__ == '__main__':
    main()
