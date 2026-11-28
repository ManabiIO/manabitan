/* Copyright (C) 2026 Manabitan authors. GPL-3.0-or-later. */
import {describe, expect, test, vi} from 'vitest';
import {ContentReferenceIterationError, TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js';
import {RAW_TERM_CONTENT_COMPRESSED_SHARED_GLOSSARY_DICT_NAME, RAW_TERM_CONTENT_DICT_NAME,
    RAW_TERM_CONTENT_SHARED_GLOSSARY_DICT_NAME, RAW_TERM_CONTENT_TOKEN_DICT_NAME} from '../ext/js/dictionary/raw-term-content.js';

const GENERATION = 'dictionary-storage-generation:7';
const DICTIONARY = 'Iterator Dictionary';
const U32_NULL = 0xffffffff;
/** @typedef {{name: string, start: number, end: number}} ReadRange */
/** @typedef {{codec?: string, count?: number, format?: number, corruptDerived?: boolean}} ShardSpec */

/**
 * Browser-shaped immutable ranged file: whole-file reads fail the test. The
 * backing bytes belong to the fixture and never escape through returned blobs.
 * @param {string} name
 * @param {Uint8Array} bytes
 * @param {ReadRange[]} reads
 * @returns {File}
 */
function rangedFile(name, bytes, reads) {
    return /** @type {File} */ (/** @type {unknown} */ ({
        size: bytes.byteLength,
        /**
         * @param {number} start
         * @param {number} end
         * @returns {{arrayBuffer: () => Promise<ArrayBufferLike>}}
         */
        slice(start, end) {
            reads.push({name, start, end});
            const owned = bytes.slice(start, end);
            return {async arrayBuffer() { return owned.buffer; }};
        },
        async arrayBuffer() { throw new Error('Whole-file metadata materialization is forbidden'); },
    }));
}
/**
 * @param {Uint8Array[]} parts
 * @returns {Uint8Array}
 */
function join(parts) {
    const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
    }
    return result;
}
/**
 * @param {ShardSpec[]} [specs]
 * @returns {Promise<{store: TermRecordOpfsStore, files: Map<string, Uint8Array>, handles: Map<string, FileSystemFileHandle>, directory: FileSystemDirectoryHandle, reads: ReadRange[], expected: import('../ext/js/dictionary/term-record-opfs-store.js').ContentReference[], layout: Array<{fileName: string, fieldsStart: number, payloadStart: number, payloadEnd: number}>, attach: (target: TermRecordOpfsStore) => void}>}
 */
async function fixture(specs = [{}]) {
    const store = new TermRecordOpfsStore();
    /** @type {ReadRange[]} */
    const reads = [];
    /** @type {Map<string, Uint8Array>} */
    const files = new Map();
    /** @type {Map<string, FileSystemFileHandle>} */
    const handles = new Map();
    /** @type {Array<{recordId: number, entryContentOffset: number, entryContentLength: number, entryContentDictName: string}>} */
    const expected = [];
    /** @type {Array<{fileName: string, fieldsStart: number, payloadStart: number, payloadEnd: number}>} */
    const layout = [];
    let nextId = 1;
    for (let index = 0; index < specs.length; ++index) {
        const {codec = 'raw', count = 80, format = 1, corruptDerived = false} = specs[index];
        const base = 2 ** 40 + index * 100000;
        const fileName = store._getShardSegmentFileName(DICTIONARY, codec, index);
        const generation = Uint8Array.from({length: 16}, (_, i) => i + index);
        const descriptor = store._createBinaryHeader(codec, generation);
        const records = Array.from({length: count}, (_, i) => ({id: nextId + i,
            dictionary: DICTIONARY,
            expression: 'term-' + i,
            reading: 'reading-' + i,
            expressionReverse: null,
            readingReverse: null,
            entryContentOffset: i === 1 ? -1 : base + i * 11,
            entryContentLength: i === 2 ? -1 : i + 3,
            entryContentDictName: codec,
            score: 0,
            sequence: null}));
        const encoded = await store._encodeRecords(records);
        let fields;
        if (format === 2) {
            fields = store._encodeArtifactRecordFields(
                {rowCount: count, scoreList: new Int32Array(count)},
                Float64Array.from(records, (row) => row.entryContentOffset),
                Array.from(records, (row) => row.entryContentLength),
                base,
            );
            expect(new DataView(fields.buffer).getUint32(0, true)).toBe(0x3246524d);
        } else {
            const stride = format === 3 ? 16 : 12;
            fields = new Uint8Array(count * stride);
            const view = new DataView(fields.buffer);
            for (let i = 0; i < count; ++i) {
                view.setUint32(i * stride, records[i].entryContentOffset < 0 ? U32_NULL : records[i].entryContentOffset - base, true);
                view.setUint32(i * stride + 4, records[i].entryContentLength < 0 ? U32_NULL : records[i].entryContentLength, true);
                if (format === 3) { view.setFloat64(i * stride + 8, 0.5, true); }
            }
        }
        const chunk = store._createLookupIndexChunk(nextId, count, base, encoded.lookupIndexBytes, fields, format);
        if (corruptDerived) { chunk[40 + encoded.lookupIndexBytes.length - 1] ^= 0x55; }
        const header = new Uint8Array(40);
        header.set(new TextEncoder().encode('MBTIDX11'));
        const view = new DataView(header.buffer);
        view.setUint32(8, descriptor.length, true);
        view.setUint32(16, 1, true);
        view.setUint32(20, count, true);
        header.set(generation, 24);
        files.set(fileName, descriptor);
        files.set(fileName + '.mbti', join([header, chunk]));
        layout.push({fileName,
            payloadStart: 80,
            payloadEnd: 80 + encoded.lookupIndexBytes.length,
            fieldsStart: 80 + encoded.lookupIndexBytes.length});
        for (const record of records) {
            expected.push({recordId: record.id,
                entryContentOffset: record.entryContentOffset,
                entryContentLength: record.entryContentLength,
                entryContentDictName: codec});
        }
        nextId += count;
    }
    for (const [name] of files) {
        handles.set(name, /** @type {FileSystemFileHandle} */ (/** @type {unknown} */ ({
            getFile: vi.fn(async () => rangedFile(name, /** @type {Uint8Array} */ (files.get(name)), reads)),
        })));
    }
    const directory = /** @type {FileSystemDirectoryHandle} */ (/** @type {unknown} */ ({
        getFileHandle: vi.fn(async (name) => {
            const handle = handles.get(name);
            if (typeof handle === 'undefined') {
                const error = new Error('File not found');
                error.name = 'NotFoundError';
                throw error;
            }
            return handle;
        }),
    }));
    /**
     * @param {TermRecordOpfsStore} target
     */
    const attach = (target) => {
        Reflect.set(target, '_recordsDirectoryHandle', directory);
        for (const item of layout) {
            const info = target._decodeShardInfoFromShardFileName(item.fileName);
            if (info === null) { throw new Error('Invalid fixture shard'); }
            const handle = handles.get(item.fileName);
            if (typeof handle === 'undefined') { throw new Error('Missing fixture handle'); }
            const state = target._createShardState(
                item.fileName,
                handle,
                /** @type {Uint8Array} */ (files.get(item.fileName)).length,
                info.contentDictName,
                info.segmentIndex,
            );
            Reflect.get(target, '_shardStateByFileName').set(item.fileName, state);
        }
    };
    attach(store);
    return {store, files, handles, directory, reads, expected, layout, attach};
}
/**
 * @param {TermRecordOpfsStore} store
 * @param {boolean} [restart]
 * @returns {Promise<{rows: import('../ext/js/dictionary/term-record-opfs-store.js').ContentReference[], emptyPages: number}>}
 */
async function collect(store, restart = false) {
    /** @type {import('../ext/js/dictionary/term-record-opfs-store.js').ContentReferenceCursor|null} */
    let cursor = null;
    /** @type {import('../ext/js/dictionary/term-record-opfs-store.js').ContentReference[]} */
    const rows = [];
    let emptyPages = 0;
    for (let page = 0; page < 10000; ++page) {
        const old = cursor === null ? null : JSON.parse(JSON.stringify(cursor));
        const result = await store.iterateContentReferences(
            DICTIONARY,
            GENERATION,
            cursor,
            {byteBudget: 1024, isGenerationCurrent: () => true},
        );
        expect(cursor).toEqual(old);
        const charge = result.references.reduce((sum, row) => sum + 64 + row.entryContentDictName.length * 2, 0);
        expect(result.bytesRead + charge).toBeLessThanOrEqual(1024);
        if (result.references.length === 0) { ++emptyPages; }
        rows.push(...result.references);
        if (result.done) { return {rows, emptyPages}; }
        cursor = restart ? JSON.parse(JSON.stringify(result.cursor)) : result.cursor;
    }
    throw new Error('Iterator did not make bounded progress');
}
/**
 * @param {TermRecordOpfsStore} store
 */
function expectNoForegroundState(store) {
    expect(Reflect.get(store, '_recordsById').size).toBe(0);
    expect(Reflect.get(store, '_persistentRecordChunksByDictionary').size).toBe(0);
    expect(Reflect.get(store, '_persistentIndexLoadedDictionaryNames').size).toBe(0);
    expect(Reflect.get(store, '_loadedDictionaryNames').size).toBe(0);
    expect(Reflect.get(store, '_indexByDictionary').size).toBe(0);
    expect(Reflect.get(store, '_dictionaryHealthByName').size).toBe(0);
}

describe('private bounded authoritative content-reference metadata iterator', () => {
    test.each([1, 2, 3])('format %i: bounds, exact references, nulls and >2^32 offsets survive JSON resume', async (format) => {
        const f = await fixture([{format, count: 300}]);
        vi.spyOn(f.store, '_tryLoadPersistentDictionaryIndex').mockImplementation(async () => { throw new Error('Foreground index load forbidden'); });
        vi.spyOn(f.store, '_rebuildLookupIndexForShard').mockImplementation(async () => { throw new Error('Whole-file repair forbidden'); });
        const result = await collect(f.store, true);
        expect(result.rows).toEqual(f.expected);
        expect(result.emptyPages).toBeGreaterThan(1);
        for (const read of f.reads) { expect(read.end - read.start).toBeLessThanOrEqual(1024); }
        expectNoForegroundState(f.store);
    });


    test('resumes across multiple authoritative chunks without materializing their lookup payloads', async () => {
        const f = await fixture([{count: 120, format: 2}]);
        const name = f.layout[0].fileName + '.mbti';
        const original = f.files.get(name);
        if (typeof original === 'undefined') { throw new Error('Missing container'); }
        const second = original.slice(40);
        new DataView(second.buffer).setUint32(0, 121, true);
        const combined = join([original, second]);
        const header = new DataView(combined.buffer);
        header.setUint32(16, 2, true);
        header.setUint32(20, 240, true);
        f.files.set(name, combined);
        const expected = [...f.expected, ...f.expected.map((row) => ({...row, recordId: row.recordId + 120}))];
        const {rows} = await collect(f.store, true);
        expect(rows).toEqual(expected);
        rows[0].entryContentOffset = 0;
        expect((await collect(f.store)).rows).toEqual(expected);
        expect(rows.every((row) => Object.values(row).every((value) => typeof value === 'number' || typeof value === 'string'))).toBe(true);
        expectNoForegroundState(f.store);
    });

    test('never reads expression/base/derived payloads and tolerates damaged derived lookup bytes', async () => {
        const f = await fixture([{corruptDerived: true}]);
        const result = await collect(f.store);
        expect(result.rows).toEqual(f.expected);
        const layout = f.layout[0];
        const bodyReads = f.reads.filter((read) => read.name.endsWith('.mbti'));
        expect(bodyReads.every((read) => read.end <= layout.payloadStart || read.start >= layout.payloadEnd)).toBe(true);
        expectNoForegroundState(f.store);
    });

    test('all supported common codec headers and shard boundaries are visited', async () => {
        const codecs = ['raw',
            RAW_TERM_CONTENT_DICT_NAME,
            RAW_TERM_CONTENT_SHARED_GLOSSARY_DICT_NAME,
            RAW_TERM_CONTENT_COMPRESSED_SHARED_GLOSSARY_DICT_NAME,
            RAW_TERM_CONTENT_TOKEN_DICT_NAME,
            'jmdict',
            'custom-辞書'];
        const f = await fixture(codecs.map((codec) => ({codec})));
        const {rows} = await collect(f.store, true);
        expect(rows.sort((a, b) => a.recordId - b.recordId)).toEqual(f.expected);
        expectNoForegroundState(f.store);
    });

    test('a fresh store resumes a portable cursor and outputs have no borrowed state', async () => {
        const f = await fixture([{count: 1000, format: 2}]);
        const first = await f.store.iterateContentReferences(
            DICTIONARY,
            GENERATION,
            null,
            {byteBudget: 1024, isGenerationCurrent: () => true},
        );
        const restored = new TermRecordOpfsStore();
        f.attach(restored);
        const old = JSON.parse(JSON.stringify(first.cursor));
        const next = await restored.iterateContentReferences(
            DICTIONARY,
            GENERATION,
            old,
            {byteBudget: 1024, isGenerationCurrent: () => true},
        );
        expect(old).toEqual(first.cursor);
        expect(next.cursor).not.toBe(old);
        expect(next.cursor?.hash.lanes).not.toBe(old.hash.lanes);
        expect(next.cursor?.hash.tail).not.toBe(old.hash.tail);
        const ordinary = await collect(f.store, true);
        expect(ordinary.rows).toEqual(f.expected);
        expectNoForegroundState(restored);
    });

    test('an interrupted verification step replays the same cursor and checksum exactly', async () => {
        const f = await fixture([{format: 3, count: 500}]);
        const first = await f.store.iterateContentReferences(
            DICTIONARY,
            GENERATION,
            null,
            {byteBudget: 1024, isGenerationCurrent: () => true},
        );
        const checkpoint = JSON.parse(JSON.stringify(first.cursor));
        const a = await f.store.iterateContentReferences(
            DICTIONARY,
            GENERATION,
            checkpoint,
            {byteBudget: 1024, isGenerationCurrent: () => true},
        );
        const b = await f.store.iterateContentReferences(
            DICTIONARY,
            GENERATION,
            JSON.parse(JSON.stringify(checkpoint)),
            {byteBudget: 1024, isGenerationCurrent: () => true},
        );
        expect(a).toEqual(b);
        expect(JSON.stringify(a.cursor).length).toBeLessThan(2048);
    });

    test('transient and missing container reads are retryable without health or repair publication', async () => {
        const f = await fixture();
        const handle = f.handles.get(f.layout[0].fileName);
        if (typeof handle === 'undefined') { throw new Error('Missing handle'); }
        vi.mocked(handle.getFile).mockRejectedValueOnce(new Error('Temporary storage read error'));
        await expect(f.store.iterateContentReferences(
            DICTIONARY,
            GENERATION,
            null,
            {byteBudget: 1024, isGenerationCurrent: () => true},
        )).rejects.toMatchObject({kind: 'unavailable'});
        expectNoForegroundState(f.store);
        expect((await collect(f.store)).rows).toEqual(f.expected);
        f.handles.delete(f.layout[0].fileName + '.mbti');
        await expect(f.store.iterateContentReferences(
            DICTIONARY,
            GENERATION,
            null,
            {byteBudget: 1024, isGenerationCurrent: () => true},
        )).rejects.toMatchObject({kind: 'unavailable'});
        expectNoForegroundState(f.store);
    });

    test('partial range reads are transient and a runtime without slicing never falls back to whole-file reads', async () => {
        const f = await fixture();
        vi.spyOn(f.store, '_readFileRange').mockResolvedValueOnce(new Uint8Array(0));
        await expect(f.store.iterateContentReferences(
            DICTIONARY,
            GENERATION,
            null,
            {byteBudget: 1024, isGenerationCurrent: () => true},
        )).rejects.toMatchObject({kind: 'unavailable'});
        vi.restoreAllMocks();
        const handle = f.handles.get(f.layout[0].fileName);
        if (typeof handle === 'undefined') { throw new Error('Missing handle'); }
        const wholeRead = vi.fn(async () => new ArrayBuffer(0));
        vi.mocked(handle.getFile).mockResolvedValueOnce(/** @type {File} */ (/** @type {unknown} */ ({size: 26, arrayBuffer: wholeRead})));
        await expect(f.store.iterateContentReferences(
            DICTIONARY,
            GENERATION,
            null,
            {byteBudget: 1024, isGenerationCurrent: () => true},
        )).rejects.toMatchObject({kind: 'resource'});
        expect(wholeRead).not.toHaveBeenCalled();
        expectNoForegroundState(f.store);
    });

    test.each(['owner', 'store', 'state', 'abort'])('rechecks %s preemption after a suspended range read', async (mode) => {
        const f = await fixture();
        const entered = Promise.withResolvers();
        const resume = Promise.withResolvers();
        const controller = new AbortController();
        let current = true;
        const original = f.store._readFileRange.bind(f.store);
        vi.spyOn(f.store, '_readFileRange').mockImplementationOnce(async (...args) => {
            entered.resolve(void 0);
            await resume.promise;
            return await original(...args);
        });
        const pending = f.store.iterateContentReferences(
            DICTIONARY,
            GENERATION,
            null,
            {byteBudget: 1024, signal: controller.signal, isGenerationCurrent: () => current},
        );
        await entered.promise;
        if (mode === 'owner') { current = false; }
        if (mode === 'store') { f.store._invalidatePersistentLookupState(DICTIONARY); }
        if (mode === 'state') { Reflect.get(f.store, '_shardStateByFileName').delete(f.layout[0].fileName); }
        if (mode === 'abort') { controller.abort(); }
        resume.resolve(void 0);
        await expect(pending).rejects.toMatchObject(mode === 'abort' ? {name: 'AbortError'} : {kind: 'stale'});
    });

    test('pre-abort and active import admission perform no file reads', async () => {
        const f = await fixture();
        const controller = new AbortController(); controller.abort();
        await expect(f.store.iterateContentReferences(
            DICTIONARY,
            GENERATION,
            null,
            {byteBudget: 1024, signal: controller.signal, isGenerationCurrent: () => true},
        )).rejects.toMatchObject({name: 'AbortError'});
        Reflect.set(f.store, '_importSessionActive', true);
        await expect(f.store.iterateContentReferences(
            DICTIONARY,
            GENERATION,
            null,
            {byteBudget: 1024, isGenerationCurrent: () => true},
        )).rejects.toMatchObject({kind: 'unavailable'});
        expect(f.reads).toHaveLength(0);
    });

    test('changed shard generations reject persisted cursors without publication', async () => {
        const f = await fixture();
        const first = await f.store.iterateContentReferences(
            DICTIONARY,
            GENERATION,
            null,
            {byteBudget: 1024, isGenerationCurrent: () => true},
        );
        const descriptor = f.files.get(f.layout[0].fileName);
        const container = f.files.get(f.layout[0].fileName + '.mbti');
        if (typeof descriptor === 'undefined' || typeof container === 'undefined') { throw new Error('Missing bytes'); }
        descriptor[8] ^= 1;
        container[24] ^= 1;
        await expect(f.store.iterateContentReferences(
            DICTIONARY,
            GENERATION,
            first.cursor,
            {byteBudget: 1024, isGenerationCurrent: () => true},
        )).rejects.toMatchObject({kind: 'stale'});
        expectNoForegroundState(f.store);
    });

    test('authoritative field checksum failure emits no references and does not quarantine', async () => {
        const f = await fixture([{count: 300, format: 3}]);
        const bytes = f.files.get(f.layout[0].fileName + '.mbti');
        if (typeof bytes === 'undefined') { throw new Error('Missing container'); }
        bytes[f.layout[0].fieldsStart + 7] ^= 1;
        let cursor = null;
        let error;
        for (let page = 0; page < 100; ++page) {
            try {
                const result = await f.store.iterateContentReferences(
                    DICTIONARY,
                    GENERATION,
                    cursor,
                    {byteBudget: 1024, isGenerationCurrent: () => true},
                );
                expect(result.references).toHaveLength(0);
                cursor = result.cursor;
            } catch (caught) { error = caught; break; }
        }
        expect(error).toBeInstanceOf(ContentReferenceIterationError);
        expect(error).toMatchObject({kind: 'invalid'});
        expectNoForegroundState(f.store);
    });


    test.each(['format', 'offset', 'truncated'])('rejects invalid authoritative %s metadata without changing dictionary health', async (damage) => {
        const f = await fixture([{format: 2}]);
        const name = f.layout[0].fileName + '.mbti';
        const bytes = f.files.get(name);
        if (typeof bytes === 'undefined') { throw new Error('Missing container'); }
        const view = new DataView(bytes.buffer);
        if (damage === 'format') { view.setUint32(40 + 36, 99, true); }
        if (damage === 'offset') { view.setUint32(40 + 12, 0xffffffff, true); }
        if (damage === 'truncated') { f.files.set(name, bytes.slice(0, -1)); }
        await expect(f.store.iterateContentReferences(
            DICTIONARY,
            GENERATION,
            null,
            {byteBudget: 1024, isGenerationCurrent: () => true},
        )).rejects.toMatchObject({kind: 'invalid'});
        expectNoForegroundState(f.store);
    });

    test('malformed checkpoints, mismatched generations and invalid request budgets fail before I/O', async () => {
        const f = await fixture();
        const first = await f.store.iterateContentReferences(
            DICTIONARY,
            GENERATION,
            null,
            {byteBudget: 1024, isGenerationCurrent: () => true},
        );
        /** @type {Array<(state: import('core').SafeAny) => void>} Malformed persisted checkpoints intentionally exceed the admitted type. */
        const mutations = [
            (s) => { s.version = 2; },
            (s) => { s.generation = 'another-generation'; },
            (s) => { s.row = -1; },
            (s) => { s.chunkOffset = 2 ** 53; },
            (s) => { s.extra = true; },
            (s) => { s.verifyOffset = -1; },
            (s) => { s.hash.tail = new Array(16).fill(0); },
            (s) => { s.hash.lanes = [0, 1]; },
            (s) => { s.shardGeneration = 12; },
        ];
        f.reads.length = 0;
        for (const mutate of mutations) {
            const bad = JSON.parse(JSON.stringify(first.cursor)); mutate(bad);
            await expect(f.store.iterateContentReferences(
                DICTIONARY,
                GENERATION,
                bad,
                {byteBudget: 1024, isGenerationCurrent: () => true},
            )).rejects.toBeInstanceOf(TypeError);
        }
        for (const byteBudget of [0, 1023, 1048577, Number.NaN, 1024.5]) {
            await expect(f.store.iterateContentReferences(
                DICTIONARY,
                GENERATION,
                null,
                {byteBudget, isGenerationCurrent: () => true},
            )).rejects.toBeInstanceOf(TypeError);
        }
        expect(f.reads).toHaveLength(0);
    });
});


test('caps output references independently from the larger input checksum budget', async () => {
    const f = await fixture([{count: 80}]);
    /** @type {import('../ext/js/dictionary/term-record-opfs-store.js').ContentReferenceCursor|null} */
    let cursor = null;
    /** @type {import('../ext/js/dictionary/term-record-opfs-store.js').ContentReference[]} */
    const rows = [];
    for (let step = 0; step < 100; ++step) {
        const page = await f.store.iterateContentReferences(
            DICTIONARY,
            GENERATION,
            cursor,
            {byteBudget: 262144, maxReferences: 3, isGenerationCurrent: () => true},
        );
        expect(page.references.length).toBeLessThanOrEqual(3);
        rows.push(...page.references);
        if (page.done) {
            expect(rows).toEqual(f.expected);
            expect(step).toBeGreaterThan(20);
            expectNoForegroundState(f.store);
            return;
        }
        cursor = JSON.parse(JSON.stringify(page.cursor));
    }
    throw new Error('Bounded iterator did not finish');
});


test('legacy screening skips only a validated matched shard without reading its record fields', async () => {
    const f = await fixture([{codec: 'raw-block-v2:jmdict', count: 5000}]);
    const page = await f.store.iterateContentReferences(DICTIONARY, GENERATION, null, {
        byteBudget: 1024,
        isGenerationCurrent: () => true,
        skipSelector: (selector) => selector === 'raw-block-v2:jmdict',
    });
    expect(page).toMatchObject({references: [], cursor: null, done: true});
    const sidecarReads = f.reads.filter((entry) => entry.name.endsWith('.mbti'));
    expect(sidecarReads).toHaveLength(1);
    expect(sidecarReads[0].start).toBe(0);
    expect(sidecarReads[0].end).toBeLessThan(f.layout[0].payloadStart);
    expectNoForegroundState(f.store);
});


test('a finished block range exposes portable interior rows without crossing the shard boundary', async () => {
    const f = await fixture([{codec: 'raw-block-v2', count: 160, format: 2}, {codec: 'raw-block-v2', count: 136, format: 2}]);
    let current = true;
    const options = {maxReferences: 64, maxBlockReferences: 256, isGenerationCurrent: () => current};
    const start = await f.store.iterateContentReferences(DICTIONARY, GENERATION, null, options);
    expect(start.references).toEqual([]);
    const range = await f.store.iterateContentReferences(DICTIONARY, GENERATION, start.cursor, options);
    expect(range.references).toEqual(f.expected.slice(0, 160));
    const after = range.cursorAfterBlockReference;
    if (!after) { throw new Error('Expected a verified block range'); }
    expect(() => after(0)).toThrow(/inside its verified block range/);
    expect(() => after(160)).toThrow(/inside its verified block range/);
    const persisted = JSON.parse(JSON.stringify(after(65)));
    expect(persisted.row).toBe(65);
    const restarted = new TermRecordOpfsStore();
    f.attach(restarted);
    const suffix = await restarted.iterateContentReferences(DICTIONARY, GENERATION, persisted, options);
    expect(suffix.references).toEqual(f.expected.slice(65, 160));
    expect(suffix.cursor).toEqual(range.cursor);
    expect(suffix.cursor?.shardFileName).not.toBe(persisted.shardFileName);
    current = false;
    expect(() => after(65)).toThrow(/generation changed/);
});

test('an unwrapped legacy reference page still obeys the smaller bound', async () => {
    const f = await fixture([{codec: 'opaque-legacy', count: 160}]);
    const options = {maxReferences: 64, maxBlockReferences: 256, isGenerationCurrent: () => true};
    const verify = await f.store.iterateContentReferences(DICTIONARY, GENERATION, null, options);
    const page = await f.store.iterateContentReferences(DICTIONARY, GENERATION, verify.cursor, options);
    expect(page.references).toHaveLength(64);
    expect(page.cursorAfterBlockReference).toBeUndefined();
});
