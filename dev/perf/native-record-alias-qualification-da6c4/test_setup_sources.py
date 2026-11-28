# SPDX-License-Identifier: GPL-3.0-or-later
"""Reproduce the exact directory-only ignore defect before any hosted acquisition."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from run import copy_dependency_tree


class DependencySetup(unittest.TestCase):
    def test_stock_hardlink_tree_is_real_ignored_directory_unlike_symlink(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repository, installed = root / 'checkout', root / 'installed'
            repository.mkdir()
            installed.mkdir()
            (installed / 'package').mkdir()
            source = installed / 'package/index.js'
            source.write_bytes(b'export const immutableFixture = 1;\n')
            (installed / 'entry').symlink_to('package/index.js')
            subprocess.run(['git', 'init', '--quiet', str(repository)], check=True)
            (repository / '.gitignore').write_text('node_modules/\n')
            subprocess.run(['git', 'add', '.gitignore'], cwd=repository, check=True)
            destination = repository / 'node_modules'
            destination.symlink_to(installed, target_is_directory=True)
            before = subprocess.check_output(
                ['git', 'status', '--porcelain=v1', '--untracked-files=all', '--', 'node_modules'],
                cwd=repository, text=True)
            self.assertEqual(before, '?? node_modules\n')
            self.assertEqual(subprocess.run(['git', 'check-ignore', '--quiet', 'node_modules'],
                             cwd=repository).returncode, 1)
            destination.unlink()
            copy_dependency_tree(installed, destination)
            self.assertTrue(destination.is_dir())
            self.assertFalse(destination.is_symlink())
            copied = destination / 'package/index.js'
            self.assertEqual(copied.read_bytes(), source.read_bytes())
            self.assertEqual((copied.stat().st_dev, copied.stat().st_ino), (source.stat().st_dev, source.stat().st_ino))
            self.assertTrue((destination / 'entry').is_symlink())
            self.assertEqual(os.readlink(destination / 'entry'), 'package/index.js')
            self.assertEqual(subprocess.run(['git', 'check-ignore', '--quiet', 'node_modules'],
                             cwd=repository).returncode, 0)
            after = subprocess.check_output(
                ['git', 'status', '--porcelain=v1', '--untracked-files=all', '--', 'node_modules'],
                cwd=repository, text=True)
            self.assertEqual(after, '')
            print({'beforeSymlinkPorcelain': before, 'afterRealDirectoryPorcelain': after,
                   'sameFileInode': True, 'innerSymlinkPreserved': True}, flush=True)


if __name__ == '__main__':
    unittest.main()
