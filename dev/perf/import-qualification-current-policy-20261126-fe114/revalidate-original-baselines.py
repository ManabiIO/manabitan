#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Revalidate retained raw baseline reports; never turn failed attempts into timing samples."""

import argparse
from copy import deepcopy
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(ROOT / 'dev/perf/import-memory-20261125-a7f7'))
from qualification_overlay import BENCHMARK_SUPPORT_PATH, OVERLAY_IDENTITY
from qualification_receipts import (
    CURRENT_BASELINE_SHA, CURRENT_STORAGE_POLICY, canonicalize_storage,
    canonicalize_validation, storage_policy_identity, validate_import_summary,
)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--write', action='store_true', help='Write the deterministic revalidation receipt after checking all original bytes')
args = parser.parse_args()
manifest = json.loads((HERE / 'original-evidence-manifest.json').read_text())
archive = (HERE / manifest['archive']).read_bytes()
require(digest(archive) == manifest['archiveSha256'], 'Original evidence archive digest differs')
require(len(archive) == manifest['archiveBytes'], 'Original evidence archive size differs')
members = {}
with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as tar:
    for item in tar:
        require(item.isfile() and item.name not in members, 'Original archive contains an unexpected member')
        data = tar.extractfile(item).read()
        require(item.name in manifest['members'], 'Original archive has an undeclared member')
        require(manifest['members'][item.name] == {'bytes': len(data), 'sha256': digest(data)}, 'Original member identity differs')
        members[item.name] = data
require(set(members) == set(manifest['members']), 'Original archive member inventory differs')
require(digest((ROOT / BENCHMARK_SUPPORT_PATH).read_bytes()) == OVERLAY_IDENTITY['sha256'], 'Revalidation must use exact #950 support bytes')
fixture_bytes = (ROOT / 'test/perf/dictionaries.lock.json').read_bytes()
fixtures = json.loads(fixture_bytes)['dictionaries']
policy = storage_policy_identity(CURRENT_STORAGE_POLICY, CURRENT_BASELINE_SHA)
node = os.environ.get('MANABITAN_QUALIFICATION_NODE', 'node')
node_check = """import {readFileSync} from 'node:fs'
import {extractImportResult} from './dev/perf/benchmark-support.js'
const dictionary = process.argv[1]
const fixture = JSON.parse(readFileSync('test/perf/dictionaries.lock.json', 'utf8')).dictionaries[dictionary]
const report = JSON.parse(readFileSync(0, 'utf8'))
process.stdout.write(JSON.stringify(extractImportResult(report, dictionary, fixture, false, null, 'sample')))
"""
observations = []
for dictionary in ('jitendex', 'vndb'):
    prefix = f'{dictionary}-evidence/'
    identities = json.loads(members[prefix + 'source-identities.json'])
    original = identities['arms']['A']
    require(original['sha'] == CURRENT_BASELINE_SHA, 'Original observation is not the frozen baseline')
    require(identities['arms']['B']['sha'] == manifest['source']['candidate'], 'Original planned candidate differs')
    require(original['fixtureLockSha256'] == digest(fixture_bytes), 'Original fixture lock differs')
    require(original['sourceHashes'][BENCHMARK_SUPPORT_PATH] == OVERLAY_IDENTITY['originalSha256'], 'Original receipt helper differs')
    report_bytes = members[prefix + 'warmup-1-A/run-1.json']
    report = json.loads(report_bytes)
    require(report['packageSha256'] == original['packageSha256'], 'Original report package identity differs')
    browser = json.loads(members[prefix + 'browser-identity.json'])['version']
    require(report['browserVersion'] == browser, 'Original report browser identity differs')
    extracted = json.loads(subprocess.check_output(
        [node, '--input-type=module', '-e', node_check, dictionary], input=report_bytes, cwd=ROOT))
    canonical = canonicalize_validation(
        extracted['validation'], dictionary=dictionary, fixture=fixtures[dictionary], media_check='sample',
        storage_policy=CURRENT_STORAGE_POLICY, baseline_sha=CURRENT_BASELINE_SHA)
    summary_path = prefix + 'warmup-1-A/summary.json'
    if summary_path in members:
        summary = json.loads(members[summary_path])
        validate_import_summary(
            summary, report, dictionary=dictionary, fixture=fixtures[dictionary],
            source_sha=original['sha'], package_sha256=original['packageSha256'], browser_version=browser,
            source_hashes=original['sourceHashes'], storage_policy=CURRENT_STORAGE_POLICY,
            baseline_sha=CURRENT_BASELINE_SHA)
        for key, value in extracted.items():
            require(summary['runs'][0][key] == value, f'Original native summary differs from corrected extraction: {key}')
    observations.append({
        'dictionary': dictionary, 'sourceSha': original['sha'], 'packageSha256': original['packageSha256'],
        'rawReportSha256': digest(report_bytes), 'rawSummaryAvailable': summary_path in members,
        'nativeExtractionPassed': True, 'semanticValidationPassed': True,
        'canonicalValidationSha256': digest(json.dumps(canonical, sort_keys=True, separators=(',', ':')).encode()),
        'termRows': canonical['termRows'], 'mediaFiles': canonical['media']['totalFiles'],
        'lookupObservations': len(canonical['lookup']['observations']),
    })

vndb = json.loads(members['vndb-evidence/warmup-1-A/run-1.json'])['benchmark']['validation']['storage']
rejected_pages = []
for pages in (36, 38):
    changed = deepcopy(vndb)
    active = next(item for item in changed['files'] if '/.opaque/' in item['path'] and item['bytes'] > 4096)
    changed['bytes'] += pages * 4096 - active['bytes']
    active['bytes'] = pages * 4096
    try:
        canonicalize_storage(changed, 'vndb', storage_policy=CURRENT_STORAGE_POLICY, baseline_sha=CURRENT_BASELINE_SHA)
    except ValueError as failure:
        require('exactly 151552' in str(failure), 'Counterexample failed for an unrelated reason')
        rejected_pages.append(pages)
    else:
        raise ValueError('Current storage contract accepted a neighboring page allocation')
try:
    canonicalize_storage(vndb, 'vndb')
except ValueError as failure:
    require('129–131' in str(failure), 'Historical storage contract changed unexpectedly')
else:
    raise ValueError('Historical storage contract accepted the new allocation')

receipt = {
    'schemaVersion': 1,
    'purpose': 'Offline diagnosis only; original failed acquisitions stay invalid and are excluded from every timing cohort',
    'originalArchiveSha256': manifest['archiveSha256'], 'verifiedOriginalFiles': len(members),
    'measurementOverlay': OVERLAY_IDENTITY, 'storagePolicy': policy,
    'observations': observations,
    'counterexamples': {'rejectedVndbPages': rejected_pages, 'historicalContractStillRejects37Pages': True},
    'browserAcquisitions': 0,
}
result = json.dumps(receipt, indent=4, sort_keys=True) + '\n'
destination = HERE / 'baseline-revalidation.json'
if args.write:
    destination.write_text(result)
else:
    require(destination.read_text() == result, 'Deterministic baseline revalidation differs from its checked receipt')
print(f'Verified {len(members)} original files; revalidated two baseline reports; rejected 36/38-page counterexamples. No browser acquisition or timing sample added.')
