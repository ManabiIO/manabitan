#!/usr/bin/env python3
"""Focused byte-audit protocol and provenance regressions; no browser workload.

Copyright (C) 2026 Manabitan authors
SPDX-License-Identifier: GPL-3.0-or-later
"""

import base64
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest


ROOT = Path(__file__).resolve().parent


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


audit = load("storage_audit", "compare-storage-byte-audits.py")
install = load("storage_install", "install-storage-byte-audit.py")
RECORD = "manabitan-term-records/dict-fixture.mbtr"
LOOKUP = RECORD + ".mbti"


def payloads(seed=1):
    generation = bytes((seed + i) % 256 for i in range(16))
    name = b"raw-block-v2:jmdict"
    record = b"MBTRD16X" + generation + ((len(name) << 8) | 255).to_bytes(2, "little") + name
    lookup = b"MBTIDX11" + len(record).to_bytes(8, "little") + (1).to_bytes(4, "little") + (3).to_bytes(4, "little") + generation + b"payload-and-checksum-unchanged".ljust(40, b"\0")
    return {"manabitan-term-content.bin": b"complete content", RECORD: record, LOOKUP: lookup}


def receipt(files):
    entries = []
    for path, data in files.items():
        entry = {"path": path, "bytes": len(data)}
        ranges = []
        if path == RECORD:
            entry["identityHeader"] = {"format": "MBTRD16X", "hex": data.hex()}
            ranges = [{"offset": 8, "bytes": 16}]
        elif path == LOOKUP:
            entry["identityHeader"] = {"format": "MBTIDX11", "hex": data[:40].hex()}
            ranges = [{"offset": 24, "bytes": 16}]
        chunks = []
        for offset in range(0, len(data), audit.CHUNK_BYTES):
            source = data[offset:offset + audit.CHUNK_BYTES]
            normalized = bytearray(source)
            for span in ranges:
                start, end = max(offset, span["offset"]), min(offset + len(source), span["offset"] + span["bytes"])
                if start < end:
                    normalized[start - offset:end - offset] = bytes(end - start)
            chunks.append({"offset": offset, "bytes": len(source), "sha256": hashlib.sha256(source).hexdigest(), "normalizedSha256": hashlib.sha256(normalized).hexdigest()})
        entry["byteAudit"] = {"algorithm": audit.ALGORITHM, "chunkBytes": audit.CHUNK_BYTES, "ranges": ranges, "chunks": chunks}
        entries.append(entry)
    return {"termRows": 3, "storage": {"kind": audit.AUDIT_KIND, "bytes": sum(len(data) for data in files.values()), "files": entries}}


class ByteAuditTests(unittest.TestCase):
    def test_only_generation_identity_varies(self):
        left = audit.audited_files(receipt(payloads(1)))
        right = audit.audited_files(receipt(payloads(80)))
        self.assertNotEqual(left, right)
        self.assertEqual(audit.comparison_files(left), audit.comparison_files(right))
        changed = payloads(80)
        changed[LOOKUP] = changed[LOOKUP][:-1] + b"!"
        self.assertNotEqual(audit.comparison_files(left), audit.comparison_files(audit.audited_files(receipt(changed))))

    def test_header_and_coverage_fail_closed(self):
        base = receipt(payloads())
        changes = [
            lambda x: x["storage"]["files"][1]["identityHeader"].update(format="MBTRD15X"),
            lambda x: x["storage"]["files"][1]["identityHeader"].update(hex="00" * 45),
            lambda x: x["storage"]["files"][1]["byteAudit"].update(ranges=[{"offset": 8, "bytes": 17}]),
            lambda x: x["storage"]["files"][2]["identityHeader"].update(hex=(payloads(20)[LOOKUP][:40]).hex()),
            lambda x: x["storage"]["files"][0]["byteAudit"]["chunks"][0].update(offset=1),
            lambda x: x["storage"]["files"][0]["byteAudit"]["chunks"].clear(),
            lambda x: x["storage"]["files"][0]["byteAudit"]["chunks"].append(copy.deepcopy(x["storage"]["files"][0]["byteAudit"]["chunks"][0])),
            lambda x: x["storage"]["files"][0]["byteAudit"]["chunks"][0].update(sha256="not-a-hash"),
            lambda x: x["storage"]["files"][0]["byteAudit"]["chunks"][0].update(normalizedSha256="0" * 64),
            lambda x: x["storage"]["files"][1]["byteAudit"]["chunks"][0].update(normalizedSha256="0" * 64),
            lambda x: x["storage"].update(bytes=x["storage"]["bytes"] + 1),
            lambda x: x.update(termRows=4),
            lambda x: x["storage"]["files"][0].update(path="manabitan-dictionary-media-v1/example.bin"),
        ]
        for index, change in enumerate(changes):
            with self.subTest(index=index):
                value = copy.deepcopy(base)
                change(value)
                with self.assertRaises((ValueError, UnicodeDecodeError)):
                    audit.audited_files(value)
        missing = copy.deepcopy(base)
        removed = missing["storage"]["files"].pop(1)
        missing["storage"]["bytes"] -= removed["bytes"]
        with self.assertRaisesRegex(ValueError, "pairs"):
            audit.audited_files(missing)

    def test_js_observer_hashes_every_byte_and_preserves_pair_checks(self):
        files = payloads()
        files["manabitan-term-content.bin"] = b"x" * (audit.CHUNK_BYTES + 7)
        encoded = {path: base64.b64encode(data).decode() for path, data in files.items()}
        observer = """async function observe(root) {
            const files = [];
            const visit = async (directory, prefix) => {
                for await (const [name, handle] of directory.entries()) {
                    const filePath = `${prefix}${name}`;
        """ + install.NEW_VISIT + """
                }
            };
            await visit(root, '');
        """ + install.NEW_RETURN + "\n}"
        script = """import assert from 'node:assert/strict';
            function directory() { return {kind: 'directory', children: new Map(), async *entries() { yield* this.children; }}; }
            function rootFor(encoded) {
                const root = directory();
                for (const [path, value] of Object.entries(encoded)) {
                    const parts = path.split('/');
                    let cursor = root;
                    for (const part of parts.slice(0, -1)) {
                        if (!cursor.children.has(part)) { cursor.children.set(part, directory()); }
                        cursor = cursor.children.get(part);
                    }
                    const file = new File([Buffer.from(value, 'base64')], parts.at(-1), {lastModified: 123});
                    cursor.children.set(parts.at(-1), {kind: 'file', async getFile() { return file; }});
                }
                return root;
            }
        """ + observer + "\nconst encoded = " + json.dumps(encoded) + ";\n" + """
            const result = await observe(rootFor(encoded));
            const changed = {...encoded};
            const lookup = Object.keys(changed).find((path) => path.endsWith('.mbti'));
            const bytes = Buffer.from(changed[lookup], 'base64'); bytes[24] ^= 1;
            changed[lookup] = bytes.toString('base64');
            await assert.rejects(observe(rootFor(changed)), /generation/);
            await assert.rejects(observe(rootFor({...encoded, 'manabitan-dictionary-media-v1/test.bin': 'AA=='})), /media/);
            console.log(JSON.stringify(result));
        """
        result = subprocess.run(["node", "--input-type=module"], input=script, text=True, capture_output=True, check=True)
        observed = {"termRows": 3, "storage": json.loads(result.stdout)}
        self.assertEqual(audit.audited_files(observed), audit.audited_files(receipt(files)))

    def test_report_independence_and_pinned_provenance(self):
        with tempfile.TemporaryDirectory(prefix="manabitan-byte-audit-test-") as temporary:
            root = Path(temporary)
            fixture = {"expectedTitle": "JMdict fixture", "revision": "fixture.1", "termRows": 3}
            lock = root / "lock.json"
            lock.write_text(json.dumps({"dictionaries": {"jmdict": fixture}}))
            instrument = {"sourceHarnessSha256": audit.SOURCE_HARNESS_SHA256, "patchedHarnessSha256": "c" * 64, "installerSha256": "d" * 64, "fixtureLockSha256": hashlib.sha256(lock.read_bytes()).hexdigest(), "excludedPrefix": audit.EXCLUDED_PREFIX, "normalization": audit.NORMALIZATION, "kind": audit.AUDIT_KIND, "algorithm": audit.ALGORITHM, "chunkBytes": audit.CHUNK_BYTES}
            manifest = root / "instrumentation.json"
            manifest.write_text(json.dumps(instrument))
            paths = [root / f"report-{i}.json" for i in range(4)]
            reports = []
            for i, path in enumerate(paths):
                validation = receipt(payloads(i + 1))
                validation.update(title=fixture["expectedTitle"], revision=fixture["revision"], contentReadable=True, probeCount=12, outputDigestSha256="e" * 64, media={"mode": "all", "files": 0, "bytes": 0, "totalFiles": 0, "totalBytes": 0, "sha256": hashlib.sha256(b"").hexdigest()})
                validation["probeTerms"] = [f"p{j}" for j in range(12)]
                validation["lookup"] = {"observations": [{"term": term, "pass": k, "originalTextLength": len(term), "hasExactHeadwordMatch": True, "results": 1, "sha256": "e" * 64} for term in validation["probeTerms"] for k in range(6)]}
                validation["restart"] = {key: validation[key] for key in ("title", "revision", "termRows", "contentReadable", "probeCount")}
                validation["restart"]["mediaFiles"] = 0
                report = {"status": "success", "skippedVerification": False, "startedAtIso": f"2026-11-28T00:00:0{i}.000Z", "packageSha256": ("a" if i < 2 else "b") * 64, "byteAuditProvenance": {key: instrument[key] for key in ("sourceHarnessSha256", "patchedHarnessSha256", "installerSha256", "fixtureLockSha256")}, "benchmark": {"dictionary": "jmdict", "pinnedDictionaries": True, "mediaCheck": "all", "validation": validation}}
                reports.append(report)
                path.write_text(json.dumps(report))
            args = SimpleNamespace(baseline=paths[:2], candidate=paths[2:], instrumentation=manifest, fixture_lock=lock, expected_baseline_package_sha256="a" * 64, expected_candidate_package_sha256="b" * 64, expected_patched_harness_sha256="c" * 64, require_lookahead=False)
            self.assertEqual(audit.compare(args)["status"], "passed")
            duplicate = copy.copy(args)
            duplicate.baseline = [paths[0], paths[0]]
            with self.assertRaisesRegex(ValueError, "distinct"):
                audit.compare(duplicate)
            changes = [
                lambda x: x.update(startedAtIso=reports[0]["startedAtIso"]),
                lambda x: x.update(packageSha256="f" * 64),
                lambda x: x["byteAuditProvenance"].update(patchedHarnessSha256="f" * 64),
                lambda x: x["benchmark"]["validation"]["restart"].update(termRows=4),
                lambda x: x["benchmark"]["validation"]["lookup"]["observations"].pop(),
                lambda x: x["benchmark"]["validation"]["lookup"]["observations"][0].update(sha256="f" * 64),
            ]
            for change in changes:
                invalid = copy.deepcopy(reports[3])
                change(invalid)
                paths[3].write_text(json.dumps(invalid))
                with self.assertRaises(ValueError):
                    audit.compare(args)
            paths[3].write_text(json.dumps(reports[3]))
            args.expected_patched_harness_sha256 = "f" * 64
            with self.assertRaisesRegex(ValueError, "provenance"):
                audit.compare(args)
            args.expected_patched_harness_sha256 = "c" * 64
            args.require_lookahead = True
            for i, report in enumerate(reports):
                report["benchmark"]["importFlags"] = {"experimentalTermContentLookahead": True} if i >= 2 else None
                counters = {"contentLookaheadPreparedCount": 11, "contentLookaheadCompressionCount": 11} if i >= 2 else {}
                report["phases"] = [{"name": "JMdict: total import", "data": {"importDebug": {"hasResult": True, "resultTitle": fixture["expectedTitle"], "errorCount": 0, "addSettingsErrorCount": 0, "usesFallbackStorage": False, "importerPhaseTimings": [{"phase": "term-file-fast-path:fixture", "details": counters}]}}}]
                paths[i].write_text(json.dumps(report))
            self.assertEqual(audit.compare(args)["status"], "passed")
            reports[3]["phases"][0]["data"]["importDebug"]["importerPhaseTimings"][0]["details"].clear()
            paths[3].write_text(json.dumps(reports[3]))
            with self.assertRaisesRegex(ValueError, "lookahead"):
                audit.compare(args)


if __name__ == "__main__":
    unittest.main()
