#!/usr/bin/env python3
"""Deterministic analysis tests; these do not acquire an import or measure performance."""
import copy
import io
import unittest
import zipfile

import analyze


def frame(name, url="", line=0):
    return {"functionName": name, "url": url, "lineNumber": line, "columnNumber": 0}


def node(identity, name, parent=None, url=""):
    value = {"id": identity, "callFrame": frame(name, url)}
    if parent is not None:
        value["parent"] = parent
    return value


def profile_event(pid=1, identity="0x1", tid=7, start=100):
    return {"name": "Profile", "pid": pid, "id": identity, "tid": tid, "args": {"data": {"startTime": start}}}


def chunk(nodes, samples, deltas, pid=1, identity="0x1", tid=7, end=None, ts=1000):
    data = {"cpuProfile": {"nodes": nodes, "samples": samples}, "timeDeltas": deltas}
    if end is not None:
        data["endTime"] = end
    return {"name": "ProfileChunk", "pid": pid, "id": identity, "tid": tid, "ts": ts, "args": {"data": data}}


def parse(events):
    return analyze.parse_profiles({"traceEvents": events})


def uleb(value):
    result = bytearray()
    while True:
        byte = value & 127
        value >>= 7
        result.append(byte | (128 if value else 0))
        if not value:
            return bytes(result)


def wasm(export_name="parser"):
    name = export_name.encode()
    sections = [
        (1, b"\x01\x60\x00\x00"),             # one () -> () function type
        (3, b"\x02\x00\x00"),                 # two functions of that type
        (7, b"\x01" + uleb(len(name)) + name + b"\x00\x00"),
        (10, b"\x02\x02\x00\x0b\x02\x00\x0b") # two empty function bodies
    ]
    return b"\0asm\x01\0\0\0" + b"".join(bytes([kind]) + uleb(len(data)) + data for kind, data in sections)


class ProfileTests(unittest.TestCase):
    def test_identity_uses_pid_and_id_not_emitter_tid(self):
        profiles = parse([
            profile_event(), profile_event(pid=2),
            chunk([node(1, "(root)")], [1], [2], tid=99),
            chunk([node(2, "other")], [2], [3], pid=2),
            chunk([node(3, "leaf", 1)], [3], [4], tid=100)
        ])
        self.assertEqual(len(profiles), 2)
        self.assertEqual(profiles[0]["samples"], [1, 3])
        self.assertEqual(profiles[0]["tid"], 7)
        self.assertEqual(profiles[1]["samples"], [2])

    def test_chunks_sorted_before_delta_reconstruction_without_changing_raw_chunks(self):
        profile = parse([
            profile_event(),
            chunk([node(2, "later", 1)], [2], [20], ts=300),
            chunk([node(1, "earlier")], [1], [10], ts=200)
        ])[0]
        self.assertEqual([item["data"]["cpuProfile"]["samples"] for item in profile["rawChunks"]], [[2], [1]])
        self.assertEqual(profile["chunkMergeOrder"], [2, 1])
        self.assertEqual(profile["samples"], [1, 2])
        self.assertEqual(profile["rawDeltas"], [10, 20])
        weighted = analyze.weighted_samples(profile)
        self.assertEqual([item["timestampUs"] for item in weighted], [110, 130])
        self.assertEqual([item["adjacentWallUs"] for item in weighted], [20, 0])

    def test_negative_deltas_preserved_and_prefix_not_assigned(self):
        raw = [10, 20, -5, 15]
        profile = parse([profile_event(), chunk([node(1, "a"), node(2, "b")], [1, 2, 1, 2], raw, end=150)])[0]
        weighted = analyze.weighted_samples(profile)
        self.assertEqual(profile["rawDeltas"], raw)
        self.assertEqual([value["timestampUs"] for value in weighted], [110, 125, 130, 140])
        self.assertEqual([value["order"] for value in weighted], [0, 2, 1, 3])
        self.assertEqual([value["adjacentWallUs"] for value in weighted], [15, 5, 10, 0])
        self.assertEqual(sum(value["adjacentWallUs"] for value in weighted), 30)
        self.assertEqual([value["rawDeltaUs"] for value in weighted], [10, -5, 20, 15])

    def test_equal_timestamps_and_missing_end_are_retained(self):
        profile = parse([profile_event(), chunk([node(1, "a")], [1, 1, 1], [10, 0, 3])])[0]
        self.assertIsNone(profile["endTimeUs"])
        weighted = analyze.weighted_samples(profile)
        self.assertEqual([value["order"] for value in weighted], [0, 1, 2])
        self.assertEqual([value["adjacentWallUs"] for value in weighted], [0, 3, 0])

    def test_conflicting_node_and_duplicate_end_rejected(self):
        original = node(1, "a")
        changed = node(1, "b")
        with self.assertRaisesRegex(ValueError, "Conflicting CPU"):
            parse([profile_event(), chunk([original], [1], [1]), chunk([changed], [1], [1])])
        with self.assertRaisesRegex(ValueError, "Duplicate CPU profile end"):
            parse([profile_event(), chunk([original], [1], [1], end=103), chunk([], [], [], end=104)])

    def test_missing_nodes_cycles_and_conflicting_parent_rejected(self):
        cases = [
            ([node(1, "a", 99)], [1]),
            ([node(1, "a")], [99]),
            ([node(1, "a", 2), node(2, "b", 1)], [1]),
            ([dict(node(1, "a"), children=[2]), node(2, "b", 3), node(3, "c")], [2])
        ]
        for nodes, samples in cases:
            with self.subTest(nodes=nodes), self.assertRaises(ValueError):
                parse([profile_event(), chunk(nodes, samples, [1])])

    def test_matching_node_repeat_and_children_are_valid(self):
        root = dict(node(1, "root"), children=[2])
        leaf = node(2, "leaf", 1)
        profile = parse([profile_event(), chunk([root, leaf], [2], [1]),
                         chunk([copy.deepcopy(leaf)], [2], [1])])[0]
        self.assertEqual(profile["chains"][2], [2, 1])

    def test_role_is_source_bound_and_ambiguity_rejected(self):
        prefix = "chrome-extension://test/js/dictionary/"
        events = [profile_event(), chunk([node(1, "parse", url=prefix + "term-bank-wasm-parser-worker.js")], [1], [1])]
        self.assertEqual(parse(events)[0]["role"], "parser")
        events[1]["args"]["data"]["cpuProfile"]["nodes"].append(
            node(2, "compress", url=prefix + "zstd-term-content-compression-worker.js"))
        with self.assertRaisesRegex(ValueError, "Ambiguous profile role"):
            parse(events)

    def test_timeline_keeps_clock_domains_unmapped_and_retains_marks(self):
        harness = "\n".join([
            "await importTraceSession.send('Tracing.start', {",
            "const expectedTraceLogFragment = ",
            "await stopBrowserTraceToFile(traceSession, importTracePath);",
            "await importWorkerTraceStopPromise;",
            "const state = await evalSendMessage(page, 'benchmarkDictionaryState');",
            "for (const term of probeTerms) {"
        ])
        trace = {"traceEvents": [
            {"name": "mark", "cat": "blink.user_timing", "ts": 20, "pid": 1, "tid": 1},
            {"name": "TimeStamp", "ts": 10, "args": {"data": {"message": "kept"}}},
            {"name": "other", "ts": 25}
        ]}
        report = {"phases": [{"name": "total", "durationMs": 2, "details": "large unabridged data",
                              "data": {"browserTiming": {"start": 3, "end": 5}}}]}
        value = analyze.timeline_evidence(trace, report, {"runs": [{"elapsedMs": 2}]},
                                          "wrote worker import browser trace: a\n", harness,
                                          {"acquisition": {"traceBoundary": "original"}})
        self.assertFalse(value["timedImportClockWindowEstablished"])
        self.assertTrue(value["workerTraceStopLogObserved"])
        self.assertFalse(value["visibleCompletionFallbackLogObserved"])
        self.assertEqual([item["ts"] for item in value["traceTimestampAndUserTimingEvents"]], [10, 20])
        self.assertEqual(value["phaseSummaries"][0]["browserTiming"], {"start": 3, "end": 5})
        self.assertNotIn("details", value["phaseSummaries"][0])

    def test_wasm_exports_only_name_exact_indices(self):
        exports, sections = analyze.wasm_exports(wasm("parse"))
        self.assertEqual(exports, {0: ["parse"]})
        self.assertNotIn(1, exports)
        self.assertEqual([value["id"] for value in sections], [1, 3, 7, 10])
        with self.assertRaises(ValueError):
            analyze.wasm_exports(wasm()[:-1])


class SourceTests(unittest.TestCase):
    def fixture(self):
        paths = {
            "lib/term-bank-parser.wasm": wasm("parse"),
            "lib/term-content-canonical-scan-v1.wasm": wasm("scan"),
            "lib/zstd.wasm": wasm("compress"),
            "js/dictionary/term-bank-wasm-parser-worker.js": b"function worker() {}\n"
        }
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as archive:
            for name, data in paths.items():
                archive.writestr(name, data)
        return output.getvalue(), {"ext/" + name: analyze.digest(data) for name, data in paths.items()}

    def test_dynamic_ancestor_names_do_not_invent_internal_symbols(self):
        data, runtime = self.fixture()
        with analyze.checked_zip(io.BytesIO(data)) as package:
            source = analyze.SourceMap(package, runtime)
            url = "chrome-extension://test/js/dictionary/term-bank-wasm-parser-worker.js"
            profile = parse([profile_event(), chunk([
                node(1, "worker", url=url),
                node(2, "wasm-function[0]", 1, "wasm://wasm/test"),
                node(3, "wasm-function[1]", 2, "wasm://wasm/test")
            ], [3], [10])])[0]
            context = source.native_context(profile, profile["chains"][3])
            self.assertEqual(context["module"], "lib/term-bank-parser.wasm")
            self.assertEqual(context["exactExportNames"], [])
            self.assertEqual(context["nearestJsAncestor"]["functionDeclarationSourceLine"], "function worker() {}")
            self.assertEqual(context["nearestExportedAncestor"], {"functionIndex": 0, "exportNames": ["parse"]})
            result, _ = analyze.summarize_profile(profile, source, 100)
            self.assertEqual(result["sampleCount"], 1)
            self.assertEqual(result["adjacentWallSumUs"], 0)
            self.assertIsNone(result["explicitEndMinusLastSampleUs"])

    def test_packaged_source_hash_mismatch_is_fatal(self):
        data, runtime = self.fixture()
        runtime["ext/lib/term-bank-parser.wasm"] = "0" * 64
        with analyze.checked_zip(io.BytesIO(data)) as package, self.assertRaisesRegex(ValueError, "Packaged source differs"):
            analyze.SourceMap(package, runtime)

    def test_zip_path_safety_and_unique_member_are_enforced(self):
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as archive:
            archive.writestr("../trace.json", b"{}")
        with self.assertRaisesRegex(ValueError, "Unsafe ZIP"):
            analyze.checked_zip(io.BytesIO(output.getvalue()))
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as archive:
            archive.writestr("a/trace.json", b"{}")
            archive.writestr("b/trace.json", b"{}")
        with analyze.checked_zip(io.BytesIO(output.getvalue())) as archive, self.assertRaisesRegex(ValueError, "exactly one"):
            analyze.unique_suffix(archive, "trace.json")


if __name__ == "__main__":
    unittest.main()
