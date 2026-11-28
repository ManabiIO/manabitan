# SPDX-License-Identifier: GPL-3.0-or-later
"""Synthetic rejection checks for the independent corrected artifact reader.

No browser, dictionary import, real-artifact audit or acquisition is performed.
"""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest

from audit_artifact import (
    BASELINE_SHA, HARNESS, OBSERVATION_FILES, PRODUCT_BLOBS, SOURCE_CONTEXT,
    overlay_manifest, require_observation_members, require_overlay_sources,
    require_parser_workers, require_physical_family, require_report_pointer,
    require_saved_proof, require_source_context,
)
from compression_harness_overlay import apply_overlay
from compression_proof_receipts import comparison_receipt, require_matching_trial_receipts
from protocol import memory_overlay
from test_compression_proof_receipts import fixture, rewrite_physical


class ArtifactReaderTests(unittest.TestCase):
    def saved(self, dictionary='jmdict', arm='A'):
        receipt, proof, _, report = fixture(dictionary, arm)
        report['benchmark']['compressionProof'] = deepcopy(proof)
        compared, audit = comparison_receipt(receipt, proof, dictionary=dictionary, arm=arm)
        files = {
            'compression-proof.json': deepcopy(proof),
            'comparison-receipt.json': compared,
            'compression-proof-policy.json': audit,
            'compression-storage-policy.json': deepcopy(audit['originalStorageAudit']),
        }
        return receipt, report, files

    def verify_saved(self, receipt, report, files, *, dictionary='jmdict', arm='A'):
        return require_saved_proof(report, receipt, files.__getitem__,
            dictionary=dictionary, arm=arm, comparison_receipt=comparison_receipt)

    def test_every_arm_accepts_exact_sidecars_without_rewriting_raw_input(self):
        for dictionary in ('jmdict', 'jitendex'):
            for arm in ('A', 'B', 'C'):
                with self.subTest(dictionary=dictionary, arm=arm):
                    receipt, report, files = self.saved(dictionary, arm)
                    before = json.dumps([receipt, report, files], sort_keys=True)
                    proof, audit = self.verify_saved(receipt, report, files, dictionary=dictionary, arm=arm)
                    self.assertEqual(proof, report['benchmark']['compressionProof'])
                    self.assertEqual(audit, files['compression-proof-policy.json'])
                    self.assertEqual(json.dumps([receipt, report, files], sort_keys=True), before)

    def test_old_report_cannot_be_repaired_by_only_adding_a_sidecar(self):
        receipt, report, files = self.saved()
        del report['benchmark']['compressionProof']
        with self.assertRaisesRegex(ValueError, 'raw report lacks'):
            self.verify_saved(receipt, report, files)

    def test_each_derived_file_is_recomputed_and_bound_to_the_raw_proof(self):
        for filename in ('compression-proof.json', 'comparison-receipt.json',
                         'compression-proof-policy.json', 'compression-storage-policy.json'):
            with self.subTest(filename=filename):
                receipt, report, files = self.saved('jitendex', 'B')
                files[filename]['unregistered'] = True
                with self.assertRaises(ValueError):
                    self.verify_saved(receipt, report, files, dictionary='jitendex', arm='B')

    def test_self_consistent_sidecar_does_not_excuse_invalid_raw_proof(self):
        receipt, report, files = self.saved()
        proof = report['benchmark']['compressionProof']
        proof['references']['preRestart'][0]['probes'][0]['rows'][0]['rawEntryContentDictName'] = 'raw'
        files['compression-proof.json'] = deepcopy(proof)
        with self.assertRaisesRegex(ValueError, 'compact-reference format'):
            self.verify_saved(receipt, report, files)

    def test_labeled_comparison_copy_cannot_replace_raw_receipt(self):
        _, report, files = self.saved()
        with self.assertRaises(ValueError):
            self.verify_saved(files['comparison-receipt.json'], report, files)

    def test_candidate_family_rejects_allowed_cross_arm_physical_drift_at_all_stages(self):
        a, ap, _, _ = fixture('jmdict', 'A')
        b, bp, _, _ = fixture('jmdict', 'B')
        changed = fixture('jmdict', 'B')
        rewrite_physical(changed, lambda rows: rows[0]['probes'][0]['rowSample'][0].__setitem__(
            'rawContentPreview', 'changed but readable compressed preview'))
        require_matching_trial_receipts(a, changed[0], reference_proof=ap, candidate_proof=changed[1],
            dictionary='jmdict', reference_arm='A', candidate_arm='B')
        for stage, media in (('timed', 'sample'), ('exhaustive-media', 'all'), ('memory', 'sample')):
            with self.subTest(stage=stage):
                anchors = {}
                require_physical_family(anchors, b, bp, dictionary='jmdict', arm='B', media='sample',
                    matcher=require_matching_trial_receipts)
                with self.assertRaisesRegex(ValueError, 'differs'):
                    require_physical_family(anchors, changed[0], changed[1], dictionary='jmdict', arm='B',
                        media=media, matcher=require_matching_trial_receipts)

    def test_control_uses_baseline_family_and_same_media_still_compares_media(self):
        a, ap, _, _ = fixture('jitendex', 'A')
        anchors = {}
        require_physical_family(anchors, a, ap, dictionary='jitendex', arm='A', media='sample',
            matcher=require_matching_trial_receipts)
        changed = deepcopy(a)
        changed['media']['sha256'] = 'f' * 64
        with self.assertRaisesRegex(ValueError, 'media'):
            require_physical_family(anchors, changed, ap, dictionary='jitendex', arm='C', media='sample',
                matcher=require_matching_trial_receipts)
        self.assertEqual(set(anchors), {'A'})

    def test_missing_extra_or_duplicate_observation_paths_fail_completeness(self):
        items = [(f'run-{number}', 'A', 'sample', False) for number in range(26)]
        inventory = [{'path': 'jmdict/' + item[0] + '/' + filename}
                     for item in items for filename in OBSERVATION_FILES]
        require_observation_members(inventory, 'jmdict', items)
        for invalid in (inventory[:-1], inventory + [{'path': 'jmdict/unregistered/run-1.json'}]):
            with self.assertRaises(ValueError):
                require_observation_members(invalid, 'jmdict', items)
        with self.assertRaisesRegex(ValueError, '26 distinct'):
            require_observation_members(inventory, 'jmdict', items[:-1] + [items[0]])

    def test_context_requires_new_common_baseline_and_known_candidate(self):
        candidate = '1' * 40
        plan = {'baseline': BASELINE_SHA, 'candidate': candidate,
                'sourceContext': deepcopy(SOURCE_CONTEXT), 'frozenProductBlobs': deepcopy(PRODUCT_BLOBS)}
        identities = {'arms': {'A': {'sha': BASELINE_SHA}, 'B': {'sha': candidate}},
                      'sourceContext': deepcopy(SOURCE_CONTEXT), 'frozenProductBlobs': deepcopy(PRODUCT_BLOBS)}
        require_source_context(plan, identities, candidate)
        with self.assertRaisesRegex(ValueError, 'supplied candidate'):
            require_source_context(plan, identities, '2' * 40)
        for value in (plan, identities):
            value['sourceContext']['commonBaselineSha'] = SOURCE_CONTEXT['historicalStoragePredictionBaselineSha']
        with self.assertRaisesRegex(ValueError, 'source context'):
            require_source_context(plan, identities, candidate)

    def test_observed_worker_policy_is_exact_and_not_a_runtime_override(self):
        summary = {'runs': [{'step4Breakdown': {'dictionaries': [{'parserWorkerCount': 3}]}}]}
        require_parser_workers(summary)
        for changed in (None, True, 1, 2, 4, '3'):
            summary['runs'][0]['step4Breakdown']['dictionaries'][0]['parserWorkerCount'] = changed
            with self.subTest(value=changed), self.assertRaises(ValueError):
                require_parser_workers(summary)

    def test_report_pointer_binds_exact_observation_and_shared_original_root(self):
        prefix = '/home/runner/work/repository/builds/perf/corrected-study'
        for observation in ('warmup-1-A', 'pair-06-B', 'exhaustive-media-A', 'memory/A1'):
            summary = {'runs': [{'reportJsonPath': prefix + '/jmdict/' + observation + '/run-1.json'}]}
            self.assertEqual(require_report_pointer(summary, 'jmdict', observation, None), prefix)
            self.assertEqual(require_report_pointer(summary, 'jmdict', observation, prefix), prefix)
        invalid = (
            prefix + '/jmdict/pair-01-B/run-1.json',
            prefix + '/jitendex/pair-01-A/run-1.json',
            prefix + '/jmdict/pair-01-A/different.json',
            'relative/jmdict/pair-01-A/run-1.json',
            prefix + '/../jmdict/pair-01-A/run-1.json',
            prefix + '/jmdict//pair-01-A/run-1.json',
            '/other-root/jmdict/pair-01-A/run-1.json',
        )
        for path in invalid:
            with self.subTest(path=path), self.assertRaises(ValueError):
                require_report_pointer({'runs': [{'reportJsonPath': path}]}, 'jmdict', 'pair-01-A', prefix)

    def test_emitted_harness_bytes_must_match_derived_proof_and_composed_markers(self):
        original = (Path(__file__).resolve().parents[3] / HARNESS).read_text()
        proof = apply_overlay(original)
        memory = memory_overlay(proof)
        expected = overlay_manifest(original, proof, memory)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sources = {
                'proof-overlay/harness-original.js': original,
                'proof-overlay/harness-proof.js': proof,
                'proof-overlay/harness-memory.js': memory,
                'memory/harness-original.js': proof,
                'memory/harness-instrumented.js': memory,
            }
            for relative, source in sources.items():
                path = root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(source)
            plan = {'proofOverlay': deepcopy(expected)}
            identities = {'proofOverlay': deepcopy(expected)}
            require_overlay_sources(root, plan, identities, original, proof, memory)
            for relative, source in sources.items():
                with self.subTest(relative=relative):
                    (root / relative).write_text(source + '\n// unregistered\n')
                    with self.assertRaisesRegex(ValueError, 'Emitted overlay source'):
                        require_overlay_sources(root, plan, identities, original, proof, memory)
                    (root / relative).write_text(source)
            plan['proofOverlay']['proofSha256'] = '0' * 64
            with self.assertRaisesRegex(ValueError, 'registered proof overlay'):
                require_overlay_sources(root, plan, identities, original, proof, memory)


if __name__ == '__main__':
    unittest.main()
