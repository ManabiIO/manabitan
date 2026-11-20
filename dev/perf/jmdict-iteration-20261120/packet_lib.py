"""Small standard-library helpers; the archived analyzers remain authoritative."""

import hashlib
import json
import math
from pathlib import PurePosixPath
import re
import statistics


SCHEMA = "manabitan-offline-evidence-20261120-v1"


def check(value, message):
    if not value:
        raise RuntimeError(message)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def json_bytes(value, pretty=False):
    options = {"ensure_ascii": False, "allow_nan": False, "sort_keys": True}
    if pretty:
        options["indent"] = 2
    else:
        options["separators"] = (",", ":")
    return (json.dumps(value, **options) + "\n").encode()


def safe_path(name):
    check(isinstance(name, str) and name and "\\" not in name and "\x00" not in name, "Unsafe member path")
    path = PurePosixPath(name)
    check(not path.is_absolute() and all(part not in ("", ".", "..") for part in path.parts), "Unsafe member path")
    check(":" not in path.parts[0] and str(path) == name, "Noncanonical member path")
    return path


def close_values(actual, expected, location="result"):
    if type(actual) in (int, float) and type(expected) in (int, float):
        check(math.isfinite(actual) and math.isfinite(expected) and math.isclose(actual, expected, rel_tol=1e-10, abs_tol=1e-8), "Different numeric value: " + location)
    elif isinstance(expected, dict):
        check(isinstance(actual, dict) and actual.keys() == expected.keys(), "Different keys: " + location)
        for key, value in expected.items():
            close_values(actual[key], value, location + "/" + key)
    elif isinstance(expected, list):
        check(isinstance(actual, list) and len(actual) == len(expected), "Different list: " + location)
        for index, value in enumerate(expected):
            close_values(actual[index], value, location + "/" + str(index))
    else:
        check(actual == expected, "Different value: " + location)


def pair_statistics(pairs):
    """Compute from raw browser timer endpoints, without calling protocol helpers."""
    deltas = [100 * (candidate / baseline - 1) for baseline, candidate in pairs]
    return {
        "pairs": len(pairs),
        "pairedChangesPercent": deltas,
        "medianPairedChangePercent": statistics.median(deltas),
        "equalWorkChangePercent": 100 * (sum(candidate for _, candidate in pairs) / sum(baseline for baseline, _ in pairs) - 1),
        "meanSavingMs": statistics.mean(baseline - candidate for baseline, candidate in pairs),
        "fasterPairs": sum(candidate < baseline for baseline, candidate in pairs),
    }


def derive_cell(cell, read_bytes):
    def read(name):
        return json.loads(read_bytes(name))

    state, cohort, analysis = (read(name) for name in ("preparation.json", "cohort.json", "analysis.json"))
    planned = state["order"]
    check(cohort["planned"] == planned and [row["label"] for row in cohort["observations"]] == planned, "Changed observation coverage")
    check(state["complete"] is True and cohort["complete"] is True, "Incomplete source cohort")
    check(analysis["complete"] is cell["expectedValid"], "Changed original disposition")
    check(analysis["observations"] == len(planned), "Changed original observation count")
    errors = {row["label"]: row["error"] for row in analysis["errors"]}
    rows, failures = [], []
    for index, row in enumerate(cohort["observations"]):
        label = row["label"]
        check(re.fullmatch(r"[ABCD][1-9][0-9]*", label), "Invalid observation label")
        arm_id = state["armSources"][label[0]]
        arm = state["arms"][arm_id]
        command_path = f"commands/{label}/command.json"
        command = read(command_path)
        check(row["source"] == arm["source"] and row["packageSha256"] == arm["packageSha256"], "Observation identity differs from source arm")
        if state["browser"] == "chromium":
            raw_path = f"observations/{label}/run-1.json"
            raw = read(raw_path)
            phases = [phase for phase in raw["phases"] if phase.get("name") == state["fixture"]["label"] + ": total import"]
            check(len(phases) == 1, "Raw interval missing or duplicated")
            timing = phases[0]["data"]["browserTiming"]
            browser_version = raw["browserVersion"]
            raw_status = raw["status"]
            raw_skipped = raw["skippedVerification"]
        else:
            raw_path = f"observations/{label}/summary.json"
            raw = read(raw_path)
            timing = raw["importResult"]["timing"]
            browser_version = raw["browser"]["version"]
            raw_status = "success" if raw["completed"] else "incomplete"
            raw_skipped = raw["skippedVerification"]
        elapsed = timing["completedAtMs"] - timing["startedAtMs"]
        check(type(elapsed) in (int, float) and math.isfinite(elapsed) and elapsed > 0, "Invalid raw elapsed time")
        check(timing["trigger"] == "file-input-change" and timing["errorCount"] == 0 and timing["sequence"] > timing["sequenceBefore"] >= 0, "Invalid raw operation timer")
        observation_valid = label not in errors and row.get("error") is None and command["complete"] is True and command.get("exitCode") == 0 and command.get("timedOut", False) is False
        if observation_valid:
            check("result" in row, "Qualified observation lacks its live result")
            check(abs(row["result"]["totalImportMs"] - elapsed) < 1e-8, "Raw timer and live result disagree")
        qualified = analysis["complete"] and observation_valid
        item = {
            "cell": cell["id"], "label": label, "order": index + 1,
            "sourceArm": arm_id, "source": row["source"], "packageSha256": row["packageSha256"],
            "startedAtMs": timing["startedAtMs"], "completedAtMs": timing["completedAtMs"], "rawElapsedMs": elapsed,
            "qualifiedElapsedMs": elapsed if qualified else None,
            "originalObservationValid": observation_valid, "originalCohortValid": analysis["complete"],
            "eligibleForPerformanceClaim": qualified,
            "rawStatus": raw_status, "rawSkippedVerification": raw_skipped, "browserVersion": browser_version,
            "commandComplete": command["complete"], "commandExitCode": command.get("exitCode"), "commandTimedOut": command.get("timedOut", False),
            "originalCohortError": row.get("error"), "originalAnalysisError": errors.get(label),
            "rawFile": raw_path, "rawSha256": sha256(read_bytes(raw_path)),
            "commandFile": command_path, "commandSha256": sha256(read_bytes(command_path)),
        }
        rows.append(item)
        if not qualified:
            stderr_path = f"commands/{label}/stderr.log"
            stderr = read_bytes(stderr_path).decode()
            lines = [line for line in stderr.splitlines() if line.startswith("Error:") or "receipt mismatch:" in line]
            failures.append({
                "cell": cell["id"], "label": label, "disposition": "invalid_original_cohort_not_reclassified",
                "originalCohortError": row.get("error"), "originalAnalysisError": errors.get(label),
                "commandExitCode": command.get("exitCode"), "summaryPresent": f"observations/{label}/summary.json" in cell["archivePaths"],
                "rawStatus": raw_status, "rawElapsedAvailable": True, "eligibleForPerformanceClaim": False,
                "stderrFile": stderr_path, "stderrSha256": sha256(read_bytes(stderr_path)), "stderrErrorLines": lines,
            })
    by_label = {row["label"]: row for row in rows}
    pair_rows, comparisons = [], {}
    for name, baseline_arm, candidate_arm in (("B/A", "A", "B"), ("D/C", "C", "D")):
        numbers = sorted(int(label[1:]) for label in by_label if label[0] == baseline_arm)
        check(numbers == list(range(1, len(numbers) + 1)), "Pair sequence has gaps")
        values = []
        for number in numbers:
            baseline, candidate = (by_label[arm + str(number)] for arm in (baseline_arm, candidate_arm))
            a, b = baseline["rawElapsedMs"], candidate["rawElapsedMs"]
            eligible = baseline["eligibleForPerformanceClaim"] and candidate["eligibleForPerformanceClaim"]
            pair_rows.append({
                "cell": cell["id"], "comparison": name, "pair": number,
                "baselineLabel": baseline["label"], "candidateLabel": candidate["label"],
                "baselineRawMs": a, "candidateRawMs": b,
                "rawChangePercent": 100 * (b / a - 1),
                "eligibleForPerformanceClaim": eligible,
                "qualifiedChangePercent": 100 * (b / a - 1) if eligible else None,
            })
            values.append((a, b))
        if analysis["complete"]:
            comparisons[name] = pair_statistics(values)
    if analysis["complete"]:
        close_values(comparisons, analysis["comparisons"], cell["id"] + "/comparisons")
    else:
        check(analysis["comparisons"] is None, "Invalid original cohort contains qualified statistics")
        check(len(failures) == len(rows), "Unexpected partially valid failed cohort")
    summary = {
        "cell": cell["id"], "group": cell["group"], "browser": state["browser"], "dictionary": state["dictionary"],
        "originalValid": analysis["complete"], "originalDisposition": "valid" if analysis["complete"] else "invalid_original_verifier_receipt_mismatch",
        "observations": len(rows), "qualifiedObservations": sum(row["eligibleForPerformanceClaim"] for row in rows),
        "invalidObservations": len(failures), "pairRows": len(pair_rows),
        "originalErrors": analysis["errors"], "independentComparisons": comparisons if analysis["complete"] else None,
    }
    return rows, pair_rows, summary, failures
