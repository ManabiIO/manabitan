# SPDX-License-Identifier: GPL-3.0-or-later
"""Reconcile retained package, source and native correctness receipts offline."""

import json
from pathlib import Path
import sys

from protocol import (DEPENDENCY_PATHS, HARNESS, digest, package_entries, read_summary,
                      receipt_comparison_key, require_package_differences, save, storage_allocation_summary)
from run_memory import memory_overlay, schedule
from storage_receipts import POLICY_VERSION


def verify(root):
    root = Path(root)
    plan = json.loads((root / 'plan.json').read_text())
    assert plan['authoritativeTiming'] is False
    assert plan['storagePolicyVersion'] == POLICY_VERSION
    assert plan['schedule'] == schedule(plan['replication'])
    assert plan['promotionCriteria'] == {
        'maximumMedianPairedIncreasePercent': 5, 'maximumIndividualPairedIncreasePercent': 10,
        'everyObservationQualified': True, 'bothIndependentReplicationsRequired': True,
    }
    assert plan['frozenCoverage'] == {
        'minimumFullyCoveredImportScans': 5, 'maximumCoveredGapMs': 250,
        'maximumBracketGapMs': 250, 'betweenScanWaitMs': 25,
    }
    for name, expected in plan['sourceFiles'].items():
        assert digest(root / 'source' / name) == expected, name
    assert plan['dependencySourceSha256'] == {name: plan['harnessSha256'][name] for name in DEPENDENCY_PATHS}
    assert plan['dependencySourceSha256'] == {name: digest(root / 'source' / name) for name in DEPENDENCY_PATHS}
    assert digest(root / 'original-harness.e2e.js') == plan['harnessSha256'][HARNESS]
    assert memory_overlay((root / 'original-harness.e2e.js').read_text()) == (root / 'memory-harness.e2e.js').read_text()
    assert digest(root / 'memory-harness.e2e.js') == plan['memoryOverlaySha256']
    fixtures = json.loads((root / 'setup-fixtures.json').read_text())
    assert fixtures[plan['dictionary']] == plan['fixture']
    packages, identities = {}, {}
    for arm in ('A', 'B'):
        identities[arm] = json.loads((root / f'{arm}-identity.json').read_text())
        identity = identities[arm]
        assert all(identity[name] == plan['sourceIdentities'][arm][name] for name in ('commit', 'tree'))
        assert identity['buildCleanBeforeOverlay'] is True
        assert identity['statusWithHarnessOverlay'] == f'M {HARNESS}'
        assert identity['harnessOverlaySha256'] == plan['memoryOverlaySha256']
        assert digest(root / f'{arm}-product.zip') == identity['packageSha256']
        packages[arm] = package_entries(root / f'{arm}-product.zip')
        assert packages[arm] == json.loads((root / f'{arm}-package-entries.json').read_text())
    differences = require_package_differences(packages, plan['expectedPackageDifferences'])
    assert differences == json.loads((root / 'package-differences.json').read_text())
    results = []
    expected_receipt = None
    for observation in plan['schedule']:
        location = root / observation['name']
        acquisition = json.loads((location / 'acquisition.json').read_text())
        assert all(acquisition[name] == value for name, value in observation.items())
        assert acquisition['retried'] is False and acquisition['authoritativeTiming'] is False
        assert acquisition['startedEpochSeconds'] <= acquisition['endedEpochSeconds']
        assert acquisition['source'] == plan['sourceIdentities'][observation['arm']]
        assert acquisition['packageSha256'] == identities[observation['arm']]['packageSha256']
        recorded = json.loads((location / 'correctness.json').read_text())
        memory = json.loads((location / 'memory.json').read_text())
        try:
            receipt = read_summary(location, plan, observation['arm'], identities[observation['arm']])
            receipt_key = receipt_comparison_key(receipt)
            if expected_receipt is not None and receipt_key != expected_receipt:
                raise ValueError('Correctness receipt differs across observations')
            expected_receipt = receipt_key
            if memory['benchmarkExitCode'] != 0:
                raise ValueError('Native command failed')
        except (AssertionError, KeyError, ValueError, OSError) as error:
            assert recorded['status'] == 'failed', str(error)
        else:
            assert recorded == {'name': observation['name'], 'status': 'passed',
                                'authoritativeTiming': False, 'receipt': receipt}
        results.append(recorded)
    assert results == json.loads((root / 'correctness.json').read_text())
    assert storage_allocation_summary(results, plan['schedule']) == json.loads((root / 'storage-allocation-summary.json').read_text())
    return {'schemaVersion': 1, 'authoritativeTiming': False, 'observations': len(results),
            'allCorrectnessPassed': all(row['status'] == 'passed' for row in results),
            'packageDifferences': differences, 'sourceIdentities': plan['sourceIdentities']}


if __name__ == '__main__':
    result = verify(sys.argv[1])
    save(Path(sys.argv[1]) / 'receipt-audit.json', result)
    print(json.dumps(result))
