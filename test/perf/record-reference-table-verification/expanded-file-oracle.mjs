// Bounded reread of final files, independent of the product's record-field reader.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {open} from 'node:fs/promises';
import path from 'node:path';
import {decodeFields, expandReferenceFields, fieldByteLength, sha256} from './actual-fields.mjs';

export async function expandedFileOracle(root, persisted, chunks, hashLookupBytes) {
    assert.equal(persisted.generationLinkageVerified, true);
    const expected = new Map(chunks.map((chunk) => [chunk.firstId, chunk]));
    assert.equal(expected.size, chunks.length);
    const seen = new Set();
    const files = [];
    let savedBytes = 0;
    for (const file of persisted.files) {
        if (!file.path.endsWith('.mbtr.mbti')) {
            files.push(file);
            continue;
        }
        assert.deepEqual(file.normalizedGenerationRange, [24, 40], 'This exact index generation must have been independently linked');
        const handle = await open(path.join(root, file.path), 'r');
        const read = async (position, length) => {
            assert(Number.isSafeInteger(position) && position >= 0 && Number.isSafeInteger(length) && length >= 0);
            assert(length <= file.bytes - position, 'File range may not be clipped');
            const bytes = Buffer.allocUnsafe(length);
            let total = 0;
            while (total < length) {
                const {bytesRead} = await handle.read(bytes, total, length - total, position + total);
                assert(bytesRead > 0, 'Unexpected end of persisted file');
                total += bytesRead;
            }
            return bytes;
        };
        try {
            assert.equal((await handle.stat()).size, file.bytes);
            const header = await read(0, 40);
            assert.equal(header.subarray(0, 8).toString(), 'MBTIDX11');
            const descriptor = persisted.files.find((item) => item.path === file.path.slice(0, -5));
            assert(descriptor);
            assert.deepEqual(descriptor.normalizedGenerationRange, [8, 24]);
            assert.equal(header.readBigUInt64LE(8), BigInt(descriptor.bytes));
            const chunkCount = header.readUInt32LE(16);
            const recordCount = header.readUInt32LE(20);
            const normalized = createHash('sha256');
            // Paired generation linkage was already validated by the raw oracle.
            header.fill(0, 24, 40);
            normalized.update(header);
            let cursor = 40;
            let expandedBytes = 40;
            let readChunks = 0;
            let readRecords = 0;
            while (cursor < file.bytes) {
                const chunkHeader = await read(cursor, 40);
                const firstId = chunkHeader.readUInt32LE(0);
                const count = chunkHeader.readUInt32LE(4);
                const payloadLength = chunkHeader.readUInt32LE(16);
                const baseLength = chunkHeader.readUInt32LE(20);
                const format = chunkHeader.readUInt32LE(36);
                const item = expected.get(firstId);
                assert(item && !seen.has(firstId));
                assert.equal(count, item.count);
                assert.equal(payloadLength, item.lookupPayloadBytes);
                assert.equal(Number(chunkHeader.readBigUInt64LE(8)), item.contentOffsetBase);
                assert.equal(format, item.format);
                assert(count > 0 && baseLength > 0 && baseLength < payloadLength);
                cursor += 40;
                const payload = await read(cursor, payloadLength);
                cursor += payloadLength;
                assert.equal(sha256(payload), item.lookupPayloadSha256);
                assert.equal(payload.readUInt32LE(0), 0x37494c4d);
                assert([7, 8].includes(payload.readUInt32LE(4)));
                assert.equal(payload.readUInt32LE(8), baseLength);
                const derivedLength = payload.readUInt32LE(12);
                assert(baseLength >= 32 && derivedLength >= 32);
                assert.equal(16 + baseLength + derivedLength, payload.byteLength);
                assert.equal(hashLookupBytes(payload.subarray(16, 16 + baseLength)), chunkHeader.readUInt32LE(24));
                assert.equal(hashLookupBytes(payload.subarray(16 + baseLength)), chunkHeader.readUInt32LE(28));
                const fieldHeader = format === 2 || format === 4 ? await read(cursor, format === 4 ? 20 : 16) : new Uint8Array();
                const fieldsLength = fieldByteLength(fieldHeader, count, format);
                assert.equal(fieldsLength, item.bytes);
                const fields = await read(cursor, fieldsLength);
                cursor += fieldsLength;
                assert.equal(sha256(fields), item.fieldsSha256);
                assert.equal(hashLookupBytes(fields), chunkHeader.readUInt32LE(32));
                assert.equal(createHash('sha256').update(chunkHeader).update(payload)
                    .update(fields)
                    .digest('hex'), item.encodedEnvelopeSha256);
                const decoded = decodeFields(fields, count, format);
                for (let row = 0; row < count; ++row) { decoded.get(row); }
                const expanded = expandReferenceFields(fields, count, format);
                assert.equal(sha256(expanded), item.expandedSha256);
                assert.equal(expanded.byteLength, item.expandedBytes);
                if (format === 4) {
                    chunkHeader.writeUInt32LE(hashLookupBytes(expanded), 32);
                    chunkHeader.writeUInt32LE(2, 36);
                }
                normalized.update(chunkHeader).update(payload).update(expanded);
                expandedBytes += 40 + payloadLength + expanded.byteLength;
                seen.add(firstId);
                ++readChunks;
                readRecords += count;
            }
            assert.equal(cursor, file.bytes);
            assert.equal(readChunks, chunkCount);
            assert.equal(readRecords, recordCount);
            savedBytes += expandedBytes - file.bytes;
            files.push({...file, bytes: expandedBytes, sha256: normalized.digest('hex')});
        } finally { await handle.close(); }
    }
    assert.equal(seen.size, chunks.length, 'Every encoded chunk must be present in the final files');
    assert.equal(savedBytes, chunks.reduce((sum, item) => sum + item.actualSavedFieldBytes, 0));
    return {persisted: {...persisted, files},
        verifiedChunks: seen.size,
        actualSavedIndexBytes: savedBytes,
        boundary: 'Every actual final index chunk is reread, checked against encoder receipts, and expanded independently to format2; checksums use the unchanged baseline hash. Only independently linked generation identifiers are normalized.'};
}
