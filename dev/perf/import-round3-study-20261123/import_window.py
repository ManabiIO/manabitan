"""Prospectively scoped process-memory observations inside importer markers.

This does not change the schema-3 observer or its full-lifecycle receipt. The
same observation-level rules run over every wholly contained scan, followed by
the separately frozen minimum sample-count and coverage-span requirements.
"""
import math

from chromium_memory import SIBLING_RECOVERY_RULE, summarize_samples


IMPORT_WINDOW_RULE = "recorded-importer-complete-scans-v1"
START_MARKER = "archive-and-index"
END_MARKER = "post-finalization-integrity-sample"
MIN_QUALIFIED_SCANS = 3
MIN_QUALIFIED_START_SPAN_MS = 250


def require(condition, message):
    if not condition:
        raise ValueError(message)


def finite_number(value):
    return type(value) in (int, float) and math.isfinite(value)


def window_plan():
    return {"scopeRule": IMPORT_WINDOW_RULE, "observerRule": SIBLING_RECOVERY_RULE,
            "startMarker": START_MARKER, "startField": "startEpochMs",
            "endMarker": END_MARKER, "endField": "endEpochMs",
            "endMarkerMeaning": "Post-commit marker with skipped=true; no additional integrity sampling operation",
            "selection": "All and only scans whose complete start/end interval lies inside the inclusive recorded marker bounds",
            "minimumQualifiedScans": MIN_QUALIFIED_SCANS,
            "minimumQualifiedScanStartSpanMs": MIN_QUALIFIED_START_SPAN_MS,
            "scope": "Sampled process-tree PSS/private memory during the recorded importer interval only",
            "wholeLifecycleReceiptRetained": True, "authoritativeTiming": False}


def import_bounds(report, result, fixture):
    """Require one structured, successful import and unambiguous phase bounds."""
    matches = [(index, phase) for index, phase in enumerate(report["phases"])
               if phase.get("name") == fixture["label"] + ": total import"]
    require(len(matches) == 1, "Missing or duplicate structured total-import phase")
    total_index, total = matches[0]
    data = total["data"]
    require(data["kind"] == "dictionary-import" and data["dictionary"] == fixture["label"],
            "Total-import phase names a different operation")
    debug = data["importDebug"]
    require(debug == result["importDebug"], "Summary and retained report import debug differ")
    require(debug["hasResult"] is True and debug["resultTitle"] == fixture["expectedTitle"] and
            type(debug["errorCount"]) is int and debug["errorCount"] == 0 and
            type(debug["addSettingsErrorCount"]) is int and debug["addSettingsErrorCount"] == 0 and
            debug["usesFallbackStorage"] is False, "Import completion is not successful production storage")
    phases = debug["importerPhaseTimings"]
    require(isinstance(phases, list) and bool(phases), "Missing structured importer phase timings")
    for phase in phases:
        require(isinstance(phase, dict) and isinstance(phase.get("phase"), str) and phase["phase"], "Invalid importer phase")
        start, end, elapsed = (phase[key] for key in ("startEpochMs", "endEpochMs", "elapsedMs"))
        require(type(start) is int and type(end) is int and 0 <= start <= end and
                finite_number(elapsed) and elapsed == end - start, "Invalid importer phase epoch/elapsed bounds")
    def unique(name):
        selected = [(index, phase) for index, phase in enumerate(phases) if phase["phase"] == name]
        require(len(selected) == 1, "Missing or duplicate importer marker: " + name)
        return selected[0]
    start_index, start = unique(START_MARKER)
    end_index, end = unique(END_MARKER)
    bulk_index, bulk = unique("bulk-finalization")
    require(start["details"]["ok"] is True and start["details"]["archiveSizeBytes"] == fixture["sizeBytes"],
            "Archive marker does not identify the successful pinned input")
    require(bulk["details"]["ok"] is True, "Bulk finalization did not succeed")
    require(end["details"]["skipped"] is True and end["details"]["reason"] == "transaction-commit-completed" and
            type(end["details"]["termCount"]) is int and end["details"]["termCount"] == fixture["termRows"],
            "End marker is not the expected post-commit marker")
    left, right = start["startEpochMs"], end["endEpochMs"]
    require(left < right and start_index < bulk_index < end_index and bulk["endEpochMs"] <= end["startEpochMs"],
            "Importer boundary ordering differs")
    require(all(left <= phase["startEpochMs"] <= phase["endEpochMs"] <= right for phase in phases),
            "An importer phase falls outside the declared interval")
    return {"startEpochMs": left, "endEpochMs": right,
            "reportTotalImportPhaseIndex": total_index, "importerPhaseCount": len(phases),
            "markerIndices": {"start": start_index, "bulkFinalization": bulk_index, "end": end_index},
            "startMarker": start, "endMarker": end}


def derive_import_window(raw, report, result, fixture):
    """Return a separate scoped result; never mutate or reclassify raw receipts."""
    require(raw["schemaVersion"] == 3 and raw["observerRule"] == SIBLING_RECOVERY_RULE and
            raw["authoritativeTiming"] is False, "Unexpected frozen observer identity")
    bounds = import_bounds(report, result, fixture)
    samples = raw["samples"]
    require(isinstance(samples, list) and bool(samples), "No retained process-memory scans")
    intervals, previous_end = [], None
    for sample in samples:
        start, end = sample["startedAtEpochSeconds"], sample["finishedAtEpochSeconds"]
        require(finite_number(start) and finite_number(end) and 0 <= start <= end,
                "Invalid sampler epoch bounds")
        require(previous_end is None or previous_end <= start, "Sampler intervals overlap or its wall clock moved backward")
        previous_end = end
        intervals.append((start * 1000, end * 1000))
    left, right = bounds["startEpochMs"], bounds["endEpochMs"]
    require(intervals[0][0] <= left and intervals[-1][1] >= right,
            "Retained sampling does not enclose the recorded importer interval")
    selected_indices = [index for index, (start, end) in enumerate(intervals) if left <= start and end <= right]
    selected = [samples[index] for index in selected_indices]
    eligible_indices = [index for index in selected_indices if samples[index]["qualifiedForWholeTreePss"]]
    # Do not filter failed selected scans out before applying the existing rules.
    observer = summarize_samples(selected, raw["benchmarkExitCode"])
    start_span = (intervals[eligible_indices[-1]][0] - intervals[eligible_indices[0]][0]) if eligible_indices else 0
    failures = list(observer["qualificationFailures"])
    if len(eligible_indices) < MIN_QUALIFIED_SCANS:
        failures.append("fewer-than-three-qualified-import-window-scans")
    if start_span < MIN_QUALIFIED_START_SPAN_MS:
        failures.append("qualified-import-window-scan-start-span-below-250ms")
    qualified = not failures
    # The producer's narrative scope describes the whole lifecycle. Retain its
    # numeric/rule results here without relabeling the original raw summary.
    omitted = {"samples", "scope", "sampling", "limitations", "maxSampledPssKiB", "maxSampledPrivateKiB"}
    observer_counts = {key: value for key, value in observer.items() if key not in omitted}
    chosen = set(selected_indices)
    return {"schemaVersion": 1, **window_plan(), "window": bounds,
            "selectedSampleIndices": selected_indices,
            "excludedSampleIndices": [index for index in range(len(samples)) if index not in chosen],
            "qualifiedSampleIndices": eligible_indices, "selectedSampleCount": len(selected),
            "qualifiedSampleCount": len(eligible_indices), "qualifiedScanStartSpanMs": start_span,
            "scopedObserverCounts": observer_counts,
            "qualifiedForImportWindowPss": qualified, "qualificationFailures": failures,
            "maxSampledPssKiB": observer["maxSampledPssKiB"] if qualified else None,
            "maxSampledPrivateKiB": observer["maxSampledPrivateKiB"] if qualified else None,
            "wholeLifecycleQualifiedForWholeTreePss": raw["qualifiedForWholeTreePss"],
            "wholeLifecycleQualificationFailures": list(raw["qualificationFailures"]),
            "limitations": ["This prospective interval answers an import-window question only; it is not a full-lifecycle memory result.",
                            "Epoch markers have Date.now precision; process scans are non-atomic and may miss peaks or short-lived processes.",
                            "Excluded and partially overlapping scans remain in the original whole-lifecycle receipt. No prior observation is requalified.",
                            "The post-finalization endpoint is a skipped post-commit marker, not a measured integrity-sampling operation.",
                            "No elapsed time from this sampled observation is performance evidence."]}
