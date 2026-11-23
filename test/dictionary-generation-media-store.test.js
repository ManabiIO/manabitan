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

    test.each([
        '',
        '0',
        '02',
        '+2',
        '-2',
        '2.0',
        '2e0',
        '0x2',
        ' 2',
        '2 ',
        '2\n',
        '\uff12',
        '\u0662',
        '2_0',
        '2/0',
        '2\0',
        'Infinity',
        'NaN',
        '4294967296',
        '9007199254740991',
        '9007199254740992',
        '9007199254740993',
        '99999999999999999999999999999999999999999999999999',
    ])('declines noncanonical or out-of-range media ID %j', (digits) => {
        const {blob, records, plan} = createPack();
        const path = `img/card${digits}.webp`;
        expect(createGenerationMediaIndex([records[0], {...records[1], path}], blob.size)).toBeNull();
        expect(restrictGenerationMediaIndex(plan, [path])).toBeNull();
    });

    test('preserves exact namespace matching and the maximum media ID', () => {
        const {blob, records} = createPack();
        const first = 0xfffffffe;
        const plan = createGenerationMediaIndex(records.slice(0, 2).map((record, index) => ({
            ...record,
            path: `img/card${first + index}.webp`,
        })), blob.size);
        if (plan === null) { throw new Error('Expected the maximum media IDs to be admitted'); }
        expect(plan.descriptor).toMatchObject({firstId: first, slotCount: 2, count: 2});
        const selected = restrictGenerationMediaIndex(plan, ['img/card4294967295.webp']);
        if (selected === null) { throw new Error('Expected the maximum media ID to be selected'); }
        expect(selected.descriptor).toEqual({...plan.descriptor, count: 1});
        expect(selected.index.slice(24)).toEqual(plan.index.slice(24));
        expect(new DataView(selected.index.buffer).getUint32(0, true)).toBe(0);
        expect(restrictGenerationMediaIndex(plan, ['img/card4294967295.WEBP'])).toBeNull();
        expect(restrictGenerationMediaIndex(plan, ['img/other4294967295.webp'])).toBeNull();
        expect(restrictGenerationMediaIndex(plan, ['img/card4294967295.webp/'])).toBeNull();
    });
});
