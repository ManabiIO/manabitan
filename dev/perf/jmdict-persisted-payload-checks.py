#!/usr/bin/env python3
"""Falsification checks for the standalone persisted-payload comparator."""

from copy import deepcopy
import importlib.util
from pathlib import Path
import unittest

path = Path(__file__).with_name("jmdict-persisted-payload-20261120.py")
spec = importlib.util.spec_from_file_location("payload_diagnostic", path)
diagnostic = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diagnostic)


def rehash(value):
    for prefix, field in (("raw", "rawSha256"), ("normalized", "normalizedSha256")):
        value[prefix + "ManifestSha256"] = diagnostic.object_digest([
            {"path": item["path"], "bytes": item["bytes"], "sha256": item[field]} for item in value["files"]])
    return value


def payload(generation="11", record_hash="a", index_hash="b"):
    files = [
        {"path": "manabitan-term-content.bin", "kind": "content", "bytes": 5,
         "rawSha256": "c" * 64, "normalizedSha256": "c" * 64, "excludedRange": None},
        {"path": "manabitan-term-records/dict-Example.mbtr", "kind": "record", "bytes": 30,
         "rawSha256": record_hash * 64, "normalizedSha256": "d" * 64,
         "excludedRange": {"offset": 8, "length": 16, "field": "shardGenerationId"}},
        {"path": "manabitan-term-records/dict-Example.mbtr.mbti", "kind": "index", "bytes": 96,
         "rawSha256": index_hash * 64, "normalizedSha256": "e" * 64,
         "excludedRange": {"offset": 24, "length": 16, "field": "shardGenerationId"}},
    ]
    return rehash({"schemaVersion": 1, "inventoryStable": True, "files": files,
        "pairs": [{"descriptor": files[1]["path"], "index": files[2]["path"], "generation": generation * 16, "chunkCount": 1, "rows": 1}],
        "rowCount": 1, "fileCount": 3, "totalBytes": 131, "excludedByteCount": 32})


def observation():
    fixture = {"termRows": 1, "sha256": diagnostic.FIXTURE_SHA, "expectedTitle": "Example", "revision": "1"}
    arm = {"source": diagnostic.CANDIDATE, "tree": diagnostic.CANDIDATE_TREE, "packageSha256": "1" * 64}
    state = {"fixture": fixture, "fixtureLockSha256": "2" * 64,
        "runtime": {"binarySha256": "3" * 64, "geckodriver": {"binarySha256": "4" * 64}, "applicationVersion": "161.0", "release": "161.0b5"},
        "expectedExperiments": {},
        "helperInputs": {diagnostic.HELPER: "5" * 64, diagnostic.READER: "6" * 64},
        "sharedInputs": {"test/e2e/import-timing.js": "7" * 64}}
    probes = [{"expression": f"sample-{index}", "reading": f"sample-{index}", "glossary": ["definition"]} for index in range(12)]
    semantic = {"dictionaryInfo": [{"title": fixture["expectedTitle"], "revision": fixture["revision"]}],
        "counts": {"counts": [{"terms": 1}]}, "probeCount": 12,
        "storage": {"usesFallbackStorage": False, "openStorageDiagnostics": {"mode": "opfs-sahpool"}},
        "semantics": probes, "samples": probes, "semanticDigest": diagnostic.object_digest(probes), "storageSampleDigest": diagnostic.object_digest(probes)}
    full = payload()
    result = diagnostic.validate_payload(full, 1)
    summary = {"completed": True, "diagnosticOnly": True, "authoritativeTiming": False, "peakMemoryClaim": False,
        "skippedVerification": False, "error": None, "cleanupErrors": [], "diagnosticErrors": [],
        "source": {"commit": arm["source"], "tree": arm["tree"]},
        "package": {"sha256": arm["packageSha256"], "buildTarget": "firefox", "manifest": {
            "background": {"page": "background.html"}, "browser_specific_settings": {"gecko": {
                "id": "{1e12d533-8e72-4ec5-9edc-cd50e26d7d43}", "strict_min_version": "115.0"}}}},
        "fixture": {**fixture, "lockSha256": state["fixtureLockSha256"], "probes": probes},
        "runtime": {"binarySha256": state["runtime"]["binarySha256"], "geckodriverSha256": state["runtime"]["geckodriver"]["binarySha256"], "headless": False},
        "browser": {"freshProfile": True, "suppliedProfile": False, "profile": "/tmp/profile-A", "version": "161.0"},
        "productionEnvironment": {"flags": None, "profiling": False, "sharedArrayBuffer": True},
        "effectiveExperiments": {}, "tooling": {"helperSha256": "5" * 64, "payloadReaderSha256": "6" * 64, "timingFileSha256": "7" * 64},
        "completion": {"currentOperationPostUi": True, "trigger": "file-input-change", "sequence": 1, "sequenceBefore": 0, "errorCount": 0},
        "reload": {"browserRestarted": False, "reimported": False, "priorOrigin": 10, "nextOrigin": 20},
        "beforeReload": deepcopy(semantic), "afterReload": deepcopy(semantic),
        "payloadBeforeReload": deepcopy(full), "payloadAfterReload": deepcopy(full),
        "payloadValidation": {**result, "rawEqualityOverReload": True, "normalizedEqualityOverReload": True}}
    return summary, arm, state


class PayloadChecks(unittest.TestCase):
    def test_accepts_complete_payload(self):
        result = diagnostic.validate_payload(payload(), 1)
        self.assertEqual(result["totalBytes"], 131)

    def test_generation_only_difference_is_allowed_across_fresh_arms(self):
        left, right = payload(), payload("22", "f", "1")
        self.assertNotEqual(left["rawManifestSha256"], right["rawManifestSha256"])
        self.assertEqual(diagnostic.compare_payloads(left, right, 1), left["normalizedManifestSha256"])

    def test_any_payload_hash_difference_fails_cross_arm_comparison(self):
        for index in range(3):
            with self.subTest(index=index):
                right = payload()
                right["files"][index]["normalizedSha256"] = "9" * 64
                if index == 0:
                    right["files"][index]["rawSha256"] = "9" * 64
                rehash(right)
                with self.assertRaisesRegex(RuntimeError, "payload differs"):
                    diagnostic.compare_payloads(payload(), right, 1)

    def test_payload_receipts_fail_closed(self):
        changes = [
            lambda value: value.update(inventoryStable=False),
            lambda value: value.update(schemaVersion=2),
            lambda value: value.update(rowCount=0),
            lambda value: value.update(fileCount=2),
            lambda value: value.update(totalBytes=130),
            lambda value: value.update(excludedByteCount=33),
            lambda value: value.update(rawManifestSha256="0" * 64),
            lambda value: value.update(normalizedManifestSha256="0" * 64),
            lambda value: value["files"][1].update(bytes=True),
            lambda value: value["files"][1]["excludedRange"].update(offset=9),
            lambda value: value["files"][2]["excludedRange"].update(length=17),
            lambda value: value["files"][0].update(normalizedSha256="0" * 64),
            lambda value: value["files"][0].update(path="manabitan-term-content^1.bin"),
            lambda value: value["files"].reverse(),
            lambda value: value["pairs"].clear(),
            lambda value: value["pairs"][0].update(generation="00"),
            lambda value: value["pairs"][0].update(rows=2),
            lambda value: value["pairs"].append(deepcopy(value["pairs"][0])),
        ]
        for index, mutate in enumerate(changes):
            with self.subTest(index=index):
                value = payload()
                mutate(value)
                with self.assertRaises(RuntimeError):
                    diagnostic.validate_payload(value, 1)

    def test_exact_expected_rows_required(self):
        with self.assertRaisesRegex(RuntimeError, "row coverage"):
            diagnostic.validate_payload(payload(), 2)

    def test_valid_observation_uses_release_manifest_with_minimum_version(self):
        summary, arm, state = observation()
        self.assertEqual(diagnostic.validate_observation(summary, arm, state)["fileCount"], 3)

    def test_reloaded_generation_changes_are_rejected_even_when_normalized_equal(self):
        summary, arm, state = observation()
        summary["payloadAfterReload"] = payload("22", "f", "1")
        with self.assertRaisesRegex(RuntimeError, "changed over reload"):
            diagnostic.validate_observation(summary, arm, state)

    def test_observation_receipts_fail_closed(self):
        changes = [
            lambda value: value.update(completed=False),
            lambda value: value.update(diagnosticOnly=False),
            lambda value: value.update(authoritativeTiming=True),
            lambda value: value.update(peakMemoryClaim=True),
            lambda value: value.update(skippedVerification=True),
            lambda value: value["cleanupErrors"].append("shutdown failed"),
            lambda value: value["source"].update(commit=diagnostic.BASELINE),
            lambda value: value["package"].update(sha256="0" * 64),
            lambda value: value["package"]["manifest"]["browser_specific_settings"]["gecko"].update(update_url="https://invalid.example"),
            lambda value: value["browser"].update(freshProfile=False),
            lambda value: value["browser"].update(version="161.0b5"),
            lambda value: value["tooling"].update(payloadReaderSha256="0" * 64),
            lambda value: value["completion"].update(sequence=0),
            lambda value: value["reload"].update(nextOrigin=10),
            lambda value: value["payloadValidation"].update(rawEqualityOverReload=False),
            lambda value: value["afterReload"]["storage"].update(usesFallbackStorage=True),
            lambda value: value["beforeReload"]["semantics"].clear(),
        ]
        for index, mutate in enumerate(changes):
            with self.subTest(index=index):
                summary, arm, state = observation()
                mutate(summary)
                with self.assertRaises(RuntimeError):
                    diagnostic.validate_observation(summary, arm, state)


if __name__ == "__main__":
    unittest.main(verbosity=2)
