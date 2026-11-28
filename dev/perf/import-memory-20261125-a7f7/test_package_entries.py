import unittest

from package_entries import validate_package_entry_delta


class PackageEntryDeltaTests(unittest.TestCase):
    def setUp(self):
        self.baseline = {"changed.js": "old", "unchanged.js": "same"}
        self.candidate = {"changed.js": "new", "unchanged.js": "same"}

    def test_default_requires_same_members_and_exact_existing_changes(self):
        self.assertEqual(
            validate_package_entry_delta(self.baseline, self.candidate, ["changed.js"]),
            {"changedPackageEntries": ["changed.js"], "addedPackageEntries": [], "removedPackageEntries": []},
        )

    def test_explicit_addition_is_recorded(self):
        candidate = {**self.candidate, "limits.js": "new module"}
        self.assertEqual(
            validate_package_entry_delta(self.baseline, candidate, ["changed.js"], ["limits.js"]),
            {"changedPackageEntries": ["changed.js"], "addedPackageEntries": ["limits.js"], "removedPackageEntries": []},
        )

    def test_default_rejects_any_addition(self):
        with self.assertRaisesRegex(RuntimeError, "Unexpected added"):
            validate_package_entry_delta(self.baseline, {**self.candidate, "limits.js": "new"}, ["changed.js"])

    def test_declared_additions_must_match_exactly(self):
        for candidate in (self.candidate, {**self.candidate, "limits.js": "new", "extra.js": "extra"}):
            with self.subTest(candidate=candidate), self.assertRaisesRegex(RuntimeError, "Unexpected added"):
                validate_package_entry_delta(self.baseline, candidate, ["changed.js"], ["limits.js"])

    def test_addition_does_not_permit_removal(self):
        candidate = {"changed.js": "new", "limits.js": "new"}
        with self.assertRaisesRegex(RuntimeError, "removes packaged files"):
            validate_package_entry_delta(self.baseline, candidate, ["changed.js"], ["limits.js"])

    def test_addition_does_not_relax_existing_change_checks(self):
        candidate = {**self.candidate, "unchanged.js": "unexpected", "limits.js": "new"}
        with self.assertRaisesRegex(RuntimeError, "Unexpected packaged changes"):
            validate_package_entry_delta(self.baseline, candidate, ["changed.js"], ["limits.js"])

    def test_expected_existing_change_must_occur(self):
        with self.assertRaisesRegex(RuntimeError, "Unexpected packaged changes"):
            validate_package_entry_delta(self.baseline, self.candidate, ["changed.js", "unchanged.js"])

    def test_no_existing_runtime_change_still_rejects(self):
        with self.assertRaisesRegex(RuntimeError, "no changed runtime"):
            validate_package_entry_delta(self.baseline, self.baseline.copy(), ["changed.js"])


if __name__ == "__main__":
    unittest.main()
