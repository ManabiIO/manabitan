// Independent diagnostics for actual persisted fields; no hypothetical format selection.
import assert from 'node:assert/strict';
import {decodeFields as decodeLegacyFields, sha256} from './legacy-field-analysis.mjs';

export {sha256};

export function fieldByteLength(header, count, format) {
    if (format === 1 || format === 3) { return count * (format === 1 ? 12 : 16); }
    assert(format === 2 || format === 4);
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    const scoreCount = view.getUint32(8, true);
    assert.equal(view.getUint32(0, true), format === 4 ? 0x3446524d : 0x3246524d);
    assert.equal(view.getUint32(4, true), count);
    assert.equal(view.getUint32(12, true), format);
    assert(scoreCount > 0 && scoreCount < 65535);
    if (format === 2) { return 16 + scoreCount * 4 + count * 8; }
    const references = view.getUint32(16, true);
    assert(references > 0 && references < 65535);
    return 20 + scoreCount * 4 + references * 4 + Math.ceil(references / 2) * 4 + count * 4;
}

export function decodeFields(bytes, count, format) {
    if (format !== 4) { return decodeLegacyFields(bytes, count, format); }
    assert.equal(fieldByteLength(bytes, count, format), bytes.byteLength);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const scoreCount = view.getUint32(8, true);
    const referenceCount = view.getUint32(16, true);
    const offsetsStart = 20 + scoreCount * 4;
    const lengthsStart = offsetsStart + referenceCount * 4;
    const keysStart = lengthsStart + Math.ceil(referenceCount / 2) * 4;
    const scoreKeysStart = keysStart + count * 2;
    if (referenceCount % 2) { assert.equal(view.getUint16(lengthsStart + referenceCount * 2, true), 0); }
    return {scoreCount,
        referenceCount,
        offsetsStart,
        lengthsStart,
        keysStart,
        scoreKeysStart,
        view,
        get(row) {
            assert(Number.isInteger(row) && row >= 0 && row < count);
            const key = view.getUint16(keysStart + row * 2, true);
            const scoreKey = view.getUint16(scoreKeysStart + row * 2, true);
            assert(key < referenceCount && scoreKey < scoreCount);
            return [view.getUint32(offsetsStart + key * 4, true),
                view.getUint16(lengthsStart + key * 2, true),
                view.getInt32(20 + scoreKey * 4, true)];
        }};
}

// Reconstruct the existing format2 representation directly from actual format4
// bytes. This allows an exact whole-file oracle against the disabled writer.
export function expandReferenceFields(bytes, count, format) {
    if (format !== 4) {
        decodeFields(bytes, count, format);
        return bytes;
    }
    const parsed = decodeFields(bytes, count, format);
    const output = new Uint8Array(16 + parsed.scoreCount * 4 + count * 8);
    const view = new DataView(output.buffer);
    view.setUint32(0, 0x3246524d, true);
    view.setUint32(4, count, true);
    view.setUint32(8, parsed.scoreCount, true);
    view.setUint32(12, 2, true);
    output.set(bytes.subarray(20, 20 + parsed.scoreCount * 4), 16);
    const offsetsStart = 16 + parsed.scoreCount * 4;
    const lengthsStart = offsetsStart + count * 4;
    const scoresStart = lengthsStart + count * 2;
    for (let row = 0; row < count; ++row) {
        const [offset, length] = parsed.get(row);
        view.setUint32(offsetsStart + row * 4, offset, true);
        view.setUint16(lengthsStart + row * 2, length, true);
    }
    output.set(bytes.subarray(parsed.scoreKeysStart), scoresStart);
    assert(output.byteLength > bytes.byteLength, 'The actual writer may select format4 only for a strict saving');
    return output;
}

export function sourceTableReceipt(chunk, base, decoded, fields) {
    const references = chunk.resolvedContentReferences;
    if (!references) { return {hasReferenceTable: false}; }
    const count = references.offsets.length;
    assert.equal(references.lengths.length, count);
    const used = new Uint8Array(count);
    for (let row = 0; row < chunk.rowCount; ++row) {
        const key = references.uniqueIndexList[row];
        assert(key < count);
        used[key] = 1;
    }
    let usedCount = 0;
    let offsetsBeforeBase = 0;
    let unsafeOffsets = 0;
    let wideLengths = 0;
    let nullOffsets = 0;
    for (let key = 0; key < count; ++key) {
        usedCount += used[key];
        const offset = references.offsets[key];
        if (offset === -1) {
            ++nullOffsets;
        } else if (!Number.isSafeInteger(offset) || offset < 0 || offset - base > 0xfffffffe) {
            ++unsafeOffsets;
        } else if (offset < base) {
            ++offsetsBeforeBase;
            assert.equal(used[key], 0);
        }
        if (references.lengths[key] >= 65535) { ++wideLengths; }
    }
    const proposedBytes = decoded.scoreCount === null ?
null :
20 + decoded.scoreCount * 4 +
count * 4 + Math.ceil(count / 2) * 4 + chunk.rowCount * 4;
    const existingCompactBytes = decoded.scoreCount === null ? null : 16 + decoded.scoreCount * 4 + chunk.rowCount * 8;
    const receipt = {hasReferenceTable: true,
        fullReferenceCount: count,
        usedReferenceCount: usedCount,
        unusedReferenceCount: count - usedCount,
        nullOffsets,
        offsetsBeforeBase,
        unsafeOffsets,
        wideLengths,
        backingKinds: Object.fromEntries(Object.entries(references).filter(([, value]) => ArrayBuffer.isView(value)).map(([name, value]) => [name, value.buffer.constructor.name])),
        scoreColumn: chunk.scoreList.constructor.name,
        scoreBackingKind: chunk.scoreList.buffer?.constructor.name ?? null,
        countRepresentable: count > 0 && count < 65535,
        proposedBytes,
        existingCompactBytes,
        numericalAndSizeEligible: proposedBytes !== null && count > 0 && count < 65535 &&
        offsetsBeforeBase === 0 && unsafeOffsets === 0 && wideLengths === 0 && proposedBytes < existingCompactBytes};
    if (decoded.referenceCount !== undefined) {
        assert(receipt.numericalAndSizeEligible);
        assert.equal(decoded.referenceCount, count, 'The actual writer must preserve all private table entries');
        assert.equal(fields.byteLength, proposedBytes);
        for (let key = 0; key < count; ++key) {
            assert.equal(
                decoded.view.getUint32(decoded.offsetsStart + key * 4, true),
                references.offsets[key] === -1 ? 0xffffffff : references.offsets[key] - base,
            );
            assert.equal(decoded.view.getUint16(decoded.lengthsStart + key * 2, true), references.lengths[key]);
        }
        for (let row = 0; row < chunk.rowCount; ++row) {
            assert.equal(decoded.view.getUint16(decoded.keysStart + row * 2, true), references.uniqueIndexList[row], 'Private row ID was remapped');
        }
    }
    return receipt;
}

export function analyzeFields(bytes, count, format, metadata = {}) {
    const parsed = decodeFields(bytes, count, format);
    const expanded = expandReferenceFields(bytes, count, format);
    return {...metadata,
        count,
        format,
        bytes: bytes.byteLength,
        fieldsSha256: sha256(bytes),
        scoreCount: parsed.scoreCount,
        referenceCount: parsed.referenceCount ?? null,
        expandedFormat: format === 4 ? 2 : format,
        expandedBytes: expanded.byteLength,
        expandedSha256: sha256(expanded),
        actualSavedFieldBytes: expanded.byteLength - bytes.byteLength};
}

export function summarize(chunks) {
    const sum = (name) => chunks.reduce((total, chunk) => total + chunk[name], 0);
    const formatCounts = {};
    const rowsByFormat = {};
    const bytesByFormat = {};
    for (const chunk of chunks) {
        formatCounts[chunk.format] = (formatCounts[chunk.format] ?? 0) + 1;
        rowsByFormat[chunk.format] = (rowsByFormat[chunk.format] ?? 0) + chunk.count;
        bytesByFormat[chunk.format] = (bytesByFormat[chunk.format] ?? 0) + chunk.bytes;
    }
    return {chunks: chunks.length,
        rows: sum('count'),
        writtenFieldsBytes: sum('bytes'),
        expandedFieldsBytes: sum('expandedBytes'),
        actualSavedFieldBytes: sum('actualSavedFieldBytes'),
        format4Chunks: formatCounts[4] ?? 0,
        format4Rows: rowsByFormat[4] ?? 0,
        formatCounts,
        rowsByFormat,
        bytesByFormat};
}
