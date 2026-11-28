#!/usr/bin/env python3
"""Pure frozen 74-report fields statistics and nomination policy; no I/O or acquisition."""
import json
import math
import random
import statistics

CELLS = {dictionary + "-" + order: (dictionary, order)
         for dictionary in ("jmdict", "jitendex", "vndb") for order in ("AB", "BA")}
POLICY = json.loads(r'''{
  "primaryTarget": "jmdict",
  "originalHostsPerDictionary": 2,
  "measuredPairsPerHost": 24,
  "controlPairsPerHost": 8,
  "originalReportsPerCell": 74,
  "originalReportsByArm": {
    "A": 37,
    "B": 29,
    "C": 8
  },
  "targetMedianChangePercentAtMost": -2,
  "targetFasterPairsAtLeast": 18,
  "targetAbsoluteControlMedianAtMost": 1,
  "targetAbsoluteControlEqualWorkAtMost": 1,
  "nonTargetAbsoluteControlMedianAtMost": 3,
  "nonTargetAbsoluteControlEqualWorkAtMost": 3,
  "repeatedNonTargetRegressionPercent": 3,
  "repeatedNonTargetDefinition": "Paired-median slowdown greater than 3 percent for the same dictionary on both original hosts",
  "requireAllSixSourceSemanticMediaMemoryActivationCells": true,
  "requireSeparateFullCorrectness": true,
  "requireCompletedComponentNominationAndArtifactAudit": true,
  "noRetriesReplacementsExclusionsOrPooling": true,
  "scope": "Complete browser import qualification of the original frozen fields study; component measurements do not substitute for whole-import evidence."
}''')


def require(condition, message):
    if not condition:
        raise ValueError(message)


def same(actual, expected, label):
    require(json.dumps(actual, sort_keys=True, allow_nan=False) ==
            json.dumps(expected, sort_keys=True, allow_nan=False), label + " differs")


def frozen_schedule(initial_order, pairs=24):
    require(initial_order in ("AB", "BA") and pairs == 24, "Unexpected frozen timing schedule")
    result = []
    for number, order in enumerate((initial_order, initial_order[::-1]), 1):
        for arm in order:
            result.append({"id": f"warmup-{number}-{arm}", "kind": "warmup", "pair": number, "arm": arm})
    for number in range(1, pairs + 1):
        order = initial_order if number % 2 else initial_order[::-1]
        for arm in order:
            result.append({"id": f"pair-{number:02d}-{arm}", "kind": "candidate", "pair": number, "arm": arm})
        if number % 3 == 0:
            control_pair = number // 3
            order = "AC" if (control_pair + (initial_order == "BA")) % 2 else "CA"
            for arm in order:
                result.append({"id": f"control-{control_pair:02d}-{arm}", "kind": "control",
                               "pair": control_pair, "arm": arm})
    return result


def independent_contrast(observations, kind, left, right):
    groups = {}
    for observation in observations:
        if observation["kind"] != kind:
            continue
        number, arm = observation["pair"], observation["arm"]
        require(type(number) is int and number > 0, "Invalid original pair identifier")
        require(arm in (left, right) and arm not in groups.setdefault(number, {}), "Duplicate or unknown pair arm")
        duration = observation["totalImportMs"]
        require(type(duration) in (int, float) and math.isfinite(duration) and duration > 0, "Invalid recorded duration")
        groups[number][arm] = duration
    require(kind in ("candidate", "control"), "Unexpected contrast role")
    expected_count = 24 if kind == "candidate" else 8
    same(sorted(groups), list(range(1, expected_count + 1)), "Complete pair identifiers")
    require(all(set(pair) == {left, right} for pair in groups.values()), "Incomplete paired observation")
    pairs = [groups[number] for number in range(1, expected_count + 1)]
    ratios = [pair[right] / pair[left] for pair in pairs]
    require(all(math.isfinite(value) and value > 0 for value in ratios), "Invalid paired ratio")
    generator = random.Random(897)
    medians = sorted(statistics.median(generator.choices(ratios, k=len(ratios))) for _ in range(10000))
    return {
        "count": len(pairs), "ratios": ratios,
        "medianPairedChangePercent": 100 * (statistics.median(ratios) - 1),
        "equalWorkChangePercent": 100 * (sum(pair[right] for pair in pairs) / sum(pair[left] for pair in pairs) - 1),
        "worstPairChangePercent": 100 * (max(ratios) - 1),
        "descriptiveBootstrap95Percent": [100 * (medians[index] - 1) for index in (249, 9749)],
        "fasterPairs": sum(value < 1 for value in ratios),
    }


def cell_qualification(dictionary, candidate, controls, correctness, memory, semantics, activation, original_job_passed):
    """Inputs are independently reconstructed contrasts and explicit complete evidence gates."""
    require(dictionary in ("jmdict", "jitendex", "vndb"), "Unknown original dictionary")
    candidate_complete = type(candidate) is dict and candidate.get("count") == 24
    control_complete = type(controls) is dict and controls.get("count") == 8
    limit = 1 if dictionary == "jmdict" else 3
    gates = {
        "completeSourceAndSemantics": semantics is True,
        "separateCorrectness": correctness is True,
        "separateMemory": memory is True,
        "allOriginalActivationReceipts": activation is True,
        "originalJobSucceeded": original_job_passed is True,
        "completeTwentyFourCandidatePairs": candidate_complete,
        "completeEightSameCodeControlPairs": control_complete,
        "absoluteControlMedianWithinFrozenLimit": control_complete and abs(controls["medianPairedChangePercent"]) <= limit,
        "absoluteControlEqualWorkWithinFrozenLimit": control_complete and abs(controls["equalWorkChangePercent"]) <= limit,
    }
    if dictionary == "jmdict":
        gates.update({
            "pairedMedianAtMostMinusTwoPercent": candidate_complete and candidate["medianPairedChangePercent"] <= -2,
            "atLeastEighteenOfTwentyFourFaster": candidate_complete and candidate["fasterPairs"] >= 18,
        })
    return {
        "passesCellPolicy": all(gates.values()), "gates": gates,
        "controlAbsoluteLimitPercent": limit,
        "nonTargetMedianSlowdownAboveThreePercent": dictionary != "jmdict" and candidate_complete and candidate["medianPairedChangePercent"] > 3,
    }


def qualify_study(cells, correctness, prerequisite_evidence, audit_errors=False):
    """No missing, duplicate, partial or failed original host can qualify."""
    by_cell = {cell["dictionary"] + "-" + cell["initialOrder"]: cell for cell in cells}
    complete = len(cells) == len(CELLS) and len(by_cell) == len(CELLS) and set(by_cell) == set(CELLS)
    repeated = []
    for dictionary in ("jitendex", "vndb"):
        hosts = [by_cell.get(dictionary + "-" + order) for order in ("AB", "BA")]
        if all(host is not None and type(host.get("candidateVsBaseline")) is dict and
               host["candidateVsBaseline"].get("count") == 24 and
               host["candidateVsBaseline"]["medianPairedChangePercent"] > 3 for host in hosts):
            repeated.append(dictionary)
    gates = {
        "allSixOriginalCellsAudited": complete and not audit_errors,
        "separateFullCorrectness": correctness is True,
        "allProspectivePrerequisitesVerified": prerequisite_evidence is True,
        "allSixCellPoliciesPass": complete and all(cell["qualification"]["passesCellPolicy"] is True for cell in cells),
        "noRepeatedNonTargetRegression": not repeated,
    }
    return {
        "qualifiesFrozenStudy": all(gates.values()), "gates": gates,
        "repeatedNonTargetRegressions": repeated, "policy": POLICY,
        "productPrAuthorizedByReader": False,
    }
