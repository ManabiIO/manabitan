#!/usr/bin/env python3
"""Regression coverage using complete package entry maps retained from v1."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest

STUDY=Path(__file__).resolve().parent
SPEC=importlib.util.spec_from_file_location('native_study_v2_package_driver',STUDY/'run.py')
DRIVER=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DRIVER)
EXPECTED=['js/dictionary/wasm/term-content-canonical-scan-v1.c','lib/term-content-canonical-scan-v1.wasm']


class PackageMapTests(unittest.TestCase):
    def setUp(self):
        self.manifest=json.loads((STUDY.parent/'jmdict-native-config-study/manifest.json').read_text())
        self.manifest['sources']['native-config']['packagePaths']=EXPECTED.copy()
        fixture=json.loads((STUDY/'package-map-fixture.json').read_text())
        self.entries={arm:copy.deepcopy(fixture['packages']['A' if arm in 'AC' else 'B']) for arm in 'ABCD'}

    def test_actual_complete_entry_sets_accept_only_the_two_known_changes(self):
        result=DRIVER.preflight_package_map(self.manifest)
        self.assertEqual(result['entryCounts'],dict.fromkeys('ABCD',538))
        self.assertEqual(result['changedPackageEntries'],{'B':EXPECTED,'D':EXPECTED})
        self.assertEqual(result['provenance']['artifactId'],14624378243)

    def test_original_wasm_only_declaration_reproduces_the_preparation_rejection(self):
        self.manifest['sources']['native-config']['packagePaths']=[EXPECTED[1]]
        with self.assertRaisesRegex(RuntimeError,'Unexpected packaged product differences for B'):
            DRIVER.validate_package_entries(self.entries,self.manifest)

    def test_any_unrelated_added_removed_or_changed_entry_is_rejected(self):
        common=next(name for name,value in self.entries['A'].items() if self.entries['B'].get(name)==value)
        for mode in ('add','remove','change'):
            with self.subTest(mode=mode):
                entries=copy.deepcopy(self.entries)
                for arm in 'BD':
                    if mode=='add':
                        entries[arm]['unexpected-entry.txt']='a'*64
                    elif mode=='remove':
                        del entries[arm][common]
                    else:
                        entries[arm][common]='b'*64
                with self.assertRaisesRegex(RuntimeError,'Unexpected packaged product differences for B'):
                    DRIVER.validate_package_entries(entries,self.manifest)

    def test_both_duplicate_control_entry_sets_must_match(self):
        for arm,message in [('C','Baseline controls'),('D','Candidate controls')]:
            with self.subTest(arm=arm):
                entries=copy.deepcopy(self.entries)
                entries[arm]['unexpected-entry.txt']='c'*64
                with self.assertRaisesRegex(RuntimeError,message):
                    DRIVER.validate_package_entries(entries,self.manifest)


if __name__=='__main__':
    unittest.main()
