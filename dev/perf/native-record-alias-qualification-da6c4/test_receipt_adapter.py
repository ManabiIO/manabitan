# SPDX-License-Identifier: GPL-3.0-or-later
"""Synthetic adversarial evidence checks; no corpus timing or browser claim."""
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(os.environ['MANABITAN_RECEIPT_SOURCE']).resolve()
sys.path.insert(0, str(ROOT / 'dev/perf/import-memory-20261125-a7f7'))
from test_qualification_receipts import observation, validate, change_validation, set_active_sah_units
from receipt_adapter import AliasReceiptComparator, CURRENT_BASE, PROTOCOL_BLOB, ROUTE_KEYS, file_vector, route_receipt, term_paths
from harness_overlay import ANCHOR, layout_overlay
from probe_projection import js_json_sha, original_semantic_projection, physical_probes, probe_views
from test_probe_projection import synthetic_probes


def sha(value):
    return hashlib.sha256(value if isinstance(value, bytes) else value.encode()).hexdigest()


def corpus(dictionary='vndb', arm='A', generation='1'):
    summary, report = observation(dictionary)
    if dictionary == 'vndb':
        change_validation(summary, report, lambda value: set_active_sah_units(value, 37))
    if dictionary == 'vndb' and arm == 'B':
        def move(value):
            value['outputDigestSha256'] = 'e' * 64
            for item in value['storage']['files']:
                if item['path'] in term_paths(dictionary):
                    item['bytes'] += 10
                    value['storage']['bytes'] += 10
        change_validation(summary, report, move)
    probes = synthetic_probes(dictionary, arm)
    change_validation(summary, report, lambda value: value.__setitem__('outputDigestSha256', probes['physicalOutputDigestSha256']))
    receipt = validate(summary, report, vndb_sah_allocation_units=(37, 37) if dictionary == 'vndb' else None)
    validation = deepcopy(summary['runs'][0]['validation'])
    fixture = summary['fixture']
    inventory = deepcopy(sorted(validation['storage']['files'], key=lambda item: item['path']))
    selected = {item['path']: item['bytes'] for item in inventory if item['path'] in term_paths(dictionary)}
    files = []
    indexes = sorted(path for path in selected if path.endswith('.mbti'))
    for pathname, size in sorted(selected.items()):
        if pathname.endswith('.mbti'):
            header = {'kind': 'index', 'generationRange': [24, 40], 'generationId': generation * 32,
                'descriptorBytes': selected[pathname[:-5]], 'chunkCount': 1,
                'rowCount': fixture['termRows'] - len(indexes) + 1 if pathname == indexes[0] else 1}
        elif pathname.endswith('.mbtr'):
            header = {'kind': 'descriptor', 'generationRange': [8, 24], 'generationId': generation * 32}
        else:
            header = {'kind': 'content', 'generationRange': None, 'generationId': None}
        normalized = sha(pathname + ('candidate' if dictionary == 'vndb' and arm == 'B' else 'baseline'))
        files.append({'path': pathname, 'bytes': size, 'sha256': normalized if header['kind'] == 'content' else sha(normalized + generation),
            'normalizedSha256': normalized, 'header': header, 'chunks': 1})
    route = {key: 0 for key in ROUTE_KEYS}
    route.update({'rows': fixture['termRows'], 'chunkCount': 170 if dictionary == 'vndb' else 12,
        'parserParallelWorkerCount': 3, 'parserParallelPipelineGroupsPerWorker': 3,
        'parserParallelGroupCount': 170 if dictionary == 'vndb' else 12})
    route.update({'contentAliasCount': 8 if dictionary == 'vndb' and arm == 'B' else 0,
                  'contentAliasInputBytes': 2983 if dictionary == 'vndb' and arm == 'B' else 0})
    request = {'schemaVersion': 1, 'baseline': CURRENT_BASE, 'candidate': 'b' * 40, 'protocolBlob': PROTOCOL_BLOB,
        'arm': arm, 'mode': 'hash-only', 'dictionary': dictionary, 'fixtureSha256': fixture['sha256'],
        'sourceCommit': 'b' * 40 if arm == 'B' else CURRENT_BASE, 'sourceTree': 'c' * 40 if arm == 'B' else 'd' * 40,
        'sourceManifestSha256': ('1' if arm == 'B' else '2') * 64,
        'packageSha256': ('3' if arm == 'B' else '4') * 64, 'exporterSha256': '9' * 64,
        'termFiles': sorted(term_paths(dictionary)), 'outputDirectory': '/synthetic/' + arm}
    layout = {'schemaVersion': 1, 'complete': True, 'authoritativeTiming': False, 'request': request,
        'cleanupFailures': [], 'failure': None, 'files': files, 'fixture': fixture, 'validation': validation,
        'beforeInventory': inventory, 'afterInventory': deepcopy(inventory),
        'headerLinkage': {'pairs': len(indexes), 'rows': fixture['termRows']},
        'probes': probes,
        'importDebug': {'hasResult': True, 'errorCount': 0, 'addSettingsErrorCount': 0, 'usesFallbackStorage': False,
            'importerPhaseTimings': [{'phase': 'term-file-fast-path:all-source-banks', 'details': route}]}}
    return receipt, layout


def binding(a, b, dictionary='vndb'):
    result = {'schemaVersion': 1, 'baseline': CURRENT_BASE, 'candidate': 'b' * 40, 'protocolBlob': PROTOCOL_BLOB,
        'dictionary': dictionary, 'fixtureSha256': a['fixture']['sha256'], 'exporterSha256': '9' * 64,
        'receiptAdapterSha256': sha(Path(__file__).with_name('receipt_adapter.py').read_bytes()),
        'sources': {arm: {'commit': layout['request']['sourceCommit'], 'tree': layout['request']['sourceTree'],
                         'sourceManifestSha256': layout['request']['sourceManifestSha256'], 'packageSha256': layout['request']['packageSha256']}
                    for arm, layout in [('A', a), ('B', b)]}}
    if dictionary == 'vndb':
        result['physicalProof'] = {'complete': True, 'baseline': CURRENT_BASE, 'candidate': 'b' * 40,
            'naturalReplayComparisonSha256': '5' * 64, 'browserVerificationASha256': '6' * 64, 'browserVerificationBSha256': '7' * 64}
        result['witnesses'] = {arm: {'preflightLayoutSha256': sha(arm),
            'physicalOutputDigestSha256': layout['probes']['physicalOutputDigestSha256'],
            'semanticProbeDigestSha256': layout['probes']['semanticProbeDigestSha256'],
            'files': file_vector(layout, dictionary, layout['fixture']['termRows']),
            'route': route_receipt(layout['importDebug'])[0], **probe_views(layout['probes'])}
            for arm, layout in [('A', a), ('B', b)]}
        result['physicalProof']['rawProbeRelocationProof'] = {
            'schemaVersion': 1, 'complete': True, 'naturalComparisonSha256': '5' * 64,
            'contentFiles': {arm: {'bytes': next(item['bytes'] for item in layout['files'] if item['header']['kind'] == 'content'),
                                  'sha256': next(item['normalizedSha256'] for item in layout['files'] if item['header']['kind'] == 'content')}
                             for arm, layout in [('A', a), ('B', b)]},
        }
    return result


class AliasReceipts(unittest.TestCase):
    def setUp(self):
        self.ra, self.la = corpus()
        self.rb, self.lb = corpus(arm='B', generation='2')
        self.plan = binding(self.la, self.lb)
        self.comparator = AliasReceiptComparator(self.plan)

    def check_both(self):
        self.comparator.check(self.ra, self.la, 'A')
        self.comparator.check(self.rb, self.lb, 'B')

    def test_only_exact_proved_cross_arm_layout_can_differ(self):
        self.check_both()
        original = deepcopy((self.ra, self.rb, self.la, self.lb))
        self.comparator.compare(self.ra, self.rb, 'A', 'B')
        self.assertEqual((self.ra, self.rb, self.la, self.lb), original)

    def test_unchecked_or_mutated_observation_cannot_use_previous_hash_proof(self):
        with self.assertRaises(ValueError):
            self.comparator.compare(self.ra, self.rb, 'A', 'B')
        self.check_both()
        with self.assertRaises(ValueError):
            self.comparator.compare(self.ra, deepcopy(self.rb), 'A', 'B')
        self.rb['common']['validation']['additionalSemanticField'] = 'must survive'
        with self.assertRaises(ValueError):
            self.comparator.compare(self.ra, self.rb, 'A', 'B')

    def test_wrong_own_arm_preview_is_rejected_with_stale_or_recomputed_digests(self):
        for arm, receipt, layout in [('A', self.ra, self.la), ('B', self.rb, self.lb)]:
            changed = deepcopy(layout)
            for phase in ('before', 'after'):
                changed['probes'][phase][0]['probes'][0]['diagnostics']['offscreenState']['rowSample'][0]['rawContentPreview'] = 'wrong'
            with self.subTest(arm=arm), self.assertRaises(ValueError):
                self.comparator.check(receipt, changed, arm)
            physical = physical_probes(changed['probes']['before'])
            semantic = original_semantic_projection(physical)
            changed['probes'].update(physicalBefore=physical, physicalAfter=deepcopy(physical),
                semanticProjection=semantic, physicalOutputDigestSha256=js_json_sha(physical),
                semanticProbeDigestSha256=js_json_sha(semantic))
            changed['validation']['outputDigestSha256'] = js_json_sha(physical)
            changed_receipt = deepcopy(receipt)
            changed_receipt['common']['validation']['outputDigestSha256'] = js_json_sha(physical)
            with self.subTest(arm=arm, self_consistent=True), self.assertRaisesRegex(ValueError, 'frozen arm oracle'):
                self.comparator.check(changed_receipt, changed, arm)

    def test_logical_id_decoded_error_and_row_order_mutations_are_not_projected(self):
        for key, value in [('id', 999), ('id', True), ('expression', 'wrong'), ('reading', 'wrong'),
                           ('decodedContentDebug', {'length': 1}), ('readErrorDetails', {'error': 'failed'})]:
            changed = deepcopy(self.lb)
            for phase in ('before', 'after'):
                changed['probes'][phase][0]['probes'][0]['diagnostics']['offscreenState']['rowSample'][0][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.comparator.check(self.rb, changed, 'B')
        changed = deepcopy(self.lb)
        for phase in ('before', 'after'):
            changed['probes'][phase][0]['probes'][0]['diagnostics']['offscreenState']['rowSample'].reverse()
        with self.assertRaises(ValueError):
            self.comparator.check(self.rb, changed, 'B')

    def test_fresh_random_generation_is_the_only_within_arm_file_normalization(self):
        self.check_both()
        rc, lc = corpus(arm='C', generation='3')
        self.comparator.check(rc, lc, 'C')
        self.comparator.compare(self.ra, rc, 'A', 'C')
        self.assertNotEqual(self.la['files'][1]['sha256'], lc['files'][1]['sha256'])
        self.assertEqual(self.la['files'][1]['normalizedSha256'], lc['files'][1]['normalizedSha256'])

    def test_same_size_corruption_and_unknown_files_and_fields_fail(self):
        mutations = [
            lambda value: value['files'][1].__setitem__('normalizedSha256', 'a' * 64),
            lambda value: value['files'][0].__setitem__('sha256', 'a' * 64),
            lambda value: value['files'][0].__setitem__('path', 'unrelated.bin'),
            lambda value: value['files'][1].__setitem__('ignored', True),
            lambda value: value['files'].append(deepcopy(value['files'][0])),
            lambda value: value['files'][0].__setitem__('chunks', 2),
            lambda value: value['files'][0].__setitem__('bytes', value['files'][0]['bytes'] + 1),
        ]
        for mutate in mutations:
            value = deepcopy(self.lb); mutate(value)
            with self.subTest(mutate=mutate), self.assertRaises(ValueError):
                self.comparator.check(self.rb, value, 'B')

    def test_bad_generation_links_and_normalization_ranges_fail(self):
        index = next(i for i, value in enumerate(self.lb['files']) if value['header']['kind'] == 'index')
        for key, changed in [('generationId', 'a' * 32), ('generationRange', [0, 40]), ('descriptorBytes', 999), ('rowCount', 1)]:
            layout = deepcopy(self.lb); layout['files'][index]['header'][key] = changed
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.comparator.check(self.rb, layout, 'B')

    def test_source_fixture_protocol_and_completion_identity_are_not_optional(self):
        mutations = [lambda value: value.__setitem__('complete', False),
            lambda value: value['cleanupFailures'].append('lock'),
            lambda value: value.__setitem__('failure', {'message': 'bad'}),
            lambda value: value['request'].__setitem__('baseline', '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2'),
            lambda value: value['request'].__setitem__('sourceCommit', CURRENT_BASE),
            lambda value: value['request'].__setitem__('sourceTree', 'e' * 40),
            lambda value: value['request'].__setitem__('packageSha256', 'e' * 64),
            lambda value: value['request'].__setitem__('exporterSha256', 'e' * 64),
            lambda value: value['request'].__setitem__('fixtureSha256', 'e' * 64),
            lambda value: value['request'].__setitem__('protocolBlob', 'e' * 40),
            lambda value: value['afterInventory'][0].__setitem__('bytes', 1)]
        for mutate in mutations:
            layout = deepcopy(self.lb); mutate(layout)
            with self.subTest(mutate=mutate), self.assertRaises(ValueError):
                self.comparator.check(self.rb, layout, 'B')

    def test_actual_phase_activation_and_all_logical_counts_are_required(self):
        for key, changed in [('contentAliasCount', 0), ('contentAliasInputBytes', 2984), ('rows', 1),
                             ('parserParallelWorkerCount', 4), ('parserFusedFallbacks', 1), ('dedupPersistedHitCount', 1)]:
            layout = deepcopy(self.lb); layout['importDebug']['importerPhaseTimings'][0]['details'][key] = changed
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.comparator.check(self.rb, layout, 'B')
        layout = deepcopy(self.lb); layout['importDebug']['importerPhaseTimings'] *= 2
        with self.assertRaises(ValueError): self.comparator.check(self.rb, layout, 'B')

    def test_missing_or_stale_oracle_is_rejected_before_observations(self):
        for mutate in [lambda value: value.pop('witnesses'),
                       lambda value: value['physicalProof'].__setitem__('complete', False),
                       lambda value: value['physicalProof'].__setitem__('baseline', 'a' * 40),
                       lambda value: value['witnesses']['B'].__setitem__('semanticProbeDigestSha256', 'a' * 64),
                       lambda value: value.__setitem__('receiptAdapterSha256', 'a' * 64)]:
            plan = deepcopy(self.plan); mutate(plan)
            with self.subTest(mutate=mutate), self.assertRaises(ValueError): AliasReceiptComparator(plan)

    def test_unrelated_storage_and_additional_semantics_remain_exact(self):
        self.check_both()
        # A new non-location field survives the projection and must compare equal.
        receipt, layout = deepcopy(self.rb), deepcopy(self.lb)
        receipt['common']['validation']['additionalSemanticField'] = {'value': 1}
        layout['validation']['additionalSemanticField'] = {'value': 1}
        self.comparator.check(receipt, layout, 'B')
        with self.assertRaises(ValueError): self.comparator.compare(self.ra, receipt, 'A', 'B')

    def test_unrelated_media_storage_and_media_digest_are_never_projected(self):
        self.check_both()
        receipt, layout = deepcopy(self.rb), deepcopy(self.lb)
        media_path = next(item['path'] for item in layout['beforeInventory'] if item['path'].startswith('manabitan-dictionary-media-v1/'))
        for inventory in [layout['beforeInventory'], layout['afterInventory'], layout['validation']['storage']['files']]:
            next(item for item in inventory if item['path'] == media_path)['bytes'] += 1
        layout['validation']['storage']['bytes'] += 1
        normalized = receipt['common']['validation']['storage']
        next(item for item in normalized['files'] if item['path'].startswith('manabitan-dictionary-media-v1/'))['bytes'] += 1
        normalized['bytes'] += 1
        self.comparator.check(receipt, layout, 'B')
        with self.assertRaises(ValueError): self.comparator.compare(self.ra, receipt, 'A', 'B')
        receipt, layout = deepcopy(self.rb), deepcopy(self.lb)
        receipt['media']['sha256'] = '1' * 64; layout['validation']['media']['sha256'] = '1' * 64
        self.comparator.check(receipt, layout, 'B')
        with self.assertRaises(ValueError): self.comparator.compare(self.ra, receipt, 'A', 'B')

    def test_sqlite_allocation_and_unknown_inventory_paths_fail_before_projection(self):
        for kind in ('sqlite', 'unknown'):
            layout = deepcopy(self.lb)
            if kind == 'sqlite':
                set_active_sah_units(layout['validation'], 38)
            else:
                layout['validation']['storage']['files'].append({'path': 'unknown.bin', 'bytes': 1})
                layout['validation']['storage']['bytes'] += 1
            with self.subTest(kind=kind), self.assertRaises(ValueError): self.comparator.check(self.rb, layout, 'B')

    def test_non_target_arms_have_zero_aliases_and_exact_whole_file_hashes(self):
        for dictionary in ('jmdict', 'jitendex'):
            ra, la = corpus(dictionary); rb, lb = corpus(dictionary, 'B', '2')
            comparator = AliasReceiptComparator(binding(la, lb, dictionary))
            comparator.check(ra, la, 'A'); comparator.check(rb, lb, 'B'); comparator.compare(ra, rb, 'A', 'B')
            changed = deepcopy(lb); changed['files'][1]['normalizedSha256'] = 'a' * 64
            with self.assertRaises(ValueError): comparator.check(rb, changed, 'B')
            changed = deepcopy(lb); changed['importDebug']['importerPhaseTimings'][0]['details']['contentAliasCount'] = 1
            with self.assertRaises(ValueError): comparator.check(rb, changed, 'B')


class Overlay(unittest.TestCase):
    def test_current_real_harness_unique_post_endpoint_hook_parses_and_is_identical_across_modes(self):
        source = (ROOT / 'test/chromium/extension-two-dictionary-import.e2e.js').read_text()
        module = Path(__file__).with_name('browser-layout-export.mjs').resolve()
        output, receipt = layout_overlay(source, module, sha(source))
        self.assertEqual(output.count('await exportBrowserTermLayoutFromHarness('), 1)
        self.assertTrue(receipt['sourceDirty']); self.assertFalse(receipt['productChanged'])
        self.assertGreater(output.index('await exportBrowserTermLayoutFromHarness('), output.index('report.benchmark.validation = {'))
        self.assertNotIn('hash-only', receipt['hook'])
        with tempfile.TemporaryDirectory() as temporary:
            filename = Path(temporary) / 'overlaid.mjs'; filename.write_text(output)
            subprocess.run(['node', '--check', str(filename)], check=True, capture_output=True)
        for changed, expected in [(source, '0' * 64), (output, sha(output)), (source.replace(ANCHOR, ''), sha(source.replace(ANCHOR, '')))]:
            with self.assertRaises(ValueError): layout_overlay(changed, module, expected)


if __name__ == '__main__':
    unittest.main()
