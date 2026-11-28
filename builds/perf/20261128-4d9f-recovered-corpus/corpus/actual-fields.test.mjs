import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {analyzeFields, decodeFields, expandReferenceFields, sha256} from './actual-fields.mjs';
import {expandedFileOracle} from './expanded-file-oracle.mjs';
import {digestStoredFiles} from './file-oracle.mjs';

function fixture() {
    const count = 128;
    const compact = Buffer.alloc(16 + 5 * 4 + count * 8);
    const references = Buffer.alloc(20 + 5 * 4 + 3 * 4 + 8 + count * 4);
    for (const [bytes, format, header] of [[compact, 2, 16], [references, 4, 20]]) {
        bytes.writeUInt32LE(format === 2 ? 0x3246524d : 0x3446524d, 0);
        bytes.writeUInt32LE(count, 4); bytes.writeUInt32LE(5, 8); bytes.writeUInt32LE(format, 12);
        for (let score = 0; score < 5; ++score) { bytes.writeInt32LE(score - 2, header + score * 4); }
    }
    references.writeUInt32LE(3, 16);
    for (let key = 0; key < 3; ++key) {
        references.writeUInt32LE([0xffffffff, 24, 84][key], 40 + key * 4);
        references.writeUInt16LE([7, 9, 11][key], 52 + key * 2);
    }
    for (let row = 0; row < count; ++row) {
        references.writeUInt16LE(row % 3, 60 + row * 2);
        references.writeUInt16LE(row % 5, 60 + count * 2 + row * 2);
        compact.writeUInt32LE([0xffffffff, 24, 84][row % 3], 36 + row * 4);
        compact.writeUInt16LE([7, 9, 11][row % 3], 36 + count * 4 + row * 2);
        compact.writeUInt16LE(row % 5, 36 + count * 6 + row * 2);
    }
    return {count, compact, references};
}

test('independent format4 expansion reproduces all explicit row values and old field bytes', () => {
    const {count, compact, references} = fixture();
    const parsed = decodeFields(references, count, 4);
    for (let row = 0; row < count; ++row) {
        assert.deepEqual(parsed.get(row), [[0xffffffff, 24, 84][row % 3], [7, 9, 11][row % 3], row % 5 - 2]);
    }
    assert.deepEqual(Buffer.from(expandReferenceFields(references, count, 4)), compact);
});

test('independent format4 oracle rejects invalid keys, padding, dimensions and truncated spans', () => {
    for (const kind of ['key', 'score', 'padding', 'count', 'references', 'truncation']) {
        const {count, references} = fixture();
        if (kind === 'key') { references.writeUInt16LE(3, 60); }
        if (kind === 'score') { references.writeUInt16LE(5, 60 + count * 2); }
        if (kind === 'padding') { references.writeUInt16LE(1, 58); }
        if (kind === 'count') { references.writeUInt32LE(count - 1, 4); }
        if (kind === 'references') { references.writeUInt32LE(65535, 16); }
        const bytes = kind === 'truncation' ? references.subarray(0, -1) : references;
        assert.throws(() => expandReferenceFields(bytes, count, 4), kind);
    }
});

test('final-file reread expands a complete stored container and detects unobserved byte changes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'manabitan-format4-oracle-'));
    try {
        const {count, compact, references} = fixture();
        const checksum = bytes => bytes.reduce((sum, value) => (sum + value) >>> 0, 0);
        const payload = Buffer.alloc(80);
        payload.writeUInt32LE(0x37494c4d, 0); payload.writeUInt32LE(7, 4);
        payload.writeUInt32LE(32, 8); payload.writeUInt32LE(32, 12);
        for (let i = 16; i < payload.length; ++i) { payload[i] = i; }
        const descriptor = Buffer.alloc(26);
        descriptor.write('MBTRD16X');
        for (let i = 0; i < 16; ++i) { descriptor[i + 8] = i + 1; }
        const header = Buffer.alloc(40);
        header.write('MBTIDX11'); header.writeBigUInt64LE(26n, 8);
        header.writeUInt32LE(1, 16); header.writeUInt32LE(count, 20);
        descriptor.copy(header, 24, 8, 24);
        const envelope = (fields, format) => {
            const chunkHeader = Buffer.alloc(40);
            chunkHeader.writeUInt32LE(1, 0); chunkHeader.writeUInt32LE(count, 4);
            chunkHeader.writeBigUInt64LE(16n, 8); chunkHeader.writeUInt32LE(payload.length, 16);
            chunkHeader.writeUInt32LE(32, 20); chunkHeader.writeUInt32LE(checksum(payload.subarray(16, 48)), 24);
            chunkHeader.writeUInt32LE(checksum(payload.subarray(48)), 28);
            chunkHeader.writeUInt32LE(checksum(fields), 32); chunkHeader.writeUInt32LE(format, 36);
            return Buffer.concat([chunkHeader, payload, fields]);
        };
        for (const [arm, fields, format] of [['off', compact, 2], ['on', references, 4]]) {
            await mkdir(path.join(root, arm, 'manabitan-term-records'), {recursive: true});
            await writeFile(path.join(root, arm, 'manabitan-term-records/dict.mbtr'), descriptor);
            await writeFile(path.join(root, arm, 'manabitan-term-records/dict.mbtr.mbti'), Buffer.concat([header, envelope(fields, format)]));
        }
        const expected = await digestStoredFiles(path.join(root, 'off'));
        const actual = await digestStoredFiles(path.join(root, 'on'));
        const chunk = analyzeFields(references, count, 4, {firstId: 1, contentOffsetBase: 16,
            lookupPayloadBytes: payload.byteLength, lookupPayloadSha256: sha256(payload),
            encodedEnvelopeSha256: sha256(envelope(references, 4))});
        const expanded = await expandedFileOracle(path.join(root, 'on'), actual, [chunk], checksum);
        assert.deepEqual(expanded.persisted, expected);
        assert.equal(expanded.actualSavedIndexBytes, compact.byteLength - references.byteLength);
        const damaged = Buffer.concat([header, envelope(references, 4)]);
        damaged[90] ^= 1;
        await writeFile(path.join(root, 'on', 'manabitan-term-records/dict.mbtr.mbti'), damaged);
        await assert.rejects(expandedFileOracle(path.join(root, 'on'), actual, [chunk], checksum));
    } finally { await rm(root, {recursive: true, force: true}); }
});
