/* SPDX-License-Identifier: GPL-3.0-or-later */
import {afterEach, expect, test, vi} from 'vitest';
import {TermContentOpfsStore} from '../ext/js/dictionary/term-content-opfs-store.js';

function latch() {
    /** @type {() => void} */
    let resolve = () => {};
    const promise = new Promise((r) => {
        resolve = () => { r(void 0); };
    });
    return {promise, resolve};
}

/** Stateful storage fake with the same commit-on-close behavior as OPFS. */
class Directory {
    constructor() {
        /** @type {Map<string, Uint8Array>} */
        this.files = new Map();
        this.secondStarted = latch();
        this.releaseSecond = latch();
        this.writes = 0;
    }

    /**
     * @param {string} name
     * @param {{create?: boolean}} [options]
     * @returns {Promise<unknown>}
     */
    async getFileHandle(name, options = {}) {
        if (!this.files.has(name)) {
            if (!options.create) { throw new DOMException('Missing', 'NotFoundError'); }
            this.files.set(name, new Uint8Array());
        }
        return {
            kind: 'file',
            name,
            getFile: async () => new File([new Uint8Array(this.files.get(name) ?? [])], name),
            createWritable: async () => {
                let bytes = new Uint8Array(this.files.get(name) ?? []);
                let offset = 0;
                return {
                    /** @param {number} value */
                    async seek(value) { offset = value; },
                    /** @param {Uint8Array|Blob} value */
                    write: async (value) => {
                        if (++this.writes === 2) {
                            this.secondStarted.resolve();
                            await this.releaseSecond.promise;
                        }
                        const data = value instanceof Blob ? new Uint8Array(await value.arrayBuffer()) : value;
                        const next = new Uint8Array(Math.max(bytes.length, offset + data.length));
                        next.set(bytes); next.set(data, offset);
                        offset += data.length; bytes = next;
                    },
                    close: async () => { this.files.set(name, bytes); },
                };
            },
        };
    }

    /**
     * @returns {AsyncGenerator<unknown>}
     * @yields {unknown}
     */
    async *entries() { for (const name of this.files.keys()) { yield [name, await this.getFileHandle(name)]; } }
}
afterEach(() => { vi.unstubAllGlobals(); });

test('queued append cursor never counts a completed write group twice', async () => {
    const directory = new Directory();
    vi.stubGlobal('navigator', {storage: {getDirectory: async () => directory}, deviceMemory: 8});
    const store = new TermContentOpfsStore();
    await store.prepare(); await store.beginImportSession();
    store.setQueueImportWritesEnabled(true);
    Reflect.set(store, '_flushThresholdBytes', 1);
    Reflect.set(store, '_writeCoalesceMaxChunks', 1);
    Reflect.set(store, '_writeCoalesceTargetBytes', 3);
    const first = await store.appendBatch([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])]);
    await directory.secondStarted.promise;
    try {
        const next = await store.appendBatch([new Uint8Array([7, 8, 9])]);
        expect(first.map((s) => s.offset)).toEqual([0, 3]);
        expect(next).toEqual([{offset: 6, length: 3}]);
        expect(await store.readSlice(6, 3)).toEqual(new Uint8Array([7, 8, 9]));
    } finally { directory.releaseSecond.resolve(); await store.endImportSession(); }
    expect(await store.readSlice(0, 9)).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]));
    expect(store.getDebugState().totalLength).toBe(9);
});
