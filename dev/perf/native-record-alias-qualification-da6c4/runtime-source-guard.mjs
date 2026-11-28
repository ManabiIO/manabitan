#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Research-only fixed historical/current byte proof; never rewrites runtime files.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const RUNTIME_SOURCE_PROOF_SHA256 = '158ae77608da6f774aa6c0187c486d7621c8e82063637ebd9220df4895107c2e';
const proofUrl = new URL('./generated-runtime-source-proof.json', import.meta.url);
const expectedPaths = ['handlebars', 'hangul-js', 'kanji-processor', 'linkedom', 'parse5', 'resvg-wasm', 'ucs2length', 'z-worker', 'zip']
    .flatMap((name) => ['ext/lib/' + name + '.js', 'ext/lib/' + name + '.js.map']).sort();
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function validateRuntimeSourceProof(bytes) {
    assert.equal(sha(bytes), RUNTIME_SOURCE_PROOF_SHA256, 'Fixed generated-runtime proof bytes changed');
    const proof = JSON.parse(bytes);
    assert.equal(proof.schemaVersion, 1);
    assert.equal(proof.kind, 'fixed-generated-runtime-source-path-proof');
    assert.equal(proof.baseline, 'dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16');
    assert.equal(proof.candidate, '2c02336b135ee01661ca2a788395afec75e66712');
    assert.deepEqual(proof.pairs.map(({path: relative}) => relative).sort(), expectedPaths);
    return proof;
}

async function loadProof() {
    return validateRuntimeSourceProof(await readFile(proofUrl));
}

function checkFile(proof, relative, naturalExpected, bytes) {
    assert.equal(typeof relative, 'string');
    assert(!path.isAbsolute(relative) && !relative.split('/').includes('..'), 'Unsafe runtime path');
    assert.match(naturalExpected, /^[0-9a-f]{64}$/);
    const actual = sha(bytes);
    const pair = proof.pairs.find((item) => item.path === relative);
    if (pair) assert.equal(naturalExpected, pair.naturalSha256, 'Unknown natural hash for fixed generated pair: ' + relative);
    if (actual === naturalExpected) return {path: relative, naturalSha256: naturalExpected, actualSha256: actual, mode: 'exact', replacedSpans: 0};
    assert(pair, 'Unproved runtime byte difference: ' + relative);
    assert.equal(actual, pair.hostedSha256, 'Unknown hosted hash for fixed generated pair: ' + relative);
    assert.equal(bytes.length, pair.hostedBytes, 'Fixed hosted byte count changed: ' + relative);
    const from = Buffer.from(proof.hostedPrefix), to = Buffer.from(proof.naturalPrefix);
    const pieces = [];
    let cursor = 0;
    for (const start of pair.hostedPrefixStarts) {
        assert(Number.isSafeInteger(start) && start >= cursor && start + from.length <= bytes.length, 'Invalid fixed path span');
        assert(bytes.subarray(start, start + from.length).equals(from), 'Fixed path span no longer matches: ' + relative);
        pieces.push(bytes.subarray(cursor, start), to);
        cursor = start + from.length;
    }
    pieces.push(bytes.subarray(cursor));
    const reconstructed = Buffer.concat(pieces);
    assert.equal(reconstructed.length, pair.naturalBytes, 'Historical byte count differs: ' + relative);
    assert.equal(sha(reconstructed), naturalExpected, 'Any non-path byte differs from historical runtime: ' + relative);
    return {path: relative, naturalSha256: naturalExpected, actualSha256: actual,
        mode: 'fixed-source-path-pair', replacedSpans: pair.hostedPrefixStarts.length};
}

export async function verifyRuntimeFile(relative, naturalExpected, bytes) {
    return checkFile(await loadProof(), relative, naturalExpected, Buffer.from(bytes));
}

export async function verifyRuntimeSources(root, naturalSourceHashes) {
    const proof = await loadProof();
    assert(naturalSourceHashes && typeof naturalSourceHashes === 'object' && !Array.isArray(naturalSourceHashes));
    for (const relative of expectedPaths) assert(Object.hasOwn(naturalSourceHashes, relative), 'Missing fixed runtime path: ' + relative);
    const files = [], actualSourceHashes = {};
    for (const [relative, expected] of Object.entries(naturalSourceHashes).sort(([a], [b]) => a.localeCompare(b))) {
        const result = checkFile(proof, relative, expected, await readFile(path.join(root, relative)));
        actualSourceHashes[relative] = result.actualSha256;
        files.push(result);
    }
    return {schemaVersion: 1, complete: true, proofSha256: RUNTIME_SOURCE_PROOF_SHA256,
        naturalSourceHashes, actualSourceHashes, exactFiles: files.filter(({mode}) => mode === 'exact').length,
        fixedPathPairs: files.filter(({mode}) => mode === 'fixed-source-path-pair').length,
        replacedSpans: files.reduce((sum, file) => sum + file.replacedSpans, 0), files,
        scope: 'Fixed raw-byte pair proof only. Actual release/runtime files are unchanged and remain individually hashed.'};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [configPath, outputPath] = process.argv.slice(2);
    assert(configPath && outputPath, 'Expected binding configuration and output receipt paths');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    const report = await verifyRuntimeSources(config.root, config.naturalSourceHashes);
    await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
    console.log(JSON.stringify({kind: 'fixed-runtime-source-proof', complete: report.complete,
        proofSha256: report.proofSha256, exactFiles: report.exactFiles, fixedPathPairs: report.fixedPathPairs,
        replacedSpans: report.replacedSpans}));
}
