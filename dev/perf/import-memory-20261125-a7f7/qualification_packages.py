# SPDX-License-Identifier: GPL-3.0-or-later
"""Exact package-member gates, with evidence retained before policy rejection."""

from collections import Counter
import hashlib
import json
import zipfile


def read_package_manifest(path):
    """Retain every member, including ambiguous duplicates that must be rejected."""
    with zipfile.ZipFile(path) as package:
        members = [
            {
                'name': item.filename,
                'directory': item.is_dir(),
                'sha256': None if item.is_dir() else hashlib.sha256(package.read(item)).hexdigest(),
            }
            for item in package.infolist()
        ]
    counts = Counter(member['name'] for member in members)
    return {
        'entries': {member['name']: member['sha256'] for member in members if not member['directory']},
        'packageMembers': members,
        'duplicatePackageEntries': sorted(name for name, count in counts.items() if count > 1),
    }


def write_package_identity_receipt(path, identities, expected_entries, expected_added_entries=()):
    """Write complete manifests/deltas, then admit only the exact declared changes."""
    baseline = identities['A']['entries']
    candidate = identities['B']['entries']
    added = set(candidate) - set(baseline)
    removed = set(baseline) - set(candidate)
    changed = added | {name for name in baseline.keys() & candidate.keys()
                       if baseline[name] != candidate[name]}
    expected_entries = list(expected_entries)
    expected_added_entries = list(expected_added_entries)
    receipt = {
        'arms': identities,
        'changedPackageEntries': sorted(changed),
        'addedPackageEntries': sorted(added),
        'removedPackageEntries': sorted(removed),
        'expectedPackageEntries': expected_entries,
        'expectedAddedPackageEntries': expected_added_entries,
        'controlC': 'Same A source, package, runtime, and flags under a distinct observation label',
    }
    path.write_text(json.dumps(receipt, indent=2, sort_keys=True) + '\n')
    for label in ('A', 'B'):
        duplicates = identities[label]['duplicatePackageEntries']
        if duplicates:
            raise RuntimeError(f'Duplicate package member names in arm {label}: {duplicates}')
    if removed:
        raise RuntimeError(f'Candidate removes packaged files: {sorted(removed)}')
    if not set(expected_added_entries) <= set(expected_entries):
        raise RuntimeError('Expected added package entries must be a subset of expected package changes')
    if added != set(expected_added_entries):
        raise RuntimeError(f'Unexpected added package entries: actual={sorted(added)}, expected={sorted(set(expected_added_entries))}')
    if not changed:
        raise RuntimeError('Candidate has no changed runtime package bytes')
    if changed != set(expected_entries):
        raise RuntimeError(f'Unexpected packaged changes: {sorted(changed)}')
    return receipt
