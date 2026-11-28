// SPDX-License-Identifier: GPL-3.0-or-later
// Exact cross-arm physical relocation proof, separate from the full logical decoders.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {sha, saveJson, MIXED_GROUPS, verifyBindings} from './product-common.mjs';
const config = JSON.parse(await readFile(process.argv[2]));
const report = {schemaVersion: 1, complete: false, configuration: config, failures: [], normalSpanProofs: []};
await saveJson(config.reportPath, report);
try {
    const [a, b, va, vb] = await Promise.all([config.a, config.b, config.verifyA, config.verifyB].map(async (file) => JSON.parse(await readFile(file))));
    assert(a.complete && b.complete && va.complete && vb.complete);
    assert.equal(va.pipelineSha256, sha(await readFile(config.a)));
    assert.equal(vb.pipelineSha256, sha(await readFile(config.b)));
    assert.equal(a.configuration.arm, 'A'); assert.equal(b.configuration.arm, 'B');
    assert.equal(a.rows, 6648310); assert.equal(a.rows, b.rows); assert.equal(va.verifiedRows, a.rows); assert.equal(vb.verifiedRows, b.rows);
    assert.equal(a.inputLogicalSha256, b.inputLogicalSha256); assert.equal(va.inputLogicalSha256, vb.inputLogicalSha256);
    assert.deepEqual(a.policy, b.policy); assert.equal(a.groups.length, 170); assert.equal(b.groups.length, 170);
    assert.equal(a.privateLeaseClaims, 0); assert.equal(b.privateLeaseClaims, 170);
    assert.equal(a.canonicalMetadata.logicalMetadataSha256, b.canonicalMetadata.logicalMetadataSha256);
    assert.equal(a.canonicalMetadata.published, b.canonicalMetadata.published);
    assert.deepEqual(a.canonicalMetadata.names, b.canonicalMetadata.names); assert.deepEqual(a.recentCache, b.recentCache);
    assert.equal(a.canonicalMetadata.width, 60); assert.equal(b.canonicalMetadata.width, 60);
    assert.deepEqual(a.groups.map(({input}) => input), b.groups.map(({input}) => input));
    assert.deepEqual(a.groups.map(({index, requirements}) => ({index, requirements})), b.groups.map(({index, requirements}) => ({index, requirements})));
    const metadataA = await readFile(path.join(path.dirname(config.a), a.canonicalMetadata.file));
    const metadataB = await readFile(path.join(path.dirname(config.b), b.canonicalMetadata.file));
    assert.equal(sha(metadataA), a.canonicalMetadata.sha256); assert.equal(sha(metadataB), b.canonicalMetadata.sha256);
    assert.equal(metadataA.length, metadataB.length);
    const contentName = 'manabitan-term-content.bin';
    const contentA = await readFile(path.join(path.dirname(config.a), 'opfs', contentName));
    const contentB = await readFile(path.join(path.dirname(config.b), 'opfs', contentName));
    assert.equal(sha(contentA), a.fileInventory.find(({file}) => file === contentName).sha256);
    assert.equal(sha(contentB), b.fileInventory.find(({file}) => file === contentName).sha256);
    const raw = await import(pathToFileURL(path.join(a.configuration.root, 'ext/js/dictionary/raw-term-content.js')));
    const normalA = [], normalB = [], extraB = [];
    let tailA = 0, tailB = 0;
    for (let index = 0; index < 170; ++index) {
        const ga = a.groups[index], gb = b.groups[index], sa = ga.normalContentSpan, sb = gb.normalContentSpan;
        assert.equal(sa.start, tailA); assert.equal(sb.start, tailB);
        assert.equal(sa.end - sa.start, sb.end - sb.start);
        for (const key of ['pendingEntries', 'inputBytes', 'sourceSha256', 'offsetsSha256', 'lengthsSha256']) { assert.equal(sa[key], sb[key]); }
        normalA.push(sa); normalB.push(sb); tailA = sa.end; tailB = sb.end;
        assert.equal(ga.aliasContentSpans.length, 0);
        for (const span of gb.aliasContentSpans) {
            assert.equal(span.start, tailB); assert(span.end > span.start); assert(span.entries > 0 && span.entries <= 64);
            assert(span.inputBytes <= 65536); assert(span.result); tailB = span.end; extraB.push({group: index, ...span});
        }
        for (const key of ['dedupNativeCallCount', 'dedupNativeScannedRows', 'dedupNativeFallbackCount', 'dedupUniqueCount', 'dedupPersistedHitCount']) { assert.equal(ga.metrics[key], gb.metrics[key]); }
    }
    assert.equal(tailA, contentA.length); assert.equal(tailB, contentB.length);
    assert.deepEqual(extraB.map(({group}) => group), MIXED_GROUPS);
    const findSpan = (offset) => {
        const index = normalA.findIndex(({start, end}) => offset >= start && offset < end); assert(index >= 0); return index;
    };
    const relocate = (offset) => { const index = findSpan(offset); return normalB[index].start + offset - normalA[index].start; };
    const normalizedB = Buffer.from(contentB);
    let canonicalRows = 0, rawRows = 0, compactRows = 0;
    const canonicalReferenceOffsets = new Set();
    const comparedBlocks = new Set();
    for (let row = 0; row < a.canonicalMetadata.count; ++row) {
        const start = row * 60, state = metadataA.readUInt32LE(start + 8);
        const left = Buffer.from(metadataA.subarray(start, start + 60)), right = Buffer.from(metadataB.subarray(start, start + 60));
        const offsetA = left.readDoubleLE(20), offsetB = right.readDoubleLE(20), length = left.readUInt32LE(28), name = a.canonicalMetadata.names[left.readUInt32LE(32)];
        left.fill(0, 20, 28); right.fill(0, 20, 28); assert.deepEqual(left, right, 'Canonical metadata field changed');
        if (state === 0) { assert.equal(offsetA, offsetB); continue; }
        assert.equal(state, 1); assert.equal(offsetB, relocate(offsetA), 'Canonical entry was replaced by an alias'); ++canonicalRows;
        assert(!extraB.some(({start, end}) => offsetB >= start && offsetB < end));
        if (name === 'raw-v6') {
            assert.deepEqual(contentA.subarray(offsetA, offsetA + length), contentB.subarray(offsetB, offsetB + length)); ++rawRows;
        } else {
            assert(raw.getRawTermContentBlockCompressionDictName(name) !== undefined);
            const refA = raw.decodeRawTermContentCompactBlockReference(contentA.subarray(offsetA, offsetA + 20), length);
            const refB = raw.decodeRawTermContentCompactBlockReference(contentB.subarray(offsetB, offsetB + 20), length);
            assert(refA && refB); assert.equal(refB.blockOffset, relocate(refA.blockOffset));
            assert.deepEqual({...refA, blockOffset: 0}, {...refB, blockOffset: 0});
            if (!comparedBlocks.has(refA.blockOffset)) {
                assert.deepEqual(contentA.subarray(refA.blockOffset, refA.blockOffset + refA.blockCompressedLength),
                    contentB.subarray(refB.blockOffset, refB.blockOffset + refB.blockCompressedLength));
                comparedBlocks.add(refA.blockOffset);
            }
            normalizedB.writeBigUInt64LE(BigInt(refA.blockOffset), offsetB); canonicalReferenceOffsets.add(offsetB); ++compactRows;
        }
    }
    assert.equal(canonicalRows, a.canonicalMetadata.published);
    assert.equal(canonicalReferenceOffsets.size, compactRows);
    for (let index = 0; index < normalA.length; ++index) {
        const sa = normalA[index], sb = normalB[index];
        const original = contentA.subarray(sa.start, sa.end), relocated = normalizedB.subarray(sb.start, sb.end);
        assert.deepEqual(original, relocated, 'Non-alias content bytes changed in group ' + index);
        report.normalSpanProofs.push({group: index, baselineStart: sa.start, candidateStart: sb.start, bytes: sa.end - sa.start, sha256: sha(original)});
    }
    assert.equal(vb.aliasProofs.length, 8); assert.equal(va.aliasProofs.length, 0);
    assert.equal(b.groups.reduce((sum, group) => sum + group.recordEntry.aliasRows.length, 0), 175);
    assert.equal(b.groups.reduce((sum, group) => sum + (group.metrics.contentAliasInputBytes ?? 0), 0), 2983);
    assert.equal(vb.nativePreparedGroups, 170);
    report.logicalSha256 = a.inputLogicalSha256;
    report.canonicalRows = canonicalRows; report.rawCanonicalRows = rawRows; report.compactCanonicalRows = compactRows;
    report.canonicalMetadataLogicalSha256 = a.canonicalMetadata.logicalMetadataSha256;
    report.addedContentBytes = contentB.length - contentA.length; report.aliasSpans = extraB;
    report.physicalDelta = a.fileInventory.map((left) => {
        const right = b.fileInventory.find(({file}) => file === left.file); assert(right);
        return {file: left.file, baselineBytes: left.bytes, candidateBytes: right.bytes, deltaBytes: right.bytes - left.bytes,
            baselineSha256: left.sha256, candidateSha256: right.sha256, baselineNormalizedSha256: left.normalizedSha256, candidateNormalizedSha256: right.normalizedSha256};
    });
    assert.equal(a.fileInventory.length, b.fileInventory.length);
    report.scope = 'Exact source/input logical parity across all6648310rows, full per-arm strict decode/restart proof, unchanged canonical metadata modulo proven physical relocation, byte-identical normal content spans after only verified compact-reference block-offset relocation; bounded extra aliases only. Instrumented Node storage diagnostic, not a gain estimate or browser/full-import qualification.';
    await verifyBindings(a.configuration); await verifyBindings(b.configuration);
    report.complete = true; await saveJson(config.reportPath, report);
} catch (error) {
    report.complete = false; report.failures.push({message: String(error), stack: error?.stack ?? null}); await saveJson(config.reportPath, report); throw error;
}
console.log(JSON.stringify({complete: report.complete, rows: 6648310, logicalSha256: report.logicalSha256,
    canonicalRows: report.canonicalRows, addedContentBytes: report.addedContentBytes, physicalDelta: report.physicalDelta}));
