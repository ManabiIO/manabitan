# SPDX-License-Identifier: GPL-3.0-or-later
"""Synthetic source/hash/closure binding negatives; no browser evidence is invented."""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest

from test_receipt_adapter import corpus, binding
from receipt_adapter import file_vector
from browser_proof import bind_preflight, file_sha


class FullBrowserProofBindings(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.arms = {}
        self.common = None
        layouts = {}
        self.core = {
            'complete': True, 'rows': 6648310, 'canonicalEntries': 157150,
            'normalContentSpansVerified': 170, 'aliasGroups': [1, 87, 91, 92, 105, 123, 126, 139],
            'aliasRows': 175, 'aliasCount': 8, 'aliasInputBytes': 2983, 'logicalSha256': '1' * 64, 'arms': {},
        }
        self.comparison = self.root / 'comparison.json'
        self.comparison.write_text(json.dumps({'complete': True, 'logicalSha256': self.core['logicalSha256'],
            'canonicalRows': 157150, 'normalSpanProofs': [{}] * 170, 'addedContentBytes': 2260}))
        self.core['comparisonSha256'] = file_sha(self.comparison)
        for arm in ('A', 'B'):
            receipt, layout = corpus(arm=arm)
            layout['request']['mode'] = 'export'
            layout['validation']['media'].update(mode='all', files=146570, bytes=188131284)
            receipt['media'] = deepcopy(layout['validation']['media'])
            layout['exclusiveTermHandles'] = [{'exclusiveHandleClosed': True}] * 5
            location = self.root / (arm + '-layout.json')
            location.write_text(json.dumps(layout))
            layouts[arm] = layout
            self.arms[arm] = {'layout': layout, 'layoutPath': location,
                              'verificationPath': self.root / (arm + '-verified.json'), 'receipt': receipt}
        self.common = binding(layouts['A'], layouts['B'])
        self.common.pop('witnesses')
        self.common.pop('physicalProof')
        self.core.update(baseline=self.common['baseline'], candidate=self.common['candidate'])
        for arm, item in self.arms.items():
            identity = self.common['sources'][arm]
            oracle = {'pipelineSha256': ('2' if arm == 'A' else '3') * 64,
                      'verificationSha256': ('4' if arm == 'A' else '5') * 64,
                      'nativePreparedGroups': 162 if arm == 'A' else 170, 'coldLookupProbes': 82,
                      'coldRecordProbes': 20 if arm == 'A' else 194,
                      'files': file_vector(item['layout'], 'vndb', self.core['rows'])}
            self.core['arms'][arm] = oracle
            inventory = [{'file': entry['path'], 'bytes': entry['bytes'], 'sha256': entry['sha256'],
                          'normalizedSha256': entry['normalizedSha256']} for entry in item['layout']['files']]
            verified = {'schemaVersion': 1, 'complete': True, 'browserNaturalTermFileEqualityEstablished': True,
                'failures': [], 'arm': arm, 'protocolBlob': self.common['protocolBlob'],
                'sourceCommit': identity['commit'], 'sourceTree': identity['tree'],
                'packageSha256': identity['packageSha256'], 'sourceManifestSha256': identity['sourceManifestSha256'],
                'naturalCoreSha256': '6' * 64, 'pipelineSha256': oracle['pipelineSha256'],
                'naturalPipelineReportSha256': oracle['pipelineSha256'],
                'naturalVerificationReportSha256': oracle['verificationSha256'],
                'naturalComparisonReportSha256': self.core['comparisonSha256'],
                'browserLayoutReportSha256': file_sha(item['layoutPath']),
                'inputLogicalSha256': self.core['logicalSha256'], 'verifiedRows': self.core['rows'],
                'nativePreparedGroups': oracle['nativePreparedGroups'],
                'coldLookupProbes': oracle['coldLookupProbes'], 'coldRecordProbes': oracle['coldRecordProbes'],
                'groups': [{}] * 170, 'aliasProofs': [{}] * (8 if arm == 'B' else 0),
                'fileInventory': inventory, 'fileInventoryAfterReads': deepcopy(inventory),
                'quiescenceAfterRead': {'parentOpenResources': 0, 'lockEntries': [], 'stagingEntries': []}}
            item['verificationPath'].write_text(json.dumps(verified))

    def tearDown(self):
        self.temporary.cleanup()

    def call(self):
        return bind_preflight(core=self.core, core_sha256='6' * 64, comparison_path=self.comparison,
                              arms=self.arms, common_binding=self.common)

    def mutate_verification(self, arm, mutate):
        path = self.arms[arm]['verificationPath']
        value = json.loads(path.read_text())
        mutate(value)
        path.write_text(json.dumps(value))

    def test_complete_linked_synthetic_witness_is_accepted(self):
        result = self.call()
        self.assertTrue(result['physicalProof']['complete'])
        self.assertEqual(set(result['witnesses']), {'A', 'B'})

    def test_stale_pipeline_or_layout_hash_is_rejected(self):
        for key in ('pipelineSha256', 'naturalPipelineReportSha256', 'browserLayoutReportSha256'):
            original = self.arms['B']['verificationPath'].read_bytes()
            self.mutate_verification('B', lambda value: value.__setitem__(key, '0' * 64))
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.call()
            self.arms['B']['verificationPath'].write_bytes(original)

    def test_late_cleanup_failure_or_inventory_mutation_is_rejected(self):
        mutations = (
            lambda value: value['quiescenceAfterRead']['lockEntries'].append('leftover'),
            lambda value: value['fileInventoryAfterReads'][0].__setitem__('sha256', '0' * 64),
            lambda value: value.__setitem__('fileInventory', []),
            lambda value: value.__setitem__('complete', False),
        )
        for mutate in mutations:
            original = self.arms['B']['verificationPath'].read_bytes()
            self.mutate_verification('B', mutate)
            with self.subTest(mutate=mutate), self.assertRaises(ValueError):
                self.call()
            self.arms['B']['verificationPath'].write_bytes(original)

    def test_incomplete_normal_or_alias_proof_is_rejected(self):
        self.core['normalContentSpansVerified'] = 169
        with self.assertRaises(ValueError):
            self.call()
        self.core['normalContentSpansVerified'] = 170
        self.mutate_verification('B', lambda value: value['aliasProofs'].pop())
        with self.assertRaises(ValueError):
            self.call()

    def test_missing_arm_or_changed_natural_file_bytes_is_rejected(self):
        original = self.arms.pop('B')
        with self.assertRaises(ValueError):
            self.call()
        self.arms['B'] = original
        self.core['arms']['B']['files'][0]['normalizedSha256'] = '0' * 64
        with self.assertRaises(ValueError):
            self.call()


if __name__ == '__main__':
    unittest.main()
