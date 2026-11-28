# SPDX-License-Identifier: GPL-3.0-or-later
"""Exact, prospective package member gates for import qualification."""


def package_changes(baseline, candidate):
    """Return every added, removed, or byte-changed runtime package member."""
    before, after = set(baseline), set(candidate)
    return {
        'changedPackageEntries': sorted(
            name for name in before & after if baseline[name] != candidate[name]
        ),
        'addedPackageEntries': sorted(after - before),
        'removedPackageEntries': sorted(before - after),
    }


def require_expected_package_changes(changes, *, expected_changed, expected_added=()):
    """Allow only the exact declared changes; removing members is never allowed."""
    expected = {
        'changedPackageEntries': list(expected_changed),
        'addedPackageEntries': list(expected_added),
    }
    for kind, names in expected.items():
        if any(not isinstance(name, str) or not name or name.endswith('/') for name in names):
            raise ValueError(f'Invalid expected package member names: {kind}')
        if len(names) != len(set(names)):
            raise ValueError(f'Duplicate expected package member names: {kind}')
    if set(expected['changedPackageEntries']) & set(expected['addedPackageEntries']):
        raise ValueError('An expected package member cannot be both changed and added')
    if set(changes) != {*expected, 'removedPackageEntries'}:
        raise ValueError('Unexpected package change receipt fields')
    if changes['removedPackageEntries']:
        raise ValueError(f"Candidate removes packaged files: {changes['removedPackageEntries']}")
    for kind, names in expected.items():
        actual = changes[kind]
        if len(actual) != len(set(actual)) or set(actual) != set(names):
            raise ValueError(f'Unexpected {kind}: expected {sorted(names)}, observed {actual}')
    if not changes['changedPackageEntries'] and not changes['addedPackageEntries']:
        raise ValueError('Candidate has no changed runtime package bytes')
