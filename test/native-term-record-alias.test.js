/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {describe, expect, test, vi} from 'vitest';
import {tryCreateNativeTermRecordAliases} from '../ext/js/dictionary/native-term-record-alias.js';
import {TermContentBlockImportSession, TermContentBlockStore} from '../ext/js/dictionary/term-content-block-store.js';
import {TermContentOpfsStore} from '../ext/js/dictionary/term-content-opfs-store.js';
import {TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js';
import {createNativeRecordFixture, createNativeRecordGate, receiveNativeRecordFixture} from './util/native-term-record-fixture.js';

/** @typedef {import('../ext/js/dictionary/dictionary-database.js').ArtifactTermRecordChunk} RecordChunk */
/**
 * @typedef {{
 * owner: import('../ext/js/dictionary/native-term-record-ownership.js').NativeTermRecordImportOwner,
 * chunk: RecordChunk, recordChunk: RecordChunk, plan: NonNullable<RecordChunk['contentDedupPlan']>, names: string[],
 * blockSession: TermContentBlockImportSession,
 * append: import('vitest').MockInstance<TermContentBlockImportSession['append']>,
 * read: import('vitest').Mock<() => Promise<Uint8Array|null>>,
 * validateOwner: import('vitest').Mock<() => void>,
 * aliasOwner: import('../ext/js/dictionary/native-term-record-alias.js').NativeRecordAliasOwner,
 * rawBytes: Uint8Array,
 * }} AliasFixture
 */

/**
 * @param {{rawEntries?: number, rawLength?: number}} [options]
 * @returns {AliasFixture}
 */
function createFixture(options = {}) {
    const {source, rawBytes} = createNativeRecordFixture(options);
    const {owner, lease, chunk, recordChunk} = receiveNativeRecordFixture(source);
    const blockStore = new TermContentBlockStore(new TermContentOpfsStore());
    const blockSession = new TermContentBlockImportSession(blockStore);
    Reflect.get(blockSession, '_blockEnabledDictionaries').add(chunk.dictionary);
    const append = vi.spyOn(blockSession, 'append').mockImplementation(async (_dictionary, bytes) => ({
        contentOffsets: Float64Array.from(bytes, (_, index) => 10000 + index * 20),
        contentLengths: Uint32Array.from(bytes, (entry) => entry.byteLength),
        contentDictName: 'raw-block-v2',
        compressedBytes: 5,
        uncompressedBytes: bytes.reduce((sum, entry) => sum + entry.byteLength, 0),
        packMs: 0,
        compressMs: 0,
        envelopeMs: 0,
        referenceMs: 0,
        opfsAppendMs: 0,
    }));
    const read = vi.fn(async () => /** @type {Uint8Array|null} */ (rawBytes));
    const validateOwner = vi.fn(() => {});
    const aliasOwner = {sourceChunk: chunk, lease, validateOwner};
    const plan = /** @type {NonNullable<typeof chunk.contentDedupPlan>} */ (chunk.contentDedupPlan);
    const names = /** @type {string[]} */ (plan.resolvedDictNames);
    return {owner, chunk, recordChunk, plan, names, blockSession, append, read, validateOwner, aliasOwner, rawBytes};
}

/**
 * @param {ReturnType<typeof createFixture>} fixture
 * @returns {ReturnType<typeof tryCreateNativeTermRecordAliases>}
 */
function startAliases(fixture) {
    return tryCreateNativeTermRecordAliases(fixture.aliasOwner, fixture.recordChunk, fixture.names, fixture.blockSession, null, fixture.read);
}

describe('bounded native term-record aliases', () => {
    test('copies only record offsets and preserves canonical metadata and complete prepared bytes', async () => {
        const fixture = createFixture();
        const canonicalOffsets = new Float64Array(fixture.plan.resolvedOffsets);
        const canonicalNames = [...fixture.names];
        const result = await startAliases(fixture);
        expect(result).not.toBeNull();
        expect(result?.contentDictName).toBe('raw-block-v2');
        expect(result?.chunk.resolvedContentReferences?.offsets).toStrictEqual(new Float64Array([10000, 108]));
        expect(result?.chunk.resolvedContentReferences?.lengths).toBe(fixture.plan.resolvedLengths);
        expect(result?.chunk.preparedLookupIndexes).toBe(fixture.chunk.preparedLookupIndexes);
        expect(result?.chunk.termRecordPreinternedPlan).toBe(fixture.chunk.termRecordPreinternedPlan);
        expect(fixture.plan.resolvedOffsets).toStrictEqual(canonicalOffsets);
        expect(fixture.names).toStrictEqual(canonicalNames);
        expect(fixture.read).toHaveBeenCalledWith(100, 8, 'raw-v6');
        expect(fixture.append.mock.calls[0][1][0]).toStrictEqual(fixture.rawBytes);
        expect(fixture.append.mock.calls[0][1][0].buffer).not.toBe(fixture.rawBytes.buffer);
    });

    test('reads and aliases an identical canonical raw reference only once per group', async () => {
        const fixture = createFixture({rawEntries: 2});
        fixture.plan.resolvedOffsets[1] = fixture.plan.resolvedOffsets[0];
        const result = await startAliases(fixture);
        expect(fixture.read).toHaveBeenCalledTimes(1);
        expect(fixture.append.mock.calls[0][1]).toHaveLength(1);
        expect(result?.aliasCount).toBe(1);
        expect(result?.inputBytes).toBe(8);
        expect(result?.chunk.resolvedContentReferences?.offsets).toStrictEqual(new Float64Array([10000, 10000, 116]));
    });

    test.each(['unwitnessed', 'uniform', 'unselected', 'other-format', 'other-family', 'unresolved', 'replaced-resolution'])('keeps %s calls on the synchronous fallback', (kind) => {
        const fixture = createFixture();
        if (kind === 'unwitnessed') { fixture.aliasOwner.lease = {}; }
        if (kind === 'uniform') { fixture.names.fill('raw-v6'); }
        if (kind === 'unselected') { Reflect.get(fixture.blockSession, '_blockEnabledDictionaries').clear(); }
        if (kind === 'other-format') { fixture.names[0] = 'raw-v2'; }
        if (kind === 'other-family') { fixture.names[1] = 'raw-block-v2:jmdict'; }
        if (kind === 'unresolved') { fixture.plan.resolvedFlags[0] = 0; }
        if (kind === 'replaced-resolution') { fixture.plan.resolvedOffsets = new Float64Array(fixture.plan.resolvedOffsets); }
        expect(startAliases(fixture)).toBeNull();
        expect(fixture.read).not.toHaveBeenCalled();
        expect(fixture.append).not.toHaveBeenCalled();
    });

    test.each([{rawEntries: 65}, {rawLength: 65537}])('rejects inputs beyond the fixed group bounds before reading', (options) => {
        const fixture = createFixture(options);
        expect(startAliases(fixture)).toBeNull();
        expect(fixture.read).not.toHaveBeenCalled();
    });

    test('accepts exactly the entry and byte bounds', async () => {
        const fixture = createFixture({rawEntries: 64, rawLength: 1024});
        const result = await startAliases(fixture);
        expect(result?.aliasCount).toBe(64);
        expect(result?.inputBytes).toBe(65536);
        expect(fixture.read).toHaveBeenCalledTimes(64);
    });

    test.each(['unavailable', 'short', 'other-format'])('falls back before writing when a canonical read is %s', async (kind) => {
        const fixture = createFixture();
        if (kind === 'unavailable') { fixture.read.mockResolvedValueOnce(null); }
        if (kind === 'short') { fixture.read.mockResolvedValueOnce(fixture.rawBytes.subarray(0, 4)); }
        if (kind === 'other-format') { fixture.read.mockResolvedValueOnce(new Uint8Array(8)); }
        await expect(startAliases(fixture)).resolves.toBeNull();
        expect(fixture.append).not.toHaveBeenCalled();
    });

    test('does not start a write after cancellation during a canonical read', async () => {
        const fixture = createFixture();
        const gate = createNativeRecordGate();
        fixture.read.mockImplementationOnce(async () => {
            await gate.promise;
            return fixture.rawBytes;
        });
        const pending = startAliases(fixture);
        fixture.owner.close();
        gate.resolve();
        await expect(pending).rejects.toThrow('ownership changed');
        expect(fixture.append).not.toHaveBeenCalled();
    });

    test('holds resolution and record input ownership through alias append completion', async () => {
        const fixture = createFixture();
        const started = createNativeRecordGate();
        const gate = createNativeRecordGate();
        const original = fixture.append.getMockImplementation();
        fixture.append.mockImplementationOnce(async (...args) => {
            started.resolve();
            await gate.promise;
            return await /** @type {NonNullable<typeof original>} */ (original)(...args);
        });
        const pending = startAliases(fixture);
        await started.promise;
        fixture.plan.resolvedLengths = new Uint32Array(fixture.plan.resolvedLengths);
        gate.resolve();
        await expect(pending).rejects.toThrow('resolved content ownership changed');
        expect(fixture.plan.resolvedOffsets[0]).toBe(100);
    });

    test('propagates a write failure without publishing alias references', async () => {
        const fixture = createFixture();
        fixture.append.mockRejectedValueOnce(new Error('alias write failed'));
        await expect(startAliases(fixture)).rejects.toThrow('alias write failed');
        expect(fixture.plan.resolvedOffsets[0]).toBe(100);
        expect(fixture.recordChunk.resolvedContentReferences?.offsets[0]).toBe(100);
    });

    test('preserves ordinary references beyond the 32-bit segment boundary', async () => {
        const fixture = createFixture();
        fixture.plan.resolvedOffsets[1] = 0x100000000 + 10;
        const result = await startAliases(fixture);
        expect(result?.chunk.resolvedContentReferences?.offsets[1]).toBe(0x100000000 + 10);
        expect(result?.chunk.preparedLookupIndexes).toBe(fixture.chunk.preparedLookupIndexes);
    });

    test('the actual record sink retains its 4 GiB split and rebuilt-index fallback after aliasing', async () => {
        const fixture = createFixture();
        fixture.plan.resolvedOffsets[1] = 0x100000000 + 10010;
        const result = await startAliases(fixture);
        if (result === null) { throw new Error('Expected an alias overlay'); }
        const encoded = [];
        for (const useReferences of [true, false]) {
            const store = new TermRecordOpfsStore();
            vi.spyOn(store, '_getOrCreateShardState').mockResolvedValue(
                /** @type {Awaited<ReturnType<TermRecordOpfsStore['_getOrCreateShardState']>>} */ ({}),
            );
            const append = vi.spyOn(store, '_appendEncodedChunk').mockResolvedValue();
            await store.appendBatchFromArtifactChunkResolvedContent(
                useReferences ? result.chunk : {...result.chunk, resolvedContentReferences: void 0},
                useReferences ? [] : [10000, 0x100000000 + 10010],
                useReferences ? [] : [8, 8],
                result.contentDictName,
            );
            expect(append.mock.calls.map((args) => [args[2], args[4]])).toStrictEqual([[1, 10000], [1, 0x100000000 + 10010]]);
            expect(append.mock.calls.every((args) => args[5] instanceof Uint8Array && args[5].byteLength > 0 && args[6] instanceof Uint8Array && args[6].byteLength > 0)).toBe(true);
            encoded.push(append.mock.calls);
        }
        expect(encoded[0]).toStrictEqual(encoded[1]);
    });

    test('reads an active import overlay without flushing queued writes', async () => {
        const fixture = createFixture();
        const contentStore = new TermContentOpfsStore();
        Reflect.set(contentStore, '_importSessionActive', true);
        Reflect.set(contentStore, '_length', 108);
        Reflect.set(contentStore, '_importReadOverlayChunks', [fixture.rawBytes]);
        Reflect.set(contentStore, '_importReadOverlayOffsets', [100]);
        Reflect.set(contentStore, '_importReadOverlayBytes', fixture.rawBytes.byteLength);
        const loaded = vi.spyOn(contentStore, 'ensureLoadedForRead');
        const blockStore = new TermContentBlockStore(contentStore);
        const result = await tryCreateNativeTermRecordAliases(
            fixture.aliasOwner,
            fixture.recordChunk,
            fixture.names,
            fixture.blockSession,
            null,
            (offset, length, name) => blockStore.read(offset, length, name),
        );
        expect(result?.aliasCount).toBe(1);
        expect(loaded).not.toHaveBeenCalled();
    });

    test('includes a cold canonical-read wait before starting the alias append', async () => {
        const fixture = createFixture();
        const gate = createNativeRecordGate();
        const started = createNativeRecordGate();
        const contentStore = new TermContentOpfsStore();
        const file = new File([new Uint8Array(100), fixture.rawBytes], 'content');
        const fileHandle = {getFile: async () => file};
        const state = {index: 0, fileName: 'content', fileHandle, fileLength: 108, startOffset: 0, readFile: /** @type {File|null} */ (null)};
        Reflect.set(contentStore, '_length', 108);
        Reflect.set(contentStore, '_fileHandle', fileHandle);
        Reflect.set(contentStore, '_segmentStates', [state]);
        const load = vi.spyOn(contentStore, 'ensureLoadedForRead').mockImplementation(async () => {
            started.resolve();
            await gate.promise;
            state.readFile = file;
            Reflect.set(contentStore, '_loadedForRead', true);
        });
        const blockStore = new TermContentBlockStore(contentStore);
        const pending = tryCreateNativeTermRecordAliases(
            fixture.aliasOwner,
            fixture.recordChunk,
            fixture.names,
            fixture.blockSession,
            null,
            (offset, length, name) => blockStore.read(offset, length, name),
        );
        await started.promise;
        expect(load).toHaveBeenCalledOnce();
        expect(fixture.append).not.toHaveBeenCalled();
        gate.resolve();
        expect((await pending)?.aliasCount).toBe(1);
    });
});
