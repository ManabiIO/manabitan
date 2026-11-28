import unittest
from sah_allocation_contract import exact_parent_allocation

def contract():
    return {
        'schemaVersion': 2,
        'parent': 'a300da36d00df8e353c5679b1528b50a1299b75f',
        'dictionaries': {'vndb': {'sahAllocationUnits': [77, 77]}, 'jmdict': {}, 'jitendex': {}},
        'parentAllocationObservation': {
            'source': 'a300da36d00df8e353c5679b1528b50a1299b75f',
            'status': 'observed-parent-only', 'importFlags': None, 'timingEligible': False,
            'activeSahUnits': 77, 'activeSahBytes': 315392,
            'allSahSizes': [4096] * 7 + [315392],
        },
    }

class AllocationContracts(unittest.TestCase):
    def test_exact_independent_parent(self):
        value = contract()
        actual = exact_parent_allocation(value, 'vndb')
        self.assertEqual(actual, [77, 77])
        actual[0] = 37
        self.assertEqual(value['dictionaries']['vndb']['sahAllocationUnits'], [77, 77])
        self.assertIsNone(exact_parent_allocation(value, 'jmdict'))
        self.assertIsNone(exact_parent_allocation(value, 'jitendex'))

    def test_old_expectation_and_broadened_ranges_rejected(self):
        for bounds in ([37, 37], [37, 77], [76, 78], [77], [77.0, 77], [True, 77]):
            with self.subTest(bounds=bounds):
                value = contract()
                value['dictionaries']['vndb']['sahAllocationUnits'] = bounds
                with self.assertRaises(ValueError):
                    exact_parent_allocation(value, 'vndb')

    def test_unrelated_or_candidate_observations_rejected(self):
        for change in ({'source': 'other'}, {'status': 'candidate'}, {'importFlags': {'experimentalReferenceTableFields': False}}, {'timingEligible': True}):
            with self.subTest(change=change):
                value = contract()
                value['parentAllocationObservation'].update(change)
                with self.assertRaises(ValueError):
                    exact_parent_allocation(value, 'vndb')

    def test_malformed_allocation_rejected(self):
        for change in ({'activeSahBytes': 315391}, {'activeSahUnits': 77.0}, {'allSahSizes': [4096] * 6 + [315392, 8192]}):
            with self.subTest(change=change):
                value = contract()
                value['parentAllocationObservation'].update(change)
                with self.assertRaises(ValueError):
                    exact_parent_allocation(value, 'vndb')

    def test_missing_or_wrong_schema_rejected(self):
        for missing in ('parentAllocationObservation', 'parent'):
            value = contract()
            del value[missing]
            with self.assertRaises(KeyError):
                exact_parent_allocation(value, 'vndb')
        value = contract()
        value['schemaVersion'] = 1
        with self.assertRaises(ValueError):
            exact_parent_allocation(value, 'vndb')
        value = contract()
        value['dictionaries']['jmdict']['sahAllocationUnits'] = [77, 77]
        with self.assertRaises(ValueError):
            exact_parent_allocation(value, 'jmdict')

if __name__ == '__main__':
    unittest.main()
