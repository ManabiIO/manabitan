"""Verify the prospective package-addition exception without running imports."""

import importlib.util
import pathlib
import stat
import tempfile
import unittest
import warnings
import zipfile


ROOT = pathlib.Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "package_identity",
    ROOT / "dev/perf/import-memory-20261125-a7f7/package_identity.py",
)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class PackageIdentityTests(unittest.TestCase):
    def test_existing_changes_keep_the_strict_default(self):
        self.assertEqual(MODULE.changed_package_entries({"a": "old"}, {"a": "new"}), ["a"])

    def test_only_the_exact_declared_addition_is_accepted(self):
        self.assertEqual(
            MODULE.changed_package_entries({"a": "old"}, {"a": "new", "owned.js": "bytes"}, ["owned.js"]),
            ["a", "owned.js"],
        )

    def test_undeclared_addition_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "added"):
            MODULE.changed_package_entries({"a": "same"}, {"a": "same", "surprise": "bytes"})

    def test_extra_addition_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "added"):
            MODULE.changed_package_entries(
                {"a": "same"}, {"a": "same", "owned.js": "bytes", "surprise": "bytes"}, ["owned.js"],
            )

    def test_absent_declared_addition_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "added"):
            MODULE.changed_package_entries({"a": "same"}, {"a": "same"}, ["owned.js"])

    def test_removal_is_rejected_even_when_additions_match(self):
        with self.assertRaisesRegex(RuntimeError, "Removed"):
            MODULE.changed_package_entries({"a": "same"}, {"owned.js": "bytes"}, ["owned.js"])

    def read_archive(self, members):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "package.zip"
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", UserWarning)
                with zipfile.ZipFile(path, "w") as archive:
                    for name, kind, contents in members:
                        item = zipfile.ZipInfo(name)
                        item.create_system = 3
                        item.external_attr = (kind | 0o644) << 16
                        archive.writestr(item, contents)
            return MODULE.package_entries(path)

    def test_regular_and_unspecified_file_types_are_accepted(self):
        entries = self.read_archive([
            ("directory/", stat.S_IFDIR, b""),
            ("regular.js", stat.S_IFREG, b"same"),
            ("legacy.js", 0, b"same"),
        ])
        self.assertEqual(set(entries), {"regular.js", "legacy.js"})
        self.assertEqual(entries["regular.js"], entries["legacy.js"])

    def test_duplicate_member_name_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "Duplicate"):
            self.read_archive([("same.js", 0, b"a"), ("same.js", 0, b"b")])

    def test_special_file_types_are_rejected(self):
        for kind in (stat.S_IFLNK, stat.S_IFIFO, stat.S_IFCHR, stat.S_IFBLK, stat.S_IFSOCK):
            with self.subTest(kind=kind), self.assertRaisesRegex(RuntimeError, "file type"):
                self.read_archive([("owned.js", kind, b"target")])

    def test_directory_type_without_directory_name_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "file type"):
            self.read_archive([("owned.js", stat.S_IFDIR, b"")])

    def test_file_type_with_directory_name_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "directory type"):
            self.read_archive([("directory/", stat.S_IFREG, b"")])


if __name__ == "__main__":
    unittest.main()
