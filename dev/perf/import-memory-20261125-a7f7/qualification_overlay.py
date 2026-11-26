# SPDX-License-Identifier: GPL-3.0-or-later
"""One pinned, measurement-only receipt repair for frozen product packages."""

from copy import deepcopy
import hashlib
from pathlib import Path
import subprocess


BENCHMARK_SUPPORT_PATH = 'dev/perf/benchmark-support.js'
MEMORY_HARNESS_PATH = 'test/chromium/extension-two-dictionary-import.e2e.js'
OVERLAY_NAME = 'native-image-policy-439a1c9b'
OVERLAY_IDENTITY = {
    'name': OVERLAY_NAME,
    'path': BENCHMARK_SUPPORT_PATH,
    'sourceSha': '439a1c9b6d40452061cda094b0727005553c1d1d',
    'originalSha256': '08463998f6e6b4590c65e5c36c9e162bd28d770fdd1e51e869a75ccbec1e8132',
    'sha256': 'eacc5eeee1aaeb13ea44867f0d2ff168f5e723392652ebfee6dfc717ba3865d0',
    'scope': 'Measurement receipt validation only; applied after clean product packaging',
}
ALLOWED_DIRTY_PATHS = frozenset((BENCHMARK_SUPPORT_PATH, MEMORY_HARNESS_PATH))


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def load_measurement_overlay(root, name):
    """Resolve only the reviewed #950 bytes, never an arbitrary file overlay."""
    if name is None:
        return None
    if name != OVERLAY_NAME:
        raise ValueError('Unsupported measurement overlay')
    identity = deepcopy(OVERLAY_IDENTITY)
    data = subprocess.check_output(
        ['git', 'show', f"{identity['sourceSha']}:{identity['path']}"], cwd=root)
    if sha256(data) != identity['sha256']:
        raise ValueError('Pinned measurement overlay hash differs')
    if (Path(root) / identity['path']).read_bytes() != data:
        raise ValueError('Qualification checkout differs from pinned measurement overlay')
    return {'identity': identity, 'bytes': data}


def require_source_state(root, expected_hashes):
    """Reject additional, staged, renamed, missing, or re-edited source files."""
    if type(expected_hashes) is not dict or not set(expected_hashes) <= ALLOWED_DIRTY_PATHS:
        raise ValueError('Unexpected deliberate dirty paths')
    status = subprocess.check_output(
        ['git', 'status', '--porcelain=v1', '--untracked-files=all'], cwd=root, text=True).splitlines()
    if sorted(status) != sorted(f' M {path}' for path in expected_hashes):
        raise ValueError(f'Unexpected source state: {status}')
    actual_hashes = {path: sha256((Path(root) / path).read_bytes()) for path in expected_hashes}
    if actual_hashes != expected_hashes:
        raise ValueError('Deliberate measurement source hash differs')
    return {'dirtyPaths': sorted(expected_hashes), 'sha256': actual_hashes, 'gitStatus': status}


def apply_measurement_overlay(root, overlay):
    """Require an unchanged reviewed original and a clean source tree first."""
    require_source_state(root, {})
    identity = overlay['identity']
    if identity != OVERLAY_IDENTITY or sha256(overlay['bytes']) != identity['sha256']:
        raise ValueError('Measurement overlay identity differs')
    path = Path(root) / identity['path']
    original = path.read_bytes()
    if sha256(original) != identity['originalSha256']:
        raise ValueError('Frozen benchmark-support original hash differs')
    path.write_bytes(overlay['bytes'])
    require_source_state(root, {identity['path']: identity['sha256']})
    return original
