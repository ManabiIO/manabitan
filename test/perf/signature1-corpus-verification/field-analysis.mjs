// Standalone size/semantic census, not a production format implementation.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const align4 = (value) => (value + 3) & ~3;

export function decodeFields(bytes, count, format) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (format === 1 || format === 3) {
        const width = format === 1 ? 12 : 16;
        assert.equal(bytes.byteLength, count * width);
        return {scoreCount: null,
            get(row) {
                const offset = row * width;
                return [view.getUint32(offset, true),
                    view.getUint32(offset + 4, true),
                format === 1 ? view.getInt32(offset + 8, true) : view.getFloat64(offset + 8, true)];
            }};
    }
    assert.equal(format, 2);
    assert.equal(view.getUint32(0, true), 0x3246524d);
    assert.equal(view.getUint32(4, true), count);
    const scoreCount = view.getUint32(8, true);
    assert(scoreCount > 0 && scoreCount < 0xffff);
    assert.equal(view.getUint32(12, true), 2);
    assert.equal(bytes.byteLength, 16 + scoreCount * 4 + count * 8);
    const offsetsStart = 16 + scoreCount * 4;
    const lengthsStart = offsetsStart + count * 4;
    const scoreKeysStart = lengthsStart + count * 2;
    return {scoreCount,
        offsetsStart,
        lengthsStart,
        scoreKeysStart,
        view,
        get(row) {
            const scoreKey = view.getUint16(scoreKeysStart + row * 2, true);
            assert(scoreKey < scoreCount);
            return [view.getUint32(offsetsStart + row * 4, true),
                view.getUint16(lengthsStart + row * 2, true),
                view.getInt32(16 + scoreKey * 4, true)];
        }};
}

export function analyzeFields(bytes, count, format, metadata = {}) {
    const parsed = decodeFields(bytes, count, format);
    const result = {...metadata,
        count,
        format,
        bytes: bytes.byteLength,
        fieldsSha256: sha256(bytes),
        scoreCount: parsed.scoreCount,
        referenceCount: null,
        candidateBytes: null,
        selectedBytes: bytes.byteLength,
        savingsBytes: 0,
        selectsReferenceTable: false,
        allRowsRoundTrip: false};
    if (format !== 2) { return result; }
    const indexes = new Map();
    const references = [];
    const keys = new Uint32Array(count);
    let consecutiveRuns = 0;
    let previousKey = -1;
    for (let row = 0; row < count; ++row) {
        const [offset, length] = parsed.get(row);
        // A u32 offset and u16 length fit exactly in a JavaScript integer pair.
        const pair = offset * 65536 + length;
        let key = indexes.get(pair);
        if (typeof key === 'undefined') {
            key = references.length;
            indexes.set(pair, key);
            references.push([offset, length]);
        }
        keys[row] = key;
        if (key !== previousKey) {
            ++consecutiveRuns;
            previousKey = key;
        }
    }
    const referenceCount = references.length;
    const candidateBytes = 20 + parsed.scoreCount * 4 + referenceCount * 4 + align4(referenceCount * 2) + count * 4;
    Object.assign(result, {referenceCount,
        referenceRatio: referenceCount / count,
        consecutiveRuns,
        candidateBytes,
        tablePaddingBytes: align4(referenceCount * 2) - referenceCount * 2,
        hypotheticalDeltaBytes: candidateBytes - bytes.byteLength});
    if (referenceCount >= 0xffff || candidateBytes >= bytes.byteLength) { return result; }
    // Materialize only this one candidate chunk, verify every decoded row, and
    // discard it. Score order and keys remain exactly those of current format2.
    const candidate = new Uint8Array(candidateBytes);
    const output = new DataView(candidate.buffer);
    output.setUint32(0, 0x3446524d, true);
    output.setUint32(4, count, true);
    output.setUint32(8, parsed.scoreCount, true);
    output.setUint32(12, 4, true);
    output.setUint32(16, referenceCount, true);
    candidate.set(bytes.subarray(16, 16 + parsed.scoreCount * 4), 20);
    const offsetsStart = 20 + parsed.scoreCount * 4;
    const lengthsStart = offsetsStart + referenceCount * 4;
    const keysStart = lengthsStart + align4(referenceCount * 2);
    const scoresStart = keysStart + count * 2;
    for (let key = 0; key < referenceCount; ++key) {
        output.setUint32(offsetsStart + key * 4, references[key][0], true);
        output.setUint16(lengthsStart + key * 2, references[key][1], true);
    }
    for (let row = 0; row < count; ++row) { output.setUint16(keysStart + row * 2, keys[row], true); }
    candidate.set(bytes.subarray(parsed.scoreKeysStart), scoresStart);
    for (let row = 0; row < count; ++row) {
        const key = output.getUint16(keysStart + row * 2, true);
        const scoreKey = output.getUint16(scoresStart + row * 2, true);
        assert(key < referenceCount && scoreKey < parsed.scoreCount);
        const expected = parsed.get(row);
        assert.equal(output.getUint32(offsetsStart + key * 4, true), expected[0]);
        assert.equal(output.getUint16(lengthsStart + key * 2, true), expected[1]);
        assert.equal(output.getInt32(20 + scoreKey * 4, true), expected[2]);
    }
    return {...result,
        selectedBytes: candidateBytes,
        savingsBytes: bytes.byteLength - candidateBytes,
        selectsReferenceTable: true,
        allRowsRoundTrip: true,
        candidateSha256: sha256(candidate)};
}

export function summarize(chunks) {
    const sum = (key) => chunks.reduce((total, chunk) => total + (chunk[key] ?? 0), 0);
    const result = {chunks: chunks.length,
        rows: sum('count'),
        currentFieldsBytes: sum('bytes'),
        selectedFieldsBytes: sum('selectedBytes'),
        savingsBytes: sum('savingsBytes'),
        selectedChunks: chunks.filter((chunk) => chunk.selectsReferenceTable).length,
        selectedRows: chunks.filter((chunk) => chunk.selectsReferenceTable).reduce((total, chunk) => total + chunk.count, 0),
        formatCounts: {},
        rowsByFormat: {},
        bytesByFormat: {},
        compactReferences: sum('referenceCount')};
    for (const chunk of chunks) {
        result.formatCounts[chunk.format] = (result.formatCounts[chunk.format] ?? 0) + 1;
        result.rowsByFormat[chunk.format] = (result.rowsByFormat[chunk.format] ?? 0) + chunk.count;
        result.bytesByFormat[chunk.format] = (result.bytesByFormat[chunk.format] ?? 0) + chunk.bytes;
    }
    result.fieldsReductionPercent = result.savingsBytes / result.currentFieldsBytes * 100;
    return result;
}
