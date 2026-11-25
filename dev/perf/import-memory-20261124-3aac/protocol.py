# SPDX-License-Identifier: GPL-3.0-or-later
"""Frozen source, package and native correctness gates for memory diagnostics."""

import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import statistics
import subprocess
import zipfile

from storage_receipts import POLICY_VERSION, normalize_storage_receipt, storage_comparison_key

ROOT = Path(__file__).resolve().parents[3]
DIRECTORY = 'dev/perf/import-memory-20261124-3aac'
WORKFLOW = '.github/workflows/import-memory-20261124-3aac.yml'
HARNESS = 'test/chromium/extension-two-dictionary-import.e2e.js'
DEPENDENCY_PATHS = ('package.json', 'package-lock.json', '.github/actions/setup/action.yml')
HARNESS_PATHS = (
    'dev/perf', 'test/chromium', 'test/e2e', 'test/perf', 'test/firefox/data',
    'package.json', 'package-lock.json', '.github/actions/setup/action.yml',
    'ext/js/core/json.js', 'ext/js/core/safe-performance.js',
    'ext/js/dictionary/term-bank-experiments.js', 'ext/js/data/anki-util.js',
    'ext/js/media/media-util.js', 'ext/js/pages/settings/dictionary-import-controller.js',
)


def digest(path):
    with Path(path).open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def save(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')
    temporary.replace(path)


def command(args, cwd=ROOT, log=None):
    if log is None:
        return subprocess.run(args, cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()
    with Path(log).open('w') as output:
        result = subprocess.run(args, cwd=cwd, stdout=output, stderr=subprocess.STDOUT)
    if result.returncode != 0:
        raise RuntimeError(f'Command failed ({result.returncode}); complete log retained at {log}')
    return ''


def source_identity(revision):
    if re.fullmatch('[a-f0-9]{40}', revision) is None:
        raise ValueError('Sources must be full lowercase commit SHAs')
    if command(['git', 'rev-parse', f'{revision}^{{commit}}']) != revision:
        raise ValueError('Source revision did not resolve exactly')
    return {'commit': revision, 'tree': command(['git', 'rev-parse', f'{revision}^{{tree}}'])}


def harness_hashes(root):
    files = command(['git', 'ls-files', '--', *HARNESS_PATHS], root).splitlines()
    return {name: digest(root / name) for name in files if not name.startswith(DIRECTORY + '/')}


def require_dependency_source(source, tooling):
    hashes = {name: digest(tooling / name) for name in DEPENDENCY_PATHS}
    if any(digest(source / name) != value for name, value in hashes.items()):
        raise ValueError('Tooling dependency manifests/setup differ from frozen source')
    return hashes


def package_entries(path):
    with zipfile.ZipFile(path) as archive:
        entries = [entry for entry in archive.infolist() if not entry.is_dir()]
        if len({entry.filename for entry in entries}) != len(entries):
            raise ValueError('Package contains duplicate file entries')
        return {entry.filename: hashlib.sha256(archive.read(entry)).hexdigest() for entry in entries}


def require_package_differences(packages, expected):
    if (not isinstance(expected, list) or not expected or
            any(not isinstance(name, str) for name in expected) or expected != sorted(set(expected))):
        raise ValueError('Freeze a nonempty sorted unique packaged difference list')
    a, b = packages['A'], packages['B']
    actual = sorted(name for name in a.keys() | b.keys() if a.get(name) != b.get(name))
    if actual != expected:
        raise ValueError(f'Unexpected packaged product differences: {actual}')
    return actual


def link_or_copy(source, destination):
    try:
        os.link(source, destination)
    except OSError:
        shutil.copy2(source, destination)
    return destination


def read_summary(output, plan, arm, identity):
    summary = json.loads((output / 'summary.json').read_text())
    fixture = plan['fixture']
    if (summary.get('schemaVersion') != 3 or summary.get('dictionary') != plan['dictionary'] or
            summary.get('fixture') != fixture or summary.get('buildTarget') != 'chrome' or
            summary.get('mediaCheck') != 'sample' or summary.get('traceEnabled') is not False or
            summary.get('importFlags') is not None or summary.get('authoritativeTiming') is not True or
            not isinstance(summary.get('runs'), list) or len(summary['runs']) != 1):
        raise ValueError('Native benchmark summary differs from the frozen protocol')
    # The unchanged benchmark does not know about this observer. Retain its
    # raw internal label, but never adopt it as an authoritative timing label.
    run = summary['runs'][0]
    source = summary.get('source', {})
    expected_source = plan['sourceIdentities'][arm]
    if (summary.get('gitSha') != expected_source['commit'] or source.get('gitSha') != expected_source['commit'] or
            source.get('dirty') is not True or run.get('packageSha256') != identity['packageSha256'] or
            source.get('sha256', {}).get('builds/manabitan-chrome.zip') != identity['packageSha256']):
        raise ValueError('Observation source/package differs from frozen arm and explicit marker overlay')
    for name, value in source.get('sha256', {}).items():
        if name in plan['harnessSha256']:
            expected = plan['memoryOverlaySha256'] if name == HARNESS else plan['harnessSha256'][name]
            if value != expected:
                raise ValueError(f'Observation harness hash differs: {name}')
    if source.get('sha256', {}).get(HARNESS) != plan['memoryOverlaySha256']:
        raise ValueError('Observation did not execute the exact marker harness')
    if summary.get('hostEnvironment', {}).get('nodeVersion') != 'v22.22.0':
        raise ValueError('Observation did not use pinned Node 22.22.0')
    browser = summary.get('browserVersion')
    if not isinstance(browser, str) or not browser or run.get('browserVersion') != browser:
        raise ValueError('Missing or inconsistent browser identity')
    validation = run['validation']
    for name, value in (('title', fixture['expectedTitle']), ('revision', fixture['revision']),
                        ('termRows', fixture['termRows']), ('contentReadable', True), ('probeCount', 12)):
        if validation.get(name) != value or validation.get('restart', {}).get(name) != value:
            raise ValueError(f'Inventory/restart validation differs: {name}')
    if validation['restart'].get('mediaFiles') != fixture['mediaFiles']:
        raise ValueError('Restart media inventory differs')
    terms = validation['probeTerms']
    lookups = validation['lookup']['observations']
    if len(terms) != 12 or len(set(terms)) != 12 or len(lookups) != 72:
        raise ValueError('Incomplete deterministic production lookup coverage')
    expected_lookups = {(number, term) for number in range(6) for term in terms}
    if {(row['pass'], row['term']) for row in lookups} != expected_lookups:
        raise ValueError('Lookup passes/terms differ')
    if any(type(row['results']) is not int or row['results'] <= 0 or
           row.get('hasExactHeadwordMatch') is not True or
           re.fullmatch('[a-f0-9]{64}', row.get('sha256', '')) is None for row in lookups):
        raise ValueError('Empty or invalid production lookup receipt')
    media = validation['media']
    if (media.get('mode') != 'sample' or media.get('totalFiles') != fixture['mediaFiles'] or
            media.get('totalBytes') != fixture['mediaBytes'] or
            media.get('files') != min(64, fixture['mediaFiles']) or
            re.fullmatch('[a-f0-9]{64}', media.get('sha256', '')) is None):
        raise ValueError('Sampled source-media validation differs')
    storage = normalize_storage_receipt(validation['storage'], plan['dictionary'])
    return {'authoritativeTiming': False, 'browserVersion': browser,
            'lookup': sorted([row['pass'], row['term'], row['results'], row['sha256']] for row in lookups),
            'media': {name: media[name] for name in ('mode', 'totalFiles', 'totalBytes', 'files', 'bytes', 'sha256')},
            'storage': storage}


def receipt_comparison_key(receipt):
    """Keep semantic equality and compare the explicit prospective storage key."""
    return {**receipt, 'storage': storage_comparison_key(receipt['storage'])}


def storage_allocation_summary(correctness, fixed_schedule):
    """Retain per-arm raw allocations, including absent/failed observations."""
    by_name = {row['name']: row for row in correctness}
    observations = []
    for observation in fixed_schedule:
        row = by_name[observation['name']]
        storage = row.get('receipt', {}).get('storage')
        if storage is not None:
            storage_comparison_key(storage)
        observations.append({**observation, 'correctnessStatus': row['status'],
                             'rawStorageBytes': None if storage is None else storage['rawStorageBytes'],
                             'nonSahBytes': None if storage is None else storage['nonSahBytes'],
                             'activeSahFileBytes': None if storage is None else storage['sahPool']['activeFileBytes']})
    return {'policyVersion': POLICY_VERSION, 'observations': observations,
            'activeSahFileBytesByArm': {arm: [row['activeSahFileBytes'] for row in observations if row['arm'] == arm]
                                      for arm in ('A', 'B')},
            'rawStorageBytesByArm': {arm: [row['rawStorageBytes'] for row in observations if row['arm'] == arm]
                                    for arm in ('A', 'B')}}


def memory_comparison(observations, dictionary, replication, schedule):
    if [row['name'] for row in observations] != [row['name'] for row in schedule(replication)]:
        raise ValueError('The fixed four-observation cohort is incomplete or reordered')
    pairs = []
    qualified = all(row['qualifiedForWholeTreePss'] for row in observations)
    for index in (1, 2):
        arms = {row['arm']: row for row in observations if row['pair'] == index}
        pair = {'pair': index, 'qualified': all(row['qualifiedForWholeTreePss'] for row in arms.values())}
        for metric in ('maxSampledPssKiB', 'maxSampledPrivateKiB'):
            a, b = arms['A'][metric], arms['B'][metric]
            if pair['qualified'] and (type(a) not in (int, float) or type(b) not in (int, float) or
                                      not math.isfinite(a) or not math.isfinite(b) or a <= 0 or b < 0):
                raise ValueError('Invalid qualified memory maxima')
            pair[metric] = {'baseline': a, 'candidate': b,
                            'changePercent': 100 * (b / a - 1) if pair['qualified'] else None}
        pairs.append(pair)
    metrics = {}
    for metric in ('maxSampledPssKiB', 'maxSampledPrivateKiB'):
        changes = [pair[metric]['changePercent'] for pair in pairs]
        metrics[metric] = {'medianPairedChangePercent': statistics.median(changes) if qualified else None,
                           'maximumPairedChangePercent': max(changes) if qualified else None}
    passes = qualified and all(value['medianPairedChangePercent'] <= 5 and value['maximumPairedChangePercent'] <= 10
                               for value in metrics.values())
    return {'schemaVersion': 1, 'dictionary': dictionary, 'replication': replication, 'authoritativeTiming': False,
            'observations': observations, 'pairs': pairs, 'metrics': metrics, 'everyObservationQualified': qualified,
            'passesProspectiveMemoryScreen': passes}
