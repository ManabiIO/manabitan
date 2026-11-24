# SPDX-License-Identifier: GPL-3.0-or-later
"""Offline package and semantic receipts reconcile without a browser."""

import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

from protocol import DEPENDENCY_PATHS, HARNESS, digest, package_entries, read_summary, save
from run_memory import memory_overlay, schedule
from test_protocol import native_receipt
from verify_receipts import verify


def artifact(root, replication):
    template, plan, _ = native_receipt()
    original = ("import {existsSync, readFileSync} from 'node:fs';\n"
                '/**\n * Exercise real browser confirmation dialogs\n */\n'
                '        const initialImportTriggerStart = safePerformance.now();\n'
                '            const importTotalEnd = safePerformance.now();\n')
    overlay = memory_overlay(original)
    (root / 'original-harness.e2e.js').write_text(original)
    (root / 'memory-harness.e2e.js').write_text(overlay)
    hashes = {}
    for name in DEPENDENCY_PATHS:
        path = root / 'source' / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(name)
        hashes[name] = digest(path)
    plan.update(authoritativeTiming=False, replication=replication, schedule=schedule(replication),
                sourceFiles=hashes, dependencySourceSha256=hashes,
                memoryOverlaySha256=hashlib.sha256(overlay.encode()).hexdigest(),
                harnessSha256={**hashes, HARNESS: hashlib.sha256(original.encode()).hexdigest()},
                expectedPackageDifferences=['runtime.js'],
                promotionCriteria={'maximumMedianPairedIncreasePercent': 5,
                                   'maximumIndividualPairedIncreasePercent': 10,
                                   'everyObservationQualified': True,
                                   'bothIndependentReplicationsRequired': True},
                frozenCoverage={'minimumFullyCoveredImportScans': 5, 'maximumCoveredGapMs': 250,
                                'maximumBracketGapMs': 250, 'betweenScanWaitMs': 25})
    plan['sourceIdentities']['B'] = {'commit': 'c' * 40, 'tree': 'd' * 40}
    save(root / 'plan.json', plan)
    save(root / 'setup-fixtures.json', {'jmdict': plan['fixture']})
    save(root / 'package-differences.json', ['runtime.js'])
    identities = {}
    for arm in ('A', 'B'):
        package = root / f'{arm}-product.zip'
        with zipfile.ZipFile(package, 'w') as archive:
            archive.writestr('runtime.js', arm)
            archive.writestr('unchanged.js', 'same bytes')
        identity = {**plan['sourceIdentities'][arm], 'packageSha256': digest(package),
                    'buildCleanBeforeOverlay': True, 'statusWithHarnessOverlay': f'M {HARNESS}',
                    'harnessOverlaySha256': plan['memoryOverlaySha256']}
        identities[arm] = identity
        save(root / f'{arm}-identity.json', identity)
        save(root / f'{arm}-package-entries.json', package_entries(package))
    correctness = []
    for item in plan['schedule']:
        location = root / item['name']
        identity = identities[item['arm']]
        summary = copy.deepcopy(template)
        summary['gitSha'] = identity['commit']
        summary['source'] = {'gitSha': identity['commit'], 'dirty': True,
                             'sha256': {**hashes, HARNESS: plan['memoryOverlaySha256'],
                                        'builds/manabitan-chrome.zip': identity['packageSha256']}}
        summary['runs'][0]['packageSha256'] = identity['packageSha256']
        save(location / 'summary.json', summary)
        save(location / 'acquisition.json', {**item, 'retried': False, 'authoritativeTiming': False,
             'startedEpochSeconds': item['index'] * 2, 'endedEpochSeconds': item['index'] * 2 + 1,
             'source': plan['sourceIdentities'][item['arm']], 'packageSha256': identity['packageSha256']})
        save(location / 'memory.json', {'benchmarkExitCode': 0})
        check = {'name': item['name'], 'status': 'passed', 'authoritativeTiming': False,
                 'receipt': read_summary(location, plan, item['arm'], identity)}
        save(location / 'correctness.json', check)
        correctness.append(check)
    save(root / 'correctness.json', correctness)


class OfflineReceiptsWitness(unittest.TestCase):
    def test_independent_schedules_accept_exact_packages_and_semantics(self):
        for replication in (1, 2):
            with self.subTest(replication=replication), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                artifact(root, replication)
                result = verify(root)
                self.assertTrue(result['allCorrectnessPassed'])
                self.assertEqual(result['observations'], 4)
                self.assertFalse(result['authoritativeTiming'])

    def test_tampered_package_dependency_or_native_receipt_cannot_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifact(root, 1)
            for name in ('A-product.zip', 'source/package-lock.json', 'A1/summary.json'):
                path = root / name
                original = path.read_bytes()
                if name.endswith('summary.json'):
                    summary = json.loads(original)
                    summary['runs'][0]['validation']['lookup']['observations'][0]['sha256'] = '0' * 64
                    save(path, summary)
                else:
                    path.write_bytes(original + b'changed')
                with self.subTest(name=name), self.assertRaises(AssertionError):
                    verify(root)
                path.write_bytes(original)
            self.assertTrue(verify(root)['allCorrectnessPassed'])


if __name__ == '__main__':
    unittest.main()
