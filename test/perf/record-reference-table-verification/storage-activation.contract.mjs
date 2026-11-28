/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {collectReferenceFormatActivation} from './storage-activation.mjs';

const descriptorPath = 'manabitan-term-records/dict-1.mbtr';
const indexPath = `${descriptorPath}.mbti`;
const poolPrefix = 'manabitan/sqlite-sahpool-v1/.opaque/';
const mainPath = `${poolPrefix}main`;

function associate(bytes, logicalPath, flags) {
    bytes.fill(0, 0, 524);
    bytes.write(logicalPath, 0);
    bytes.writeUInt32BE(flags, 512);
    let h1 = 0;
    let h2 = 0;
    if (flags & 0x80) {
        h1 = 3735928559;
        h2 = 1103547991;
        for (const value of bytes.subarray(0, 516)) {
            h1 = Math.imul(h1 ^ value, 2654435761);
            h2 = Math.imul(h2 ^ value, 104729);
        }
    }
    bytes.writeUInt32LE(h1 >>> 0, 516);
    bytes.writeUInt32LE(h2 >>> 0, 520);
    return bytes;
}

function sqlite(floor) {
    const bytes = associate(Buffer.alloc(4608), '/dict.sqlite3', 0x186);
    bytes.write('SQLite format 3\0', 4096);
    bytes.writeUInt16BE(512, 4112);
    bytes[4114] = 1;
    bytes[4115] = 1;
    bytes[4117] = 64;
    bytes[4118] = 32;
    bytes[4119] = 32;
    bytes.writeUInt32BE(1, 4120);
    bytes.writeUInt32BE(1, 4124);
    bytes.writeUInt32BE(floor, 4156);
    bytes.writeUInt32BE(1, 4188);
    return bytes;
}

function fixture({formats = [4], requestedFlag = true, floor = 12, generationMedia = null} = {}) {
    const descriptor = Buffer.alloc(26);
    descriptor.write('MBTRD16X');
    for (let i = 8; i < 24; ++i) { descriptor[i] = i; }
    const header = Buffer.alloc(40);
    header.write('MBTIDX11');
    header.writeBigUInt64LE(26n, 8);
    header.writeUInt32LE(formats.length, 16);
    header.writeUInt32LE(formats.length * 128, 20);
    descriptor.copy(header, 24, 8, 24);
    const parts = [header];
    for (let index = 0; index < formats.length; ++index) {
        const format = formats[index];
        const chunk = Buffer.alloc(40);
        chunk.writeUInt32LE(1 + index * 128, 0);
        chunk.writeUInt32LE(128, 4);
        chunk.writeBigUInt64LE(16n, 8);
        chunk.writeUInt32LE(80, 16);
        chunk.writeUInt32LE(32, 20);
        chunk.writeUInt32LE(format, 36);
        const payload = Buffer.alloc(80);
        payload.writeUInt32LE(0x37494c4d, 0);
        payload.writeUInt32LE(7, 4);
        payload.writeUInt32LE(32, 8);
        payload.writeUInt32LE(32, 12);
        const bytes = format === 4 ?
20 + 5 * 4 + 3 * 4 + 8 + 128 * 4 :
            (format === 2 ? 16 + 5 * 4 + 128 * 8 : 128 * (format === 3 ? 16 : 12));
        const fields = Buffer.alloc(bytes);
        if (format === 2 || format === 4) {
            fields.writeUInt32LE(format === 4 ? 0x3446524d : 0x3246524d, 0);
            fields.writeUInt32LE(128, 4);
            fields.writeUInt32LE(5, 8);
            fields.writeUInt32LE(format, 12);
            if (format === 4) { fields.writeUInt32LE(3, 16); }
        }
        parts.push(chunk, payload, fields);
    }
    return {data: new Map([[descriptorPath, descriptor],
        [indexPath, Buffer.concat(parts)],
        [mainPath, sqlite(floor)],
        [`${poolPrefix}empty`, Buffer.alloc(4096)]]),
    options: {totalRows: formats.length * 128, requestedFlag, generationMedia},
    reads: []};
}

function source(input, mutateOnSecondRead = null) {
    const counts = new Map();
    const directory = (prefix) => ({
        async getDirectoryHandle(name, options) {
            assert.equal(options, undefined, 'Read-only observer must not create directories');
            return directory(`${prefix}${name}/`);
        },
        async getFileHandle(name, options) {
            assert.equal(options, undefined, 'Read-only observer must not create files');
            const filePath = `${prefix}${name}`;
            assert(input.data.has(filePath));
            return {async getFile() {
                const calls = (counts.get(filePath) ?? 0) + 1;
                counts.set(filePath, calls);
                if (calls === 2) { mutateOnSecondRead?.(filePath, input.data.get(filePath)); }
                const bytes = Buffer.from(input.data.get(filePath));
                return {size: bytes.length,
                    slice(start, end) {
                        input.reads.push({filePath, start, length: end - start});
                        return new Blob([bytes.subarray(start, end)]);
                    }};
            }};
        },
    });
    return directory('');
}

function run(input, mutate = null) {
    return collectReferenceFormatActivation({...input.options,
        files: [...input.data].map(([filePath, bytes]) => ({path: filePath, bytes: bytes.length}))}, source(input, mutate));
}

test('counts every mixed-format chunk and links actual descriptors to the index generation', async () => {
    const input = fixture({formats: [1, 2, 3, 4]});
    const receipt = await run(input);
    assert.equal(receipt.totalRows, 512);
    assert.equal(receipt.chunks, 4);
    assert.deepEqual(receipt.formatCounts, {'1': 1, '2': 1, '3': 1, '4': 1});
    assert.deepEqual(receipt.formatRows, {'1': 128, '2': 128, '3': 128, '4': 128});
    assert.equal(receipt.format4Rows, 128);
    assert.equal(receipt.floor, 12);
    assert.equal(receipt.database.logicalPath, '/dict.sqlite3');
    assert.equal(receipt.timingEligible, false);
    assert(input.reads.every(({length}) => length <= 4196));
    assert.equal(input.reads.reduce((sum, {length}) => sum + length, 0), receipt.readBytes);
});

test('default-off, enabled no-gain fallback and packed-media reader floors remain distinct', async () => {
    const generationMedia = {version: 2, count: 146570, dataBytes: 188131284};
    for (const [requestedFlag, formats, floor, media] of [
        [false, [2], 10, null],
        [true, [2], 10, null],
        [false, [2], 11, generationMedia],
        [true, [4], 12, generationMedia],
    ]) {
        const receipt = await run(fixture({requestedFlag, formats, floor, generationMedia: media}));
        assert.equal(receipt.floor, floor);
        assert.equal(receipt.minimumFloor, floor);
        assert.equal(receipt.requestedFlag, requestedFlag);
    }
    await assert.rejects(run(fixture({requestedFlag: false})), /disabled/);
    await assert.rejects(run(fixture({floor: 11})), /below actual persisted formats/);
    await assert.rejects(run(fixture({formats: [2], floor: 10, generationMedia})), /below actual persisted formats/);
});

test('malformed authoritative framing, dimensions, formats and row intervals fail closed', async () => {
    const mutations = [
        (b) => { b[0] ^= 1; },
        (b) => { b.writeBigUInt64LE(27n, 8); },
        (b) => { b.writeUInt32LE(2, 16); },
        (b) => { b.writeUInt32LE(127, 20); },
        (b) => { b[24] ^= 1; },
        (b) => { b.writeUInt32LE(0, 40); },
        (b) => { b.writeUInt32LE(0, 44); },
        (b) => { b.writeUInt32LE(0xffffffff, 40); },
        (b) => { b.writeBigUInt64LE(0x20000000000000n, 48); },
        (b) => { b.writeUInt32LE(0xffffffff, 56); },
        (b) => { b.writeUInt32LE(1, 60); },
        (b) => { b.writeUInt32LE(5, 76); },
        (b) => { b[80] ^= 1; },
        (b) => { b.writeUInt32LE(6, 84); },
        (b) => { b.writeUInt32LE(33, 88); },
        (b) => { b[160] ^= 1; },
        (b) => { b.writeUInt32LE(127, 164); },
        (b) => { b.writeUInt32LE(0, 168); },
        (b) => { b.writeUInt32LE(65535, 168); },
        (b) => { b.writeUInt32LE(2, 172); },
        (b) => { b.writeUInt32LE(0, 176); },
        (b) => { b.writeUInt32LE(65535, 176); },
        (b) => { b.writeUInt32LE(128, 176); },
    ];
    for (const mutation of mutations) {
        const input = fixture();
        mutation(input.data.get(indexPath));
        await assert.rejects(run(input), /Reference-format activation/);
    }
    for (const length of [0, 8, 39, 79, 159, 179, 200]) {
        const input = fixture();
        input.data.set(indexPath, input.data.get(indexPath).subarray(0, length));
        await assert.rejects(run(input), /Reference-format activation/);
    }
    const gap = fixture({formats: [4, 4]});
    const second = 40 + 40 + 80 + (20 + 20 + 12 + 8 + 512);
    gap.data.get(indexPath).writeUInt32LE(130, second);
    await assert.rejects(run(gap), /Noncontiguous/);
});

test('SQLite floor requires a valid unique association, valid main header and no live recovery overlay', async () => {
    const mutations = [
        (b) => { b[516] ^= 1; },
        (b) => { b.fill(65, 0, 512); },
        (b) => { associate(b, '/other.sqlite3', 0x186); },
        (b) => { associate(b, '/dict.sqlite3', 0x80); },
        (b) => { associate(b, '/dict.sqlite3', 0x18e); },
        (b) => { associate(b, '', 0); },
        (b) => { b[4096] ^= 1; },
        (b) => { b.writeUInt16BE(513, 4112); },
        (b) => { b[4114] = 2; },
        (b) => { b[4115] = 2; },
        (b) => { b[4117] = 63; },
        (b) => { b.writeUInt32BE(2, 4124); },
        (b) => { b.writeUInt32BE(2, 4188); },
        (b) => { b.writeUInt32BE(9, 4156); },
        (b) => { b.writeUInt32BE(13, 4156); },
    ];
    for (const mutation of mutations) {
        const input = fixture();
        mutation(input.data.get(mainPath));
        await assert.rejects(run(input), /Reference-format activation/);
    }
    for (const length of [0, 523, 4095, 4195]) {
        const input = fixture();
        input.data.set(mainPath, input.data.get(mainPath).subarray(0, length));
        await assert.rejects(run(input), /Reference-format activation/);
    }
    const duplicate = fixture();
    duplicate.data.set(`${poolPrefix}duplicate`, sqlite(12));
    await assert.rejects(run(duplicate), /Duplicate SQLite/);
    const wal = fixture();
    wal.data.set(`${poolPrefix}wal`, associate(Buffer.alloc(4128), '/dict.sqlite3-wal', 0x80086));
    await assert.rejects(run(wal), /Live WAL/);
    const journal = fixture();
    const journalBytes = associate(Buffer.alloc(4608), '/dict.sqlite3-journal', 0x886);
    journalBytes[4096] = 1;
    journal.data.set(`${poolPrefix}journal`, journalBytes);
    await assert.rejects(run(journal), /Hot rollback journal/);
    journalBytes[4096] = 0;
    assert.equal((await run(journal)).floor, 12);
});

test('file size/header races, unpaired files, clipped ranges and inventory traversal fail closed', async () => {
    await assert.rejects(run(fixture(), (name, bytes) => {
        if (name === indexPath) { bytes[0] ^= 1; }
    }), /changed during observation/);
    await assert.rejects(run(fixture(), (name, bytes) => {
        if (name === mainPath) { bytes[4156] ^= 1; }
    }), /changed during observation/);
    const unpaired = fixture();
    unpaired.data.set('manabitan-term-records/unused.mbtr', Buffer.alloc(26));
    await assert.rejects(run(unpaired), /unpaired/);
    const traversal = fixture();
    traversal.data.set('manabitan-term-records/../bad', Buffer.alloc(26));
    await assert.rejects(run(traversal), /Noncanonical inventory/);
    const duplicate = fixture();
    const files = [...duplicate.data].map(([filePath, bytes]) => ({path: filePath, bytes: bytes.length}));
    await assert.rejects(collectReferenceFormatActivation({...duplicate.options, files: [...files, files[0]]}, source(duplicate)), /Duplicate inventory/);
    files[0].bytes += 1;
    await assert.rejects(collectReferenceFormatActivation({...duplicate.options, files}, source(duplicate)), /size changed/);
});
