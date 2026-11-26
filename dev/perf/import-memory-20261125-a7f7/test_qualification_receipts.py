# SPDX-License-Identifier: GPL-3.0-or-later
"""Identity and semantic mutations must fail before a cohort can complete."""

from copy import deepcopy
import hashlib
import json
from pathlib import Path
import unittest

from qualification_receipts import (
    CURRENT_BASELINE_SHA, CURRENT_STORAGE_POLICY, EMPTY_SHA256, EXPECTED_PRODUCT_PATHS, LOOKUP_BOUNDARY,
    SOURCE_HASH_FIELDS, STORAGE_KIND, TIMING_BOUNDARY, canonicalize_storage,
    require_matching_receipts, validate_import_summary,
)


SOURCE = 'a' * 40
PACKAGE = 'b' * 64
BROWSER = '153.0.8010.12'
HARNESS = 'test/chromium/extension-two-dictionary-import.e2e.js'
ROOT = Path(__file__).resolve().parents[3]
FIXTURES = json.loads((ROOT / 'test/perf/dictionaries.lock.json').read_text())['dictionaries']


def observation(dictionary='vndb'):
    fixture = deepcopy(FIXTURES[dictionary])
    terms = ['supplementary-\U0001f98a', *[f'probe-{number}' for number in range(1, 12)]]
    rows = [{'pass': number, 'term': term, 'elapsedMs': 1.25, 'results': 1,
             'originalTextLength': len(term.encode('utf-16-le')) // 2,
             'hasExactHeadwordMatch': True,
             'sha256': hashlib.sha256(term.encode()).hexdigest()}
            for number in range(6) for term in terms]
    files = [{'path': path.replace('{generation}', '01234567-89ab-4cde-8fab-0123456789ab'), 'bytes': 100 + index}
             for index, path in enumerate(sorted(EXPECTED_PRODUCT_PATHS[dictionary]))]
    files += [{'path': f'manabitan/sqlite-sahpool-v1/.opaque/opaque{number}',
               'bytes': 4096 if number < 7 else 129 * 4096} for number in range(8)]
    media = {'mode': 'sample', 'totalFiles': fixture['mediaFiles'], 'totalBytes': fixture['mediaBytes'],
             'files': min(64, fixture['mediaFiles']),
             'bytes': min(1024, fixture['mediaBytes']),
             'sha256': 'c' * 64 if fixture['mediaFiles'] else EMPTY_SHA256}
    if fixture['mediaFiles'] <= 64:
        media['bytes'] = fixture['mediaBytes']
    validation = {'title': fixture['expectedTitle'], 'revision': fixture['revision'],
                  'termRows': fixture['termRows'], 'contentReadable': True, 'probeCount': 12,
                  'probeTerms': terms, 'outputDigestSha256': 'd' * 64, 'media': media,
                  'storage': {'kind': STORAGE_KIND, 'bytes': sum(item['bytes'] for item in files), 'files': files},
                  'lookup': {'timingBoundary': LOOKUP_BOUNDARY, 'observations': rows},
                  'restart': {'title': fixture['expectedTitle'], 'revision': fixture['revision'],
                              'termRows': fixture['termRows'], 'mediaFiles': fixture['mediaFiles'],
                              'contentReadable': True, 'probeCount': 12}}
    debug = {'hasResult': True, 'resultTitle': fixture['expectedTitle'], 'errorCount': 0,
             'addSettingsErrorCount': 0, 'usesFallbackStorage': False}
    breakdown = {'dictionaries': [{'title': fixture['expectedTitle'], 'parserWorkerCount': 3}]}
    run = {'index': 1, 'tracePath': None, 'browserVersion': BROWSER, 'packageSha256': PACKAGE,
           'totalImportMs': 1000, 'automationObservedImportMs': 1050,
           'step4Breakdown': deepcopy(breakdown),
           'importDebug': deepcopy(debug), 'validation': deepcopy(validation)}
    summary = {'schemaVersion': 3, 'dictionary': dictionary, 'buildTarget': 'chrome', 'fixture': fixture,
               'traceEnabled': False, 'authoritativeTiming': True, 'importFlags': None,
               'mediaCheck': 'sample', 'gitSha': SOURCE, 'timingBoundary': TIMING_BOUNDARY,
               'runs': [run], 'browserVersion': BROWSER, 'hostEnvironment': {'nodeVersion': 'v22.22.0'},
               'source': {'gitSha': SOURCE, 'dirty': False,
                          'sha256': {name: PACKAGE if name == 'builds/manabitan-chrome.zip' else 'e' * 64
                                     for name in SOURCE_HASH_FIELDS}},
               'timing': {'count': 1, 'minMs': 1000, 'medianMs': 1000, 'p95Ms': 1000, 'maxMs': 1000}}
    report = {'status': 'success', 'skippedVerification': False, 'buildTarget': 'chrome',
              'browserFlavor': 'chromium', 'launchMode': 'headless', 'browserVersion': BROWSER,
              'packageSha256': PACKAGE, 'hostEnvironment': {'nodeVersion': 'v22.22.0'},
              'benchmark': {'dictionary': dictionary, 'pinnedDictionaries': True, 'productionImportDefaults': True,
                            'traceEnabled': False, 'authoritativeTiming': True, 'phaseProfiling': False,
                            'phaseScreenshots': False, 'processSampling': False, 'importFlags': None,
                            'mediaCheck': 'sample', 'validation': deepcopy(validation)},
              'phases': [{'name': f'Import {fixture["label"]} via file input', 'startMs': 100, 'endMs': 120},
                         {'name': f'{fixture["label"]}: total import', 'startMs': 100, 'endMs': 1150, 'durationMs': 1050,
                          'data': {'kind': 'dictionary-import', 'dictionary': fixture['label'],
                                   'step4Breakdown': deepcopy(breakdown),
                                   'browserTiming': {'startedAtMs': 50, 'completedAtMs': 1050, 'sequenceBefore': 0,
                                                     'sequence': 1, 'trigger': 'file-input-change', 'errorCount': 0},
                                   'importDebug': deepcopy(debug)}}]}
    return summary, report


def validate(summary, report, **options):
    values = {'dictionary': summary['dictionary'], 'fixture': FIXTURES[summary['dictionary']],
              'source_sha': SOURCE, 'package_sha256': PACKAGE, 'browser_version': BROWSER}
    values.update(options)
    return validate_import_summary(summary, report, **values)


def change_validation(summary, report, change):
    change(summary['runs'][0]['validation'])
    report['benchmark']['validation'] = deepcopy(summary['runs'][0]['validation'])


class QualificationReceiptWitness(unittest.TestCase):
    def test_current_baseline_requires_exactly_37_pages_and_retains_legacy_default(self):
        for pages in (36, 37, 38, 129, 130, 131):
            summary, report = observation()

            def resize(validation):
                storage = validation['storage']
                active = next(item for item in storage['files'] if '/.opaque/' in item['path'] and item['bytes'] > 4096)
                storage['bytes'] += pages * 4096 - active['bytes']
                active['bytes'] = pages * 4096

            change_validation(summary, report, resize)
            with self.subTest(pages=pages):
                if pages == 37:
                    receipt = validate(summary, report, storage_policy=CURRENT_STORAGE_POLICY, baseline_sha=CURRENT_BASELINE_SHA)
                    self.assertEqual(receipt['common']['storagePolicy']['vndbActiveSahBytes'], 151552)
                else:
                    with self.assertRaisesRegex(ValueError, 'exactly 151552'):
                        validate(summary, report, storage_policy=CURRENT_STORAGE_POLICY, baseline_sha=CURRENT_BASELINE_SHA)
                if 129 <= pages <= 131:
                    self.assertNotIn('storagePolicy', validate(summary, report)['common'])
                else:
                    with self.assertRaisesRegex(ValueError, '129–131'):
                        validate(summary, report)

    def test_storage_contract_is_bound_to_baseline_and_compared_for_every_dictionary(self):
        summary, report = observation('jitendex')
        legacy = validate(summary, report)
        current = validate(summary, report, storage_policy=CURRENT_STORAGE_POLICY, baseline_sha=CURRENT_BASELINE_SHA)
        with self.assertRaises(ValueError):
            require_matching_receipts(legacy, current)
        for baseline in (None, SOURCE, CURRENT_BASELINE_SHA[:-1]):
            with self.subTest(baseline=baseline), self.assertRaises(ValueError):
                validate(summary, report, storage_policy=CURRENT_STORAGE_POLICY, baseline_sha=baseline)
        with self.assertRaises(ValueError):
            validate(summary, report, storage_policy='unregistered-policy', baseline_sha=CURRENT_BASELINE_SHA)

    def test_measurement_dirty_paths_require_exact_hashes_and_preserve_default_marker_contract(self):
        summary, report = observation('jitendex')
        path = 'dev/perf/benchmark-support.js'
        summary['source']['dirty'] = True
        options = {'source_dirty': True, 'source_dirty_paths': [path], 'source_hashes': {path: 'e' * 64}}
        validate(summary, report, **options)
        for change in ({'source_dirty_paths': []}, {'source_dirty_paths': [path, path]},
                       {'source_dirty_paths': ['ext/js/dictionary/zstd-term-content.js']},
                       {'source_hashes': {}}, {'source_hashes': {path: 'f' * 64}},
                       {'source_dirty_paths': [HARNESS]}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                validate(summary, report, **{**options, **change})

    def test_all_three_frozen_fixture_shapes_pass_without_mutating_inputs(self):
        for dictionary in ('jmdict', 'jitendex', 'vndb'):
            with self.subTest(dictionary=dictionary):
                summary, report = observation(dictionary)
                original = deepcopy((summary, report))
                receipt = validate(summary, report)
                require_matching_receipts(receipt, receipt)
                self.assertEqual((summary, report), original)

    def test_same_shaped_content_lookup_and_media_digests_cannot_silently_change(self):
        def lookup_digest(validation):
            term = validation['probeTerms'][0]
            for row in validation['lookup']['observations']:
                if row['term'] == term:
                    row['sha256'] = 'f' * 64

        mutations = [lambda value: value.__setitem__('outputDigestSha256', 'f' * 64), lookup_digest,
                     lambda value: value['media'].__setitem__('sha256', 'f' * 64)]
        for mutation in mutations:
            summary, report = observation()
            reference = validate(summary, report)
            change_validation(summary, report, mutation)
            changed = validate(summary, report)
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                require_matching_receipts(reference, changed)

    def test_every_non_timing_semantic_field_remains_in_the_comparison(self):
        summary, report = observation()
        reference = validate(summary, report)
        change_validation(summary, report, lambda value: value.__setitem__('additionalWitness', {'value': 'retained'}))
        with self.assertRaises(ValueError):
            require_matching_receipts(reference, validate(summary, report))

    def test_only_lookup_elapsed_times_and_validated_random_names_are_ignored(self):
        summary, report = observation()
        reference = validate(summary, report)

        def reorder(validation):
            for row in validation['lookup']['observations']:
                row['elapsedMs'] += 100
            validation['lookup']['observations'].reverse()
            for number, item in enumerate(validation['storage']['files']):
                if '/.opaque/' in item['path']:
                    item['path'] = f'manabitan/sqlite-sahpool-v1/.opaque/changed{number}'
                elif item['path'].startswith('manabitan-dictionary-media-v1/'):
                    item['path'] = 'manabitan-dictionary-media-v1/11234567-89ab-4cde-9fab-0123456789ab.bin'
            validation['storage']['files'].reverse()

        change_validation(summary, report, reorder)
        require_matching_receipts(reference, validate(summary, report))

    def test_exact_total_and_each_file_size_are_compared_including_allowed_sah_pages(self):
        for is_sah in (False, True):
            summary, report = observation()
            reference = validate(summary, report)

            def resize(validation):
                storage = validation['storage']
                item = storage['files'][0]
                if is_sah:
                    item = next(item for item in storage['files']
                                if item['path'].startswith('manabitan/sqlite-sahpool-v1/.opaque/') and item['bytes'] > 4096)
                delta = 4096 if is_sah else 1
                item['bytes'] += delta
                storage['bytes'] += delta

            change_validation(summary, report, resize)
            changed = validate(summary, report)
            with self.subTest(is_sah=is_sah), self.assertRaises(ValueError):
                require_matching_receipts(reference, changed)

    def test_malformed_unknown_duplicate_and_out_of_bound_storage_fail_closed(self):
        def out_of_bound(storage):
            item = next(item for item in storage['files'] if '/.opaque/' in item['path'] and item['bytes'] > 4096)
            storage['bytes'] += 3 * 4096
            item['bytes'] += 3 * 4096

        mutations = [
            lambda value: value.__setitem__('bytes', value['bytes'] + 1),
            lambda value: value['files'].append(deepcopy(value['files'][0])),
            lambda value: value['files'][0].__setitem__('path', 'unexpected-product.bin'),
            lambda value: value['files'][0].__setitem__('path', 'manabitan-dictionary-media-v1/not-a-uuid.bin'),
            lambda value: value['files'][-1].__setitem__('path', 'manabitan/sqlite-sahpool-v1/.opaque/subdirectory/file'),
            lambda value: value['files'][0].__setitem__('bytes', True),
            out_of_bound,
        ]
        for mutation in mutations:
            summary, _ = observation()
            storage = summary['runs'][0]['validation']['storage']
            mutation(storage)
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                canonicalize_storage(storage, 'vndb')

    def test_duplicate_probe_or_lookup_missing_pass_and_utf16_length_fail(self):
        mutations = [
            lambda value: value['probeTerms'].__setitem__(1, value['probeTerms'][0]),
            lambda value: value['lookup']['observations'].__setitem__(1, deepcopy(value['lookup']['observations'][0])),
            lambda value: value['lookup']['observations'].pop(),
            lambda value: value['lookup']['observations'][0].__setitem__('originalTextLength', len(value['probeTerms'][0])),
            lambda value: value['lookup']['observations'][0].__setitem__('sha256', 'f' * 64),
            lambda value: value['restart'].__setitem__('contentReadable', False),
        ]
        for mutation in mutations:
            summary, report = observation()
            change_validation(summary, report, mutation)
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                validate(summary, report)

    def test_package_source_browser_and_raw_binding_mismatches_fail(self):
        mutations = [
            lambda summary, report: summary['runs'][0].__setitem__('packageSha256', 'f' * 64),
            lambda summary, report: report.__setitem__('packageSha256', 'f' * 64),
            lambda summary, report: summary['source']['sha256'].__setitem__('builds/manabitan-chrome.zip', 'f' * 64),
            lambda summary, report: summary['source'].__setitem__('gitSha', 'f' * 40),
            lambda summary, report: summary.__setitem__('gitSha', 'f' * 40),
            lambda summary, report: report.__setitem__('browserVersion', '154.0.8010.12'),
            lambda summary, report: summary['runs'][0]['validation'].__setitem__('outputDigestSha256', 'f' * 64),
            lambda summary, report: summary['runs'].append(deepcopy(summary['runs'][0])),
            lambda summary, report: report['benchmark'].__setitem__('processSampling', True),
            lambda summary, report: report['benchmark'].__setitem__('phaseProfiling', True),
            lambda summary, report: report['benchmark'].__setitem__('traceEnabled', True),
            lambda summary, report: report['benchmark'].pop('importFlags'),
            lambda summary, report: summary['source'].__setitem__('dirty', True),
            lambda summary, report: report.__setitem__('skippedVerification', True),
            lambda summary, report: summary['timing'].__setitem__('medianMs', 900),
            lambda summary, report: summary['runs'][0]['step4Breakdown']['dictionaries'][0].__setitem__('parserWorkerCount', 2),
            lambda summary, report: report['hostEnvironment'].__setitem__('nodeVersion', 'v24.22.3'),
        ]
        for mutation in mutations:
            summary, report = observation()
            mutation(summary, report)
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                validate(summary, report)

    def test_cohort_browser_version_and_expected_harness_hash_are_binding(self):
        summary, report = observation()
        for value in (summary, summary['runs'][0], report):
            value['browserVersion'] = '154.0.8010.12'
        with self.assertRaises(ValueError):
            validate(summary, report)
        summary, report = observation()
        with self.assertRaises(ValueError):
            validate(summary, report, source_hashes={HARNESS: 'f' * 64})
        summary['source']['dirty'] = True
        with self.assertRaises(ValueError):
            validate(summary, report, source_dirty=True)
        validate(summary, report, source_dirty=True, source_hashes={HARNESS: 'e' * 64})

    def test_full_media_retains_common_identity_and_has_a_separate_digest(self):
        summary, report = observation()
        sample = validate(summary, report)
        summary['mediaCheck'] = report['benchmark']['mediaCheck'] = 'all'

        def full(validation):
            media = validation['media']
            media.update(mode='all', files=media['totalFiles'], bytes=media['totalBytes'], sha256='f' * 64)

        change_validation(summary, report, full)
        full_receipt = validate(summary, report, media_check='all')
        require_matching_receipts(sample, full_receipt, compare_media=False)
        with self.assertRaises(ValueError):
            require_matching_receipts(sample, full_receipt)
        change_validation(summary, report, lambda value: value['media'].__setitem__('sha256', '1' * 64))
        with self.assertRaises(ValueError):
            require_matching_receipts(full_receipt, validate(summary, report, media_check='all'))
        change_validation(summary, report, lambda value: value['media'].__setitem__('bytes', value['media']['bytes'] - 1))
        with self.assertRaises(ValueError):
            validate(summary, report, media_check='all')


if __name__ == '__main__':
    unittest.main()
