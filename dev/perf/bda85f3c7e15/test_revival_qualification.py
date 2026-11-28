"""Small wrapper checks only; no browser, source gate or acquisition is run."""
import ast
from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('revival_qualification', HERE / 'revival_qualification.py')
wrapper = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(wrapper)
REGISTERED = json.loads((HERE / 'envelope-revival-plan.json').read_text())
PENDING = deepcopy(REGISTERED)
PENDING['status'] = 'PENDING_SOURCE_AND_COUNTER_CONTRACT'
PENDING['participation']['status'] = 'CONFIRMED_WIP_CONTRACT_PENDING_FINAL_SOURCE'
PENDING['candidate'] = dict.fromkeys(REGISTERED['candidate'], 'PENDING')


def ready_plan():
    return deepcopy(REGISTERED)


def summary(count=None, byte_count=None):
    details = {}
    if count is not None:
        details[PENDING['participation']['countField']] = count
    if byte_count is not None:
        details[PENDING['participation']['bytesField']] = byte_count
    return {'runs': [{'importDebug': {'importerPhaseTimings': [{'phase': 'bulk-finalization', 'details': details}]}}]}


class WrapperTests(unittest.TestCase):
    def test_pending_registration_cannot_acquire(self):
        with self.assertRaisesRegex(ValueError, 'PENDING'):
            wrapper.validate_plan(PENDING)
        wrapper.validate_plan(PENDING, require_ready=False)

    def test_registered_matrix_commands_and_counts(self):
        plan = ready_plan()
        wrapper.validate_plan(plan)
        self.assertEqual(sum(x['totalImports'] for x in plan['matrix']), 188)
        for cell in plan['matrix']:
            rows = wrapper.expected_observations(cell)
            self.assertEqual(len(rows), 42 if cell['dictionary'] == 'vndb' else 26)
            self.assertEqual(sum(x['kind'] == 'warmup' for x in rows), 4)
            self.assertEqual(sum(x['kind'] == 'memory' for x in rows), 4)
            command = wrapper.driver_command(plan, cell, Path('/review-root'), Path('/evidence'))
            self.assertEqual(command[command.index('--pairs') + 1], '12' if cell['dictionary'] == 'vndb' else '6')
            self.assertNotIn('--baseline-flags', command)
            self.assertNotIn('--candidate-flags', command)
            self.assertEqual('--vndb-sah-allocation-units' in command, cell['dictionary'] == 'vndb')

    def test_inventory_matches_exact_unchanged_driver_schedule(self):
        driver = HERE / 'reuse/import-qualification-bda85f3c7e15.py'
        if not driver.exists():
            driver = HERE.parents[2] / 'dev/perf/import-qualification-bda85f3c7e15.py'
        tree = ast.parse(driver.read_text())
        statements = []
        active = False
        for node in tree.body:
            if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'schedule' for t in node.targets):
                active = True
            if active and isinstance(node, ast.Expr) and isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Name) and node.value.func.id == 'write_json':
                break
            if active:
                statements.append(node)
        self.assertTrue(statements)
        code = compile(ast.Module(body=statements, type_ignores=[]), '<unchanged-driver-schedule>', 'exec')
        for cell in PENDING['matrix']:
            scope = {'args': SimpleNamespace(initial_order=cell['initialOrder'], pairs=cell['candidatePairs'])}
            exec(code, scope)
            inventory = [x for x in wrapper.expected_observations(cell) if x['kind'] in ['warmup', 'candidate', 'control']]
            self.assertEqual(scope['schedule'], inventory)

    def test_changed_matrix_memory_or_partial_source_fails(self):
        for mutate in [lambda p: p['matrix'][0].update(candidatePairs=6),
                       lambda p: p['memory'].update(maximumCoveredGapMs=300),
                       lambda p: p['candidate'].update(expectedPackageEntries='PENDING'),
                       lambda p: p['candidate'].update(sha='PENDING')]:
            plan = ready_plan()
            mutate(plan)
            with self.assertRaises(ValueError):
                wrapper.validate_plan(plan)

    def test_positive_and_legacy_counter_receipts(self):
        contract = PENDING['participation']
        self.assertEqual(wrapper.counter_receipt(summary(3, 900), 'vndb', 'B', contract)['count'], 3)
        for dictionary, arm in [('vndb', 'A'), ('vndb', 'C'), ('jmdict', 'B'), ('jitendex', 'B')]:
            self.assertEqual(wrapper.counter_receipt(summary(), dictionary, arm, contract)['count'], 0)
            with self.assertRaises(ValueError):
                wrapper.counter_receipt(summary(1, 100), dictionary, arm, contract)

    def test_invalid_zero_or_inconsistent_active_counters_fail(self):
        for count, byte_count in [(None, None), (0, 0), (-1, 40), (True, 40), (1.5, 40), (1, 0), (0, 40), (1, 2**53)]:
            with self.assertRaises(ValueError):
                wrapper.counter_receipt(summary(count, byte_count), 'vndb', 'B', PENDING['participation'])
        for phases in [[], [summary()['runs'][0]['importDebug']['importerPhaseTimings'][0]] * 2]:
            invalid = {'runs': [{'importDebug': {'importerPhaseTimings': phases}}]}
            with self.assertRaises(ValueError):
                wrapper.counter_receipt(invalid, 'vndb', 'A', PENDING['participation'])

    def test_missing_observations_are_incomplete_not_replaced(self):
        with tempfile.TemporaryDirectory() as directory:
            plan = ready_plan()
            result = wrapper.audit_participation(plan, plan['matrix'][0], Path(directory))
            self.assertEqual(result['status'], 'failed')
            self.assertEqual(result['expectedObservations'], 42)
            self.assertEqual(len(result['observations']), 42)
            self.assertEqual(result['passedObservations'], 0)

    def test_driver_pass_does_not_override_participation_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            plan = ready_plan()
            plan_path = root / 'plan.json'
            plan_path.write_text(json.dumps(plan))
            original_analysis = '{"memoryPassed":true,"preserve":"exact original bytes"}\n'
            def fake_driver(command, cwd, log):
                output = Path(command[command.index('--evidence') + 1])
                output.mkdir()
                (output / 'analysis.json').write_text(original_analysis)
                log.write_text('synthetic wrapper-only fixture; no acquisition\n')
                return 0
            with patch.object(wrapper, 'capture', fake_driver), patch.object(wrapper, 'audit_participation', return_value={'status': 'failed'}):
                result = wrapper.run_cell(plan, plan['matrix'][0], root, root / 'cell', plan_path)
            self.assertEqual(result, 1)
            verdict = json.loads((root / 'cell/cohort-verdict.json').read_text())
            self.assertEqual(verdict['status'], 'not-qualified')
            self.assertTrue(verdict['authoritativeCohortVerdict'])
            self.assertEqual((root / 'cell/acquisition/analysis.json').read_text(), original_analysis)


if __name__ == '__main__':
    unittest.main()
