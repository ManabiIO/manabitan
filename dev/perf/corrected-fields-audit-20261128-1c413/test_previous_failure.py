"""Pure previous-failure classification checks; no files, network or product execution."""
import copy
import json
import unittest

import original_fields as original
import previous_failure as previous
from transport import AuditError


def fixture():
    source = {"files": [
        {"path": "evidence/stage1/test-attempts/" + str(index) + "/report.json"}
        for index in range(77)
    ]}
    preparation = {
        "complete": False, "timingAcquisition": False, "localUntimed": False,
        "node": "v22.22.0", "plannedNode": "v22.22.0",
        "sources": original.source_receipt(), "schedule": original.schedule_balance(),
        "compilerVersion": "Ubuntu clang version 21.1.8 (6ubuntu1)",
        "linkerVersion": "Ubuntu LLD 21.1.8",
        "buildCommand": [
            "clang-21", "-fuse-ld=wasm-ld-21", "--target=wasm32", "-O3",
            "-nostdlib", "-mbulk-memory", "-Wl,--no-entry", "-Wl,--import-memory",
            "-Wl,-z,stack-size=65536", "-Wl,--strip-all", "-o",
            "/repo/builds/perf/" + previous.ROOT + "/rebuilt-record-fields.wasm",
            "/repo/" + original.KIT + "/record-fields.c",
        ],
        "buildExitCode": 1,
        "error": "AssertionError: " + previous.DIAGNOSTIC,
        "stack": "AssertionError at file:///repo/" + original.KIT + "/prepare.mjs:37:12",
    }
    return source, preparation, previous.expected_file_names(source)


def classify(source, preparation, names, build_log=None, outer_log=None):
    return previous.verify_failure_records(
        preparation, previous.DIAGNOSTIC + "\n" if build_log is None else build_log,
        json.dumps(preparation) + "\n" if outer_log is None else outer_log,
        names, source,
    )


class PreviousFailureTests(unittest.TestCase):
    def test_known_failure_is_valid_but_never_qualifying(self):
        source, preparation, names = fixture()
        receipt = classify(source, preparation, names)
        self.assertEqual(len(names), 82)
        self.assertEqual(receipt["originalWarmupObservations"], 0)
        self.assertEqual(receipt["originalMeasuredObservations"], 0)
        self.assertFalse(receipt["originalFocusedTestsExecuted"])
        self.assertFalse(receipt["nativeModuleReproducedInOriginal"])
        self.assertFalse(receipt["performanceResultAvailable"])
        self.assertFalse(receipt["nominationGatePassed"])
        self.assertFalse(receipt["qualifiedForComponentNomination"])
        self.assertTrue(receipt["historicalFrozenStage1RecordsAreNotNewObservations"])

    def test_historical_records_do_not_hide_new_acquisition_outputs(self):
        source, preparation, names = fixture()
        for added in ("screen/observations/000-warmup-A/receipt.json",
                      "focused-tests/001/report.json", "rebuilt-record-fields.wasm",
                      "untimed-verification/observations.json", "affinity.json", "unexpected.txt"):
            with self.subTest(added=added), self.assertRaises(AuditError):
                classify(source, preparation, names | {previous.ROOT + "/" + added})
        with self.assertRaises(AuditError):
            classify(source, preparation, names - {previous.ROOT + "/build.log"})

    def test_source_runtime_and_failure_phase_must_match(self):
        source, preparation, names = fixture()
        for key, value in (("complete", True), ("timingAcquisition", True),
                           ("localUntimed", True), ("node", "v24.22.3"),
                           ("buildExitCode", 0), ("testExitCode", 0),
                           ("tests", {"passed": 51}), ("rebuild", {"bytes": 1753})):
            changed = copy.deepcopy(preparation)
            changed[key] = value
            with self.subTest(key=key), self.assertRaises(AuditError):
                classify(source, changed, names)
        changed = copy.deepcopy(preparation)
        changed["sources"]["head"] = "0" * 40
        with self.assertRaises(AuditError):
            classify(source, changed, names)

    def test_other_compiler_or_test_failures_are_not_this_failure(self):
        source, preparation, names = fixture()
        changes = [
            ("buildCommand", 1, "-fuse-ld=/usr/bin/wasm-ld-21"),
            ("buildCommand", 3, "-O0"),
        ]
        for key, index, value in changes:
            changed = copy.deepcopy(preparation)
            changed[key][index] = value
            with self.subTest(value=value), self.assertRaises(AuditError):
                classify(source, changed, names)
        for key, value in (("error", "test assertion failed"),
                           ("stack", "at tests.mjs:37:12"),
                           ("compilerVersion", "clang version 22.1.0")):
            changed = copy.deepcopy(preparation)
            changed[key] = value
            with self.subTest(key=key), self.assertRaises(AuditError):
                classify(source, changed, names)
        with self.assertRaises(AuditError):
            classify(source, preparation, names, build_log=previous.DIAGNOSTIC + "\nextra compiler output")

    def test_outer_log_cannot_contain_measurements_or_unbound_receipts(self):
        source, preparation, names = fixture()
        altered = dict(preparation, buildExitCode=0)
        for outer in (json.dumps(altered),
                      json.dumps(preparation) + "\n" + json.dumps({"index": 0, "phase": "measured", "arm": "A"}),
                      json.dumps(preparation) + "\n" + json.dumps(preparation)):
            with self.subTest(outer=outer[-80:]), self.assertRaises(AuditError):
                classify(source, preparation, names, outer_log=outer)

    def test_original_job_must_fail_before_the_skipped_schedule(self):
        publication = {
            "run": {"status": "completed", "conclusion": "failure"},
            "job": {"status": "completed", "conclusion": "failure", "steps": [
                {"name": previous.PREPARATION_STEP, "status": "completed", "conclusion": "failure"},
                {"name": previous.SCHEDULE_STEP, "status": "completed", "conclusion": "skipped"},
                {"name": previous.UPLOAD_STEP, "status": "completed", "conclusion": "success"},
            ]},
            "allOriginalJobsSucceeded": False,
        }
        self.assertEqual(len(previous.verify_failure_job(publication)), 3)
        changed = copy.deepcopy(publication)
        changed["job"]["steps"][1]["conclusion"] = "success"
        with self.assertRaises(AuditError):
            previous.verify_failure_job(changed)
        changed = copy.deepcopy(publication)
        changed["allOriginalJobsSucceeded"] = True
        with self.assertRaises(AuditError):
            previous.verify_failure_job(changed)
        changed = copy.deepcopy(publication)
        changed["job"]["steps"].append(dict(changed["job"]["steps"][1]))
        with self.assertRaises(AuditError):
            previous.verify_failure_job(changed)

    def test_original_frozen_inventory_must_remain_complete_and_unique(self):
        source, preparation, names = fixture()
        for changed in ({"files": source["files"][:-1]},
                        {"files": source["files"][:-1] + [source["files"][0]]}):
            with self.assertRaises(AuditError):
                previous.expected_file_names(changed)


if __name__ == "__main__":
    unittest.main()
