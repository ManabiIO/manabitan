"""Small protocol tests; these never launch Chromium or import a dictionary."""

import copy
import hashlib
import pathlib
import subprocess
import unittest

import analyze
import instrument


def timeline(next_ready=18):
    groups = [{"run": 0, "group": i, "rowCount": 10, "uniqueCount": 10, "mediaRows": 0,
               "sourceBytes": 1000, "ownedContentBytes": 500, "borrowsWorkerMemory": False,
               "resultFinishedAtMs": ready} for i, ready in enumerate((0, next_ready))]
    events = []

    def mark(group, event, at, **details):
        events.append({"run": 0, "group": group, "event": event, "atMs": at, "details": details})

    for group, offset, ready, canonical in ((0, 0, 0, 5), (1, 59, next_ready, 10)):
        mark(group, "group-ready", ready)
        mark(group, "sink-enter", offset + 1)
        mark(group, "dedup-start", offset + 2)
        mark(group, "canonical-start", offset + 3)
        mark(group, "canonical-end", offset + 3 + canonical, canonicalMs=canonical, exactMs=0, pendingCount=10)
        mark(group, "dedup-end", offset + 4 + canonical)
        delta = offset + canonical - 5
        mark(group, "content-storage-ready", delta + 10, early=True)
        mark(group, "metadata-published", delta + 11, early=True)
        mark(group, "record-start", delta + 12)
        mark(group, "record-validation-start", delta + 13, runStart=0)
        mark(group, "record-validation-end", delta + 14, runStart=0, rows=5)
        mark(group, "record-encode-start", delta + 15, rows=5)
        mark(group, "record-encode-end", delta + 16, rows=5)
        mark(group, "lookahead-gate", delta + 17)
        mark(group, "record-validation-start", delta + 20, runStart=5)
        mark(group, "record-validation-end", delta + 24, runStart=5, rows=5)
        mark(group, "record-encode-start", delta + 25, rows=5)
        mark(group, "record-encode-end", delta + 28, rows=5)
        mark(group, "content-done", delta + 45)
        mark(group, "record-done", delta + 50)
        mark(group, "join-done", delta + 51)
        mark(group, "sink-exit", delta + 52)
    events.sort(key=lambda e: e["atMs"])
    for i, event in enumerate(events):
        event["sequence"] = i
    return {"schemaVersion": 1, "authoritativeTiming": False, "recorderErrors": 0, "droppedEvents": 0,
            "unboundEvents": {}, "timeOriginMs": 1000,
            "runs": [{"run": 0, "groupCount": 2, "workerCount": 1, "startedAtMs": 0}],
            "groups": groups, "events": events}


def resequence(data):
    for i, event in enumerate(data["events"]):
        event["sequence"] = i


def acquisition():
    files = {p: {"beforeSha256": value, "afterSha256": hashlib.sha256(p.encode()).hexdigest(),
                 "markerCount": 2, "inverseByteProof": p in instrument.PRODUCT_PATHS}
             for p, value in instrument.SOURCES.items()}
    manifest = {"baseline": instrument.BASE, "scope": instrument.SCOPE, "files": files,
                "runtime": {"path": instrument.RUNTIME, "sha256": "a" * 64},
                "unchangedInputs": {"package-lock.json": "b" * 64}}
    entries = {p.removeprefix("ext/"): files[p]["afterSha256"] for p in instrument.PRODUCT_PATHS}
    entries[instrument.RUNTIME.removeprefix("ext/")] = "a" * 64
    receipt = {"baseline": instrument.BASE, "sourceVerified": True,
               "package": {"sha256": "c" * 64, "entries": entries}}
    base_validation = {"title": analyze.FIXTURE["expectedTitle"], "revision": analyze.FIXTURE["revision"],
                       "termRows": analyze.FIXTURE["termRows"], "contentReadable": True, "probeCount": 12}
    validation = {**base_validation, "probeTerms": analyze.PROBES, "outputDigestSha256": analyze.OUTPUT_DIGEST,
                  "restart": {**base_validation, "mediaFiles": 0},
                  "media": {"mode": "sample", "totalFiles": 0, "totalBytes": 0, "files": 0, "bytes": 0,
                            "sha256": hashlib.sha256(b"").hexdigest()},
                  "lookup": {"observations": [{"pass": p, "term": term, "hasExactHeadwordMatch": True,
                                                "results": 1, "elapsedMs": 1, "sha256": hashlib.sha256(term.encode()).hexdigest()}
                                               for p in range(6) for term in analyze.PROBES]}}
    run = {"index": 1, "packageSha256": "c" * 64, "tracePath": None, "validation": validation,
           "importDebug": {"hasResult": True, "errorCount": 0, "addSettingsErrorCount": 0, "usesFallbackStorage": False}}
    summary = {"schemaVersion": 3, "dictionary": "jmdict", "fixture": analyze.FIXTURE,
               "buildTarget": "chrome", "authoritativeTiming": False, "diagnosticScope": instrument.SCOPE,
               "traceEnabled": False, "importFlags": None, "mediaCheck": "sample", "gitSha": instrument.BASE,
               "source": {"gitSha": instrument.BASE, "dirty": True,
                          "sha256": {"package-lock.json": "b" * 64, "builds/manabitan-chrome.zip": "c" * 64,
                                     "dev/perf/import-benchmark.js": files["dev/perf/import-benchmark.js"]["afterSha256"]}},
               "runs": [run]}
    return summary, manifest, receipt


class IntervalTests(unittest.TestCase):
    def test_union_counts_overlaps_once_and_clips(self):
        self.assertEqual(analyze.union_length([(0, 8), (2, 5), (7, 12), (14, 16)], 3, 15), 10)
        self.assertEqual(analyze.union_length([(0, 1), (20, 30)], 3, 15), 0)

    def test_next_ready_before_gate_uses_gate_and_subtracts_cpu(self):
        result = analyze.analyze_timeline(timeline(next_ready=8), 20)
        pair = result["pairs"][0]
        self.assertEqual(pair["apparentWindowMs"], 34)
        self.assertEqual(pair["knownRecordCpuMs"], 7)
        self.assertEqual(pair["residualWindowCeilingMs"], 27)
        self.assertEqual(pair["canonicalWorkOverlapCeilingMs"], 10)
        self.assertEqual(result["totals"]["firstGroupCanonicalCounterMsExcluded"], 5)

    def test_next_ready_during_tail_caps_work(self):
        pair = analyze.analyze_timeline(timeline(next_ready=43), 20)["pairs"][0]
        self.assertEqual(pair["apparentWindowMs"], 8)
        self.assertEqual(pair["knownRecordCpuMs"], 0)
        self.assertEqual(pair["canonicalWorkOverlapCeilingMs"], 8)
        self.assertEqual(pair["wholePreparationOverlapCeilingMs"], 8)

    def test_next_ready_during_cpu_subtracts_only_remaining_part(self):
        pair = analyze.analyze_timeline(timeline(next_ready=22), 20)["pairs"][0]
        self.assertEqual(pair["apparentWindowMs"], 29)
        self.assertEqual(pair["knownRecordCpuMs"], 5)

    def test_next_ready_after_join_has_no_window(self):
        pair = analyze.analyze_timeline(timeline(next_ready=55), 20)["pairs"][0]
        self.assertEqual(pair["residualWindowCeilingMs"], 0)
        self.assertEqual(pair["canonicalWorkOverlapCeilingMs"], 0)

    def test_non_early_storage_is_explicitly_ineligible(self):
        data = timeline()
        data["events"] = [e for e in data["events"] if not (e["group"] == 0 and e["event"] in ("lookahead-gate", "content-done", "join-done"))]
        for event in data["events"]:
            if event["group"] == 0 and event["event"] in ("content-storage-ready", "metadata-published"):
                event["details"]["early"] = False
        resequence(data)
        pair = analyze.analyze_timeline(data, 20)["pairs"][0]
        self.assertFalse(pair["eligible"])
        self.assertEqual(pair["residualWindowCeilingMs"], 0)

    def test_missing_duplicate_and_reversed_marks_are_rejected(self):
        mutations = []
        missing = timeline()
        missing["events"] = [e for e in missing["events"] if not (e["event"] == "canonical-end" and e["group"] == 0)]
        resequence(missing)
        mutations.append(missing)
        duplicate = timeline()
        duplicate["events"].insert(1, copy.deepcopy(duplicate["events"][0]))
        resequence(duplicate)
        mutations.append(duplicate)
        reversed_marks = timeline()
        reversed_marks["events"][1]["atMs"] = 100
        mutations.append(reversed_marks)
        unmatched = timeline()
        unmatched["events"] = [e for e in unmatched["events"] if not (e["event"] == "record-encode-end" and e["group"] == 0)]
        resequence(unmatched)
        mutations.append(unmatched)
        for data in mutations:
            with self.subTest(data=data), self.assertRaises(ValueError):
                analyze.analyze_timeline(data, 20)

    def test_recorder_loss_and_aggregate_disagreement_are_rejected(self):
        for key, value in (("recorderErrors", 1), ("droppedEvents", 1), ("unboundEvents", {"record-start": 1})):
            data = timeline()
            data[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                analyze.analyze_timeline(data, 20)
        with self.assertRaises(ValueError):
            analyze.analyze_timeline(timeline(), 20, {"rows": 20, "parserParallelGroupCount": 99})


class ProvenanceTests(unittest.TestCase):
    def test_valid_acquisition(self):
        summary, manifest, receipt = acquisition()
        self.assertEqual(analyze.validate_acquisition(summary, manifest, receipt)["index"], 1)

    def test_authoritative_fixture_flags_and_package_drift_are_rejected(self):
        for target, key, value in (("summary", "authoritativeTiming", True), ("summary", "fixture", {}),
                                   ("summary", "importFlags", "{}"), ("receipt", "sourceVerified", False)):
            summary, manifest, receipt = acquisition()
            {"summary": summary, "receipt": receipt}[target][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                analyze.validate_acquisition(summary, manifest, receipt)
        summary, manifest, receipt = acquisition()
        receipt["package"]["entries"][instrument.RUNTIME.removeprefix("ext/")] = "d" * 64
        with self.assertRaises(ValueError):
            analyze.validate_acquisition(summary, manifest, receipt)

    def test_restart_and_duplicate_lookup_failure_are_rejected(self):
        summary, manifest, receipt = acquisition()
        summary["runs"][0]["validation"]["restart"]["termRows"] -= 1
        with self.assertRaises(ValueError):
            analyze.validate_acquisition(summary, manifest, receipt)
        summary, manifest, receipt = acquisition()
        observations = summary["runs"][0]["validation"]["lookup"]["observations"]
        observations[1] = copy.deepcopy(observations[0])
        with self.assertRaises(ValueError):
            analyze.validate_acquisition(summary, manifest, receipt)


class SourceGuardTests(unittest.TestCase):
    def test_every_frozen_source_anchor_and_inverse_byte_proof(self):
        # CI runs at the exact product checkout; local validation may run from
        # a descendant. In both cases read the immutable git object, not HEAD.
        root = pathlib.Path.cwd()
        for path in instrument.SOURCES:
            source = subprocess.check_output(["git", "-C", str(root), "show", f"{instrument.BASE}:{path}"]).decode()
            changed = instrument.instrument_source(path, source)
            with self.subTest(path=path):
                self.assertNotEqual(changed, source)
                if path in instrument.PRODUCT_PATHS:
                    self.assertEqual(instrument.BLOCK.sub("", changed), source)
                with self.assertRaises(ValueError):
                    instrument.instrument_source(path, source + "\n")

    def test_ambiguous_or_absent_anchor_rejected(self):
        for source in ("none", "a a"):
            with self.assertRaises(ValueError):
                instrument.replace_once(source, "a", "marker a")


if __name__ == "__main__":
    unittest.main()
