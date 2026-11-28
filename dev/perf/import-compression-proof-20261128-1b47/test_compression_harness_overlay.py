# SPDX-License-Identifier: GPL-3.0-or-later
"""Focused proof-capture tests; no browser import or performance observation."""

import hashlib
import json
from pathlib import Path
import subprocess
import unittest

import compression_harness_overlay as overlay


ROOT = Path(__file__).resolve().parents[3]
HARNESS = ROOT / 'test/chromium/extension-two-dictionary-import.e2e.js'


def node_check(program, payload):
    result = subprocess.run(
        ['node', '--input-type=module', '-e', program],
        input=json.dumps(payload, ensure_ascii=False), text=True,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
    )
    if result.returncode:
        raise AssertionError(f'Node proof fixture failed ({result.returncode}): {result.stderr}')
    return json.loads(result.stdout)


BROWSER_FIXTURE = r"""
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
const {source} = JSON.parse(readFileSync(0, 'utf8'));
assert.equal(typeof globalThis.crypto.subtle.digest, 'function');
const start = source.indexOf('async function evalSendMessage(');
const rest = source.slice(start);
const match = /\n(?:async )?function /.exec(rest.slice(1));
assert.ok(match);
const fnSource = rest.slice(0, match.index + 1);
const evalSendMessage = Function(`return (${fnSource});`)();
const title = 'JMdict [proof fixture]';
const terms = Array.from({length: 12}, (_, i) => `日本${i}𠮷`);
let calls = 0;
let fault = null;
const resultFor = (term) => ({
    originalTextLength: fault === 'length' ? 1 : term.length,
    dictionaryEntries: fault === 'entries' ? [] : [{
        headwords: [{term, reading: 'にほん'}],
        definitions: [{dictionary: fault === 'dictionary' ? 'wrong' : title, entries: [{type: 'structured-content', content: ['quoted " text', '\u0000', '𠮷']}]}],
    }],
});
globalThis.chrome = {runtime: {
    lastError: null,
    sendMessage({action, params}, callback) {
        assert.equal(action, 'termsFind');
        assert.deepEqual(params.details, {primaryReading: '', matchType: 'exact', deinflect: false});
        assert.deepEqual(params.optionsContext, {index: 0});
        ++calls;
        callback({result: resultFor(params.text)});
    },
}};
const page = {evaluate: (fn, argument) => fn(argument)};
const pre = await evalSendMessage(page, 'benchmarkCompressionProofLookups', {title, terms});
assert.equal(calls, 12);
assert.equal(pre.length, 12);
for (let i = 0; i < pre.length; ++i) {
    const row = pre[i];
    assert.equal(row.term, terms[i]);
    assert.equal(row.resultJson, JSON.stringify(resultFor(terms[i])));
    assert.equal(row.utf8Bytes, Buffer.byteLength(row.resultJson));
    assert.equal(row.sha256, createHash('sha256').update(row.resultJson).digest('hex'));
    assert.equal(row.hasExactHeadwordMatch, true);
    assert.equal(row.results, 1);
}
const full = await evalSendMessage(page, 'benchmarkLookups', {title, terms, captureCompressionProof: true});
assert.equal(calls, 84);
const {compressionProofResults, ...lookup} = full;
assert.deepEqual(compressionProofResults, pre);
assert.deepEqual(Object.keys(lookup), ['timingBoundary', 'observations']);
assert.equal(lookup.observations.length, 72);
for (const row of lookup.observations) {
    assert.equal(row.sha256, pre[terms.indexOf(row.term)].sha256);
    assert.equal(Object.hasOwn(row, 'resultJson'), false);
    assert.equal(Object.hasOwn(row, 'utf8Bytes'), false);
}
const ordinary = await evalSendMessage(page, 'benchmarkLookups', {title, terms});
assert.deepEqual(Object.keys(ordinary), ['timingBoundary', 'observations']);
assert.equal(ordinary.observations.length, 72);
for (const nextFault of ['length', 'entries', 'dictionary']) {
    fault = nextFault;
    await assert.rejects(evalSendMessage(page, 'benchmarkCompressionProofLookups', {title, terms}), /no complete exact dictionary result/);
    await assert.rejects(evalSendMessage(page, 'benchmarkLookups', {title, terms, captureCompressionProof: true}), /no complete exact dictionary result/);
}
process.stdout.write(JSON.stringify({preCount: pre.length, originalPostCount: lookup.observations.length, negativeCases: 6}));
"""


PHYSICAL_FIXTURE = r"""
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
const {original, source} = JSON.parse(readFileSync(0, 'utf8'));
const extract = (text) => {
    const a = text.indexOf('                const probeDigest = (results) => {');
    const b = text.indexOf('                const preRestartOutputDigest = ', a);
    assert.ok(a > 0 && b > a);
    return text.slice(a, b);
};
const originalDigest = Function('createHash', `${extract(original)}; return probeDigest;`)(createHash);
const proof = {physical: {preRestart: null, postRestart: null}, references: {preRestart: null, postRestart: null}};
const digest = Function('createHash', 'Buffer', 'compressionProof', 'fail', `${extract(source)}; return probeDigest;`)(
    createHash, Buffer, proof, (message) => { throw new Error(message); },
);
const row = {
    id: 0, dictionary: 'JMdict', matchSource: 'expression', expression: '日本', reading: '',
    rawEntryContentOffset: 1048576, rawEntryContentLength: 938, rawEntryContentDictName: 'raw-block-v2:jmdict',
    glossaryLength: 3, rawContentPreview: 'binary\u0000preview𠮷', decodedContentDebug: {length: 938}, readErrorDetails: null,
};
const results = [{term: '日本', probes: [{
    term: '日本', totalLength: -1, rowSampleCount: 1, inBoundsRowCount: 0, outOfBoundsRowCount: 0,
    glossaryReadyRowCount: 1, readablePreviewRowCount: 1, diagnostics: {offscreenState: {rowSample: [row]}},
}]}];
const before = JSON.stringify(results);
const first = digest(results);
assert.equal(first, originalDigest(results));
assert.equal(digest(structuredClone(results)), first);
assert.deepEqual(proof.physical.preRestart, proof.physical.postRestart);
assert.deepEqual(proof.references.preRestart, proof.references.postRestart);
assert.equal(proof.physical.preRestart.utf8Bytes, Buffer.byteLength(proof.physical.preRestart.json));
assert.equal(proof.physical.preRestart.sha256, createHash('sha256').update(proof.physical.preRestart.json).digest('hex'));
const captured = proof.references.preRestart[0].probes[0].rows[0];
assert.equal(captured.id, 0);
assert.equal(captured.reading, '');
assert.equal(captured.rawEntryContentOffset, row.rawEntryContentOffset);
assert.equal(captured.rawEntryContentLength, 938);
assert.equal(captured.decodedContentLength, 938);
assert.equal(captured.readErrorDetails, null);
assert.equal(JSON.stringify(results), before);
assert.throws(() => digest(results), /more than twice/);
const moved = structuredClone(results);
moved[0].probes[0].diagnostics.offscreenState.rowSample[0].rawEntryContentOffset += 17;
assert.notEqual(originalDigest(moved), first);
const missingProof = {physical: {preRestart: null, postRestart: null}, references: {preRestart: null, postRestart: null}};
const missingDigest = Function('createHash', 'Buffer', 'compressionProof', 'fail', `${extract(source)}; return probeDigest;`)(
    createHash, Buffer, missingProof, (message) => { throw new Error(message); },
);
const missing = structuredClone(results);
delete missing[0].probes[0].diagnostics.offscreenState.rowSample[0].decodedContentDebug;
delete missing[0].probes[0].diagnostics.offscreenState.rowSample[0].rawEntryContentDictName;
missingDigest(missing);
assert.equal(missingProof.references.preRestart[0].probes[0].rows[0].decodedContentLength, null);
assert.equal(missingProof.references.preRestart[0].probes[0].rows[0].rawEntryContentDictName, null);
process.stdout.write(JSON.stringify({physicalDigestPreserved: true, missingFieldsExplicit: true, repeatedCaptureRejected: true}));
"""


class CompressionHarnessOverlayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.original = HARNESS.read_text()
        cls.overlaid = overlay.apply_overlay(cls.original)

    def test_original_identity_and_deterministic_output(self):
        self.assertEqual(hashlib.sha256(self.original.encode()).hexdigest(), overlay.ORIGINAL_HARNESS_SHA256)
        self.assertEqual(self.overlaid, overlay.apply_overlay(self.original))
        self.assertEqual(HARNESS.read_text(), self.original)

    def test_rejects_changed_repeated_or_nontext_input(self):
        for source in [self.original + '\n', self.original.replace('probeCount: probeTerms.length', 'probeCount: 0'), self.overlaid]:
            with self.subTest(sourceLength=len(source)), self.assertRaises(ValueError):
                overlay.apply_overlay(source)
        with self.assertRaises(TypeError):
            overlay.apply_overlay(self.original.encode())

    def test_anchor_fail_closed(self):
        for source in ['absent', 'present present']:
            with self.assertRaises(ValueError):
                overlay._replace_once(source, 'present', 'changed')

    def test_original_validation_shape_and_restart_assertion_retained(self):
        start = '                report.benchmark.validation = {'
        stop = '\n            }\n            report.status'
        def section(source):
            a = source.index(start)
            return source[a:source.index(stop, a)]
        self.assertEqual(section(self.original), section(self.overlaid))
        self.assertIn('if (preRestartOutputDigest !== postRestartOutputDigest)', self.overlaid)
        self.assertIn('const {compressionProofResults, ...lookup} = lookupWithCompressionProof;', self.overlaid)
        self.assertLess(self.overlaid.index("compressionProof.decoded.preRestart = await evalSendMessage"), self.overlaid.index('                await relaunchPersistentContext();', self.overlaid.index('const preRestartOutputDigest')))
        self.assertIn("fail('Decoded compression proof changed across restart');", self.overlaid)

    def test_existing_import_timing_implementation_unchanged(self):
        a = self.original.index('const initialImport')
        b = self.original.index('        if (quickImportBenchmarkMode) {', a)
        original = self.original[a:b]
        self.assertIn(original, self.overlaid)

    def test_decoded_browser_capture_and_negative_results(self):
        result = node_check(BROWSER_FIXTURE, {'source': self.overlaid})
        self.assertEqual(result, {'preCount': 12, 'originalPostCount': 72, 'negativeCases': 6})

    def test_exact_physical_preimages_and_reference_capture(self):
        result = node_check(PHYSICAL_FIXTURE, {'original': self.original, 'source': self.overlaid})
        self.assertEqual(result, {'physicalDigestPreserved': True, 'missingFieldsExplicit': True, 'repeatedCaptureRejected': True})


if __name__ == '__main__':
    unittest.main()
