#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Preserve exact evidence trees, including OPFS names illegal in upload-artifact."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import tarfile
import traceback

DIRECT_RECEIPTS = (
    'outcome.json', 'source-binding.json', 'commands.json', 'verification-gate.json',
    'cell-result.json', 'cell-gate.json', 'stage-gate.json',
    'pre-acquisition-binding.json', 'tail-admission-diagnostics.json',
)
EXCLUDED_REPRODUCIBLE_DIRECTORY = 'cohort-sources'



def digest(stream):
    return hashlib.file_digest(stream, 'sha256').hexdigest()


def inventory(root):
    result = []
    for directory, dirs, files in os.walk(root, topdown=True, followlinks=False):
        directory = Path(directory)
        if directory == root:
            dirs[:] = [name for name in dirs if name != EXCLUDED_REPRODUCIBLE_DIRECTORY]
        for name in sorted(dirs):
            item = directory / name
            if item.is_symlink():
                raise ValueError('Evidence symlink is not silently followed: ' + str(item))
        for name in sorted(files):
            item = directory / name
            info = item.lstat()
            if not stat.S_ISREG(info.st_mode):
                raise ValueError('Nonregular evidence file: ' + str(item))
            with item.open('rb') as stream:
                checksum = digest(stream)
            if item.stat().st_size != info.st_size:
                raise ValueError('Evidence size changed while hashing')
            result.append({'path': item.relative_to(root).as_posix(), 'bytes': info.st_size, 'sha256': checksum})
    return sorted(result, key=lambda item: item['path'])


def verify_archive(filename, expected):
    actual = []
    with tarfile.open(filename, 'r:gz') as archive:
        for member in archive:
            if not member.isfile():
                raise ValueError('Unexpected archive member type: ' + member.name)
            with archive.extractfile(member) as stream:
                actual.append({'path': member.name, 'bytes': member.size, 'sha256': digest(stream)})
    if actual != expected:
        raise ValueError('Archive members differ from original byte inventory')
    return actual


def preserve(evidence, destination):
    evidence, destination = Path(evidence).resolve(), Path(destination).resolve()
    if destination == evidence or evidence in destination.parents:
        raise ValueError('Archive destination must be outside the evidence tree')
    destination.mkdir(parents=True, exist_ok=False)
    receipt = {'schemaVersion': 1, 'complete': False, 'source': str(evidence),
               'destination': str(destination), 'originalsDeleted': False, 'failures': [],
               'excludedReproducibleDirectory': EXCLUDED_REPRODUCIBLE_DIRECTORY,
               'exclusionScope': 'Only duplicated runtime worktrees and dependencies; original packages, observations, source-state diagnostics and every failure remain included'}
    try:
        if not evidence.is_dir():
            raise ValueError('Evidence directory was not created before setup failed')
        original = inventory(evidence)
        if not original:
            raise ValueError('Empty evidence tree cannot qualify')
        receipt['members'] = original
        receipt['totalOriginalBytes'] = sum(item['bytes'] for item in original)
        filename = destination / 'complete-evidence.tar.gz'
        temporary = destination / 'complete-evidence.tar.gz.partial'
        with tarfile.open(temporary, 'w:gz', compresslevel=6) as archive:
            for item in original:
                archive.add(evidence / item['path'], arcname=item['path'], recursive=False)
        verify_archive(temporary, original)
        if inventory(evidence) != original:
            raise ValueError('Original evidence changed while archiving')
        temporary.replace(filename)
        with filename.open('rb') as stream:
            receipt['archiveSha256'] = digest(stream)
        receipt['archiveBytes'] = filename.stat().st_size
        receipt['archivePath'] = filename.name
        receipt['verifiedEveryMember'] = True
        receipt['verifiedOriginalsAfterArchive'] = True
        for relative in DIRECT_RECEIPTS:
            source = evidence / relative
            if source.is_file():
                shutil.copyfile(source, destination / relative)
        receipt['complete'] = True
        return receipt
    except Exception as error:
        receipt['failures'].append({'type': type(error).__name__, 'message': str(error), 'traceback': traceback.format_exc()})
        raise
    finally:
        (destination / 'artifact-preservation.json').write_text(json.dumps(receipt, indent=2, sort_keys=True) + '\n')
        print('TAIL_ARTIFACT ' + json.dumps({key: value for key, value in receipt.items() if key != 'members'}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence', required=True)
    parser.add_argument('--destination', required=True)
    args = parser.parse_args()
    preserve(args.evidence, args.destination)


if __name__ == '__main__':
    main()
