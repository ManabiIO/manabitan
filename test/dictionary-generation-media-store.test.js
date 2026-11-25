/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {crc32, deflateRawSync} from 'node:zlib';
import {afterEach, describe, expect, test, vi} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';
import {deferPromise} from '../ext/js/core/utilities.js';
import {createGenerationMediaIndex, DictionaryGenerationMediaStore, restrictGenerationMediaIndex} from '../ext/js/dictionary/dictionary-generation-media-store.js';

import {startSourceZipMediaPreparation} from '../ext/js/dictionary/source-zip-media-preparation.js';

const generation = 'f67e29e0-ea36-4d71-9cb8-55aa1916db07';
const retired = 'b255d1d4-2074-463c-a0d7-2a1edd656224';

/**
 * Minimal persistent OPFS stand-in. Each read takes a File snapshot.
 * @param {{onOpen?: () => Promise<void>, onWrite?: (position: number, data: Blob) => Promise<void>, onClose?: () => void, onAbort?: () => void, onRemove?: () => void}} [hooks]
 * @returns {Map<string, File>}
 */
function stubOpfs(hooks = {}) {
    /** @type {Map<string, File>} */
    const files = new Map();
    let directoryExists = false;
    const directory = {
        /**
         * @param {string} name
         * @param {{create?: boolean}} [options]
         * @returns {Promise<{getFile: () => Promise<File>, createWritable: () => Promise<{write: (input: Blob|{position: number, data: Blob}) => Promise<void>, close: () => Promise<void>, abort: () => Promise<void>}>}>}
         */
        async getFileHandle(name, {create = false} = {}) {
            if (!files.has(name)) {
                if (!create) { throw new DOMException('File not found', 'NotFoundError'); }
                files.set(name, new File([], name));
            }
            return {
                async getFile() {
                    const file = files.get(name);
                    if (typeof file === 'undefined') { throw new DOMException('File not found', 'NotFoundError'); }
                    return file;
                },
                async createWritable() {
                    await hooks.onOpen?.();
                    let buffer = new Blob();
                    return {
                        /** @param {Blob|{position: number, data: Blob}} input */
                        async write(input) {
                            const {position, data} = input instanceof Blob ? {position: 0, data: input} : input;
                            await hooks.onWrite?.(position, data);
                            buffer = new Blob([
                                buffer.slice(0, position),
                                new Uint8Array(Math.max(0, position - buffer.size)),
                                data,
                                buffer.slice(position + data.size),
                            ]);
                        },
                        async close() {
                            files.set(name, new File([buffer], name));
                            hooks.onClose?.();
                        },
                        async abort() { hooks.onAbort?.(); },
                    };
                },
            };
        },
        /** @param {string} name */
        async removeEntry(name) {
            hooks.onRemove?.();
            if (!files.delete(name)) { throw new DOMException('File not found', 'NotFoundError'); }
        },
        async *entries() {
            for (const name of files.keys()) { yield [name, {kind: 'file'}]; }
        },
    };
    const root = {
        /**
         * @param {string} name
         * @param {{create?: boolean}} [options]
         * @returns {Promise<typeof directory>}
         */
        async getDirectoryHandle(name, {create = false} = {}) {
            if (name !== 'manabitan-dictionary-media-v1' || (!directoryExists && !create)) {
                throw new DOMException('Directory not found', 'NotFoundError');
            }
            directoryExists = true;
            return directory;
        },
        async removeEntry() {
            files.clear();
            directoryExists = false;
        },
    };
    vi.stubGlobal('navigator', {storage: {async getDirectory() { return root; }}});
    return files;
}

function createPack() {
    const inline = Uint8Array.of(3, 4, 5, 6);
    const decoded = new TextEncoder().encode('image bytes');
    const deflated = new Uint8Array(deflateRawSync(decoded));
    const blob = new Blob([inline, deflated]);
    const records = [1, 2, 4, 5].map((id) => {
        const compressed = id === 4;
        return {
            path: `img/card${id}.webp`,
            packedOffset: compressed ? inline.byteLength : 0,
            packedLength: compressed ? deflated.byteLength : inline.byteLength,
            compressionMethod: compressed ? 8 : 0,
            uncompressedLength: compressed ? decoded.byteLength : inline.byteLength,
            signature: crc32(compressed ? decoded : inline),
        };
    });
    const plan = createGenerationMediaIndex(records, blob.size);
    if (plan === null) { throw new Error('Dense media fixture was not admitted'); }
    return {blob, inline, decoded, deflated, records, plan};
}

function createStagingDatabase() {
    class WritableFileHandle {
        createWritable() {}
    }
    vi.stubGlobal('FileSystemFileHandle', WritableFileHandle);
    const database = new DictionaryDatabase();
    Reflect.set(database, '_db', {});
    Reflect.set(database, '_bulkImportState', 'active');
    Reflect.set(database, '_bulkImportTransactionOpen', true);
    Reflect.set(database, '_bulkImportJournalRecord', {sessionId: generation});
    return database;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('Dictionary generation media storage', () => {
    /* eslint-disable @stylistic/semi */
    test('reuses an unchanged immutable index with holes and nonphysical reference order', async () => {
        stubOpfs()
        const {blob, records, plan, inline, deflated} = createPack()
        const before = new Uint8Array(plan.index)
        const selected = restrictGenerationMediaIndex(plan, records.map(({path}) => path).reverse())
        if (selected === null) { throw new Error('Complete image selection was declined') }
        expect(selected.index).toBe(plan.index)
        expect(selected.index).toEqual(before)
        expect(selected.descriptor).toEqual(plan.descriptor)

        const writer = new DictionaryGenerationMediaStore()
        await writer.write(generation, blob, selected)
        const reopened = new DictionaryGenerationMediaStore()
        for (const {path} of records) {
            const stored = await reopened.read(generation, selected.descriptor, path)
            expect(stored === null ? null : new Uint8Array(stored.content)).toEqual(path.endsWith('4.webp') ? deflated : inline)
        }
        await expect(reopened.read(generation, selected.descriptor, 'img/card3.webp')).resolves.toBeNull()
    })

    test('copies only selected index bytes before removing an occupied slot', () => {
        const {records, plan} = createPack()
        const backing = new Uint8Array(plan.index.length + 17).fill(0xa5)
        backing.set(plan.index, 7)
        const index = backing.subarray(7, 7 + plan.index.length)
        const source = {...plan, index}
        const before = new Uint8Array(backing)
        const complete = restrictGenerationMediaIndex(source, records.map(({path}) => path))
        const subset = restrictGenerationMediaIndex(source, ['img/card1.webp', 'img/card4.webp'])
        if (complete === null || subset === null) { throw new Error('Image selection was declined') }
        expect(complete.index).toBe(index)
        expect(subset.index.buffer).not.toBe(backing.buffer)
        expect(subset.index.byteOffset).toBe(0)
        expect(subset.index.byteLength).toBe(index.byteLength)
        expect(subset.descriptor.count).toBe(2)
        expect(backing).toEqual(before)
        expect(complete.index).toEqual(plan.index)
    })

    test('snapshots a reused complete index when selecting a staged payload', async () => {
        stubOpfs()
        const {blob, records, plan, inline} = createPack()
        const sourceBytes = new Uint8Array(plan.index)
        const store = new DictionaryGenerationMediaStore()
        const staged = store.stage(generation, blob, plan)
        const selected = restrictGenerationMediaIndex(plan, records.map(({path}) => path))
        if (selected === null) { throw new Error('Complete image selection was declined') }
        expect(selected.index).toBe(plan.index)
        staged.select(selected)
        expect(plan.index).toEqual(sourceBytes)
        plan.index.fill(0)
        await staged.promise
        const reopened = new DictionaryGenerationMediaStore()
        const stored = await reopened.read(generation, selected.descriptor, 'img/card1.webp')
        expect(stored === null ? null : new Uint8Array(stored.content)).toEqual(inline)
    })

    test('does not reuse an index with an unselected occupied slot even if the declared count matches', async () => {
        stubOpfs()
        const {blob, plan, inline} = createPack()
        const selected = restrictGenerationMediaIndex({...plan, descriptor: {...plan.descriptor, count: 1}}, ['img/card1.webp'])
        if (selected === null) { throw new Error('Image selection was declined') }
        expect(selected.index).not.toBe(plan.index)
        const store = new DictionaryGenerationMediaStore()
        await store.write(generation, blob, selected)
        const first = await store.read(generation, selected.descriptor, 'img/card1.webp')
        expect(first === null ? null : new Uint8Array(first.content)).toEqual(inline)
        for (const id of [2, 3, 4, 5]) {
            await expect(store.read(generation, selected.descriptor, `img/card${id}.webp`)).resolves.toBeNull()
        }
    })
    /* eslint-enable @stylistic/semi */

    test('terminates speculative work on cancellation even if a result arrives later', async () => {
        vi.useFakeTimers();
        try {
            const terminate = vi.fn();
            const postMessage = vi.fn();
            /** @type {((message: {data: unknown}) => void)|null} */
            let sendResult = null;
            vi.stubGlobal('Worker', class {
                /** @param {((message: {data: unknown}) => void)|null} handler */
                set onmessage(handler) { sendResult = handler; }
                get onmessage() { return sendResult; }
                postMessage = postMessage;
                terminate = terminate;
            });
            const archive = new Blob(['temporary benchmark archive']);
            let cancelled = false;
            const task = startSourceZipMediaPreparation(archive, () => cancelled);
            if (task === null) { throw new Error('Expected a worker preparation task'); }
            expect(postMessage).toHaveBeenCalledWith(archive);
            cancelled = true;
            await vi.advanceTimersByTimeAsync(50);
            await expect(task.result).resolves.toBeNull();
            task.cancel();
            const sender = /** @type {((message: {data: unknown}) => void)|null} */ (sendResult);
            sender?.({data: null});
            expect(terminate).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    test('publishes only canonical referenced paths from a speculative plan', async () => {
        stubOpfs();
        const {blob, plan, inline, deflated} = createPack();
        expect(restrictGenerationMediaIndex(plan, ['img/card3.webp'])).toBeNull();
        expect(restrictGenerationMediaIndex(plan, ['img/card01.webp'])).toBeNull();
        expect(restrictGenerationMediaIndex(plan, ['img/card1.webp', 'img/card1.webp'])).toBeNull();
        const subset = restrictGenerationMediaIndex(plan, ['img/card4.webp', 'img/card1.webp']);
        if (subset === null) { throw new Error('Image selection was declined'); }
        expect(subset.descriptor.count).toBe(2);
        const store = new DictionaryGenerationMediaStore();
        await store.write(generation, blob, subset);
        const stored = await store.read(generation, subset.descriptor, 'img/card1.webp');
        const packed = await store.read(generation, subset.descriptor, 'img/card4.webp');
        expect(stored === null ? null : new Uint8Array(stored.content)).toEqual(inline);
        expect(packed === null ? null : new Uint8Array(packed.content)).toEqual(deflated);
        await expect(store.read(generation, subset.descriptor, 'img/card2.webp')).resolves.toBeNull();
        await expect(store.read(generation, subset.descriptor, 'img/card5.webp')).resolves.toBeNull();
    });

    test('serves stored and DEFLATE image bytes through getMedia after reopening', async () => {
        const files = stubOpfs();
        const {blob, inline, decoded, plan} = createPack();
        await new DictionaryGenerationMediaStore().write(generation, blob, plan);
        expect([...files.keys()]).toEqual([generation + '.bin']);
        const database = new DictionaryDatabase();
        Reflect.set(database, '_db', {});
        Reflect.get(database, '_termRecordGenerationByStorage').set('packed media', generation);
        Reflect.get(database, '_generationMediaByDictionary').set('packed media', plan.descriptor);
        const assets = await database.getMedia([
            {dictionary: 'packed media', path: 'img/card4.webp'},
            {dictionary: 'packed media', path: 'img/card1.webp'},
        ]);
        expect(assets.map(({index, mediaType, content}) => ({index, mediaType, bytes: new Uint8Array(content)}))).toEqual([
            {index: 0, mediaType: 'image/webp', bytes: decoded},
            {index: 1, mediaType: 'image/webp', bytes: inline},
        ]);
    });

    test('treats holes and alternate spellings as misses and reclaims only retired generations', async () => {
        const files = stubOpfs();
        const {blob, plan} = createPack();
        const store = new DictionaryGenerationMediaStore();
        await store.write(generation, blob, plan);
        await store.write(retired, blob, plan);
        await expect(store.read(generation, plan.descriptor, 'img/card3.webp')).resolves.toBeNull();
        await expect(store.read(generation, plan.descriptor, 'img/card01.webp')).resolves.toBeNull();
        await store.removeOrphans(new Set([generation]));
        expect([...files.keys()]).toEqual([generation + '.bin']);
        await store.remove(generation);
        await store.remove(generation);
        expect(files.size).toBe(0);
    });

    test('rejects swapped occupied rows and a zeroed row before returning payload data', async () => {
        const files = stubOpfs();
        const {blob, plan} = createPack();
        await new DictionaryGenerationMediaStore().write(generation, blob, plan);
        const name = generation + '.bin';
        const file = files.get(name);
        if (typeof file === 'undefined') { throw new Error('Missing generated fixture'); }
        const bytes = new Uint8Array(await file.arrayBuffer());
        const rowBytes = plan.index.byteLength / plan.descriptor.slotCount;
        const indexStart = bytes.byteLength - plan.index.byteLength - blob.size;
        const first = indexStart;
        const fourth = indexStart + rowBytes * 3;
        const saved = bytes.slice(first, first + rowBytes);
        bytes.copyWithin(first, fourth, fourth + rowBytes);
        bytes.set(saved, fourth);
        files.set(name, new File([bytes], name));
        const store = new DictionaryGenerationMediaStore();
        await expect(store.read(generation, plan.descriptor, 'img/card1.webp')).rejects.toThrow('row identity mismatch');
        await expect(store.read(generation, plan.descriptor, 'img/card4.webp')).rejects.toThrow('row identity mismatch');

        // Erasing either an occupied slot or a checked hole is corruption.
        const original = new Uint8Array(await file.arrayBuffer());
        original.fill(0, first, first + rowBytes);
        const hole = first + 2 * rowBytes;
        original.fill(0, hole, hole + rowBytes);
        files.set(name, new File([original], name));
        await expect(store.read(generation, plan.descriptor, 'img/card1.webp')).rejects.toThrow('row identity mismatch');
        await expect(store.read(generation, plan.descriptor, 'img/card3.webp')).rejects.toThrow('row identity mismatch');
    });

    test('rejects another generation with the same exact file size', async () => {
        const files = stubOpfs();
        const {blob, plan} = createPack();
        const store = new DictionaryGenerationMediaStore();
        await store.write(generation, blob, plan);
        await store.write(retired, blob, plan);
        const original = files.get(generation + '.bin');
        const former = files.get(retired + '.bin');
        if (typeof former === 'undefined' || typeof original === 'undefined') { throw new Error('Missing generated fixtures'); }
        expect(former.size).toBe(original.size);
        files.set(generation + '.bin', former);
        await expect(store.read(generation, plan.descriptor, 'img/card1.webp')).rejects.toThrow('file identity mismatch');
        files.set(generation + '.bin', original);
        await expect(store.read(generation, plan.descriptor, 'img/card1.webp')).resolves.toMatchObject({method: 0});
        await expect(store.inspect(generation, {...plan.descriptor, suffix: '.png'})).rejects.toThrow('file identity mismatch');
    });

    test('reports a missing pack at startup without hiding other dictionary data', async () => {
        stubOpfs();
        const {plan} = createPack();
        const database = new DictionaryDatabase();
        Reflect.get(database, '_termRecordGenerationByStorage').set('packed media', generation);
        Reflect.get(database, '_generationMediaByDictionary').set('packed media', plan.descriptor);
        await database._checkStartupGenerationMediaHealth();
        expect(database.getStartupGenerationMediaHealth()).toEqual({
            checkedCount: 1,
            unavailable: [{dictionary: 'packed media', reason: expect.stringContaining('Missing generation media')}],
        });
        expect(Reflect.get(database, '_generationMediaByDictionary').has('packed media')).toBe(true);
    });

    test('does not return a media read resumed after connection cleanup began', async () => {
        const {inline, plan} = createPack();
        const entered = deferPromise();
        const resume = deferPromise();
        const database = new DictionaryDatabase();
        Reflect.set(database, '_db', {});
        Reflect.get(database, '_termRecordGenerationByStorage').set('packed media', generation);
        Reflect.get(database, '_generationMediaByDictionary').set('packed media', plan.descriptor);
        const store = /** @type {DictionaryGenerationMediaStore} */ (Reflect.get(database, '_generationMediaStore'));
        vi.spyOn(store, 'read').mockImplementation(async () => {
            entered.resolve(void 0);
            await resume.promise;
            return {content: inline.buffer, method: 0, outputLength: inline.byteLength, signature: crc32(inline)};
        });
        const reading = database.getMedia([{dictionary: 'packed media', path: 'img/card1.webp'}]);
        const rejected = expect(reading).rejects.toThrow('Dictionary media state changed');
        await entered.promise;
        try {
            database._beginExclusiveDatabaseCleanup();
        } finally {
            resume.resolve(void 0);
        }
        await rejected;
    });

    test('joins a delayed writer before clearing rollback ownership or publishing', async () => {
        const {blob, plan} = createPack();
        const entered = deferPromise();
        const resume = deferPromise();
        const database = new DictionaryDatabase();
        const sqlite = /** @type {import('@sqlite.org/sqlite-wasm').Database} */ (/** @type {unknown} */ ({exec: vi.fn()}));
        Reflect.set(database, '_db', sqlite);
        Reflect.set(database, '_bulkImportState', 'active');
        Reflect.set(database, '_bulkImportTransactionOpen', true);
        Reflect.set(database, '_bulkImportJournalRecord', {sessionId: generation});
        const store = /** @type {DictionaryGenerationMediaStore} */ (Reflect.get(database, '_generationMediaStore'));
        const journal = /** @type {import('../ext/js/dictionary/dictionary-import-journal.js').DictionaryImportJournal} */ (Reflect.get(database, '_importJournal'));
        const supportsWrite = vi.spyOn(DictionaryGenerationMediaStore, 'supportsWrite').mockReturnValue(true);
        const remove = vi.spyOn(store, 'remove').mockResolvedValue(void 0);
        const clear = vi.spyOn(journal, 'clear').mockResolvedValue(void 0);
        vi.spyOn(store, 'write').mockImplementation(async () => {
            entered.resolve(void 0);
            await resume.promise;
        });

        const writing = database.writeGenerationMedia(blob, plan);
        await entered.promise;
        let published = false;
        const publicationCheck = database._awaitGenerationMediaPublication(plan.descriptor).then(() => { published = true; });
        const rollback = database._rollbackBulkImport(sqlite, [], false, false);
        try {
            await Promise.resolve();
            expect(published).toBe(false);
            await expect(database._awaitGenerationMediaPublication({...plan.descriptor, suffix: '.png'})).rejects.toThrow('does not match the owned write');
            expect(remove).not.toHaveBeenCalled();
            expect(clear).not.toHaveBeenCalled();
        } finally {
            resume.resolve(void 0);
            supportsWrite.mockRestore();
            await writing;
            await publicationCheck;
            await rollback;
        }
        expect(remove).toHaveBeenCalledExactlyOnceWith(generation);
        expect(clear).toHaveBeenCalledOnce();
    });

    test('writes the payload once before selection and patches the same open writable', async () => {
        const payloadWritten = deferPromise();
        const {blob, inline, plan} = createPack();
        /** @type {string[]} */
        const events = [];
        /** @type {Array<{position: number, data: Blob}>} */
        const writes = [];
        const files = stubOpfs({
            async onOpen() { events.push('open'); },
            async onWrite(position, data) {
                writes.push({position, data});
                if (data === blob) { payloadWritten.resolve(void 0); }
            },
            onClose() { events.push('close'); },
            onAbort() { events.push('abort'); },
        });
        const database = createStagingDatabase();
        const staged = database.stageGenerationMediaPayload(blob, plan);
        await payloadWritten.promise;
        try {
            expect(writes).toEqual([{position: 512 + plan.index.byteLength, data: blob}]);
            expect(files.get(generation + '.bin')?.size).toBe(0);
            await expect(database._awaitGenerationMediaPublication(plan.descriptor)).rejects.toThrow('does not match the owned write');
            const narrowed = restrictGenerationMediaIndex(plan, ['img/card1.webp']);
            if (narrowed === null) { throw new Error('Expected the narrowed fixture'); }
            await staged.seal(narrowed);
            await database._awaitGenerationMediaPublication(narrowed.descriptor);
            expect(events).toEqual(['open', 'close']);
            expect(writes.map(({position, data}) => [position, data.size])).toEqual([
                [512 + plan.index.byteLength, blob.size], [0, 512 + plan.index.byteLength],
            ]);
            const reopened = new DictionaryGenerationMediaStore();
            expect(new Uint8Array((await reopened.read(generation, narrowed.descriptor, 'img/card1.webp'))?.content ?? new ArrayBuffer(0))).toEqual(inline);
            await expect(reopened.read(generation, narrowed.descriptor, 'img/card4.webp')).resolves.toBeNull();
        } finally {
            await staged.discard();
        }
    });

    test('cancels a delayed open and joins the single cleanup without selecting an index', async () => {
        const opened = deferPromise();
        const resume = deferPromise();
        /** @type {string[]} */
        const events = [];
        const files = stubOpfs({
            async onOpen() { opened.resolve(void 0); await resume.promise; },
            async onWrite() { events.push('write'); },
            onAbort() { events.push('abort'); },
            onRemove() { events.push('remove'); },
        });
        const database = createStagingDatabase();
        const {blob, plan} = createPack();
        const staged = database.stageGenerationMediaPayload(blob, plan);
        await opened.promise;
        const discarded = staged.discard();
        const rolledBack = database._rollbackGenerationMedia(generation);
        try {
            expect(files.has(generation + '.bin')).toBe(true);
            expect(events).toEqual([]);
        } finally {
            resume.resolve(void 0);
            await Promise.all([discarded, rolledBack]);
        }
        expect(events).toEqual(['abort', 'remove']);
        expect(files.has(generation + '.bin')).toBe(false);
        expect(database.canWriteGenerationMedia()).toBe(true);
    });

    test('rejects mismatched slot geometry and cancels during an in-flight payload write', async () => {
        const writing = deferPromise();
        const resume = deferPromise();
        /** @type {string[]} */
        const events = [];
        const files = stubOpfs({
            async onWrite() { writing.resolve(void 0); await resume.promise; },
            onAbort() { events.push('abort'); },
            onClose() { events.push('close'); },
            onRemove() { events.push('remove'); },
        });
        const database = createStagingDatabase();
        const {blob, plan} = createPack();
        const staged = database.stageGenerationMediaPayload(blob, plan);
        await writing.promise;
        try {
            await expect(staged.seal({...plan, descriptor: {...plan.descriptor, firstId: 2}})).rejects.toThrow('does not match staged generation media geometry');
            expect(events).toEqual([]);
        } finally {
            const discarded = staged.discard();
            resume.resolve(void 0);
            await discarded;
        }
        expect(events).toEqual(['abort', 'remove']);
        expect(files.has(generation + '.bin')).toBe(false);
    });

    test('cleans a failed positioned write before using the ordinary single-write fallback', async () => {
        /** @type {string[]} */
        const events = [];
        const files = stubOpfs({
            async onWrite(position) {
                events.push(`write:${position}`);
                if (position > 0) { throw new Error('Positioned write failed'); }
            },
            onAbort() { events.push('abort'); },
            onRemove() { events.push('remove'); },
            onClose() { events.push('close'); },
        });
        const database = createStagingDatabase();
        const {blob, plan} = createPack();
        const staged = database.stageGenerationMediaPayload(blob, plan);
        await expect(staged.seal(plan)).rejects.toThrow('Positioned write failed');
        await staged.discard();
        expect(files.size).toBe(0);
        await database.writeGenerationMedia(blob, plan);
        await database._awaitGenerationMediaPublication(plan.descriptor);
        expect(events).toEqual([`write:${512 + plan.index.byteLength}`, 'abort', 'remove', 'write:0', 'close']);
        expect(files.size).toBe(1);
    });

    test('reclaims a failed pack before allowing ordinary media storage to continue', async () => {
        const files = stubOpfs({
            async onWrite() { throw new Error('Pack write failed'); },
        });
        const database = createStagingDatabase();
        const {blob, plan} = createPack();
        await expect(database.writeGenerationMedia(blob, plan)).resolves.toBe(false);
        expect(files.size).toBe(0);
        expect(database._generationMediaWrite).toBeNull();
        await expect(database._awaitGenerationMediaPublication(void 0)).resolves.toBeUndefined();
    });

    test('declines duplicate IDs, loose spelling, and out-of-bounds offsets before publication', () => {
        const {blob, records} = createPack();
        expect(createGenerationMediaIndex([...records, records[0]], blob.size)).toBeNull();
        expect(createGenerationMediaIndex([...records, {...records[0], path: 'img/card01.webp'}], blob.size)).toBeNull();
        expect(createGenerationMediaIndex([{...records[0], packedOffset: blob.size}, ...records.slice(1)], blob.size)).toBeNull();
    });
});
