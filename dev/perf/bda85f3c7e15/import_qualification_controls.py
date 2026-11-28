# SPDX-License-Identifier: GPL-3.0-or-later
"""Pure command, per-arm configuration, and activation checks for qualification."""

from copy import deepcopy
import json


def parse_arm_flags(baseline_json, candidate_json):
    result = {}
    for arm, encoded in (("A", baseline_json), ("B", candidate_json)):
        flags = json.loads(encoded)
        if type(flags) is not dict:
            raise ValueError(f"Flags for {arm} must be an object")
        result[arm] = flags or None
    return result


def select_arm_flags(flags_by_arm, arm):
    if arm not in ("A", "B", "C"):
        raise ValueError(f"Unknown observation arm: {arm}")
    return flags_by_arm["A" if arm == "C" else arm]


def import_command(dictionary, output, flags, media_check="sample"):
    if media_check not in ("sample", "all"):
        raise ValueError("Media check must be sample or all")
    command = [
        "node", "dev/perf/import-benchmark.js", dictionary, "--runs", "1",
        "--no-build", "--build-target", "chrome", "--media-check", media_check,
        "--output", str(output),
    ]
    if flags is not None:
        command.extend(("--flags", json.dumps(flags, sort_keys=True, separators=(",", ":"))))
    return command


def semantic_receipt(receipt, expected_flags):
    """Normalize only separately validated configuration in the comparison view.

    The unmodified canonical receipt, including actual flags, is retained by the
    caller. Every semantic, browser and fixture field remains in the comparison.
    """
    common = receipt.get("common")
    if type(common) is not dict or "importFlags" not in common:
        raise ValueError("Missing arm flags in the validated receipt")
    if common["importFlags"] != expected_flags:
        raise ValueError("Validated receipt flags differ from the frozen arm")
    normalized = deepcopy(receipt)
    normalized["common"]["importFlags"] = None
    return normalized


def validate_lookahead_participation(summary, dictionary, expected_flags):
    """Prove inactive arms stayed inactive and record every arm's claim counts."""
    requested = (expected_flags or {}).get("experimentalTermContentLookahead") is True
    require_positive = dictionary == "jmdict" and requested
    phases = summary["runs"][0]["importDebug"].get("importerPhaseTimings", [])
    selected = [phase for phase in phases if type(phase) is dict and
                str(phase.get("phase", "")).startswith("term-file-fast-path:")]
    if require_positive and not selected:
        raise ValueError("Active JMdict lookahead has no fast-path phase receipt")
    totals = {"contentLookaheadPreparedCount": 0, "contentLookaheadCompressionCount": 0}
    for phase in selected:
        details = phase.get("details", {})
        if type(details) is not dict:
            raise ValueError("Missing lookahead phase details")
        for key in totals:
            value = details.get(key, None if requested else 0)
            if type(value) is not int or value < 0:
                raise ValueError(f"Missing or invalid lookahead activation counter: {key}")
            totals[key] += value
    if not requested and any(totals.values()):
        raise ValueError("Inactive lookahead arm reported positive claims")
    if require_positive and any(value <= 0 for value in totals.values()):
        raise ValueError("Active JMdict lookahead did not claim preparation and compression")
    if totals["contentLookaheadCompressionCount"] > totals["contentLookaheadPreparedCount"]:
        raise ValueError("Lookahead compression claims exceed prepared claims")
    return {"dictionary": dictionary, "requested": requested,
            "requiresPositiveClaims": require_positive, "fastPathPhases": len(selected), **totals}
