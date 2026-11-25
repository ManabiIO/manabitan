"""Witnesses for frozen limits, instrumentation labels, and compact receipts."""

import ast
from contextlib import redirect_stdout
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from overlay_helpers import BENCHMARK_PATH, HARNESS_PATH, SUPPORT_PATH, overlay_sources, schedule
import packaging_helpers
import run_memory as runner


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]


def observation(arm, pair, pss=1000000, private=800000, qualified=True):
    name = f'{arm}{pair}'
    return {
        'index': 1, 'arm': arm, 'name': name, 'pair': pair,
        'qualifiedForWholeTreePss': qualified, 'qualificationFailures': [] if qualified else ['missing-read'],
        'maxSampledPssKiB': pss if qualified else None,
        'maxSampledPrivateKiB': private if qualified else None,
        'benchmarkExitCode': 0, 'allObservedSampleCount': 10, 'stableFullyReadImportSampleCount': 8,
        'maximumCoveredSampleGapMs': 150, 'preImportBracketGapMs': 100, 'postImportBracketGapMs': 100,
    }


def observations():
    return [{**observation(item['arm'], item['pair']), **item} for item in schedule(1)]


class FrozenProtocolWitness(unittest.TestCase):
    def test_observer_audit_and_witnesses_remain_byte_identical(self):
        provenance = json.loads((HERE / 'provenance.json').read_text())
        for name, expected in provenance['unchangedFiles'].items():
            self.assertEqual(hashlib.sha256((HERE / name).read_bytes()).hexdigest(), expected, name)

    def test_exact_package_and_semantic_helpers_retain_original_source_blocks(self):
        provenance = json.loads((HERE / 'provenance.json').read_text())
        source = (HERE / 'packaging_helpers.py').read_text()
        lines = source.splitlines(keepends=True)
        actual = {}
        for node in ast.parse(source).body:
            name = node.name if isinstance(node, ast.FunctionDef) else (
                node.targets[0].id if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name) else None
            )
            if name in provenance['unchangedPackagerSourceBlocks']:
                block = ''.join(lines[node.lineno - 1:node.end_lineno])
                actual[name] = hashlib.sha256(block.encode()).hexdigest()
        self.assertEqual(actual, provenance['unchangedPackagerSourceBlocks'])
        self.assertEqual(packaging_helpers.ROOT, ROOT)
        self.assertIn('copyDictionaryWasm', packaging_helpers.PACKAGER)
        self.assertIn('finally {', packaging_helpers.PACKAGER)
        self.assertIn('fs.writeFileSync(manifest, original)', packaging_helpers.PACKAGER)

    def test_protocol_rejects_changed_limits_coverage_scope_and_schedule(self):
        original = json.loads(runner.PROTOCOL_PATH.read_text())
        runner.validate_protocol(original)
        cases = [
            ('promotionCriteria', 'maximumMedianPairedIncreasePercent', 6),
            ('promotionCriteria', 'maximumIndividualPairedIncreasePercent', 11),
            ('promotionCriteria', 'everyObservationQualified', False),
            ('frozenCoverage', 'minimumFullyCoveredImportScans', 4),
            ('frozenCoverage', 'maximumCoveredGapMs', 300),
            ('frozenCoverage', 'maximumBracketGapMs', 300),
            ('frozenCoverage', 'betweenScanWaitMs', 100),
            ('orders', '1', 'AABB'),
        ]
        for field, key, value in cases:
            with self.subTest(field=field, key=key):
                altered = copy.deepcopy(original)
                altered[field][key] = value
                with self.assertRaises(RuntimeError):
                    runner.validate_protocol(altered)
        for field, value in [('base', 'develop'), ('observationsPerHost', 2),
                             ('independentHostsPerDictionary', 1), ('dictionaries', ['vndb'])]:
            with self.subTest(field=field):
                altered = copy.deepcopy(original)
                altered[field] = value
                with self.assertRaises(RuntimeError):
                    runner.validate_protocol(altered)
        with self.assertRaises(ValueError):
            schedule(3)

    def test_original_individual_and_median_gates_fail_independently(self):
        rows = observations()
        self.assertTrue(runner.build_comparison(rows, schedule(1), [])['passesProspectiveMemoryScreen'])
        # This is the prior #875 failure shape: one >10% private-memory pair
        # cannot be hidden by an offsetting improvement or a passing median.
        rows[1]['maxSampledPrivateKiB'] = 892327
        rows[2]['maxSampledPrivateKiB'] = 760000
        result = runner.build_comparison(rows, schedule(1), [])
        self.assertLess(result['metrics']['maxSampledPrivateKiB']['medianPairedChangePercent'], 5)
        self.assertGreater(result['metrics']['maxSampledPrivateKiB']['maximumPairedChangePercent'], 10)
        self.assertFalse(result['passesProspectiveMemoryScreen'])
        rows = observations()
        for row in rows:
            if row['arm'] == 'B':
                row['maxSampledPssKiB'] = 1060000
        result = runner.build_comparison(rows, schedule(1), [])
        self.assertLess(result['metrics']['maxSampledPssKiB']['maximumPairedChangePercent'], 10)
        self.assertFalse(result['passesProspectiveMemoryScreen'])

    def test_missing_reordered_or_unqualified_observations_never_pass(self):
        rows = observations()
        for altered in [rows[:3], rows[::-1], rows + rows[:1]]:
            with self.assertRaises(RuntimeError):
                runner.build_comparison(altered, schedule(1), [])
        rows[2].update(qualifiedForWholeTreePss=False, maxSampledPssKiB=None, maxSampledPrivateKiB=None)
        result = runner.build_comparison(rows, schedule(1), [])
        self.assertFalse(result['passesProspectiveMemoryScreen'])
        for metric in result['metrics'].values():
            self.assertIsNone(metric['medianPairedChangePercent'])
            self.assertIsNone(metric['maximumPairedChangePercent'])


class OverlayWitness(unittest.TestCase):
    def sources(self):
        return {name: (ROOT / name).read_text() for name in (HARNESS_PATH, SUPPORT_PATH, BENCHMARK_PATH)}

    def test_overlay_is_identical_for_both_arms_and_rejects_missing_or_duplicate_anchors(self):
        originals = self.sources()
        first = overlay_sources(originals)
        second = overlay_sources(copy.deepcopy(originals))
        self.assertEqual(first, second)
        self.assertEqual(originals, self.sources())
        for name in originals:
            with self.subTest(name=name):
                for value in ['', originals[name] + originals[name], first[name]]:
                    changed = dict(originals, **{name: value})
                    with self.assertRaises(ValueError):
                        overlay_sources(changed)
        with self.assertRaises(ValueError):
            overlay_sources({HARNESS_PATH: originals[HARNESS_PATH]})

    def test_all_overlaid_javascript_parses(self):
        for name, source in overlay_sources(self.sources()).items():
            with self.subTest(name=name):
                subprocess.run(['node', '--input-type=module', '--check'], input=source, text=True,
                               check=True, capture_output=True)

    def test_browser_and_summary_labels_follow_memory_mode(self):
        changed = overlay_sources(self.sources())
        browser = re.search(r'authoritativeTiming: (.*),', changed[HARNESS_PATH]).group(1)
        summary = re.search(r'authoritativeTiming: (.*),', changed[BENCHMARK_PATH]).group(1)
        script = f"""
import assert from 'node:assert/strict'
const browserLabel = new Function('importTracePath', 'capturePhaseProfiles', 'capturePhaseScreenshots', 'captureProcessSamples', 'importMemoryMarkerPath', 'return ' + {json.dumps(browser)})
const summaryLabel = new Function('options', 'process', 'return ' + {json.dumps(summary)})
for (const marker of ['', '/tmp/markers.jsonl']) {{
    assert.equal(browserLabel('', false, false, false, marker), marker.length === 0)
    assert.equal(summaryLabel({{trace: false}}, {{env: {{MANABITAN_IMPORT_MEMORY_MARKERS: marker}}}}), marker.length === 0)
    assert.equal(browserLabel('trace.json', false, false, false, marker), false)
    assert.equal(summaryLabel({{trace: true}}, {{env: {{MANABITAN_IMPORT_MEMORY_MARKERS: marker}}}}), false)
}}
"""
        subprocess.run(['node', '--input-type=module', '-e', script], check=True, capture_output=True, text=True)

    def test_real_validator_accepts_diagnostic_label_and_preserves_semantic_checks(self):
        changed = overlay_sources(self.sources())
        original_test = (ROOT / 'test/perf-benchmark-support.test.js').read_text()
        report_helper = original_test.split('function validReport() {', 1)[1].split("\ndescribe('benchmark timing boundary'", 1)[0]
        report_helper = 'function validReport() {' + report_helper
        with tempfile.NamedTemporaryFile(mode='w', suffix='.js', prefix='memory-overlay-witness-',
                                         dir=ROOT / 'dev/perf', delete=False) as temporary:
            temporary.write(changed[SUPPORT_PATH])
            module = Path(temporary.name)
        try:
            script = f"""
import assert from 'node:assert/strict'
import {{createHash}} from 'node:crypto'
import {{createBenchmarkEnvironment, extractImportResult}} from {json.dumps(module.as_uri())}
import {{loadDictionaryFixtures}} from {json.dumps((ROOT / 'dev/perf/dictionary-fixtures.js').as_uri())}
const fixture = (await loadDictionaryFixtures()).jmdict
const probeTerms = Array.from({{length: 12}}, (_, index) => `term-${{index}}`)
{report_helper}
delete process.env.MANABITAN_IMPORT_MEMORY_MARKERS
assert.equal(extractImportResult(validReport(), 'jmdict', fixture, false, null).totalImportMs, 123.5)
process.env.MANABITAN_IMPORT_MEMORY_MARKERS = '/tmp/markers.jsonl'
assert.equal(createBenchmarkEnvironment(process.env, {{}}).MANABITAN_IMPORT_MEMORY_MARKERS, '/tmp/markers.jsonl')
const report = validReport()
assert.throws(() => extractImportResult(report, 'jmdict', fixture, false, null), /configuration/)
report.benchmark.authoritativeTiming = false
assert.equal(extractImportResult(report, 'jmdict', fixture, false, null).totalImportMs, 123.5)
report.benchmark.validation.contentReadable = false
assert.throws(() => extractImportResult(report, 'jmdict', fixture, false, null), /post-import validation/)
"""
            subprocess.run(['node', '--input-type=module', '-e', script], check=True, capture_output=True, text=True)
        finally:
            module.unlink()


class CompactSummaryWitness(unittest.TestCase):
    def test_partial_failures_missing_proofs_and_explicit_errors_never_qualify(self):
        with tempfile.TemporaryDirectory(prefix='memory-summary-witness-') as directory:
            root = Path(directory)
            output, compact = root / 'full', root / 'compact/summary.json'
            output.mkdir()
            with patch.object(runner, 'OUTPUT', output), patch.object(runner, 'SUMMARY_OUTPUT', compact), redirect_stdout(io.StringIO()):
                summary = runner.export_compact_summary()
                self.assertEqual(summary['status'], 'incomplete')
                self.assertFalse(summary['authoritativeTiming'])
                self.assertFalse(summary['passesProspectiveMemoryScreen'])
                rows = observations()
                runner.save(output / 'observations.json', rows)
                comparison = runner.build_comparison(rows, schedule(1), [])
                runner.save(output / 'memory-comparison.json', comparison)
                runner.save(output / 'memory-audit.json', {'passesProspectiveMemoryScreen': True})
                self.assertFalse(runner.export_compact_summary()['passesProspectiveMemoryScreen'])
                receipt = {'publicResults': [], 'termRows': 3, 'contentReadable': True,
                           'restart': {'contentReadable': True}, 'media': {'files': 0, 'bytes': 0}}
                for row in rows:
                    runner.save(output / row['name'] / 'semantic-receipt.json', receipt)
                summary = runner.export_compact_summary()
                self.assertEqual(summary['status'], 'passed')
                self.assertTrue(summary['passesProspectiveMemoryScreen'])
                self.assertEqual(len(summary['semanticProofs']), 4)
                self.assertEqual(json.loads(compact.read_text()), summary)
                for error in ['', 'audit failed']:
                    self.assertFalse(runner.export_compact_summary(error)['passesProspectiveMemoryScreen'])
                comparison['validationFailures'] = [{'name': 'A1', 'error': 'lookup mismatch'}]
                runner.save(output / 'memory-comparison.json', comparison)
                self.assertFalse(runner.export_compact_summary()['passesProspectiveMemoryScreen'])


if __name__ == '__main__':
    unittest.main()
