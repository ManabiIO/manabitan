# SPDX-License-Identifier: GPL-3.0-or-later
"""Fast pre-acquisition contracts; no browser, fixtures or timed work."""

import importlib.util
from pathlib import Path
import unittest

MODULE_PATH = Path(__file__).with_name("import-qualification-511a8.py")
SPEC = importlib.util.spec_from_file_location("import_qualification_511a8", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def storage(units=37):
    return {"files": [{"path": f"manabitan/sqlite-sahpool-v1/.opaque/file{index}",
                       "bytes": 4096 if index else 4096 * units} for index in range(8)]}


class QualificationContracts(unittest.TestCase):
    def test_profile_has_one_host_per_dictionary(self):
        plan = MODULE.config()
        self.assertEqual(plan["mode"], "profile")
        self.assertEqual(plan["matrix"]["include"], [
            {"dictionary": name, "initialOrder": "AB"} for name in MODULE.DICTIONARIES
        ])

    def test_policy_comes_from_one_baseline_inventory_not_old_constant(self):
        self.assertEqual(MODULE.baseline_sah_units(storage(37)), 37)
        self.assertEqual(MODULE.baseline_sah_units(storage(38)), 38)
        self.assertEqual(MODULE.baseline_sah_units(storage(130)), 130)

    def test_rejects_duplicate_and_incomplete_sah_inventory(self):
        value = storage()
        value["files"][-1] = value["files"][0].copy()
        with self.assertRaises(ValueError):
            MODULE.baseline_sah_units(value)
        value = storage()
        value["files"].pop()
        with self.assertRaises(ValueError):
            MODULE.baseline_sah_units(value)

    def test_rejects_noninteger_unaligned_and_multiple_active_allocations(self):
        for size in (37 * 4096 + 1, True, -1, 37.0 * 4096, 2 ** 53):
            value = storage()
            value["files"][0]["bytes"] = size
            with self.subTest(size=size), self.assertRaises(ValueError):
                MODULE.baseline_sah_units(value)
        value = storage()
        value["files"][1]["bytes"] = 8192
        with self.assertRaises(ValueError):
            MODULE.baseline_sah_units(value)


if __name__ == "__main__":
    unittest.main()
