/*
 * Copyright (C) 2026 Manabitan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {describe, expect, test, vi} from 'vitest';
import {deferPromise} from '../ext/js/core/utilities.js';
import {TermContentOpfsStore} from '../ext/js/dictionary/term-content-opfs-store.js';

const MAX_RECORD_CONTENT_DELTA = 0xfffffffe;

/** @returns {Promise<void>} */
async function flush() {
    await new Promise((resolve) => { setTimeout(resolve, 0); });
}

describe('bounded derived-prefix reservations', () => {
    test.each([0, MAX_RECORD_CONTENT_DELTA - 5])('publishes a prefix only within the final cursor bound at %s', async (start) => {
        const store = new TermContentOpfsStore();
        Reflect.set(store, '_length', start);
        /** @type {import('core').DeferredPromiseDetails<Uint8Array[]>} */
        const primary = deferPromise();
        const operation = store.beginAppendBatchWithDerivedPrefix(primary.promise, [2], () => [Uint8Array.of(8, 9)], {
            maximumEndOffset: MAX_RECORD_CONTENT_DELTA,
            primaryBytesUpperBound: 3,
        });
        await expect(operation.reserved).resolves.toEqual({derivedOffsets: [start], derivedLengths: [2]});
        expect(Reflect.get(store, '_length')).toBe(start);
        primary.resolve([Uint8Array.of(1, 2, 3)]);
        await expect(operation.completion).resolves.toMatchObject({primaryOffsets: [start + 2], derivedOffsets: [start]});
        expect(await store.readSlice(start, 5)).toEqual(Uint8Array.of(8, 9, 1, 2, 3));
        expect(Reflect.get(store, '_length')).toBe(start + 5);
    });

    test.each([MAX_RECORD_CONTENT_DELTA - 4, 2 ** 32 + 100])('keeps exact suffix order beyond the final cursor bound at %s', async (start) => {
        const store = new TermContentOpfsStore();
        Reflect.set(store, '_length', start);
        /** @type {import('core').DeferredPromiseDetails<Uint8Array[]>} */
        const primary = deferPromise();
        const createDerived = vi.fn(() => [Uint8Array.of(8, 9)]);
        const operation = store.beginAppendBatchWithDerivedPrefix(primary.promise, [2], createDerived, {
            maximumEndOffset: MAX_RECORD_CONTENT_DELTA,
            primaryBytesUpperBound: 3,
        });
        let reserved = false;
        void operation.reserved.then(() => { reserved = true; });
        await flush();
        expect(reserved).toBe(false);
        expect(Reflect.get(store, '_length')).toBe(start);
        primary.resolve([Uint8Array.of(1, 2, 3)]);
        await expect(operation.reserved).resolves.toEqual({derivedOffsets: [start + 3], derivedLengths: [2]});
        await operation.completion;
        expect(createDerived).toHaveBeenCalledOnce();
        expect(createDerived).toHaveBeenCalledWith([start], [3]);
        expect(await store.readSlice(start, 5)).toEqual(Uint8Array.of(1, 2, 3, 8, 9));
        expect(Reflect.get(store, '_length')).toBe(start + 5);
    });

    test('checks the post-mutation cursor and snapshots caller limits', async () => {
        const store = new TermContentOpfsStore();
        Reflect.set(store, '_length', MAX_RECORD_CONTENT_DELTA - 5);
        const earlier = store.appendBatch([Uint8Array.of(7)]);
        /** @type {import('core').DeferredPromiseDetails<Uint8Array[]>} */
        const primary = deferPromise();
        const limits = {maximumEndOffset: MAX_RECORD_CONTENT_DELTA, primaryBytesUpperBound: 3};
        const operation = store.beginAppendBatchWithDerivedPrefix(primary.promise, [2], () => [Uint8Array.of(8, 9)], limits);
        limits.maximumEndOffset = Number.MAX_SAFE_INTEGER;
        limits.primaryBytesUpperBound = 0;
        let reserved = false;
        void operation.reserved.then(() => { reserved = true; });
        await earlier;
        await flush();
        expect(reserved).toBe(false);
        primary.resolve([Uint8Array.of(1, 2, 3)]);
        await expect(operation.reserved).resolves.toEqual({derivedOffsets: [MAX_RECORD_CONTENT_DELTA - 1], derivedLengths: [2]});
        await operation.completion;
        expect(Reflect.get(store, '_length')).toBe(MAX_RECORD_CONTENT_DELTA + 1);
    });

    test.each([
        {maximumEndOffset: Number.NaN, primaryBytesUpperBound: 3},
        {maximumEndOffset: Infinity, primaryBytesUpperBound: 3},
        {maximumEndOffset: -1, primaryBytesUpperBound: 3},
        {maximumEndOffset: 100, primaryBytesUpperBound: Infinity},
        {maximumEndOffset: 100, primaryBytesUpperBound: -1},
        {maximumEndOffset: 100, primaryBytesUpperBound: 2.5},
    ])('keeps suffix placement when limits cannot prove the cursor: %j', async (limits) => {
        const store = new TermContentOpfsStore();
        const operation = store.beginAppendBatchWithDerivedPrefix(Promise.resolve([Uint8Array.of(1, 2, 3)]), [2], () => [Uint8Array.of(8, 9)], limits);
        await expect(operation.reserved).resolves.toEqual({derivedOffsets: [3], derivedLengths: [2]});
        await operation.completion;
        expect(await store.readSlice(0, 5)).toEqual(Uint8Array.of(1, 2, 3, 8, 9));
    });

    test('rejects an underestimated primary bound before mutating storage', async () => {
        const store = new TermContentOpfsStore();
        const createDerived = vi.fn(() => [Uint8Array.of(8, 9)]);
        const operation = store.beginAppendBatchWithDerivedPrefix(Promise.resolve([Uint8Array.of(1, 2, 3)]), [2], createDerived, {
            maximumEndOffset: 100,
            primaryBytesUpperBound: 2,
        });
        await expect(operation.reserved).resolves.toEqual({derivedOffsets: [0], derivedLengths: [2]});
        await expect(operation.completion).rejects.toThrow('reserved bound');
        expect(createDerived).not.toHaveBeenCalled();
        expect(Reflect.get(store, '_length')).toBe(0);
        await expect(store.appendBatch([Uint8Array.of(4)])).resolves.toEqual([{offset: 0, length: 1}]);
    });

    test('validates and appends reserved derived chunks even with an empty primary fallback', async () => {
        const store = new TermContentOpfsStore();
        const operation = store.beginAppendBatchWithDerivedPrefix(Promise.resolve([]), [2], () => [Uint8Array.of(8, 9)], {
            maximumEndOffset: 0,
            primaryBytesUpperBound: 0,
        });
        await expect(operation.reserved).resolves.toEqual({derivedOffsets: [0], derivedLengths: [2]});
        await operation.completion;
        expect(await store.readSlice(0, 2)).toEqual(Uint8Array.of(8, 9));
        const invalid = store.beginAppendBatchWithDerivedPrefix(Promise.resolve([]), [2], () => [], {
            maximumEndOffset: 0,
            primaryBytesUpperBound: 0,
        });
        await expect(invalid.reserved).rejects.toThrow('reservation');
        await expect(invalid.completion).rejects.toThrow('reservation');
        expect(Reflect.get(store, '_length')).toBe(2);
    });

    test.each([
        {derived: []},
        {derived: [Uint8Array.of(1)]},
        {derived: [Uint8Array.of(1, 2), Uint8Array.of(3)]},
        {derived: [new DataView(new ArrayBuffer(2))]},
    ])('rejects malformed derived output on suffix fallback ($derived)', async ({derived}) => {
        const store = new TermContentOpfsStore();
        const operation = store.beginAppendBatchWithDerivedPrefix(Promise.resolve([Uint8Array.of(1)]), [2], () => /** @type {Uint8Array[]} */ (derived), {
            maximumEndOffset: 0,
            primaryBytesUpperBound: 1,
        });
        await expect(operation.reserved).rejects.toThrow('reservation');
        await expect(operation.completion).rejects.toThrow('reservation');
        expect(Reflect.get(store, '_length')).toBe(0);
        expect(Reflect.get(store, '_chunks')).toEqual([]);
    });
});
