/* Full fused-output digest; called after timing and before backing memory reuse. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const updateView = (hash, view) => hash.update(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
export function digestChunk(chunk, indexes) {
    const digest = createHash('sha256');
    let indexBytes = 0;
    for (const [key, entry] of indexes) {
        digest.update(key); digest.update(entry.bytes); indexBytes += entry.bytes.byteLength;
        for (const view of [entry.preinternedPlan.stringLengths, entry.preinternedPlan.stringOffsets,
            entry.preinternedPlan.stringHashes, entry.preinternedPlan.stringsBuffer,
            Uint32Array.from(entry.preinternedPlan.expressionIndexes), entry.preinternedPlan.readingIndexes]) {
            if (view) { updateView(digest, view); }
        }
    }
    for (const view of [chunk.contentUniqueIndexList, chunk.contentDedupPlan?.uniqueRowIndexes, chunk.contentDedupPlan?.uniqueSignatures]) {
        digest.update(view ? 'present' : 'absent');
        if (view) { updateView(digest, view); }
    }
    digest.update(JSON.stringify({uniqueCount: chunk.contentDedupPlan?.uniqueCount ?? null,
        contentMetaByUniqueIndex: chunk.contentMetaByUniqueIndex ?? false, useResolvedContentReferences: chunk.useResolvedContentReferences ?? false}));
    updateView(digest, chunk.readingEqualsExpressionList);
    updateView(digest, chunk.scoreList);
    updateView(digest, chunk.sequenceList);
    const {contentMetaList, contentBytesBuffer, contentBytesBaseOffset} = chunk;
    assert(contentBytesBuffer && contentMetaList && typeof contentBytesBaseOffset === 'number');
    for (let row = 0; row < chunk.rowCount; ++row) {
        const offset = contentBytesBaseOffset + contentMetaList[row * 4];
        digest.update(contentBytesBuffer.subarray(offset, offset + contentMetaList[row * 4 + 1]));
        updateView(digest, contentMetaList.subarray(row * 4 + 1, row * 4 + 4));
    }
    digest.update(JSON.stringify(chunk.mediaRows.map(({index, row, imagePaths}) => ({index, imagePaths: imagePaths ?? null,
        row: Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
            value instanceof Uint8Array ? {length: value.length, sha256: sha(value)} : Object.is(value, -0) ? {negativeZero: true} : value ?? null]))}))));
    return {digest: digest.digest('hex'), indexBytes};
}
