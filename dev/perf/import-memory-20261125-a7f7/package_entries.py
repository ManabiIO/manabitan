"""Strict package-member accounting for exact-source qualification."""


def validate_package_entry_delta(baseline, candidate, expected_changed, expected_added=()):
    """Allow only explicitly declared additions and changed existing entries."""
    added = sorted(candidate.keys() - baseline.keys())
    removed = sorted(baseline.keys() - candidate.keys())
    if removed:
        raise RuntimeError(f"Candidate removes packaged files: {removed}")
    if set(added) != set(expected_added):
        raise RuntimeError(f"Unexpected added packaged files: {added}")
    changed = [
        name for name in baseline
        if name in candidate and baseline[name] != candidate[name]
    ]
    if not changed:
        raise RuntimeError("Candidate has no changed runtime package bytes")
    if set(changed) != set(expected_changed):
        raise RuntimeError(f"Unexpected packaged changes: {changed}")
    return {
        "changedPackageEntries": changed,
        "addedPackageEntries": added,
        "removedPackageEntries": removed,
    }
