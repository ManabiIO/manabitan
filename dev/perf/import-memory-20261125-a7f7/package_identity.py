"""Strict package identity checks for declared runtime file additions."""

import hashlib
import stat
import zipfile


def package_entries(path):
    """Return regular-file digests, rejecting duplicate names and special files."""
    with zipfile.ZipFile(path) as package:
        members = package.infolist()
        names = [item.filename for item in members]
        if len(names) != len(set(names)):
            raise RuntimeError(f"Duplicate package member names: {path}")
        entries = {}
        for item in members:
            kind = stat.S_IFMT(item.external_attr >> 16)
            if item.is_dir():
                if kind not in (0, stat.S_IFDIR):
                    raise RuntimeError(f"Invalid package directory type: {item.filename}")
                continue
            # Some ZIP producers omit the Unix file-type bits. Their ordinary
            # non-directory entries remain supported; symlinks/devices do not.
            if kind not in (0, stat.S_IFREG):
                raise RuntimeError(f"Invalid package file type: {item.filename}")
            entries[item.filename] = hashlib.sha256(package.read(item)).hexdigest()
        return entries


def changed_package_entries(baseline, candidate, expected_added=()):
    """Require the exact declared additions and prohibit every removal."""
    baseline_names = set(baseline)
    candidate_names = set(candidate)
    removed = baseline_names - candidate_names
    added = candidate_names - baseline_names
    if removed:
        raise RuntimeError(f"Removed packaged files: {sorted(removed)}")
    if added != set(expected_added):
        raise RuntimeError(f"Unexpected added packaged files: {sorted(added)}")
    return [
        name for name in dict.fromkeys((*baseline, *candidate))
        if baseline.get(name) != candidate.get(name)
    ]
