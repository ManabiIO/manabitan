/*
 * Copyright (C) 2023-2025  Yomitan Authors
 * Copyright (C) 2020-2022  Yomichan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import {describe, expect, test, vi} from 'vitest';
import {TermContentBlockStore, wrapCompressedTermContentBlock} from '../ext/js/dictionary/term-content-block-store.js';
import {deferPromise} from '../ext/js/core/utilities.js';
import {TermContentOpfsStore} from '../ext/js/dictionary/term-content-opfs-store.js';
import {encodeRawTermContentBlockReference} from '../ext/js/dictionary/raw-term-content.js';

vi.mock('../ext/js/dictionary/zstd-term-content.js', () => ({
    decompressTermContentZstd: (/** @type {Uint8Array} */ bytes) => Uint8Array.from(bytes),
}));

/**
 * @returns {{promise: Promise<Uint8Array>, resolve: (value: Uint8Array) => void}}
 */
function deferred() {
    /** @type {(value: Uint8Array) => void} */
    let resolve = () => {};
    const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
    return {promise, resolve};
}

/**
 * @param {TermContentBlockStore} store
 * @param {boolean} batch
 * @returns {ReturnType<TermContentBlockStore['readDetailed']>}
 */
async function readBlock(store, batch) {
    if (!batch) { return await store.readDetailed(64, 3, 'raw-block-v1'); }
    const [result] = await store.readDetailedBatch([{contentOffset: 64, contentLength: 3, contentDictName: 'raw-block-v1'}]);
    return result;
}

describe('content cache invalidation during asynchronous reads', () => {
    test.each([false, true])('does not join or republish old block loads (batch=%s)', async (batch) => {
        const content = new TermContentOpfsStore();
        const store = new TermContentBlockStore(content);
        const oldBlock = wrapCompressedTermContentBlock(Uint8Array.of(1, 2, 3));
        const newBlock = wrapCompressedTermContentBlock(Uint8Array.of(4, 5, 6));
        const reference = encodeRawTermContentBlockReference(0, oldBlock.length, 3, 0, 3);
        /** @type {import('core').DeferredPromiseDetails<void>} */
        const entered = deferPromise();
        const pending = deferred();
        let loads = 0;
        vi.spyOn(content, 'readSlice').mockImplementation(async (offset) => {
            if (offset === 64) { return reference; }
            if (++loads === 1) {
                entered.resolve();
                return await pending.promise;
            }
            return newBlock;
        });
        vi.spyOn(content, 'readSlicesDetailed').mockResolvedValue([{status: 'ok', bytes: reference}]);
        const oldRead = readBlock(store, batch);
        await entered.promise;
        store.clearCache();
        const newRead = readBlock(store, batch);
        // Release even on a broken implementation, so the test never strands I/O.
        pending.resolve(oldBlock);
        const [oldResult, newResult] = await Promise.all([oldRead, newRead]);
        expect(oldResult.status).toBe('temporarilyUnavailable');
        expect(newResult).toEqual({status: 'ok', bytes: Uint8Array.of(4, 5, 6)});
        expect(await readBlock(store, batch)).toEqual(newResult);
        expect(loads).toBe(2);
        expect(store.getDiagnostics()).toMatchObject({cacheEntries: 1, inFlightBlocks: 0});
    });

    test.each([false, true])('does not classify an invalidated reference as corruption (batch=%s)', async (batch) => {
        const content = new TermContentOpfsStore();
        const store = new TermContentBlockStore(content);
        /** @type {import('core').DeferredPromiseDetails<void>} */
        const entered = deferPromise();
        const pending = deferred();
        vi.spyOn(content, 'readSlice').mockImplementation(async () => {
            entered.resolve();
            return await pending.promise;
        });
        vi.spyOn(content, 'readSlicesDetailed').mockImplementation(async () => {
            entered.resolve();
            return [{status: 'ok', bytes: await pending.promise}];
        });
        const read = readBlock(store, batch);
        await entered.promise;
        store.clearCache();
        pending.resolve(new Uint8Array(32));
        expect((await read).status).toBe('temporarilyUnavailable');
        expect(store.getDiagnostics()).toMatchObject({cacheEntries: 0, lastError: null});
    });

    test('does not replace a current exact-slice cache with a late old snapshot', async () => {
        const store = new TermContentOpfsStore();
        Reflect.set(store, '_fileHandle', {});
        Reflect.set(store, '_length', 3);
        Reflect.set(store, '_loadedForRead', true);
        const state = {
            index: 0,
            fileName: 'manabitan-term-content.bin',
            fileHandle: {},
            fileLength: 3,
            startOffset: 0,
            readFile: new File([Uint8Array.of(1, 2, 3)], 'old'),
        };
        Reflect.set(store, '_segmentStates', [state]);
        /** @type {import('core').DeferredPromiseDetails<void>} */
        const entered = deferPromise();
        const pending = deferred();
        const readFile = vi.spyOn(store, '_readSliceFromFile')
            .mockImplementationOnce(async () => {
                entered.resolve();
                return await pending.promise;
            })
            .mockResolvedValue(Uint8Array.of(4, 5, 6));
        const oldRead = store.readSlice(0, 3);
        await entered.promise;
        store._invalidateReadState();
        state.readFile = new File([Uint8Array.of(4, 5, 6)], 'new');
        Reflect.set(store, '_loadedForRead', true);
        expect(await store.readSlice(0, 3)).toEqual(Uint8Array.of(4, 5, 6));
        pending.resolve(Uint8Array.of(1, 2, 3));
        await oldRead;
        expect(await store.readSlice(0, 3)).toEqual(Uint8Array.of(4, 5, 6));
        expect(readFile).toHaveBeenCalledTimes(2);
    });

    test.each([
        [Number.NaN, 1],
        [0, Number.NaN],
        [Infinity, 1],
        [0, Infinity],
        [0.5, 1],
        [0, 1.5],
        [Number.MAX_SAFE_INTEGER, 1],
    ])('rejects non-integral or unsafe scalar spans (%s, %s) without I/O', async (offset, length) => {
        const store = new TermContentOpfsStore();
        await store.appendBatch([Uint8Array.of(1, 2, 3)]);
        const reload = vi.spyOn(store, '_reloadForPotentialExternalGrowth').mockResolvedValue(false);
        expect(await store.readSlice(offset, length)).toBeNull();
        expect(reload).not.toHaveBeenCalled();
    });
});
