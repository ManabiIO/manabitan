# SPDX-License-Identifier: GPL-3.0-or-later
"""Fast pre-acquisition contracts; no browser, fixtures or timed work."""

import ast
import importlib.util
from pathlib import Path
import unittest

MODULE_PATH = Path(__file__).with_name("import-preload-qualification-511a8.py")
SPEC = importlib.util.spec_from_file_location("import_preload_qualification_511a8", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

# Execute the actual pure policy function without running the cohort CLI.
COHORT_PATH = Path(__file__).with_name("import-preload-cohort-511a8.py")
COHORT_TREE = ast.parse(COHORT_PATH.read_text())
POLICY_NODE = next(node for node in COHORT_TREE.body
                   if isinstance(node, ast.FunctionDef) and node.name == "validate_package_changes")
POLICY_SCOPE = {}
exec(compile(ast.Module(body=[POLICY_NODE], type_ignores=[]), str(COHORT_PATH), "exec"), POLICY_SCOPE)
VALIDATE_MEMBERS = POLICY_SCOPE["validate_package_changes"]


def storage(units=37):
    return {"files": [{"path": f"manabitan/sqlite-sahpool-v1/.opaque/file{index}",
                       "bytes": 4096 if index else 4096 * units} for index in range(8)]}


class QualificationContracts(unittest.TestCase):
    def test_requires_exact_candidate_and_package_contract(self):
        for candidate in (None, "develop", "a" * 39, MODULE.BASELINE):
            with self.subTest(candidate=candidate), self.assertRaises(ValueError):
                MODULE.config(candidate=candidate, entries=("js/changed.js",))
        for entries, added in (((), ()), (("../bad",), ()), (("js/a", "js/a"), ()),
                               (("js/a",), ("lib/unlisted.wasm",))):
            with self.subTest(entries=entries, added=added), self.assertRaises(ValueError):
                MODULE.config(candidate="a" * 40, entries=entries, added=added)

    def test_comparison_freezes_six_hosts_twelve_pairs_and_production_defaults(self):
        plan = MODULE.config(candidate="a" * 40, entries=("js/changed.js", "lib/added.wasm"),
                             added=("lib/added.wasm",))
        self.assertEqual(plan["mode"], "compare")
        self.assertEqual(plan["pairs"], 12)
        self.assertIsNone(plan["importFlags"])
        self.assertEqual(plan["matrix"]["include"], [
            {"dictionary": name, "initialOrder": order}
            for name in MODULE.DICTIONARIES for order in ("AB", "BA")
        ])

    def test_exact_modified_and_added_package_members_are_admitted(self):
        result = VALIDATE_MEMBERS({"same": "x", "changed": "a"},
                                  {"same": "x", "changed": "b", "added": "c"},
                                  ["changed", "added"], ["added"])
        self.assertEqual(result, {"changedPackageEntries": ["added", "changed"],
                                  "addedPackageEntries": ["added"], "removedPackageEntries": []})

    def test_rejects_unregistered_additions_removals_and_changes(self):
        cases = [
            ({"a": "x"}, {"a": "x"}, ["a"], []),
            ({"a": "x"}, {"a": "y", "b": "z"}, ["a", "b"], []),
            ({"a": "x"}, {"b": "z"}, ["a", "b"], ["b"]),
            ({"a": "x"}, {"a": "y"}, ["unlisted"], []),
            ({"a": "x"}, {"a": "y"}, ["a", "a"], []),
            ({"a": "x"}, {"a": "y", "b": "z"}, ["a", "b"], ["b", "b"]),
        ]
        for case in cases:
            with self.subTest(case=case), self.assertRaises(ValueError):
                VALIDATE_MEMBERS(*case)

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
