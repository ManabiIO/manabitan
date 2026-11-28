# SPDX-License-Identifier: GPL-3.0-or-later
"""Exercise the actual driver guards without starting a browser or an import."""

import ast
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest

from compression_proof_receipts import (
    BASELINE_SHA, comparison_receipt, require_matching_trial_receipts,
)
from qualification_receipts import validate_import_summary
from test_compression_proof_receipts import fixture, rewrite_physical
from test_qualification_receipts import BROWSER, FIXTURES, HARNESS, PACKAGE, SOURCE, change_validation


ROOT = Path(__file__).resolve().parents[3]
DRIVER = ROOT / 'dev/perf/import-compression-proof-20261128-1b47.py'
TREE = ast.parse(DRIVER.read_text())
PROOF_SOURCE = 'registered proof-only harness fixture\n'
MEMORY_SOURCE = 'registered proof and memory harness fixture\n'


def driver_function(name, namespace):
    nodes = [node for node in ast.walk(TREE) if isinstance(node, ast.FunctionDef) and node.name == name]
    if len(nodes) != 1:
        raise AssertionError('Expected one driver function: ' + name)
    module = ast.Module(body=nodes, type_ignores=[])
    exec(compile(ast.fix_missing_locations(module), str(DRIVER), 'exec'), namespace)
    return namespace[name]


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')


class DriverBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)

    def loader(self, dictionary='jmdict'):
        _, _, summary, _ = fixture(dictionary)
        identity = {'sha': SOURCE, 'packageSha256': PACKAGE,
                    'sourceHashes': deepcopy(summary['source']['sha256'])}
        namespace = {
            'json': json, 'pathlib': __import__('pathlib'), 'hashlib': hashlib,
            'args': SimpleNamespace(dictionary=dictionary, expected_workers=3),
            'fixture': FIXTURES[dictionary], 'identities': {'A': identity, 'B': deepcopy(identity)},
            'browser_version': BROWSER, 'flags': {}, 'vndb_sah_allocation_units': None,
            'proof_harness': PROOF_SOURCE, 'physical_references': {}, 'write_json': write_json,
            'validate_import_summary': validate_import_summary,
            'comparison_receipt': comparison_receipt,
            'require_matching_trial_receipts': require_matching_trial_receipts,
        }
        return driver_function('validate_observation', namespace), namespace

    def output(self, name, arm='A', *, dictionary='jmdict', media='sample', overlay=PROOF_SOURCE,
               mutate=None, wrong_report_path=False):
        value = fixture(dictionary, arm)
        receipt, proof, summary, report = value
        if mutate:
            mutate(value)
        summary['runs'][0]['validation']['outputDigestSha256'] = receipt['common']['validation']['outputDigestSha256']
        summary['source']['dirty'] = True
        summary['source']['sha256'][HARNESS] = hashlib.sha256(overlay.encode()).hexdigest()
        summary['mediaCheck'] = report['benchmark']['mediaCheck'] = media
        if media == 'all':
            item = summary['runs'][0]['validation']['media']
            item.update(mode='all', files=item['totalFiles'], bytes=item['totalBytes'])
        change_validation(summary, report, lambda value: None)
        report['benchmark']['compressionProof'] = deepcopy(proof)
        output = self.directory / name
        output.mkdir()
        summary['runs'][0]['reportJsonPath'] = str(output / ('different.json' if wrong_report_path else 'run-1.json'))
        write_json(output / 'summary.json', summary)
        write_json(output / 'run-1.json', report)
        return output

    def test_actual_validator_saves_raw_proof_and_distinct_comparison_without_mutation(self):
        validate, _ = self.loader()
        output = self.output('valid')
        original = {name: (output / name).read_bytes() for name in ('summary.json', 'run-1.json')}
        _, receipt, proof = validate(output, 'A')
        self.assertEqual(json.loads((output / 'canonical-receipt.json').read_text()), receipt)
        self.assertEqual(json.loads((output / 'compression-proof.json').read_text()), proof)
        copied = json.loads((output / 'comparison-receipt.json').read_text())
        self.assertIn('compressionLogicalProjection', copied['common']['validation'])
        self.assertNotIn('outputDigestSha256', copied['common']['validation'])
        self.assertIn('outputDigestSha256', receipt['common']['validation'])
        for name, raw in original.items():
            self.assertEqual((output / name).read_bytes(), raw)

    def test_candidate_raw_anchor_rejects_later_physical_drift_in_every_stage(self):
        def drift(value):
            rewrite_physical(value, lambda rows: rows[0]['probes'][0]['rowSample'][0].__setitem__('rawContentPreview', 'different physical bytes'))

        for stage, media, overlay in (('timed', 'sample', PROOF_SOURCE), ('full-media', 'all', PROOF_SOURCE),
                                     ('memory', 'sample', MEMORY_SOURCE)):
            with self.subTest(stage=stage):
                validate, _ = self.loader()
                _, a, ap = validate(self.output(stage + '-A'), 'A')
                _, b, bp = validate(self.output(stage + '-B', 'B'), 'B')
                require_matching_trial_receipts(a, b, dictionary='jmdict', reference_arm='A', candidate_arm='B',
                                               reference_proof=ap, candidate_proof=bp)
                output = self.output(stage + '-changed-B', 'B', media=media, overlay=overlay, mutate=drift)
                with self.assertRaisesRegex(ValueError, 'differs'):
                    validate(output, 'B', media, overlay=overlay)
                # Failure keeps the original report and the self-consistent rejected raw proof.
                for name in ('summary.json', 'run-1.json', 'canonical-receipt.json',
                             'compression-proof.json', 'comparison-receipt.json', 'compression-proof-policy.json'):
                    self.assertTrue((output / name).is_file(), name)

    def test_identical_control_is_bound_to_baseline_raw_proof(self):
        validate, _ = self.loader()
        validate(self.output('A'), 'A')
        drift = lambda value: rewrite_physical(value, lambda rows: rows[0]['probes'][0]['rowSample'][0].__setitem__('rawContentPreview', 'changed control bytes'))
        with self.assertRaisesRegex(ValueError, 'differs'):
            validate(self.output('C', mutate=drift), 'A', receipt_arm='C')

    def test_explicit_sample_all_transition_is_the_only_media_exception(self):
        validate, _ = self.loader('jitendex')
        validate(self.output('sample', dictionary='jitendex'), 'A')
        validate(self.output('full', dictionary='jitendex', media='all'), 'A', 'all')
        def drift(value):
            value[2]['runs'][0]['validation']['media']['sha256'] = 'f' * 64
        with self.assertRaisesRegex(ValueError, 'media'):
            validate(self.output('changed-sample', dictionary='jitendex', mutate=drift), 'A')

    def test_wrong_report_path_and_missing_additive_proof_fail_closed(self):
        validate, _ = self.loader()
        with self.assertRaisesRegex(RuntimeError, 'raw-report path'):
            validate(self.output('wrong', wrong_report_path=True), 'A')
        output = self.output('missing')
        report = json.loads((output / 'run-1.json').read_text())
        del report['benchmark']['compressionProof']
        write_json(output / 'run-1.json', report)
        with self.assertRaises(ValueError):
            validate(output, 'A')
        self.assertTrue((output / 'canonical-receipt.json').is_file())

    def test_reported_worker_policy_must_match_the_fixed_production_assertion(self):
        validate, _ = self.loader()
        output = self.output('wrong-workers')
        summary = json.loads((output / 'summary.json').read_text())
        report = json.loads((output / 'run-1.json').read_text())
        summary['runs'][0]['step4Breakdown']['dictionaries'][0]['parserWorkerCount'] = 2
        report['phases'][1]['data']['step4Breakdown']['dictionaries'][0]['parserWorkerCount'] = 2
        write_json(output / 'summary.json', summary)
        write_json(output / 'run-1.json', report)
        with self.assertRaisesRegex(RuntimeError, 'expected 3, observed 2'):
            validate(output, 'A')

    def test_exact_overlay_and_only_one_unstaged_dirty_path_are_required(self):
        target = self.directory / 'source'
        path = target / HARNESS
        path.parent.mkdir(parents=True)
        path.write_text(PROOF_SOURCE)
        responses = {('status', '--porcelain'): 'M ' + HARNESS,
                     ('diff', '--name-only'): HARNESS,
                     ('diff', '--cached', '--name-only'): ''}
        guard = driver_function('require_registered_overlay', {
            'harness_path': HARNESS, 'git': lambda *args, **kwargs: responses[args],
        })
        guard(target, PROOF_SOURCE)
        for key, changed in ((('status', '--porcelain'), 'M ' + HARNESS + '\n?? extra'),
                             (('diff', '--name-only'), HARNESS + '\next/js/unregistered.js'),
                             (('diff', '--cached', '--name-only'), HARNESS)):
            before = responses[key]
            responses[key] = changed
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                guard(target, PROOF_SOURCE)
            responses[key] = before
        path.write_text(PROOF_SOURCE + 'unregistered change')
        with self.assertRaisesRegex(RuntimeError, 'exact registered overlay'):
            guard(target, PROOF_SOURCE)

    def test_invalid_cli_plans_stop_before_output_or_source_setup(self):
        cases = (['--dictionary', 'vndb'], ['--pairs', '5'], ['--initial-order', 'BA'],
                 ['--baseline', '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2'], ['--flags', '{"test":true}'],
                 ['--expected-workers', '2'], ['--expected-workers', '4'], [])
        for number, changed in enumerate(cases):
            output = self.directory / f'rejected-{number}'
            command = [sys.executable, str(DRIVER), '--baseline', BASELINE_SHA, '--candidate', SOURCE,
                       '--dictionary', 'jmdict', '--initial-order', 'AB', '--pairs', '6',
                       '--expected-package-entry', 'js/dictionary/zstd-term-content.js', '--evidence', str(output)]
            if changed:
                command.extend(['--expected-workers', '3'])
            command.extend(changed)
            result = subprocess.run(command, text=True, capture_output=True, timeout=10)
            with self.subTest(arguments=changed):
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertFalse(output.exists())
                self.assertFalse((output.parent / (output.name + '-sources')).exists())


if __name__ == '__main__':
    unittest.main()
