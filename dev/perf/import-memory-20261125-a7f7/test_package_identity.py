# SPDX-License-Identifier: GPL-3.0-or-later
import unittest

from package_identity import package_changes, require_expected_package_changes


class PackageIdentityTests(unittest.TestCase):
    def test_existing_member_changes_remain_exact(self):
        changes = package_changes({'a.js': 'a', 'b.js': 'b'}, {'a.js': 'c', 'b.js': 'b'})
        self.assertEqual(changes, {
            'changedPackageEntries': ['a.js'],
            'addedPackageEntries': [],
            'removedPackageEntries': [],
        })
        require_expected_package_changes(changes, expected_changed=['a.js'])
        with self.assertRaisesRegex(ValueError, 'Unexpected changedPackageEntries'):
            require_expected_package_changes(changes, expected_changed=['b.js'])

    def test_new_member_requires_exact_prospective_declaration(self):
        changes = package_changes({'a.js': 'a'}, {'a.js': 'b', 'new.js': 'c'})
        with self.assertRaisesRegex(ValueError, 'Unexpected addedPackageEntries'):
            require_expected_package_changes(changes, expected_changed=['a.js'])
        require_expected_package_changes(
            changes, expected_changed=['a.js'], expected_added=['new.js']
        )

    def test_additions_do_not_mask_extra_changed_members(self):
        changes = package_changes(
            {'a.js': 'a', 'b.js': 'b'}, {'a.js': 'c', 'b.js': 'd', 'new.js': 'e'}
        )
        with self.assertRaisesRegex(ValueError, 'Unexpected changedPackageEntries'):
            require_expected_package_changes(
                changes, expected_changed=['a.js'], expected_added=['new.js']
            )

    def test_missing_or_additional_new_member_is_rejected(self):
        changes = package_changes({'a.js': 'a'}, {'a.js': 'b', 'new.js': 'c'})
        for declared in ([], ['absent.js'], ['new.js', 'absent.js']):
            with self.subTest(declared=declared):
                with self.assertRaisesRegex(ValueError, 'Unexpected addedPackageEntries'):
                    require_expected_package_changes(
                        changes, expected_changed=['a.js'], expected_added=declared
                    )

    def test_removed_member_is_always_rejected(self):
        changes = package_changes({'a.js': 'a', 'b.js': 'b'}, {'a.js': 'c', 'new.js': 'd'})
        with self.assertRaisesRegex(ValueError, 'removes packaged files'):
            require_expected_package_changes(
                changes, expected_changed=['a.js'], expected_added=['new.js']
            )

    def test_no_changed_runtime_bytes_is_rejected(self):
        changes = package_changes({'a.js': 'a'}, {'a.js': 'a'})
        with self.assertRaisesRegex(ValueError, 'no changed runtime package bytes'):
            require_expected_package_changes(changes, expected_changed=[])

    def test_added_member_alone_is_an_explicit_runtime_change(self):
        changes = package_changes({'a.js': 'a'}, {'a.js': 'a', 'new.js': 'b'})
        require_expected_package_changes(changes, expected_changed=[], expected_added=['new.js'])

    def test_duplicate_or_conflicting_declarations_are_rejected(self):
        changes = package_changes({'a.js': 'a'}, {'a.js': 'b', 'new.js': 'c'})
        cases = [
            (['a.js', 'a.js'], ['new.js']),
            (['a.js'], ['new.js', 'new.js']),
            (['a.js'], ['a.js']),
        ]
        for changed, added in cases:
            with self.subTest(changed=changed, added=added):
                with self.assertRaises(ValueError):
                    require_expected_package_changes(
                        changes, expected_changed=changed, expected_added=added
                    )

    def test_invalid_declaration_and_receipt_fields_are_rejected(self):
        changes = package_changes({'a.js': 'a'}, {'a.js': 'b'})
        for name in ('', 'folder/', 1, None):
            with self.subTest(name=name):
                with self.assertRaisesRegex(ValueError, 'Invalid expected'):
                    require_expected_package_changes(changes, expected_changed=[name])
        with self.assertRaisesRegex(ValueError, 'receipt fields'):
            require_expected_package_changes(
                {**changes, 'unexpected': []}, expected_changed=['a.js']
            )

    def test_receipt_order_is_stable(self):
        self.assertEqual(
            package_changes(
                {'c.js': '0', 'a.js': '0', 'b.js': '0'},
                {'z.js': '0', 'a.js': '1', 'y.js': '0', 'c.js': '1'},
            ),
            {
                'changedPackageEntries': ['a.js', 'c.js'],
                'addedPackageEntries': ['y.js', 'z.js'],
                'removedPackageEntries': ['b.js'],
            },
        )


if __name__ == '__main__':
    unittest.main()
