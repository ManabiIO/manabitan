#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {test} from 'node:test';
import {validateRuntimeSourceProof, verifyRuntimeFile} from './runtime-source-guard.mjs';

const directory = process.argv[2];
assert(directory, 'Pass the exact stock-built ext/lib directory');
const proofBytes = await readFile(new URL('./generated-runtime-source-proof.json', import.meta.url));
const proof = validateRuntimeSourceProof(proofBytes);
const byPath = new Map(proof.pairs.map((pair) => [pair.path, pair]));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const bytesFor = (relative) => readFile(path.join(directory, path.basename(relative)));

for (const pair of proof.pairs) {
    test('fixed pair accepts exact bytes: ' + pair.path, async () => {
        const bytes = await bytesFor(pair.path);
        assert.equal(sha(bytes), pair.hostedSha256);
        const result = await verifyRuntimeFile(pair.path, pair.naturalSha256, bytes);
        assert.equal(result.mode, 'fixed-source-path-pair');
        assert.equal(result.actualSha256, pair.hostedSha256);
        assert.equal(result.replacedSpans, pair.hostedPrefixStarts.length);
    });
}
test('executable JavaScript mutation is rejected', async () => {
    const pair = byPath.get('ext/lib/zip.js'), bytes = await bytesFor(pair.path);
    const changed = Buffer.from(bytes.toString().replace('4294967295', '4294967294'));
    assert.notEqual(sha(changed), sha(bytes));
    await assert.rejects(verifyRuntimeFile(pair.path, pair.naturalSha256, changed), /Unknown hosted hash/);
});
test('comment/source-path mutation is rejected', async () => {
    const pair = byPath.get('ext/lib/resvg-wasm.js'), bytes = await bytesFor(pair.path);
    const changed = Buffer.from(bytes.toString().replace('node_modules/', 'changed_path/'));
    await assert.rejects(verifyRuntimeFile(pair.path, pair.naturalSha256, changed), /Unknown hosted hash/);
});
for (const field of ['sourcesContent', 'mappings', 'sources']) {
    test('source map ' + field + ' mutation is rejected', async () => {
        const pair = byPath.get('ext/lib/zip.js.map'), bytes = await bytesFor(pair.path);
        const value = JSON.parse(bytes);
        if (field === 'mappings') value.mappings += 'A';
        else value[field][0] += 'unexpected mutation';
        await assert.rejects(verifyRuntimeFile(pair.path, pair.naturalSha256, Buffer.from(JSON.stringify(value))), /Unknown hosted hash/);
    });
}
test('known bytes at an unknown runtime path are rejected', async () => {
    const pair = byPath.get('ext/lib/zip.js');
    await assert.rejects(verifyRuntimeFile('ext/lib/unknown.js', pair.naturalSha256, await bytesFor(pair.path)), /Unproved runtime byte difference/);
});
test('unknown natural pair is rejected even when it equals the current bytes', async () => {
    const pair = byPath.get('ext/lib/zip.js');
    await assert.rejects(verifyRuntimeFile(pair.path, pair.hostedSha256, await bytesFor(pair.path)), /Unknown natural hash/);
});
test('all other runtime files retain strict equality', async () => {
    const bytes = Buffer.from('export const value = 1;\n');
    assert.equal((await verifyRuntimeFile('ext/js/example.js', sha(bytes), bytes)).mode, 'exact');
    await assert.rejects(verifyRuntimeFile('ext/js/example.js', sha(bytes), Buffer.from('export const value = 2;\n')), /Unproved runtime byte difference/);
});
test('proof source-byte mutation is rejected', () => {
    const value = JSON.parse(proofBytes);
    value.pairs[0].hostedPrefixStarts[0]++;
    assert.throws(() => validateRuntimeSourceProof(Buffer.from(JSON.stringify(value))), /Fixed generated-runtime proof bytes changed/);
});
test('proof unknown path/pair amendment is rejected', () => {
    const value = JSON.parse(proofBytes);
    value.pairs[0].path = 'ext/lib/unknown.js';
    assert.throws(() => validateRuntimeSourceProof(Buffer.from(JSON.stringify(value))), /Fixed generated-runtime proof bytes changed/);
});
