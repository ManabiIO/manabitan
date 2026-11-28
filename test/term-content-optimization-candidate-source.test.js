/* SPDX-License-Identifier: GPL-3.0-or-later */

import {expect, test} from 'vitest';
import {inspectSharedGlossaryTrainingArtifact, inspectTermContentTrainingReference} from '../ext/js/dictionary/term-content-optimization-candidate-source.js';
import {encodeRawTermContentBlockReference, encodeRawTermContentCompactBlockReference} from '../ext/js/dictionary/raw-term-content.js';

/** @typedef {import('../ext/js/dictionary/term-content-layout.js').FrameIdentity} FrameIdentity */
/** @typedef {import('../ext/js/dictionary/term-content-optimization-checkpoint.js').OnlineContentFrameDescriptor} FrameDescriptor */

/** @typedef {import('../ext/js/dictionary/term-content-optimization-candidate-source.js').CandidateFrameSource} CandidateFrameSource */
/** @typedef {{source: CandidateFrameSource, handlers: CandidateFrameSource, readSlice: Array<[number, number]>, describe: FrameIdentity[], findOverride: Array<{kind: FrameIdentity['kind'], logicalOffset: number, recordLength: number, originalCodecId: string|null}>}} SourceFixture */

/**
 * @param {Uint8Array} bytes
 * @param {{codecId?: string|null, override?: FrameIdentity|null, base?: number, highWater?: number}} [options]
 * @returns {SourceFixture}
 */
function fixture(bytes, {codecId = null, override = null, base = 0, highWater = base + bytes.length} = {}) {
    /** @type {Array<[number, number]>} */
    const readSlice = [];
    /** @type {FrameIdentity[]} */
    const describe = [];
    /** @type {SourceFixture['findOverride']} */
    const findOverride = [];
    /** @type {CandidateFrameSource} */
    const handlers = {
        logicalHighWater: highWater,
        readSlice: async (offset, length) => bytes.slice(offset - base, offset - base + length),
        assertCurrent: () => {},
        findOverride: async () => override,
        describe: async (identity) => ({identity: {...identity},
            physicalKey: 'immutable:' + identity.logicalOffset,
            storedLength: identity.sourceStoredLength,
            codecId,
            envelope: identity.originalEnvelope,
            decodedLength: identity.expectedDecodedLength,
            decodedDigest: null}),
    };
    /** @type {CandidateFrameSource} */
    const source = {
        logicalHighWater: highWater,
        readSlice: async (offset, length) => {
            readSlice.push([offset, length]);
            return await handlers.readSlice(offset, length);
        },
        assertCurrent: () => { handlers.assertCurrent(); },
        findOverride: async (query) => {
            findOverride.push(query);
            return await handlers.findOverride(query);
        },
        describe: async (identity) => {
            describe.push(identity);
            return await handlers.describe(identity);
        },
    };
    return {source, handlers, readSlice, findOverride, describe};
}

/**
 * @param {string} selector
 * @param {number} [offset]
 * @param {number} [length]
 * @returns {import('../ext/js/dictionary/term-record-opfs-store.js').ContentReference}
 */
function reference(selector, offset = 0, length = 64) {
    return {recordId: 1, entryContentOffset: offset, entryContentLength: length, entryContentDictName: selector};
}

/**
 * @param {Uint8Array} encoded
 * @param {number} [offset]
 * @returns {SourceFixture}
 */
function blockFixture(encoded, offset = 32) {
    const bytes = new Uint8Array(512);
    bytes.set(encoded, offset);
    return fixture(bytes);
}

test('compact and legacy block references read their physical reference size, not decoded entry length', async () => {
    for (const compact of [true, false]) {
        const encoded = compact ? encodeRawTermContentCompactBlockReference(200, 64, 256, 0) : encodeRawTermContentBlockReference(200, 64, 256, 0, 64);
        const f = blockFixture(encoded);
        const result = await inspectTermContentTrainingReference(f.source, reference(compact ? 'raw-block-v2' : 'raw-block-v1', 32), new AbortController().signal);
        expect(f.readSlice).toContainEqual([32, compact ? 20 : 28]);
        expect(result).toMatchObject({kind: 'frame',
            frame: {identity: {kind: 'block',
                logicalOffset: 200,
                recordLength: 64,
                sourceStoredLength: 64,
                expectedDecodedLength: 256,
                originalCodecId: null,
                originalEnvelope: 'mbc2'}}});
    }
});

test('references to the same globally shared block retain one identical frame identity', async () => {
    const bytes = new Uint8Array(512);
    bytes.set(encodeRawTermContentCompactBlockReference(200, 64, 256, 0), 0);
    bytes.set(encodeRawTermContentCompactBlockReference(200, 64, 256, 64), 20);
    const f = fixture(bytes);
    const first = await inspectTermContentTrainingReference(f.source, reference('raw-block-v2'), new AbortController().signal);
    const second = await inspectTermContentTrainingReference(f.source, reference('raw-block-v2', 20), new AbortController().signal);
    expect(first).toEqual(second);
});

test('actual resolved codec excludes custom frames even when the legacy selector collides with its ID', async () => {
    const collidingId = 'manabitan-zstd-' + 'a'.repeat(64);
    const fixtureFromReference = () => blockFixture(encodeRawTermContentCompactBlockReference(200, 64, 256, 0));
    const f = fixtureFromReference();
    f.handlers.describe = async (identity) => ({identity,
        physicalKey: 'custom:file',
        storedLength: 40,
        codecId: collidingId,
        envelope: 'none',
        decodedLength: 256,
        decodedDigest: 'a'.repeat(64)});
    const signal = new AbortController().signal;
    const generic = await inspectTermContentTrainingReference(fixtureFromReference().source, reference('raw-block-v2:' + collidingId, 32), signal);
    expect(generic).toMatchObject({kind: 'frame', frame: {identity: {originalCodecId: null}, codecId: null}});
    await expect(inspectTermContentTrainingReference(f.source, reference('raw-block-v2:' + collidingId, 32), signal))
        .resolves.toEqual({kind: 'skip', reason: 'custom'});
    expect(f.describe[0].originalCodecId).toBeNull();
});

test.each(['raw', 'raw-v2', 'raw-v3', 'raw-v4', 'raw-v6'])('raw entry selector %s never becomes a compression frame', async (selector) => {
    const f = fixture(new Uint8Array(0));
    await expect(inspectTermContentTrainingReference(f.source, reference(selector), new AbortController().signal))
        .resolves.toEqual({kind: 'skip', reason: 'raw'});
    expect(f.readSlice).toHaveLength(0);
    expect(f.findOverride).toHaveLength(0);
    expect(f.describe).toHaveLength(0);
});

test('invalid compact reference bounds fail before any frame can be checkpointed', async () => {
    const f = blockFixture(encodeRawTermContentCompactBlockReference(200, 64, 256, 240));
    await expect(inspectTermContentTrainingReference(f.source, reference('raw-block-v2', 32), new AbortController().signal)).rejects.toThrow(/reference is inconsistent/);
    expect(f.describe).toHaveLength(0);
});

test('legacy decoded record length is never substituted for its exact stored frame span', async () => {
    const bytes = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x20, 4, 0x21, 0, 0, 1, 2, 3, 4]);
    const f = fixture(bytes);
    const result = await inspectTermContentTrainingReference(f.source, reference('', 0, 999), new AbortController().signal);
    expect(result).toMatchObject({kind: 'frame',
        frame: {identity: {kind: 'legacy-entry',
            recordLength: 999,
            sourceStoredLength: 13,
            expectedDecodedLength: null},
        storedLength: 13,
        decodedLength: 4}});
    expect(f.readSlice.every(([, length]) => length <= 18)).toBe(true);
});

test('a published legacy override resolves before reading obsolete original logical bytes', async () => {
    /** @type {FrameIdentity} */
    const override = {kind: 'legacy-entry',
        logicalOffset: 0,
        recordLength: 999,
        sourceStoredLength: 13,
        originalCodecId: null,
        expectedDecodedLength: null,
        originalEnvelope: 'none'};
    const f = fixture(new Uint8Array(0), {codecId: 'trained', override});
    f.handlers.readSlice = async () => { throw new Error('Original frame interval has already been reclaimed'); };
    await expect(inspectTermContentTrainingReference(f.source, reference('', 0, 999), new AbortController().signal))
        .resolves.toEqual({kind: 'skip', reason: 'custom'});
    expect(f.readSlice).toHaveLength(0);
});

test('named legacy preset codec skips metadata scanning when no override replaced it', async () => {
    const f = fixture(new Uint8Array(0));
    await expect(inspectTermContentTrainingReference(f.source, reference('jmdict'), new AbortController().signal))
        .resolves.toEqual({kind: 'skip', reason: 'custom'});
    expect(f.findOverride).toContainEqual({kind: 'legacy-entry', logicalOffset: 0, recordLength: 64, originalCodecId: 'jmdict'});
    expect(f.readSlice).toHaveLength(0);
});

test('legacy header walks resume after unrelated appends without consuming trailing records', async () => {
    const bytes = new Uint8Array(6 + 65 * 4);
    bytes.set([0x28, 0xb5, 0x2f, 0xfd, 0x20, 65]);
    for (let index = 0; index < 65; ++index) { bytes.set([index === 64 ? 9 : 8, 0, 0, 7], 6 + index * 4); }
    const f = fixture(bytes);
    const first = await inspectTermContentTrainingReference(f.source, reference('', 0, 65), new AbortController().signal);
    expect(first.kind).toBe('pending');
    if (first.kind !== 'pending') { throw new Error('Expected a durable metadata cursor'); }
    const restarted = fixture(bytes, {highWater: bytes.length + 100});
    const second = await inspectTermContentTrainingReference(restarted.source, reference('', 0, 65), new AbortController().signal, JSON.parse(JSON.stringify(first.cursor)));
    expect(second).toMatchObject({kind: 'frame', frame: {identity: {sourceStoredLength: bytes.length}, decodedLength: 65}});
});

test('foreground abort after reference I/O prevents frame resolution and publication', async () => {
    const f = blockFixture(encodeRawTermContentCompactBlockReference(200, 64, 256, 0));
    const controller = new AbortController();
    f.handlers.readSlice = async () => {
        controller.abort();
        return encodeRawTermContentCompactBlockReference(200, 64, 256, 0);
    };
    await expect(inspectTermContentTrainingReference(f.source, reference('raw-block-v2', 32), controller.signal)).rejects.toMatchObject({name: 'AbortError'});
    expect(f.describe).toHaveLength(0);
});

test('compressed raw-v4 shared glossary is distinct from untouched raw entry headers', async () => {
    const f = fixture(new Uint8Array(0));
    await expect(inspectSharedGlossaryTrainingArtifact(f.source, {contentOffset: 400,
        contentLength: 100,
        contentDictName: 'raw-v4',
        uncompressedLength: 10000}, new AbortController().signal))
        .resolves.toMatchObject({kind: 'frame',
            frame: {identity: {kind: 'shared-glossary',
                logicalOffset: 400,
                recordLength: 100,
                sourceStoredLength: 100,
                expectedDecodedLength: 10000,
                originalCodecId: null,
                originalEnvelope: 'none'}}});
    expect(f.readSlice).toHaveLength(0);
});


test('generation replacement after awaited reference I/O preserves the stale failure and stops discovery', async () => {
    const f = blockFixture(encodeRawTermContentCompactBlockReference(200, 64, 256, 0));
    let current = true;
    const stale = new Error('Target dictionary generation was replaced');
    f.handlers.assertCurrent = () => {
        if (!current) { throw stale; }
    };
    f.handlers.readSlice = async () => {
        current = false;
        return encodeRawTermContentCompactBlockReference(200, 64, 256, 0);
    };
    await expect(inspectTermContentTrainingReference(f.source, reference('raw-block-v2', 32), new AbortController().signal)).rejects.toBe(stale);
    expect(f.describe).toHaveLength(0);
});

test('already custom shared glossary frames are excluded by their actual codec', async () => {
    const f = fixture(new Uint8Array(0), {codecId: 'shared-trained-codec', highWater: 500});
    await expect(inspectSharedGlossaryTrainingArtifact(f.source, {contentOffset: 400,
        contentLength: 100,
        contentDictName: 'raw-v4',
        uncompressedLength: 10000}, new AbortController().signal))
        .resolves.toEqual({kind: 'skip', reason: 'custom'});
    expect(f.readSlice).toHaveLength(0);
});


test.each(['unrecognized-label', '任意の自作辞書'])('vanilla legacy content remains eligible with stored label %s', async (label) => {
    const bytes = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x20, 4, 0x21, 0, 0, 1, 2, 3, 4]);
    const f = fixture(bytes);
    await expect(inspectTermContentTrainingReference(f.source, reference(label, 0, 999), new AbortController().signal))
        .resolves.toMatchObject({kind: 'frame', frame: {codecId: null, identity: {originalCodecId: null, sourceStoredLength: 13}}});
    expect(f.findOverride[0].originalCodecId).toBeNull();
});

test.each(['unrecognized-label', '任意の自作辞書'])('block reference label %s uses its actual vanilla decoder identity', async (label) => {
    const f = blockFixture(encodeRawTermContentCompactBlockReference(200, 64, 256, 0));
    await expect(inspectTermContentTrainingReference(f.source, reference('raw-block-v2:' + label, 32), new AbortController().signal))
        .resolves.toMatchObject({kind: 'frame', frame: {codecId: null, identity: {originalCodecId: null}}});
});
