import crypto from 'node:crypto';
import os from 'node:os';
function sha(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function pressure() { return {loadavg: os.loadavg(), freeMemory: os.freemem(), totalMemory: os.totalmem()}; }
function grouped(sources, totalBytes, count) {
    const groups = [];
    let start = 0;
    let consumed = 0;
    for (let gi = 0; gi < count - 1; ++gi) {
        const remaining = count - gi;
        const target = (totalBytes - consumed) / remaining;
        let end = start + 1;
        let bytes = sources[start].estimatedBytes;
        const maxEnd = sources.length - (remaining - 1);
        while (end < maxEnd) {
            const next = bytes + sources[end].estimatedBytes;
            if (Math.abs(next - target) > Math.abs(bytes - target)) { break; }
            bytes = next;
            ++end;
        }
        groups.push(sources.slice(start, end));
        start = end;
        consumed += bytes;
    }
    groups.push(sources.slice(start));
    return groups;
}
function updateListHash(hash, values) {
    for (const value of values ?? []) {
        const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
        const len = Buffer.allocUnsafe(4);
        len.writeUInt32LE(bytes.byteLength);
        hash.update(len).update(bytes);
    }
}
function normalizeLogicalValue(value) {
    if (ArrayBuffer.isView(value)) {
        return {type: value.constructor.name, bytes: value.byteLength, sha256: sha(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))};
    }
    if (value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) {
        return {type: value.constructor.name, bytes: value.byteLength, sha256: sha(new Uint8Array(value))};
    }
    if (Array.isArray(value)) { return value.map(normalizeLogicalValue); }
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalizeLogicalValue(value[key])]));
    }
    if (typeof value === 'function') { return '[function]'; }
    return value;
}
function summarize(chunk, encodeIndex) {
    const keys = crypto.createHash('sha256');
    updateListHash(keys, chunk.expressionBytesList);
    updateListHash(keys, chunk.readingBytesList);
    const plan = chunk.termRecordPreinternedPlan;
    const planHash = crypto.createHash('sha256');
    planHash.update(new Uint8Array(plan.stringsBuffer));
    planHash.update(new Uint8Array(plan.expressionIndexes.buffer, plan.expressionIndexes.byteOffset, plan.expressionIndexes.byteLength));
    planHash.update(new Uint8Array(plan.readingIndexes.buffer, plan.readingIndexes.byteOffset, plan.readingIndexes.byteLength));
    const indexBytes = encodeIndex(plan, chunk.readingEqualsExpressionList, chunk.sequenceList, chunk.rowCount);
    const meta = new Uint8Array(chunk.contentMetaList.buffer, chunk.contentMetaList.byteOffset, chunk.contentMetaList.byteLength);
    let maximumReferencedEnd = 0;
    for (let i = 0; i < chunk.contentMetaList.length; i += 4) {
        maximumReferencedEnd = Math.max(maximumReferencedEnd, chunk.contentMetaList[i] + chunk.contentMetaList[i + 1]);
    }
    const slab = chunk.contentBytesBuffer.subarray(chunk.contentBytesBaseOffset, chunk.contentBytesBaseOffset + maximumReferencedEnd);
    return {
        rows: chunk.rowCount,
        keyBytesSha256: keys.digest('hex'),
        preinternedPlanSha256: sha(new Uint8Array(plan.stringsBuffer)),
        planIndexesSha256: planHash.digest('hex'),
        persistedLookupIndexSha256: sha(indexBytes),
        contentMetaSha256: sha(meta),
        contentSlabSha256: sha(slab),
        contentSlabBytes: slab.byteLength,
        contentUniqueCount: chunk.contentDedupPlan?.uniqueCount ?? null,
        emittedMediaRowIndexes: chunk.mediaRows.map(({index}) => index),
        completeNativePlanSha256: sha(Buffer.from(JSON.stringify(normalizeLogicalValue(plan)))),
        rowColumnsSha256: sha(Buffer.from(JSON.stringify(normalizeLogicalValue({
            scoreList: chunk.scoreList, sequenceList: chunk.sequenceList,
            readingEqualsExpressionList: chunk.readingEqualsExpressionList,
            contentHash1List: chunk.contentHash1List, contentHash2List: chunk.contentHash2List,
            contentUniqueIndexList: chunk.contentUniqueIndexList,
        })))),
        dedupPlanSha256: sha(Buffer.from(JSON.stringify(normalizeLogicalValue(chunk.contentDedupPlan)))),
        completeMediaRowsSha256: sha(Buffer.from(JSON.stringify(normalizeLogicalValue(chunk.mediaRows)))),
    };
}

async function summarizeGlossaryMetadata(wasmBytes, groups) {
    const {instance} = await WebAssembly.instantiate(wasmBytes);
    const wasm = instance.exports;
    const groupHashes = [];
    for (const group of groups) {
        const hash = crypto.createHash('sha256');
        const completeMetaHash = crypto.createHash('sha256');
        let rows = 0;
        for (const source of group) {
            wasm.wasm_reset_heap();
            const input = wasm.wasm_alloc(source.byteLength);
            const output = wasm.wasm_alloc(17 * 4);
            new Uint8Array(wasm.memory.buffer, input, source.byteLength).set(source);
            const count = wasm.parse_term_bank_with_media_hints(input, source.byteLength, output, 1, 0, 0);
            if (count < 0) { throw new Error('glossary metadata audit could not parse a source bank'); }
            const metadata = new Uint32Array(wasm.memory.buffer, output, count * 17);
            completeMetaHash.update(new Uint8Array(metadata.buffer,metadata.byteOffset,metadata.byteLength));
            for (let row = 0; row < count; ++row) {
                const offset = row * 17;
                const glossaryStart = metadata[offset + 9];
                const glossaryLength = metadata[offset + 10];
                const glossary = new Uint8Array(wasm.memory.buffer, input + glossaryStart, glossaryLength);
                const rowHeader = Buffer.allocUnsafe(12);
                rowHeader.writeUInt32LE(metadata[offset + 14], 0);
                rowHeader.writeUInt32LE(metadata[offset + 15], 4);
                rowHeader.writeUInt32LE(metadata[offset + 16], 8);
                hash.update(rowHeader).update(Buffer.from(glossary));
                ++rows;
            }
        }
        groupHashes.push({rows, sha256: hash.digest('hex'),all17RowMetaFieldsSha256:completeMetaHash.digest('hex')});
    }
    return groupHashes;
}


export {sha,pressure,grouped,summarize,summarizeGlossaryMetadata,normalizeLogicalValue};
