# SPDX-License-Identifier: GPL-3.0-or-later
"""Exact one-test source amendment checks; no browser/runtime acquisition."""
from copy import deepcopy
import unittest
from unittest.mock import patch

import run


class CandidateIdentityTests(unittest.TestCase):
    def setUp(self):
        self.expected = run.CANDIDATE_TEST_AMENDMENT
        original, candidate = run.NATURAL_CANDIDATE, run.CANDIDATE
        self.responses = {
            ('rev-list', '--parents', '-n', '1', candidate): candidate + ' ' + original,
            ('diff-tree', '--no-commit-id', '--name-status', '-r', original, candidate):
                'M\t' + self.expected['changedPath'],
        }
        for commit, tree, blob in (
            (original, self.expected['naturalCandidateTree'], self.expected['beforeBlob']),
            (candidate, self.expected['candidateTree'], self.expected['afterBlob']),
        ):
            self.responses[('rev-parse', commit + '^{tree}')] = tree
            self.responses[('rev-parse', commit + ':ext')] = self.expected['runtimeExtTree']
            self.responses[('rev-parse', commit + ':' + self.expected['changedPath'])] = blob

    def call(self, responses=None):
        responses = self.responses if responses is None else responses
        with patch.object(run, 'git', side_effect=lambda root, *args: responses[args]):
            return run.verify_candidate_test_amendment('/synthetic-unused')

    def test_exact_amendment_is_accepted(self):
        self.assertEqual(self.call(), self.expected)

    def test_each_git_binding_is_required(self):
        for key in self.responses:
            changed = deepcopy(self.responses)
            changed[key] += '-changed'
            with self.subTest(query=key), self.assertRaises(RuntimeError):
                self.call(changed)

    def test_extra_parent_or_changed_product_path_is_rejected(self):
        for key, suffix in (
            (('rev-list', '--parents', '-n', '1', run.CANDIDATE), ' ' + '0' * 40),
            (('diff-tree', '--no-commit-id', '--name-status', '-r', run.NATURAL_CANDIDATE, run.CANDIDATE),
             '\nM\text/js/dictionary/dictionary-database.js'),
        ):
            changed = deepcopy(self.responses)
            changed[key] += suffix
            with self.subTest(query=key), self.assertRaises(RuntimeError):
                self.call(changed)

    def test_unregistered_natural_or_candidate_identity_is_rejected(self):
        for key in ('naturalCandidate', 'candidate', 'candidateTree'):
            changed = deepcopy(self.expected)
            changed[key] = '0' * 40
            with self.subTest(key=key), patch.object(run, 'CANDIDATE_TEST_AMENDMENT', changed), self.assertRaises(RuntimeError):
                self.call()


if __name__ == '__main__':
    unittest.main()
