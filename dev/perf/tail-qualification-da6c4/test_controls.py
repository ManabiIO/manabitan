"""Deterministic orchestration guards; no browser or corpus acquisition."""
from contextlib import redirect_stdout
from copy import deepcopy
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

import report_results
import run
from tail_stats import analyze, schedule


HERE = Path(__file__).resolve().parent


def binding():
    return {
        "studyIdentity": {"controlCommit": "a" * 40, "controlTree": "b" * 40,
                          "planSha256": "c" * 64, "manifestSha256": "d" * 64,
                          "baseline": run.BASELINE, "candidate": run.CANDIDATE},
        "runIdentity": {"githubRunId": "1", "githubRunAttempt": "1"},
    }


def observation_set(dictionary, order):
    return [
        {**item, "totalImportMs": 980.0 if item["arm"] == "B" else 1000.0}
        for item in schedule(dictionary, order)
    ]


def verification(context, plan):
    return {
        "kind": "repository-verification", "complete": True, "passed": True,
        "studyIdentity": context["studyIdentity"], "runIdentity": context["runIdentity"],
        "candidate": run.CANDIDATE, "candidateDirtyAfter": False,
        "commands": [{"id": item["id"], "command": item["command"], "returncode": 0}
                     for item in plan["verification"]["commands"]],
    }


class ControlTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.context = binding()
        cls.plan = json.loads((HERE / "plan.json").read_text())
        cls.verification = verification(cls.context, cls.plan)
        cls.cells = {}
        for dictionary, order in (("jmdict", "AB"), ("jmdict", "BA"),
                                  ("jitendex", "AB"), ("jitendex", "BA"),
                                  ("vndb", "AB"), ("vndb", "BA")):
            observations = observation_set(dictionary, order)
            cls.cells[(dictionary, order)] = {
                "kind": "cell", "complete": True, "passed": True,
                "studyIdentity": cls.context["studyIdentity"], "runIdentity": cls.context["runIdentity"],
                "dictionary": dictionary, "initialOrder": order,
                "runtimeIdentities": {"A": run.BASELINE, "B": run.CANDIDATE},
                "observations": observations, "timing": analyze(observations, dictionary, order),
                "memoryAudit": {"observations": 4, "everyObservationQualified": True,
                                "passesProspectiveMemoryScreen": True},
            }

    def test_common_runner_changes_are_only_two_declared_bindings(self):
        original = (HERE / "common-runner.py").read_text()
        self.assertEqual(original.count("root = pathlib.Path(__file__).resolve().parents[3]"), 1)
        self.assertEqual(original.count("from tail_package_identity import "), 1)
        original = original.replace("root = pathlib.Path(__file__).resolve().parents[3]",
                                    "root = pathlib.Path(__file__).resolve().parents[2]")
        original = original.replace("from tail_package_identity import ", "from package_identity import ")
        self.assertEqual(hashlib.sha256(original.encode()).hexdigest(),
                         "01b41fcc5f4589f77637acfa21de374d705d32cefaa8673807501cdfeb05e15b")

    def test_plan_schedules_and_runtime_identities_are_fixed(self):
        self.assertEqual(self.plan["baseline"], run.BASELINE)
        self.assertEqual(self.plan["candidate"], run.CANDIDATE)
        for dictionary in ("jmdict", "jitendex", "vndb"):
            for order in ("AB", "BA"):
                self.assertEqual(self.plan["schedules"][dictionary][order], schedule(dictionary, order))
        self.assertEqual(self.plan["ordinary"]["flags"], {})
        self.assertEqual(self.plan["ordinary"]["expectedParserWorkers"], 3)
        self.assertEqual(self.plan["ordinary"]["vndbSahAllocationUnits"], [37, 37])
        self.assertIsNone(self.plan["diagnostic"]["selectionOrExclusionRule"])

    def test_verification_requires_every_exact_successful_command(self):
        run.require_verification_gate(self.verification, self.context, self.plan)
        for mutation in ("missing", "failed", "altered", "dirty", "foreign"):
            value = deepcopy(self.verification)
            if mutation == "missing":
                value["commands"].pop()
            elif mutation == "failed":
                value["commands"][0]["returncode"] = 1
            elif mutation == "altered":
                value["commands"][0]["command"] = ["true"]
            elif mutation == "dirty":
                value["candidateDirtyAfter"] = True
            else:
                value["runIdentity"]["githubRunId"] = "2"
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                run.require_verification_gate(value, self.context, self.plan)

    def test_original_statistics_fields_must_match_exactly(self):
        timing = self.cells[("jmdict", "AB")]["timing"]
        stock = {
            key: {field: timing[key][field] for field in run.ORIGINAL_COMPARISON_KEYS}
            for key in ("candidateVsBaseline", "identicalCodeControl")
        }
        stock.update(status="correctness-memory-passed", memoryPassed=True)
        run.crosscheck_stock_analysis(stock, timing)
        for mutation in ("number", "extra", "memory"):
            altered = deepcopy(stock)
            if mutation == "number":
                altered["candidateVsBaseline"]["medianPairedChangePercent"] += 0.00001
            elif mutation == "extra":
                altered["candidateVsBaseline"]["unexpected"] = True
            else:
                altered["memoryPassed"] = False
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                run.crosscheck_stock_analysis(altered, timing)

    def test_complete_jmdict_stage_requires_both_orders(self):
        gates = [self.cells[("jmdict", order)] for order in ("AB", "BA")]
        result = run.aggregate_gates(gates, "jmdict", self.context)
        self.assertEqual([(item["dictionary"], item["initialOrder"]) for item in result],
                         [("jmdict", "AB"), ("jmdict", "BA")])
        for invalid in (gates[:1], [gates[0], gates[0]],
                        [gates[0], self.cells[("vndb", "BA")]]):
            with self.assertRaises(ValueError):
                run.aggregate_gates(invalid, "jmdict", self.context)

    def test_nonregression_stage_requires_all_four_hosts(self):
        gates = [self.cells[(dictionary, order)] for dictionary in ("jitendex", "vndb")
                 for order in ("AB", "BA")]
        self.assertEqual(len(run.aggregate_gates(gates, "nonregression", self.context)), 4)
        with self.assertRaises(ValueError):
            run.aggregate_gates(gates[:-1], "nonregression", self.context)

    def test_cell_recomputes_statistics_and_rejects_partial_or_unqualified_inputs(self):
        original = self.cells[("jmdict", "AB")]
        for mutation in ("partial", "numeric", "failed-memory", "missing-memory", "source", "workflow"):
            value = deepcopy(original)
            if mutation == "partial":
                value["observations"].pop()
            elif mutation == "numeric":
                value["observations"][0]["totalImportMs"] += 1
                value["observations"][4]["totalImportMs"] += 1
            elif mutation == "failed-memory":
                value["memoryAudit"]["passesProspectiveMemoryScreen"] = False
            elif mutation == "missing-memory":
                value["memoryAudit"]["observations"] = 3
            elif mutation == "source":
                value["runtimeIdentities"]["B"]["commit"] = "0" * 40
            else:
                value["studyIdentity"]["controlTree"] = "0" * 40
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                run.require_cell_gate(value, self.context)

    def test_jmdict_prerequisite_retains_and_rechecks_both_full_cell_gates(self):
        cells = run.aggregate_gates(
            [self.cells[("jmdict", order)] for order in ("AB", "BA")], "jmdict", self.context)
        stage = {
            "kind": "jmdict-stage", "complete": True, "passed": True,
            "studyIdentity": self.context["studyIdentity"], "runIdentity": self.context["runIdentity"],
            "cells": cells, "hostIdentities": [["jmdict", "AB"], ["jmdict", "BA"]],
            "prerequisites": [{"kind": self.verification["kind"], "sha256": run.object_hash(self.verification)}],
        }
        run.require_jmdict_stage(stage, self.context, self.verification)
        for mutation in ("missing", "false-memory", "different-repository-gate"):
            changed = deepcopy(stage)
            if mutation == "missing":
                changed["cells"].pop()
            elif mutation == "false-memory":
                changed["cells"][0]["cellGate"]["memoryAudit"]["everyObservationQualified"] = False
            else:
                changed["prerequisites"][0]["sha256"] = "0" * 64
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                run.require_jmdict_stage(changed, self.context, self.verification)

    def test_tail_diagnostics_never_select_or_sum_observations(self):
        with tempfile.TemporaryDirectory() as folder:
            cohort = Path(folder)
            for index, value in enumerate((0, 11, 99, None)):
                location = cohort / str(index)
                location.mkdir()
                (location / "run-1.json").write_text(json.dumps({
                    "phase": {"parserParallelOwnedTailLookaheadCount": value},
                    "mirror": {"fastPathParserParallelOwnedTailLookaheadCount": value},
                }))
            result = run.tail_diagnostics(cohort)
            self.assertEqual(len(result["reports"]), 4)
            self.assertEqual([row["fields"][0]["value"] for row in result["reports"]],
                             [0, 11, 99, None])
            self.assertTrue(all(len(row["fields"]) == 2 for row in result["reports"]))
            self.assertIsNone(result["selectionOrExclusionRule"])
            self.assertTrue(result["duplicateMirrorsAreNotSummed"])

    def test_final_state_capture_failure_is_preserved_and_raises(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            evidence = root / "evidence"
            evidence.mkdir()
            runner = run.Runner(root, evidence)
            runner.worktrees["missing"] = root / "absent"
            with mock.patch.object(run, "git", return_value=""), \
                    mock.patch.object(run, "git_bytes", return_value=b""):
                with self.assertRaises(ValueError):
                    runner.capture_state()
            captured = json.loads((evidence / "source-state.json").read_text())
            self.assertIn("captureError", captured["missing"])

    def test_final_capture_failure_revokes_previously_written_gate(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            evidence = root / "evidence"
            def successful_verification(runner, context, plan):
                gate = {"kind": "repository-verification", "complete": True, "passed": True}
                run.write_json(runner.evidence / "verification-gate.json", gate)
                return gate
            args = ["run.py", "--mode", "verify", "--repository", str(root), "--evidence", str(evidence)]
            with mock.patch.object(sys, "argv", args), \
                    mock.patch.object(run, "source_binding", return_value=(self.context, self.plan)), \
                    mock.patch.object(run.Runner, "verification", successful_verification), \
                    mock.patch.object(run.Runner, "capture_state", side_effect=OSError("capture failed")), \
                    redirect_stdout(io.StringIO()):
                self.assertEqual(run.main(), 1)
            self.assertFalse((evidence / "verification-gate.json").exists())
            self.assertTrue((evidence / "failed-verification-gate.json").exists())
            self.assertFalse(json.loads((evidence / "outcome.json").read_text())["passed"])

    def test_reporter_retains_completed_timing_after_a_memory_failure(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "cohort").mkdir()
            original = self.cells[("jmdict", "AB")]["observations"]
            run.write_json(root / "outcome.json", {"passed": False, "complete": False})
            run.write_json(root / "cohort/observations.json", original)
            run.write_json(root / "cohort/analysis.json",
                           {"status": "memory-or-semantics-failed", "memoryPassed": False})
            output = io.StringIO()
            with redirect_stdout(output):
                report_results.report(root)
            receipts = [json.loads(line.removeprefix("TAIL_RECEIPT "))
                        for line in output.getvalue().splitlines() if line.startswith("TAIL_RECEIPT ")]
            by_path = {row["path"]: row["data"] for row in receipts}
            self.assertEqual(by_path["cohort/observations.json"], original)
            self.assertEqual(by_path["cohort/analysis.json"]["status"], "memory-or-semantics-failed")


if __name__ == "__main__":
    unittest.main()
