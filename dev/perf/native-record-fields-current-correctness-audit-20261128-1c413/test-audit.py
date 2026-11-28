#!/usr/bin/env python3
"""Pure read-only-auditor regressions. No product, browser, native or GitHub work."""
from copy import deepcopy
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

HERE = Path(__file__).parent
SPEC = importlib.util.spec_from_file_location("correctness_audit_cases", HERE / "audit.py")
assert SPEC is not None and SPEC.loader is not None
AUDIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDIT)
ACTIVATION = AUDIT.load_activation(HERE)


def empty_native():
    value = {key: 0 for key in ACTIVATION.NATIVE_COUNTERS}
    value["maximumLinearMemoryBytes"] = 131072
    value["declines"] = {}
    return value


def one_native_call(ordinal=0, prior=None, rows=8, unique=3, scores=2):
    """Synthetic format/counter input, not an original corpus observation."""
    before = deepcopy(prior) if prior is not None else {"calls": 0, "javascriptCalls": 0, "native": empty_native()}
    after = deepcopy(before)
    after["calls"] += 1
    native = after["native"]
    native["nativeCalls"] += 1
    native["nativeRows"] += rows
    native["nativeAttempts"] += 1
    native["inputCopiedBytes"] += rows * 8 + unique * 12
    native["outputCopiedBytes"] += 16 + scores * 4 + rows * 8
    # Fixed row8/unique3 fixture below has64 table bytes,112 scratch,131380 layout end.
    # Other fixtures use explicitly stated source-layout values in their own tests.
    if (rows, unique) != (8, 3):
        raise ValueError("Only the independently worked8-row fixture is supported here")
    native["tableBytesRequested"] += 64
    native["maximumScratchBytes"] = max(native["maximumScratchBytes"], 112)
    old_memory = native["maximumLinearMemoryBytes"]
    native["maximumLinearMemoryBytes"] = max(old_memory, 196608)
    native["memoryGrowthBytes"] += native["maximumLinearMemoryBytes"] - old_memory
    return {
        "ordinal": ordinal, "rowCount": rows, "contentOffsetBase": 0,
        "bytes": 16 + scores * 4 + rows * 8, "sha256": "1" * 64,
        "before": before, "after": after,
    }


def frozen_manifest():
    return {
        "schemaVersion": 1, "enabled": True,
        "publication": {"runId": AUDIT.RUN_ID, "headSha": AUDIT.CANDIDATE,
                        "headBranch": AUDIT.BRANCH, "attempt": 1},
        "source": {"baseline": AUDIT.BASELINE, "baselineTree": AUDIT.BASELINE_TREE,
                   "product": AUDIT.PRODUCT, "productTree": AUDIT.PRODUCT_TREE,
                   "candidate": AUDIT.CANDIDATE, "candidateTree": AUDIT.CANDIDATE_TREE},
        "jobs": {kind: {"id": job_id, "name": AUDIT.JOB_NAMES[kind], "conclusion": "success"}
                 for kind, job_id in AUDIT.JOB_IDS.items()},
        "artifacts": {
            kind: {
                "id": 100 + index, "sizeBytes": 10, "sha256": "2" * 64,
                "name": ("native-record-fields-correctness-" if kind == "validation"
                         else "native-record-fields-corpus-") + AUDIT.CANDIDATE,
            }
            for index, kind in enumerate(AUDIT.JOB_IDS)
        },
    }


class CorrectnessArchiveCases(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.serial = 0

    def tearDown(self):
        self.temp.cleanup()

    def archive(self, entries, members=None):
        self.serial += 1
        path = self.root / ("original-" + str(self.serial) + ".tar.gz")
        expected = {}
        with tarfile.open(path, "w:gz", format=tarfile.PAX_FORMAT) as target:
            for kind, name, value in entries:
                info = tarfile.TarInfo(name)
                if kind == "directory":
                    info.type = tarfile.DIRTYPE
                    target.addfile(info)
                    expected[name] = {"kind": "directory"}
                elif kind == "symlink":
                    info.type = tarfile.SYMTYPE
                    info.linkname = value
                    target.addfile(info)
                    expected[name] = {"kind": "symlink", "target": value}
                elif kind == "hardlink":
                    info.type = tarfile.LNKTYPE
                    info.linkname = value
                    target.addfile(info)
                    expected[name] = {"kind": "file", "bytes": 1, "sha256": AUDIT.digest(b"x")}
                elif kind == "fifo":
                    info.type = tarfile.FIFOTYPE
                    target.addfile(info)
                    expected[name] = {"kind": "file", "bytes": 0, "sha256": AUDIT.digest(b"")}
                else:
                    data = value
                    info.size = len(data)
                    if kind == "unknown-pax":
                        info.pax_headers = {"LIBARCHIVE.unreviewed": "yes"}
                    target.addfile(info, io.BytesIO(data))
                    expected[name] = {"kind": "file", "bytes": len(data), "sha256": AUDIT.digest(data)}
        receipt = {
            "kind": "complete-corpus-evidence-archive", "archive": AUDIT.TAR_NAME,
            "archiveBytes": path.stat().st_size, "archiveSha256": AUDIT.file_digest(path),
            "members": expected if members is None else members,
            "verified": True, "performanceMeasurements": False,
            "missingRequestedRoots": [],
        }
        return path, receipt

    def verify(self, path, receipt):
        return AUDIT.verify_tar(path, receipt, self.root / ("extracted-" + str(self.serial)))

    def test_pipe_hidden_unicode_and_all_raw_bytes_remain_verified(self):
        root = AUDIT.CORPUS_ROOT
        raw = root + "/acquisition/smoke-A/disk/root/dict|日本.mbtr"
        regular = root + "/.hidden-receipt.json"
        path, receipt = self.archive([
            ("directory", root, None), ("file", raw, b"complete raw\0payload"),
            ("file", regular, b'{"passed":false}\n'),
        ])
        result = self.verify(path, receipt)
        self.assertEqual(result["members"], receipt["members"])
        self.assertTrue(path.exists())
        self.assertFalse((self.root / "extracted-1" / raw).exists())
        self.assertEqual((self.root / "extracted-1" / regular).read_bytes(), b'{"passed":false}\n')

    def test_opaque_absolute_dangling_and_cycle_links_are_never_materialized(self):
        root = AUDIT.CORPUS_ROOT + "/acquisition/smoke-A/disk/root"
        outside = self.root / "outside"
        outside.write_bytes(b"unchanged")
        links = [("symlink", root + "/external", str(outside)),
                 ("symlink", root + "/dangling", "../missing"),
                 ("symlink", root + "/cycle", ".")]
        path, receipt = self.archive(links)
        result = self.verify(path, receipt)
        self.assertEqual(result["memberCount"], 3)
        self.assertEqual(outside.read_bytes(), b"unchanged")
        for _, name, _ in links:
            self.assertFalse((self.root / "extracted-1" / name).is_symlink())
            self.assertFalse((self.root / "extracted-1" / name).exists())

    def test_changed_outer_size_or_hash_is_rejected_before_extraction(self):
        path, receipt = self.archive([("file", AUDIT.CORPUS_ROOT + "/receipt.json", b"x")])
        for key, value in (("archiveBytes", receipt["archiveBytes"] + 1), ("archiveSha256", "0" * 64)):
            modified = deepcopy(receipt)
            modified[key] = value
            with self.subTest(key=key), self.assertRaisesRegex(AUDIT.AuditError, "tar identity"):
                self.verify(path, modified)
        self.assertFalse((self.root / "extracted-1").exists())

    def test_regular_payload_and_symlink_target_tampering_fail(self):
        root = AUDIT.CORPUS_ROOT
        path, receipt = self.archive([("file", root + "/file", b"original"),
                                      ("symlink", root + "/link", "../original")])
        changed = deepcopy(receipt)
        changed["members"][root + "/file"]["sha256"] = AUDIT.digest(b"tampered")
        with self.assertRaisesRegex(AUDIT.AuditError, "member bytes"):
            self.verify(path, changed)
        path, receipt = self.archive([("symlink", root + "/link", "../original")])
        receipt["members"][root + "/link"]["target"] = "../tampered"
        with self.assertRaisesRegex(AUDIT.AuditError, "opaque target"):
            self.verify(path, receipt)

    def test_unknown_duplicate_and_missing_members_are_rejected(self):
        name = AUDIT.CORPUS_ROOT + "/file"
        path, receipt = self.archive([("file", name, b"x"), ("file", name, b"x")])
        with self.assertRaisesRegex(AUDIT.AuditError, "duplicate"):
            self.verify(path, receipt)
        path, receipt = self.archive([("file", name, b"x")], {})
        with self.assertRaisesRegex(AUDIT.AuditError, "Unknown"):
            self.verify(path, receipt)
        path, receipt = self.archive([])
        receipt["members"][name] = {"kind": "file", "bytes": 1, "sha256": AUDIT.digest(b"x")}
        with self.assertRaisesRegex(AUDIT.AuditError, "Incomplete"):
            self.verify(path, receipt)

    def test_path_traversal_wrong_root_and_link_ancestor_collisions_are_rejected(self):
        root = AUDIT.CORPUS_ROOT
        for name in ("../escape", "/absolute", root + "//double", "elsewhere/file", root + "/../escape"):
            with self.subTest(name=name):
                path, receipt = self.archive([("file", name, b"x")])
                with self.assertRaises(AUDIT.AuditError):
                    self.verify(path, receipt)
        path, receipt = self.archive([
            ("symlink", root + "/link", "../anywhere"), ("file", root + "/link/child", b"x")])
        with self.assertRaisesRegex(AUDIT.AuditError, "collision"):
            self.verify(path, receipt)

    def test_tar_hardlinks_fifo_and_unreviewed_pax_are_rejected(self):
        for kind in ("hardlink", "fifo", "unknown-pax"):
            with self.subTest(kind=kind):
                value = "other" if kind == "hardlink" else b"x"
                path, receipt = self.archive([(kind, AUDIT.CORPUS_ROOT + "/item", value)])
                with self.assertRaises(AUDIT.AuditError):
                    self.verify(path, receipt)

    def test_member_schema_and_bounds_reject_extra_or_oversized_claims(self):
        name = AUDIT.CORPUS_ROOT + "/file"
        _, receipt = self.archive([("file", name, b"x")])
        for change in ({"bytes": AUDIT.MAX_MEMBER + 1}, {"bytes": True}, {"extra": 1}, {"sha256": "bad"}):
            modified = deepcopy(receipt)
            modified["members"][name].update(change)
            with self.subTest(change=change), self.assertRaises(AUDIT.AuditError):
                AUDIT.validate_tar_manifest(modified)
        modified = deepcopy(receipt)
        modified["missingRequestedRoots"] = ["elsewhere"]
        with self.assertRaises(AUDIT.AuditError):
            AUDIT.validate_tar_manifest(modified)

    def test_zip_directory_payload_and_traversal_rejected(self):
        for name, data in ((AUDIT.KIT + "/", b"not empty"), ("../escape", b"x")):
            path = self.root / ("bad-" + str(self.serial) + ".zip")
            self.serial += 1
            with zipfile.ZipFile(path, "w") as archive:
                archive.writestr(name, data)
            with self.subTest(name=name), self.assertRaises(AUDIT.AuditError):
                AUDIT.extract_zip(path, self.root / ("zip-out-" + str(self.serial)))

    def test_optional_bytecode_is_hash_verified_without_materializing(self):
        # The actual source sets PYTHONDONTWRITEBYTECODE=1; this is a bounded
        # adversarial retention case, not evidence that the original produced it.
        name = AUDIT.KIT + "/__pycache__/archive-evidence.cpython-314.pyc"
        payload = b"opaque bytecode, never load"
        path, receipt = self.archive([("file", name, payload)])
        verified = self.verify(path, receipt)
        self.assertEqual(verified["members"][name]["sha256"], AUDIT.digest(payload))
        self.assertFalse((self.root / "extracted-1" / name).exists())
        zip_path = self.root / "opaque.zip"
        with zipfile.ZipFile(zip_path, "w") as archive:
            archive.writestr(name, payload)
        members = AUDIT.extract_zip(zip_path, self.root / "opaque-zip")
        self.assertEqual(members[name]["sha256"], AUDIT.digest(payload))
        self.assertFalse((self.root / "opaque-zip" / name).exists())

    def test_tracked_sources_and_only_known_opaque_bytecode_are_bound(self):
        source_path = AUDIT.KIT + "/archive-evidence.py"
        generated_path = AUDIT.KIT + "/__pycache__/archive-evidence.cpython-314.pyc"
        corpus_generated = AUDIT.CORPUS + "/__pycache__/run-all.cpython-312.pyc"
        payloads = {source_path: b"# immutable\n", generated_path: b"opaque pyc", corpus_generated: b"more opaque"}
        members = {}
        for name, data in payloads.items():
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            members[name] = {"kind": "file", "bytes": len(data), "sha256": AUDIT.digest(data)}
        tree = {source_path: {"mode": "100644", "sha": AUDIT.git_blob(payloads[source_path])}}
        bound = AUDIT.bind_archived_sources(self.root, members, tree, {source_path})
        self.assertEqual(bound[source_path]["gitBlob"], tree[source_path]["sha"])
        self.assertTrue(bound[generated_path]["opaqueGeneratedBytecode"])
        self.assertFalse(bound[corpus_generated]["executedByReader"])
        unexpected = AUDIT.KIT + "/untracked.py"
        (self.root / unexpected).write_bytes(b"never execute")
        bad = deepcopy(members)
        bad[unexpected] = {"kind": "file"}
        with self.assertRaisesRegex(AUDIT.AuditError, "unbound"):
            AUDIT.bind_archived_sources(self.root, bad, tree, {source_path})
        with self.assertRaisesRegex(AUDIT.AuditError, "required"):
            AUDIT.bind_archived_sources(self.root, members, tree, {source_path, AUDIT.KIT + "/missing.py"})
        (self.root / source_path).write_bytes(b"# altered\n")
        with self.assertRaisesRegex(AUDIT.AuditError, "tracked source differs"):
            AUDIT.bind_archived_sources(self.root, members, tree, {source_path})


class CorrectnessCounterCases(unittest.TestCase):
    def test_native_layout_has_exact_worked_boundaries(self):
        self.assertEqual(AUDIT.native_layout(8, 3), {
            "uniqueReferences": 3, "scoreCapacity": 8, "slotCount": 16, "tableBytes": 64,
            "scratchBytes": 112, "requiredMemoryBytes": 196608, "layoutEnd": 131380,
        })
        self.assertEqual(AUDIT.native_layout(65535, 1)["slotCount"], 131072)
        self.assertEqual(AUDIT.native_layout(65536, 1)["scoreCapacity"], 65535)
        self.assertEqual(AUDIT.native_layout(5, 1)["layoutEnd"] % 4, 0)
        with self.assertRaisesRegex(AUDIT.AuditError, "memory cap"):
            AUDIT.native_layout(1, 10_000_000)

    def test_complete_successful_call_reconciles_bytes_scores_and_private_memory(self):
        call = one_native_call()
        result = AUDIT.counters([call], call["after"], {"termRows": 8}, ACTIVATION)
        self.assertEqual(result["actualCalls"][0]["compactScoreCount"], 2)
        self.assertEqual(result["actualCalls"][0]["nativeLayout"]["uniqueReferences"], 3)
        self.assertEqual(result["readinessCallsObserved"], 0)
        self.assertTrue(result["final"]["nativeActivated"])

    def test_natural_readiness_transition_and_ready_decline_are_preserved(self):
        first = {"ordinal": 0, "rowCount": 8, "contentOffsetBase": 0, "bytes": 88, "sha256": "1" * 64,
                 "before": {"calls": 0, "javascriptCalls": 0, "native": None},
                 "after": {"calls": 1, "javascriptCalls": 1, "native": None}}
        before = {"calls": 1, "javascriptCalls": 1, "native": empty_native()}
        second = one_native_call(1, before)
        third = deepcopy(second)
        third["ordinal"] = 2
        third["before"] = deepcopy(second["after"])
        third["after"] = deepcopy(third["before"])
        third["after"]["calls"] += 1
        third["after"]["javascriptCalls"] += 1
        third["after"]["native"]["declines"]["eligibility"] = 1
        result = AUDIT.counters([first, second, third], third["after"], {"termRows": 24}, ACTIVATION)
        self.assertEqual(result["readinessCallsObserved"], 1)
        self.assertEqual(result["final"]["declaredFallbackCalls"], 1)
        self.assertEqual(result["final"]["metrics"]["native"]["nativeCalls"], 1)

    def test_attempted_unsupported_compact_retains_copy_and_table_work(self):
        first = one_native_call()
        second = one_native_call(1, first["after"])
        second["after"]["javascriptCalls"] += 1
        second["after"]["native"]["nativeCalls"] -= 1
        second["after"]["native"]["nativeRows"] -= 8
        second["after"]["native"]["outputCopiedBytes"] -= 88
        second["after"]["native"]["declines"]["unsupported-compact"] = 1
        result = AUDIT.counters([first, second], second["after"], {"termRows": 16}, ACTIVATION)
        self.assertEqual(result["actualCalls"][1]["nativeLayout"]["tableBytes"], 64)
        self.assertIsNone(result["actualCalls"][1]["compactScoreCount"])
        self.assertEqual(result["final"]["declaredFallbackCalls"], 1)

    def test_missing_duplicate_or_reordered_calls_cannot_pass(self):
        first = one_native_call()
        second = one_native_call(1, first["after"])
        with self.assertRaisesRegex(AUDIT.AuditError, "row coverage"):
            AUDIT.counters([first], first["after"], {"termRows": 16}, ACTIVATION)
        for calls in ([second, first], [first, first]):
            with self.subTest(ordinals=[item["ordinal"] for item in calls]), self.assertRaises(AUDIT.AuditError):
                AUDIT.counters(calls, calls[-1]["after"], {"termRows": 16}, ACTIVATION)

    def test_counter_fabrication_and_between_call_mutation_are_rejected(self):
        first = one_native_call()
        for key, delta in (("inputCopiedBytes", 4), ("tableBytesRequested", 4),
                           ("maximumScratchBytes", 2), ("memoryGrowthBytes", 65536),
                           ("outputCopiedBytes", 4), ("nativeRows", 1), ("nativeAttempts", 1)):
            changed = deepcopy(first)
            changed["after"]["native"][key] += delta
            with self.subTest(key=key), self.assertRaises((AUDIT.AuditError, ACTIVATION.ActivationError)):
                AUDIT.counters([changed], changed["after"], {"termRows": 8}, ACTIVATION)
        second = one_native_call(1, first["after"])
        second["before"]["native"]["inputCopiedBytes"] += 12
        with self.assertRaisesRegex(AUDIT.AuditError, "between actual"):
            AUDIT.counters([first, second], second["after"], {"termRows": 16}, ACTIVATION)

    def test_unready_all_javascript_and_disabled_failure_are_not_activation_proof(self):
        call = {"ordinal": 0, "rowCount": 8, "contentOffsetBase": 0, "bytes": 88, "sha256": "1" * 64,
                "before": {"calls": 0, "javascriptCalls": 0, "native": None},
                "after": {"calls": 1, "javascriptCalls": 1, "native": None}}
        with self.assertRaises(ACTIVATION.ActivationError):
            AUDIT.counters([call], call["after"], {"termRows": 8}, ACTIVATION)
        first = one_native_call()
        second = deepcopy(first)
        second["ordinal"] = 1
        second["before"] = deepcopy(first["after"])
        second["after"] = deepcopy(second["before"])
        second["after"]["calls"] += 1
        second["after"]["javascriptCalls"] += 1
        second["after"]["native"]["declines"]["unavailable"] = 1
        with self.assertRaisesRegex(ACTIVATION.ActivationError, "failure/disabled"):
            AUDIT.counters([first, second], second["after"], {"termRows": 16}, ACTIVATION)

    def test_final_snapshot_cannot_hide_work_or_reset_counters(self):
        call = one_native_call()
        modified = deepcopy(call["after"])
        modified["calls"] += 1
        with self.assertRaisesRegex(AUDIT.AuditError, "Final detached"):
            AUDIT.counters([call], modified, {"termRows": 8}, ACTIVATION)

    def test_field_and_final_term_bytes_have_no_relaxed_normalization(self):
        call = one_native_call()
        self.assertEqual(AUDIT.field_identity([call])[0]["bytes"], 88)
        record = {"path": "dict|name.mbtr", "bytes": 100, "sha256": "1" * 64,
                  "normalizedSha256": "2" * 64, "termPayload": True,
                  "normalization": {"offset": 8, "bytes": 16, "format": "MBTRD16X"}}
        index = {**record, "path": "dict|name.mbti",
                 "normalization": {"offset": 24, "bytes": 16, "format": "MBTIDX11"}}
        content = {**record, "path": "content.bin", "normalization": None, "normalizedSha256": "1" * 64}
        self.assertEqual(len(AUDIT.term_inventory({"termFiles": [record, index, content]})), 3)
        for changed in ({**record, "normalization": {"offset": 8, "bytes": 20, "format": "MBTRD16X"}},
                        {**content, "normalizedSha256": "2" * 64}):
            with self.assertRaises(AUDIT.AuditError):
                AUDIT.term_inventory({"termFiles": [changed]})
        with self.assertRaisesRegex(AUDIT.AuditError, "inventory"):
            AUDIT.term_inventory({"termFiles": [record, record]})


class CorrectnessBoundaryCases(unittest.TestCase):
    def test_complete_runtime_delta_keeps_exact_five_entries(self):
        a = {"ordinary.js": {"bytes": 1, "sha256": "1" * 64}}
        b = deepcopy(a)
        for path in AUDIT.RUNTIME_DELTA:
            b[path] = {"bytes": 2, "sha256": "2" * 64}
        self.assertEqual(AUDIT.runtime_delta(a, b), sorted(AUDIT.RUNTIME_DELTA))
        extra = deepcopy(b)
        extra["library.js.map"] = {"bytes": 3, "sha256": "3" * 64}
        with self.assertRaisesRegex(AUDIT.AuditError, "five-entry"):
            AUDIT.runtime_delta(a, extra)
        missing = deepcopy(b)
        del missing[next(iter(AUDIT.RUNTIME_DELTA))]
        with self.assertRaisesRegex(AUDIT.AuditError, "five-entry"):
            AUDIT.runtime_delta(a, missing)

    def test_source_mode_and_critical_runtime_identity_are_required(self):
        # bind_runtime is exercised with a small frozen source map; no GitHub call occurs.
        sources = {"ext/legal-npm.html": b"legal", "ext/core.js": b"core",
                   "dev/data/dictionary-wasm/term-record-fields.wasm": b"wasm"}
        class StaticApi:
            def source(self, commit, path):
                return sources[path]
            def tree(self, commit):
                return {name: {} for name in sources}
        runtime = {
            "commit": "a" * 40, "tree": "b" * 40, "kit": {},
            "setupGeneratedLicense": {"path": "ext/legal-npm.html",
                "committed": {"bytes": 5, "sha256": AUDIT.digest(b"legal")},
                "generated": {"bytes": 5, "sha256": AUDIT.digest(b"legal")}, "listedTrackedDelta": False},
            "sources": {"ext/core.js": {"bytes": 4, "sha256": AUDIT.digest(b"core")},
                "ext/lib/term-record-fields.wasm": {"bytes": 4, "sha256": AUDIT.digest(b"wasm")},
                "ext/absent.js": None},
            "runtimeFiles": {"legal-npm.html": {"bytes": 5, "sha256": AUDIT.digest(b"legal")}},
        }
        AUDIT.bind_runtime(runtime, "a" * 40, "b" * 40, StaticApi(), {})
        for changed in ({"commit": "c" * 40}, {"tree": "d" * 40}, {"kit": {"unexpected": {}}}):
            with self.subTest(changed=changed), self.assertRaises(AUDIT.AuditError):
                AUDIT.bind_runtime({**runtime, **changed}, "a" * 40, "b" * 40, StaticApi(), {})
        bad = deepcopy(runtime)
        bad["sources"]["ext/lib/term-record-fields.wasm"]["sha256"] = "0" * 64
        with self.assertRaisesRegex(AUDIT.AuditError, "critical source"):
            AUDIT.bind_runtime(bad, "a" * 40, "b" * 40, StaticApi(), {})

    def test_generated_optional_wasm_checks_mapped_arm_source_before_fetch(self):
        baseline = "a" * 40
        candidate = "c" * 40
        legal = b"legal"
        parser = b"parser"
        fields = b"fields"
        native_path = "dev/data/dictionary-wasm/"
        data = {
            baseline: {"ext/legal-npm.html": legal,
                       native_path + "term-bank-parser.wasm": parser},
            candidate: {"ext/legal-npm.html": legal,
                        native_path + "term-bank-parser.wasm": parser,
                        native_path + "term-record-fields.wasm": fields},
        }
        fetched = []
        class StaticApi:
            def source(self, commit, path):
                fetched.append((commit, path))
                return data[commit][path]
            def tree(self, commit):
                return {name: {"mode": "100644"} for name in data[commit]}
        def receipt(commit):
            return {
                "commit": commit, "tree": "b" * 40, "kit": {},
                "setupGeneratedLicense": {
                    "path": "ext/legal-npm.html",
                    "committed": {"bytes": len(legal), "sha256": AUDIT.digest(legal)},
                    "generated": {"bytes": len(legal), "sha256": AUDIT.digest(legal)},
                    "listedTrackedDelta": False,
                },
                "sources": {
                    "ext/lib/term-bank-parser.wasm": {"bytes": len(parser), "sha256": AUDIT.digest(parser)},
                    "ext/lib/term-record-fields.wasm": (
                        None if commit == baseline else
                        {"bytes": len(fields), "sha256": AUDIT.digest(fields)}
                    ),
                },
                "runtimeFiles": {"legal-npm.html": {"bytes": len(legal), "sha256": AUDIT.digest(legal)}},
            }
        # The actual baseline records null for the absent optional generated asset.
        a = receipt(baseline)
        AUDIT.bind_runtime(a, baseline, "b" * 40, StaticApi(), {})
        self.assertNotIn((baseline, native_path + "term-record-fields.wasm"), fetched)
        self.assertIn((baseline, native_path + "term-bank-parser.wasm"), fetched)

        # Absence in Git cannot justify nonnull bytes, or waive a required tracked asset.
        forged_a = deepcopy(a)
        forged_a["sources"]["ext/lib/term-record-fields.wasm"] = {"bytes": len(fields), "sha256": AUDIT.digest(fields)}
        with self.assertRaisesRegex(AUDIT.AuditError, "Untracked optional source"):
            AUDIT.bind_runtime(forged_a, baseline, "b" * 40, StaticApi(), {})
        missing_parser = deepcopy(a)
        missing_parser["sources"]["ext/lib/term-bank-parser.wasm"] = None
        with self.assertRaisesRegex(AUDIT.AuditError, "critical source"):
            AUDIT.bind_runtime(missing_parser, baseline, "b" * 40, StaticApi(), {})

        b = receipt(candidate)
        AUDIT.bind_runtime(b, candidate, "b" * 40, StaticApi(), {})
        self.assertIn((candidate, native_path + "term-record-fields.wasm"), fetched)
        for changed in (None, {"bytes": len(fields), "sha256": "0" * 64}):
            bad_b = deepcopy(b)
            bad_b["sources"]["ext/lib/term-record-fields.wasm"] = changed
            with self.subTest(recorded=changed), self.assertRaisesRegex(AUDIT.AuditError, "critical source"):
                AUDIT.bind_runtime(bad_b, candidate, "b" * 40, StaticApi(), {})

    def test_crc_metrics_cover_only_metadata_admitted_deferred_groups(self):
        minimum = 4 * 1024 * 1024
        def group(total, compressed, banks=2):
            parts = ([{"uncompressedSize": total, "compressedSize": compressed}] if banks == 1 else
                     [{"uncompressedSize": total // 2, "compressedSize": compressed // 2},
                      {"uncompressedSize": total - total // 2, "compressedSize": compressed - compressed // 2}])
            return {"banks": parts, "rowCount": 10}
        groups = [
            group(minimum - 1, (minimum - 1) // 32),
            group(minimum, minimum // 32),
            group(minimum + 31, (minimum + 31) // 32),
            group(minimum, minimum // 32 + 1),
            group(2 * minimum, 1, banks=1),
        ]
        deferred = 2 * minimum + 31
        phases = [{"phase": "import-data-banks", "details": {
            "fastPathParserEffectiveExperiments": {
                "experimentalValidatedGlossaryReuse": True, "experimentalSkipFusedParse": False,
            },
        }}]
        counts = {
            "fastPathParserSourceCompressedBytes": sum(bank["compressedSize"] for g in groups for bank in g["banks"]),
            "fastPathParserSourceUncompressedBytes": sum(bank["uncompressedSize"] for g in groups for bank in g["banks"]),
            "fastPathParserSourceCrcScannedBytes": deferred - 128,
            "fastPathParserSourceCrcReusedBytes": 128,
            "fastPathParserSourceCrcReusedGlossaryCount": 2,
        }
        result = AUDIT.crc_coverage(phases, {"groups": groups}, counts)
        self.assertEqual([g["deferredCounterCoverage"] for g in result["groups"]],
                         [False, True, True, False, False])
        self.assertEqual(result["deferredCounterBytes"], deferred)
        self.assertEqual(result["immediateCrcBytesWithoutCounters"], 4 * minimum - 1)
        self.assertEqual(result["recordedScannedBytes"] + result["recordedReusedBytes"], deferred)
        for changes in (
            {"fastPathParserSourceCrcScannedBytes": counts["fastPathParserSourceCrcScannedBytes"] + 1},
            {"fastPathParserSourceCrcScannedBytes": counts["fastPathParserSourceUncompressedBytes"] - 128},
            {"fastPathParserSourceCompressedBytes": counts["fastPathParserSourceCompressedBytes"] + 1},
            {"fastPathParserSourceUncompressedBytes": counts["fastPathParserSourceUncompressedBytes"] + 1},
            {"fastPathParserSourceCrcReusedGlossaryCount": 21},
            {"fastPathParserSourceCrcReusedGlossaryCount": 0},
        ):
            with self.subTest(changes=changes), self.assertRaises(AUDIT.AuditError):
                AUDIT.crc_coverage(phases, {"groups": groups}, {**counts, **changes})

    def test_immediate_crc_zero_metrics_do_not_imply_unvalidated_input(self):
        groups = [{"banks": [{"compressedSize": 5, "uncompressedSize": 100},
                             {"compressedSize": 5, "uncompressedSize": 100}], "rowCount": 3}]
        details = {"fastPathParserEffectiveExperiments": {
            "experimentalValidatedGlossaryReuse": True, "experimentalSkipFusedParse": False}}
        phases = [{"phase": "import-data-banks", "details": details}]
        counts = {
            "fastPathParserSourceCompressedBytes": 10, "fastPathParserSourceUncompressedBytes": 200,
            "fastPathParserSourceCrcScannedBytes": 0, "fastPathParserSourceCrcReusedBytes": 0,
            "fastPathParserSourceCrcReusedGlossaryCount": 0,
        }
        result = AUDIT.crc_coverage(phases, {"groups": groups}, counts)
        self.assertEqual(result["deferredCounterBytes"], 0)
        self.assertEqual(result["immediateCrcBytesWithoutCounters"], 200)
        for effective in (None, {}, {"experimentalValidatedGlossaryReuse": False, "experimentalSkipFusedParse": False},
                          {"experimentalValidatedGlossaryReuse": True, "experimentalSkipFusedParse": True}):
            changed = [{"phase": "import-data-banks", "details": {"fastPathParserEffectiveExperiments": effective}}]
            with self.subTest(effective=effective), self.assertRaisesRegex(AUDIT.AuditError, "defaults"):
                AUDIT.crc_coverage(changed, {"groups": groups}, counts)
        with self.assertRaisesRegex(AUDIT.AuditError, "Deferred source CRC coverage"):
            AUDIT.crc_coverage(phases, {"groups": groups}, {**counts, "fastPathParserSourceCrcScannedBytes": 200})

    def test_crc_route_premises_are_bound_to_exact_original_source_bytes(self):
        source = {"ext/parser.js": b"pinned parser", AUDIT.CORPUS + "/run.mjs": b"pinned driver"}
        expected = {path: AUDIT.git_blob(data) for path, data in source.items()}
        entries = {path: {"path": path, "mode": "100644", "type": "blob", "sha": expected[path]}
                   for path in source}
        class StaticApi:
            def tree(self, commit):
                return entries if commit == AUDIT.CANDIDATE else {"ext/parser.js": entries["ext/parser.js"]}
            def source(self, commit, path):
                return source[path]
        with patch.object(AUDIT, "CRC_POLICY_SOURCES", expected):
            result = AUDIT.crc_policy_sources(StaticApi())
            self.assertEqual(set(result["sources"]), set(source))
            bad_entries = deepcopy(entries)
            bad_entries["ext/parser.js"]["sha"] = "0" * 40
            with patch.object(StaticApi, "tree", return_value=bad_entries):
                with self.assertRaisesRegex(AUDIT.AuditError, "policy binding"):
                    AUDIT.crc_policy_sources(StaticApi())
            with patch.object(StaticApi, "source", return_value=b"changed"):
                with self.assertRaisesRegex(AUDIT.AuditError, "policy bytes"):
                    AUDIT.crc_policy_sources(StaticApi())
            base_wrong = deepcopy(entries["ext/parser.js"])
            base_wrong["mode"] = "100755"
            def tree_with_base_drift(self, commit):
                return entries if commit == AUDIT.CANDIDATE else {"ext/parser.js": base_wrong}
            with patch.object(StaticApi, "tree", tree_with_base_drift):
                with self.assertRaisesRegex(AUDIT.AuditError, "A/B CRC"):
                    AUDIT.crc_policy_sources(StaticApi())

    def test_retirement_failure_and_digest_mismatch_remain_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            inventory = [{"path": "dict|name.mbtr", "bytes": 3, "sha256": AUDIT.digest(b"abc")}]
            AUDIT.write_json(root / "files.json", inventory)
            retired = {
                "retired": True, "everyRawByteRehashed": True, "rawFilesRetained": False,
                "files": {"dict|name.mbtr": {"bytes": 3, "sha256": AUDIT.digest(b"abc")}},
                "originalFinalizedInventory": AUDIT.identity(root / "files.json"),
            }
            AUDIT.write_json(root / "retired-disk.json", retired)
            self.assertFalse(AUDIT.verify_retirement(root)["rawFilesPresentForThisReader"])
            for change in ({"retired": False}, {"everyRawByteRehashed": False},
                           {"rawFilesRetained": True}, {"files": {}}):
                AUDIT.write_json(root / "retired-disk.json", {**retired, **change})
                with self.subTest(change=change), self.assertRaises(AUDIT.AuditError):
                    AUDIT.verify_retirement(root)

    def test_original_subprocess_exit_and_log_hash_are_not_summarized_away(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "A.log").write_bytes(b"original process output\n")
            value = {"exitCode": 0, "log": AUDIT.identity(root / "A.log"),
                     "argv": ["node", "/kit/" + AUDIT.CORPUS + "/run.mjs",
                              "/source", "jmdict", "/archive", "/out", "A", AUDIT.BASELINE]}
            AUDIT.write_json(root / "A.process.json", value)
            AUDIT.process_receipt(root, "A", AUDIT.CORPUS + "/run.mjs", "jmdict", "A", AUDIT.BASELINE)
            value["exitCode"] = 137
            AUDIT.write_json(root / "A.process.json", value)
            with self.assertRaisesRegex(AUDIT.AuditError, "subprocess"):
                AUDIT.process_receipt(root, "A", AUDIT.CORPUS + "/run.mjs")
            value["exitCode"] = 0
            AUDIT.write_json(root / "A.process.json", value)
            (root / "A.log").write_bytes(b"changed")
            with self.assertRaisesRegex(AUDIT.AuditError, "log hash"):
                AUDIT.process_receipt(root, "A", AUDIT.CORPUS + "/run.mjs")

    def test_inert_or_wrong_original_manifest_never_acquires(self):
        manifest = frozen_manifest()
        AUDIT.validate_manifest(manifest)
        for change in ({"enabled": False}, {"publication": {**manifest["publication"], "attempt": 2}},
                       {"publication": {**manifest["publication"], "headSha": "0" * 40}},
                       {"source": {**manifest["source"], "product": "0" * 40}}):
            with self.subTest(change=change), self.assertRaises(AUDIT.AuditError):
                AUDIT.validate_manifest({**manifest, **change})

    def test_fresh_output_and_partial_network_failure_preserve_frozen_input(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            destination = root / "audit"
            class FailingApi:
                repository = AUDIT.REPOSITORY
                def __init__(self):
                    self.output = destination
                    self.calls = 0
                def json(self, suffix, label):
                    self.calls += 1
                    raise AUDIT.AuditError("synthetic original API failure")
            api = FailingApi()
            with self.assertRaisesRegex(AUDIT.AuditError, "synthetic original"):
                AUDIT.audit_correctness(frozen_manifest(), destination, api)
            self.assertEqual(api.calls, 1)
            failure = AUDIT.read_json(destination / "reader-failure.json")
            self.assertFalse(failure["correctnessPassed"])
            self.assertFalse(failure["auditCompleted"])
            self.assertEqual(AUDIT.read_json(destination / "frozen-input.json"), frozen_manifest())
            with self.assertRaisesRegex(AUDIT.AuditError, "fresh"):
                AUDIT.audit_correctness(frozen_manifest(), destination, api)
            self.assertEqual(api.calls, 1)

    def test_prerequisite_never_seals_missing_or_failed_originals(self):
        manifest = frozen_manifest()
        validation = {"passed": True, "outcomeFile": {"sha256": "3" * 64}}
        comparisons = [
            {"dictionary": name, "passed": True,
             "comparisonFile": {"sha256": str(index + 4) * 64},
             "candidateReportFile": {"sha256": "7" * 64},
             "candidateFieldCallsFile": {"sha256": "8" * 64}}
            for index, name in enumerate(AUDIT.GROUPS)
        ]
        corpus = {"passed": True, "reportFile": {"sha256": "9" * 64}, "comparisons": comparisons}
        result = AUDIT.prerequisite_receipt(manifest, validation, corpus, {"helper": "a" * 64})
        self.assertTrue(result["passed"])
        self.assertEqual(result["product"], {"commit": AUDIT.PRODUCT, "tree": AUDIT.PRODUCT_TREE})
        self.assertEqual(set(result["perCorpus"]), set(AUDIT.GROUPS))
        self.assertEqual(result["validation"]["receiptSha256"], "3" * 64)
        self.assertFalse(AUDIT.prerequisite_receipt(manifest, {"passed": False}, corpus, {})["passed"])
        with self.assertRaisesRegex(AUDIT.AuditError, "corpus proof"):
            AUDIT.prerequisite_receipt(manifest, validation, {**corpus, "comparisons": comparisons[:2]}, {})

    def test_recorded_parser_results_bind_every_field_call_to_source_groups(self):
        def worker(job, bank, rows):
            return {
                "entry": "term-bank-wasm-parser-worker.js", "ready": 1, "failures": [],
                "parseRequests": [{"id": job, "banks": [{"filename": "term_bank_" + str(bank) + ".json",
                    "compressedSize": 10, "uncompressedSize": 100}], "sourceByteLengths": [10]}],
                "parseResults": [{"id": job, "rowCount": rows}],
            }
        first = worker(1, 1, 8)
        second = worker(1, 2, 16)
        calls = [{"rowCount": 8}, {"rowCount": 3}, {"rowCount": 13}]
        plan = AUDIT.group_field_plan([second, first], calls, 2, 24)
        self.assertEqual(plan["extraFieldCallsBeyondGroups"], 1)
        self.assertEqual(plan["groups"][1]["fieldCallRows"], [3, 13])
        self.assertEqual(plan["groups"][0]["firstBank"], 1)
        changed = deepcopy(first)
        changed["parseResults"] = []
        with self.assertRaisesRegex(AUDIT.AuditError, "unmatched"):
            AUDIT.group_field_plan([changed, second], calls, 2, 24)
        changed = deepcopy(second)
        changed["parseRequests"][0]["banks"][0]["filename"] = "term_bank_3.json"
        with self.assertRaisesRegex(AUDIT.AuditError, "gap or overlap"):
            AUDIT.group_field_plan([first, changed], calls, 2, 24)
        with self.assertRaisesRegex(AUDIT.AuditError, "crosses"):
            AUDIT.group_field_plan([first, second], [{"rowCount": 9}, {"rowCount": 15}], 2, 24)
        with self.assertRaisesRegex(AUDIT.AuditError, "Unattributed"):
            AUDIT.group_field_plan([first, second], calls + [{"rowCount": 1}], 2, 24)

    def test_exact_source_guard_inventory_and_before_after_assets_are_required(self):
        protected = AUDIT.PROTECTED_FIXED | {
            "dev/perf/import-memory-20261125-a7f7/module-" + str(index) + ".py" for index in range(10)
        }
        own = AUDIT.KIT + "/reader-fixture.py"
        source_path = AUDIT.KIT + "/source.json"
        paths = protected | {own, source_path, "ext/legal-npm.html"} | {
            "dev/data/dictionary-wasm/" + name for name in AUDIT.NATIVE_ASSETS
        }
        data = {path: path.encode() for path in paths}
        tree = {path: {"mode": "100644", "sha": AUDIT.git_blob(value), "type": "blob"}
                for path, value in data.items()}
        def source_identity(path):
            return {"gitBlob": tree[path]["sha"], "sha256": AUDIT.digest(data[path]),
                    "bytes": len(data[path]), "mode": "100644"}
        class StaticApi:
            def source(self, commit, path):
                return data[path]
            def tree(self, commit):
                return tree
        source = {"files": {own: source_identity(own)}, "digest": "4" * 64}
        proof = {
            "passed": True, "kind": "source-only-validation", "baseline": AUDIT.BASELINE,
            "candidate": AUDIT.CANDIDATE, "parent": AUDIT.PRODUCT, "productCommit": AUDIT.PRODUCT,
            "productParent": AUDIT.BASELINE, "tree": AUDIT.CANDIDATE_TREE,
            "timingAcquired": False, "productExecution": False, "sourceDigest": source["digest"],
            "changedPaths": sorted([own, source_path]),
            "sources": {path: source_identity(path) for path in (own, source_path)},
            "protected": {path: source_identity(path) for path in protected},
            "generatedAssets": {}, "setupGeneratedDocuments": {},
        }
        generated = {
            "ext/lib/" + name: {"bytes": len(data["dev/data/dictionary-wasm/" + name]),
                                "sha256": AUDIT.digest(data["dev/data/dictionary-wasm/" + name])}
            for name in AUDIT.NATIVE_ASSETS
        }
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "source.json"
            AUDIT.write_json(path, proof)
            self.assertTrue(AUDIT.source_proof(path, StaticApi(), source)["passed"])
            after = {**proof, "generatedAssets": generated}
            AUDIT.write_json(path, after)
            self.assertTrue(AUDIT.source_proof(path, StaticApi(), source, generated=True)["passed"])
            for change in ({"protected": {}}, {"changedPaths": []}, {"kind": "other"},
                           {"generatedAssets": generated}):
                AUDIT.write_json(path, {**proof, **change})
                with self.subTest(change=change), self.assertRaises(AUDIT.AuditError):
                    AUDIT.source_proof(path, StaticApi(), source)
            for change in ({}, {**generated, "ext/lib/unbound.wasm": {"bytes": 0, "sha256": "0" * 64}}):
                AUDIT.write_json(path, {**proof, "generatedAssets": change})
                with self.assertRaisesRegex(AUDIT.AuditError, "generated native"):
                    AUDIT.source_proof(path, StaticApi(), source, generated=True)
            bad = deepcopy(generated)
            bad["ext/lib/term-record-fields.wasm"]["sha256"] = "0" * 64
            AUDIT.write_json(path, {**proof, "generatedAssets": bad})
            with self.assertRaisesRegex(AUDIT.AuditError, "generated native"):
                AUDIT.source_proof(path, StaticApi(), source, generated=True)

    def test_success_requires_every_original_validation_log_but_failure_stays_readable(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            base = root / AUDIT.VALIDATION_ROOT
            base.mkdir(parents=True)
            for name in ("source-before-setup.json", "source-after-setup.json"):
                AUDIT.write_json(base / name, {})
            value = {
                "required": list(AUDIT.REQUIRED_STEPS), "failed": [], "passed": True,
                "performanceMeasurements": False,
                "steps": {key: {"outcome": "success", "conclusion": "success"} for key in AUDIT.REQUIRED_STEPS},
            }
            AUDIT.write_json(base / "step-outcomes.json", value)
            job = {"conclusion": "success", "steps": [
                {"name": name, "conclusion": "success"} for name in AUDIT.REQUIRED_STEPS.values()]}
            for name in AUDIT.VALIDATION_LOGS:
                (base / name).write_bytes(b"original gate output\n")
            with patch.object(AUDIT, "source_proof", return_value={"passed": True}):
                self.assertTrue(AUDIT.audit_validation(root, job, None, {})["passed"])
                (base / "unit.log").unlink()
                with self.assertRaisesRegex(AUDIT.AuditError, "validation log"):
                    AUDIT.audit_validation(root, job, None, {})
                value["steps"]["unit"] = {"outcome": "failure", "conclusion": "failure"}
                value["failed"] = ["unit"]
                value["passed"] = False
                AUDIT.write_json(base / "step-outcomes.json", value)
                job["conclusion"] = "failure"
                for step in job["steps"]:
                    if step["name"] == AUDIT.REQUIRED_STEPS["unit"]:
                        step["conclusion"] = "failure"
                result = AUDIT.audit_validation(root, job, None, {})
                self.assertFalse(result["passed"])
                self.assertEqual(result["missingLogs"], ["unit.log"])


if __name__ == "__main__":
    unittest.main()
