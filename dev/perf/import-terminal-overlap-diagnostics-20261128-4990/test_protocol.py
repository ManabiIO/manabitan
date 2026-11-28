"""Check the evidence classifier's boundaries without launching imports."""
from copy import deepcopy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('terminal_overlap_run', Path(__file__).with_name('run.py'))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
FIXTURE = {'expectedTitle': 'Example', 'termRows': 10}


def observed(signed_wait=5):
    call = {'ordinal': 2, 'dictionary': 'Example', 'rowCount': 4,
            'artifactRowStart': 6, 'artifactRowEnd': 10, 'activeBulkImport': True,
            'source': {'sourceFileIndex': 2, 'sourceFileBatchCount': 1,
                       'sourceFileCount': 3, 'chunkIndex': 2, 'chunkCount': 2}}
    record_end = 20
    content_end = record_end + signed_wait
    diagnostic = {
        'artifactCallCount': 2, 'artifactRowCount': 10, 'lastArtifactCall': call,
        'lastEligible': {'call': call, 'metadataPublishedAtMs': 10,
            'recordAppendCompletedAtMs': record_end, 'contentCompletedAtMs': content_end,
            'joinFinishedAtMs': max(record_end, content_end) + 1,
            'nextRecordIdAtAppendStart': 7, 'nextRecordIdAfterAppend': 11,
            'recordStatus': 'fulfilled', 'contentStatus': 'fulfilled'},
        'finalNextRecordId': 11, 'lastEligibleWasFinalArtifactCall': True,
        'lastEligibleWasTerminalSourceChunk': True, 'lastEligibleMatchesFinalRecordId': True,
        'lastEligibleWasFinalAppend': True, 'contentCompletionMinusRecordAppendMs': signed_wait,
        'availableContentWaitMs': max(0, signed_wait),
    }
    return {'runs': [{'totalImportMs': 100, 'importDebug': {'importerPhaseTimings': [
        {'phase': 'bulk-finalization', 'elapsedMs': 10,
         'details': {'termRecordTerminalOverlapDiagnostics': diagnostic}}
    ]}}]}


def diagnostic(summary):
    return summary['runs'][0]['importDebug']['importerPhaseTimings'][0]['details']['termRecordTerminalOverlapDiagnostics']


class ProtocolTest(unittest.TestCase):
    def test_schedule_has_no_discarded_observations_and_reverses_independently(self):
        first, second = runner.plan(1), runner.plan(2)
        self.assertEqual(''.join(row['arm'] for row in first), 'ADADAD')
        self.assertEqual(''.join(row['arm'] for row in second), 'DADADA')
        self.assertTrue(all(not row['authoritativeComparativeTiming'] for row in first + second))
        with self.assertRaises(ValueError):
            runner.plan(3)

    def test_signed_and_zero_opportunity_are_retained(self):
        for wait in (-4, 0, 5):
            summary = observed(wait)
            result = runner.extract_details(summary, 'D', FIXTURE)
            self.assertEqual(result['details']['termRecordTerminalOverlapDiagnostics']['availableContentWaitMs'], max(0, wait))

    def test_absent_and_nonterminal_observations_are_valid_negative_findings(self):
        summary = observed()
        row = diagnostic(summary)
        row['lastEligible']['call']['source']['sourceFileCount'] = 4
        row['lastEligibleWasTerminalSourceChunk'] = False
        row['lastEligibleWasFinalAppend'] = False
        runner.extract_details(summary, 'D', FIXTURE)
        row['lastEligible'] = None
        row['lastEligibleWasFinalArtifactCall'] = False
        row['lastEligibleMatchesFinalRecordId'] = False
        row['contentCompletionMinusRecordAppendMs'] = None
        row['availableContentWaitMs'] = None
        runner.extract_details(summary, 'D', FIXTURE)

    def test_baseline_cannot_contain_instrumentation(self):
        summary = observed()
        with self.assertRaises(ValueError):
            runner.extract_details(summary, 'A', FIXTURE)
        del summary['runs'][0]['importDebug']['importerPhaseTimings'][0]['details']['termRecordTerminalOverlapDiagnostics']
        runner.extract_details(summary, 'A', FIXTURE)
        with self.assertRaises(ValueError):
            runner.extract_details(summary, 'D', FIXTURE)

    def test_corrupt_completion_and_identity_claims_are_rejected(self):
        mutations = [
            lambda row: row.update(lastEligibleWasFinalAppend=False),
            lambda row: row.update(availableContentWaitMs=6),
            lambda row: row.update(contentCompletionMinusRecordAppendMs=6),
            lambda row: row.update(finalNextRecordId=12),
            lambda row: row.update(artifactRowCount=11),
            lambda row: row['lastEligible'].update(joinFinishedAtMs=24),
            lambda row: row['lastEligible'].update(recordStatus='pending'),
            lambda row: row['lastEligible'].update(contentStatus='rejected'),
            lambda row: row['lastEligible'].update(nextRecordIdAtAppendStart=6),
            lambda row: row['lastEligible'].update(contentCompletedAtMs=float('nan')),
        ]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                summary = deepcopy(observed())
                mutate(diagnostic(summary))
                with self.assertRaises(ValueError):
                    runner.extract_details(summary, 'D', FIXTURE)


if __name__ == '__main__':
    unittest.main()
