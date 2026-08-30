/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {describe, expect, test, vi} from 'vitest';
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js';
import {DictionaryImportSession} from '../ext/js/dictionary/dictionary-import-session.js';
import {RawZipPayloadReader, TermBankSourcePipeline} from '../ext/js/dictionary/term-bank-source-pipeline.js';
import {DictionaryImporterMediaLoader} from './mocks/dictionary-importer-media-loader.js';

/** @returns {{startBulkImport: ReturnType<typeof vi.fn>, finishBulkImport: ReturnType<typeof vi.fn>, abortBulkImport: ReturnType<typeof vi.fn>, bulkUpdate: ReturnType<typeof vi.fn>, deleteDictionary: ReturnType<typeof vi.fn>, deleteDictionaryImportPlaceholder: ReturnType<typeof vi.fn>}} */
function createDatabase() {
    return {
        startBulkImport: vi.fn(async () => {}),
        finishBulkImport: vi.fn(async () => ({commitMs: 12})),
        abortBulkImport: vi.fn(async () => {}),
        bulkUpdate: vi.fn(async () => {}),
        deleteDictionary: vi.fn(async () => {}),
        deleteDictionaryImportPlaceholder: vi.fn(async () => {}),
    };
}

/**
 * @param {ReturnType<typeof createDatabase>} dictionaryDatabase
 * @param {Error[]} errors
 * @param {{close: () => Promise<void>}} archiveReader
 * @param {() => Promise<void>} disposeParser
 * @returns {DictionaryImportSession}
 */
function createSession(dictionaryDatabase, errors, archiveReader, disposeParser) {
    return new DictionaryImportSession({
        dictionaryDatabase: /** @type {import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} */ (/** @type {unknown} */ (dictionaryDatabase)),
        dictionaryTitle: 'Test dictionary',
        dictionarySummaryPrimaryKey: 42,
        errors,
        archiveReader,
        disposeParser,
    });
}

describe('DictionaryImportSession', () => {
    const summary = /** @type {import('dictionary-importer').Summary} */ ({title: 'Test dictionary'});

    test('commits and publishes a completed import once', async () => {
        const order = [];
        const dictionaryDatabase = createDatabase();
        const session = createSession(
            dictionaryDatabase,
            [],
            {close: vi.fn(async () => { order.push('archive'); })},
            vi.fn(async () => { order.push('parser'); }),
        );
        const sourcePipeline = {dispose: vi.fn(async () => { order.push('source'); })};
        session.setSourcePipeline(sourcePipeline);

        await Promise.all([session.startBulkImport(), session.startBulkImport()]);
        const results = await Promise.all([
            session.finalizeBulkImport(() => {}, summary),
            session.finalizeBulkImport(() => {}, summary),
        ]);

        expect(order).toEqual(['source', 'parser', 'archive']);
        expect(results).toEqual([{commitMs: 12}, {commitMs: 12}]);
        expect(dictionaryDatabase.startBulkImport).toHaveBeenCalledTimes(1);
        expect(dictionaryDatabase.finishBulkImport).toHaveBeenCalledTimes(1);
        expect(dictionaryDatabase.finishBulkImport).toHaveBeenCalledWith(expect.any(Function), {
            summary,
            primaryKey: 42,
        });
        expect(dictionaryDatabase.abortBulkImport).not.toHaveBeenCalled();
        expect(dictionaryDatabase.bulkUpdate).not.toHaveBeenCalled();
        expect(sourcePipeline.dispose).toHaveBeenCalledTimes(1);
        expect(session.state).toBe('published');
    });

    test('does not commit until owned resources have been disposed', async () => {
        const order = [];
        const dictionaryDatabase = createDatabase();
        dictionaryDatabase.finishBulkImport.mockImplementation(async () => {
            order.push('commit');
            return {commitMs: 12};
        });
        const session = createSession(
            dictionaryDatabase,
            [],
            {close: vi.fn(async () => { order.push('archive'); })},
            vi.fn(async () => { order.push('parser'); }),
        );
        session.setSourcePipeline({dispose: vi.fn(async () => { order.push('source'); })});

        await session.startBulkImport();
        await session.finalizeBulkImport(() => {}, summary);

        expect(order).toEqual(['source', 'parser', 'archive', 'commit']);
    });

    test('shares archive close completion and failure across concurrent and repeated callers', async () => {
        const closeError = new Error('archive failure');
        /** @type {() => void} */
        let releaseClose;
        const closeGate = new Promise((resolve) => { releaseClose = resolve; });
        const close = vi.fn(async () => {
            await closeGate;
            throw closeError;
        });
        const session = createSession(createDatabase(), [], {close}, vi.fn(async () => {}));

        const first = session.closeArchive();
        const second = session.closeArchive();
        releaseClose();

        await expect(first).rejects.toBe(closeError);
        await expect(second).rejects.toBe(closeError);
        await expect(session.closeArchive()).rejects.toBe(closeError);
        expect(close).toHaveBeenCalledTimes(1);
    });

    test('rolls back failures and removes the placeholder idempotently', async () => {
        const dictionaryDatabase = createDatabase();
        const errors = [];
        const session = createSession(dictionaryDatabase, errors, {close: vi.fn(async () => {})}, vi.fn(async () => {}));
        const importError = new Error('parse failed');

        await session.startBulkImport();
        session.recordFailure(importError);
        session.recordFailure(importError);
        await Promise.all([
            session.finalizeBulkImport(() => {}, summary),
            session.finalizeBulkImport(() => {}, summary),
        ]);
        await Promise.all([
            session.cleanupIncompleteSummary(),
            session.cleanupIncompleteSummary(),
        ]);

        expect(errors).toEqual([importError]);
        expect(dictionaryDatabase.abortBulkImport).toHaveBeenCalledTimes(1);
        expect(dictionaryDatabase.finishBulkImport).not.toHaveBeenCalled();
        expect(dictionaryDatabase.deleteDictionaryImportPlaceholder).toHaveBeenCalledTimes(1);
        expect(session.state).toBe('aborted');
    });

    test('continues cleanup in ownership order and aggregates cleanup failures', async () => {
        const order = [];
        const errors = [];
        const dictionaryDatabase = createDatabase();
        dictionaryDatabase.deleteDictionaryImportPlaceholder.mockRejectedValue(new Error('placeholder failure'));
        const session = createSession(
            dictionaryDatabase,
            errors,
            {close: vi.fn(async () => { order.push('archive'); throw new Error('archive failure'); })},
            vi.fn(async () => { order.push('parser'); throw new Error('parser failure'); }),
        );
        session.setSourcePipeline({
            dispose: vi.fn(async () => { order.push('source'); throw new Error('source failure'); }),
        });

        await session.startBulkImport();
        await Promise.all([session.disposeImportResources(), session.disposeImportResources()]);
        await session.finalizeBulkImport(() => {}, summary);
        await session.cleanupIncompleteSummary();

        expect(order).toEqual(['source', 'parser', 'archive']);
        expect(errors.map(({message}) => message)).toEqual([
            'source failure',
            'parser failure',
            'Failed to close dictionary archive: archive failure',
            'Failed to remove incomplete dictionary summary Test dictionary: placeholder failure',
        ]);
        expect(dictionaryDatabase.abortBulkImport).toHaveBeenCalledTimes(1);
    });

    test('does not remove an atomically published import after finalization', async () => {
        const dictionaryDatabase = createDatabase();
        const session = createSession(dictionaryDatabase, [], {close: vi.fn(async () => {})}, vi.fn(async () => {}));

        await session.startBulkImport();
        await session.finalizeBulkImport(() => {}, summary);
        session.recordFailure(new Error('cancelled after commit'));
        await session.cleanupIncompleteSummary();

        expect(dictionaryDatabase.deleteDictionary).not.toHaveBeenCalled();
        expect(dictionaryDatabase.deleteDictionaryImportPlaceholder).not.toHaveBeenCalled();
    });

    test('records fused summary publication failure and removes attempted data', async () => {
        const dictionaryDatabase = createDatabase();
        const publicationError = new Error('summary update failed');
        dictionaryDatabase.finishBulkImport.mockRejectedValue(publicationError);
        const errors = [];
        const session = createSession(dictionaryDatabase, errors, {close: vi.fn(async () => {})}, vi.fn(async () => {}));

        await session.startBulkImport();
        await session.finalizeBulkImport(() => {}, summary);
        await session.cleanupIncompleteSummary();

        expect(errors).toEqual([publicationError]);
        expect(dictionaryDatabase.deleteDictionary).toHaveBeenCalledWith('Test dictionary', 1000, expect.any(Function));
        expect(dictionaryDatabase.deleteDictionaryImportPlaceholder).not.toHaveBeenCalled();
    });
});

describe('TermBankSourcePipeline', () => {
    test('joins obsolete inflation before fallback, parser disposal, and archive close', async () => {
        const order = [];
        const files = [1, 2].map((index) => ({
            filename: `term_bank_${index}.json`,
            uncompressedSize: 32,
            getData() {},
        }));
        const pipeline = new TermBankSourcePipeline({
            termFiles: files,
            enabled: true,
            read: async (_file, signal) => await new Promise((resolve, reject) => {
                signal.addEventListener('abort', () => {
                    queueMicrotask(() => {
                        order.push('read-settled');
                        reject(new Error('ZIP read aborted'));
                    });
                }, {once: true});
            }),
        });

        pipeline.prefetchNext(0);
        await pipeline.abortAndJoin();
        order.push('fallback');
        pipeline.prefetchNext(1);
        const session = createSession(
            createDatabase(),
            [],
            {close: vi.fn(async () => { order.push('archive'); })},
            vi.fn(async () => { order.push('parser'); }),
        );
        session.setSourcePipeline(pipeline);
        await session.disposeImportResources();

        expect(order).toEqual([
            'read-settled',
            'read-settled',
            'fallback',
            'read-settled',
            'parser',
            'archive',
        ]);
    });

    test('releases successful batches and applies low-memory estimated-length batching', async () => {
        const fortyMegabytes = 40 * 1024 * 1024;
        const files = [1, 2].map((index) => ({
            filename: `term_bank_${index}.json`,
            uncompressedSize: fortyMegabytes,
            getData() {},
        }));
        const read = vi.fn(async () => new TextEncoder().encode('[]'));
        const pipeline = new TermBankSourcePipeline({termFiles: files, enabled: true, read, deviceMemory: 4});
        const batch = pipeline.getBatch(0);

        expect(batch).toEqual([files[0]]);
        await pipeline.readBatch(batch);
        await pipeline.readBatch(batch);
        expect(read).toHaveBeenCalledTimes(1);
        pipeline.releaseBatch(batch);
        await pipeline.readBatch(batch);
        expect(read).toHaveBeenCalledTimes(2);
        await pipeline.dispose();
    });

    test('does not alias distinct ZIP entries that have the same filename', async () => {
        const files = [1, 2].map((id) => ({
            id,
            filename: 'term_bank_1.json',
            uncompressedSize: 32,
            getData() {},
        }));
        const read = vi.fn(async (file) => new Uint8Array([0x5b, file.id, 0x5d]));
        const pipeline = new TermBankSourcePipeline({termFiles: files, enabled: true, read});

        const results = await pipeline.readBatch(files);

        expect(read).toHaveBeenCalledTimes(2);
        expect(results).toStrictEqual([
            new Uint8Array([0x5b, 1, 0x5d]),
            new Uint8Array([0x5b, 2, 0x5d]),
        ]);
        await pipeline.dispose();
    });

    test('prefetches the next batch within a device-memory byte budget', async () => {
        const eightMegabytes = 8 * 1024 * 1024;
        const files = Array.from({length: 16}, (_, index) => ({
            filename: `term_bank_${index + 1}.json`,
            uncompressedSize: eightMegabytes,
            getData() {},
        }));
        const read = vi.fn(async () => new TextEncoder().encode('[]'));
        const lowMemoryPipeline = new TermBankSourcePipeline({termFiles: files, enabled: true, read, deviceMemory: 4});

        expect(lowMemoryPipeline.prefetchMaxBytes).toBe(24 * 1024 * 1024);
        expect(lowMemoryPipeline.prefetchNext(0)).toStrictEqual({fileCount: 3, estimatedBytes: 24 * 1024 * 1024});
        expect(read).toHaveBeenCalledTimes(3);
        await lowMemoryPipeline.dispose();

        read.mockClear();
        const highMemoryPipeline = new TermBankSourcePipeline({termFiles: files, enabled: true, read, deviceMemory: 8});
        expect(highMemoryPipeline.prefetchMaxBytes).toBe(96 * 1024 * 1024);
        expect(highMemoryPipeline.prefetchNext(0)).toStrictEqual({fileCount: 12, estimatedBytes: 96 * 1024 * 1024});
        expect(read).toHaveBeenCalledTimes(12);
        await highMemoryPipeline.dispose();
    });

    test('creates a lazy import-wide plan only for multi-batch sources', async () => {
        const fourMegabytes = 4 * 1024 * 1024;
        const files = Array.from({length: 64}, (_, index) => ({
            filename: `term_bank_${index + 1}.json`,
            uncompressedSize: fourMegabytes,
            getData() {},
        }));
        const read = vi.fn(async () => new TextEncoder().encode('[]'));
        const pipeline = new TermBankSourcePipeline({termFiles: files, enabled: true, read, deviceMemory: 8});

        const plan = pipeline.createImportRunPlan(0);

        expect(plan?.files).toEqual(files);
        expect(plan?.estimatedByteLengths).toEqual(Array.from({length: files.length}, () => fourMegabytes));
        expect(read).not.toHaveBeenCalled();
        await plan?.loaders[0]();
        expect(read).toHaveBeenCalledTimes(1);
        expect(pipeline.createImportRunPlan(files.length - 1)).toBeNull();
        await pipeline.dispose();
    });

    test('keeps large imports batched on low-memory Chromium', async () => {
        const files = Array.from({length: 64}, (_, index) => ({
            filename: `term_bank_${index + 1}.json`,
            offset: index * 64,
            compressionMethod: 8,
            compressedSize: 4,
            uncompressedSize: 4 * 1024 * 1024,
            signature: index + 100,
            getData() {},
        }));
        const pipeline = new TermBankSourcePipeline({
            termFiles: files,
            enabled: true,
            read: async () => new TextEncoder().encode('[]'),
            readCompressed: async () => new Uint8Array(4),
            deviceMemory: 4,
        });

        expect(pipeline.createImportRunPlan(0)).toBeNull();
        expect(pipeline.createCompressedImportRunPlan(0)).toBeNull();
        expect(pipeline.getBatch(0)).toEqual(files.slice(0, 16));
        await pipeline.dispose();
    });

    test('creates a lazy raw-payload plan only with complete validation metadata', async () => {
        const files = Array.from({length: 4}, (_, index) => ({
            filename: `term_bank_${index + 1}.json`,
            offset: index * 64,
            compressionMethod: index === 0 ? 0 : 8,
            compressedSize: index === 0 ? 2 : 4,
            uncompressedSize: index === 0 ? 2 : 8,
            signature: index + 100,
            getData() {},
        }));
        const read = vi.fn(async () => new TextEncoder().encode('[]'));
        const readCompressed = vi.fn(async (file) => new Uint8Array(file.compressedSize));
        const pipeline = new TermBankSourcePipeline({termFiles: files, enabled: true, read, readCompressed});

        const plan = pipeline.createCompressedImportRunPlan(0);

        expect(plan?.files).toEqual(files);
        expect(plan?.estimatedByteLengths).toEqual([2, 8, 8, 8]);
        expect(readCompressed).not.toHaveBeenCalled();
        await expect(plan?.loaders[1]()).resolves.toMatchObject({
            compressionMethod: 8,
            compressedSize: 4,
            uncompressedSize: 8,
            signature: 101,
            filename: 'term_bank_2.json',
        });
        expect(readCompressed).toHaveBeenCalledTimes(1);
        expect(read).not.toHaveBeenCalled();
        await pipeline.dispose();
    });

    test.each([
        ['missing CRC', {signature: void 0}],
        ['missing central offset', {offset: void 0}],
        ['unsafe central offset', {offset: Number.MAX_SAFE_INTEGER + 1}],
        ['invalid raw filename', {rawFilename: 'term_bank_3.json'}],
        ['encrypted entry', {encrypted: true}],
        ['unsupported compression', {compressionMethod: 12}],
        ['stored size mismatch', {compressionMethod: 0, compressedSize: 4, uncompressedSize: 8}],
    ])('does not activate raw-payload parsing for a %s', async (_name, override) => {
        const files = Array.from({length: 4}, (_, index) => ({
            filename: `term_bank_${index + 1}.json`,
            offset: index * 64,
            compressionMethod: 8,
            compressedSize: 4,
            uncompressedSize: 8,
            signature: index + 100,
            getData() {},
            ...(index === 2 ? override : {}),
        }));
        const pipeline = new TermBankSourcePipeline({
            termFiles: files,
            enabled: true,
            read: async () => new TextEncoder().encode('[]'),
            readCompressed: async () => new Uint8Array(4),
        });

        expect(pipeline.createCompressedImportRunPlan(0)).toBeNull();
        await pipeline.dispose();
    });

    test('rejects a raw payload whose byte count disagrees with ZIP metadata', async () => {
        const files = Array.from({length: 4}, (_, index) => ({
            filename: `term_bank_${index + 1}.json`,
            offset: index * 64,
            compressionMethod: 8,
            compressedSize: 4,
            uncompressedSize: 8,
            signature: index + 100,
            getData() {},
        }));
        const pipeline = new TermBankSourcePipeline({
            termFiles: files,
            enabled: true,
            read: async () => new TextEncoder().encode('[]'),
            readCompressed: async () => new Uint8Array(3),
        });

        await expect(pipeline.createCompressedImportRunPlan(0)?.loaders[0]()).rejects.toThrow('ZIP size mismatch');
        await pipeline.dispose();
    });

    test('reads an owned raw payload from a validated ZIP local header', async () => {
        const filename = new TextEncoder().encode('term_bank_1.json');
        const extra = new Uint8Array([1, 2, 3, 4]);
        const payload = new Uint8Array([9, 8, 7, 6, 5]);
        const archive = new Uint8Array(30 + filename.byteLength + extra.byteLength + payload.byteLength);
        const view = new DataView(archive.buffer);
        view.setUint32(0, 0x04034b50, true);
        view.setUint16(6, 0x08, true);
        view.setUint16(8, 8, true);
        view.setUint16(26, filename.byteLength, true);
        view.setUint16(28, extra.byteLength, true);
        archive.set(filename, 30);
        archive.set(extra, 30 + filename.byteLength);
        archive.set(payload, 30 + filename.byteLength + extra.byteLength);
        const reader = new RawZipPayloadReader(archive.buffer);
        const controller = new AbortController();

        const result = await reader.read({
            filename: 'term_bank_1.json',
            offset: 0,
            compressionMethod: 8,
            compressedSize: payload.byteLength,
        }, controller.signal);

        expect(result).toEqual(payload);
        expect(result.buffer).not.toBe(archive.buffer);
    });

    test('rejects raw payload reads with invalid local metadata or cancellation', async () => {
        const archive = new Uint8Array(32);
        const reader = new RawZipPayloadReader(archive.buffer);
        const file = {filename: 'term_bank_1.json', offset: 0, compressionMethod: 8, compressedSize: 2};
        await expect(reader.read(file, new AbortController().signal)).rejects.toThrow('local header is invalid');

        const controller = new AbortController();
        controller.abort();
        await expect(reader.read(file, controller.signal)).rejects.toThrow();
    });

    test.each([
        ['encrypted local entry', {flags: 0x1, localMethod: 8, compressedSize: 2, filenameLength: 0}, 'disagrees with central metadata'],
        ['different local compression method', {flags: 0, localMethod: 0, compressedSize: 2, filenameLength: 0}, 'disagrees with central metadata'],
        ['out-of-bounds local name', {flags: 0, localMethod: 8, compressedSize: 2, filenameLength: 3}, 'payload is out of bounds'],
        ['out-of-bounds payload', {flags: 0, localMethod: 8, compressedSize: 3, filenameLength: 0}, 'payload is out of bounds'],
    ])('rejects a %s', async (_name, {flags, localMethod, compressedSize, filenameLength}, message) => {
        const archive = new Uint8Array(32);
        const view = new DataView(archive.buffer);
        view.setUint32(0, 0x04034b50, true);
        view.setUint16(6, flags, true);
        view.setUint16(8, localMethod, true);
        view.setUint16(26, filenameLength, true);
        const reader = new RawZipPayloadReader(archive.buffer);
        const file = {filename: 'term_bank_1.json', offset: 0, compressionMethod: 8, compressedSize};

        await expect(reader.read(file, new AbortController().signal)).rejects.toThrow(message);
    });

    test('rejects a local filename which disagrees with the central directory', async () => {
        const localFilename = new TextEncoder().encode('term_bank_2.json');
        const centralFilename = new TextEncoder().encode('term_bank_1.json');
        const archive = new Uint8Array(30 + localFilename.byteLength);
        const view = new DataView(archive.buffer);
        view.setUint32(0, 0x04034b50, true);
        view.setUint16(8, 8, true);
        view.setUint16(26, localFilename.byteLength, true);
        archive.set(localFilename, 30);
        const reader = new RawZipPayloadReader(archive.buffer);

        await expect(reader.read({
            filename: 'term_bank_1.json',
            rawFilename: centralFilename,
            offset: 0,
            compressionMethod: 8,
            compressedSize: 0,
        }, new AbortController().signal)).rejects.toThrow('local filename disagrees');
    });

    test('shares a rejected Blob materialization across concurrent raw reads', async () => {
        const archiveError = new Error('archive read failed');
        const archive = new Blob([new Uint8Array(30)]);
        const arrayBuffer = vi.spyOn(archive, 'arrayBuffer').mockRejectedValue(archiveError);
        const reader = new RawZipPayloadReader(archive);
        const file = {filename: 'term_bank_1.json', offset: 0, compressionMethod: 8, compressedSize: 0};

        const first = reader.read(file, new AbortController().signal);
        const second = reader.read(file, new AbortController().signal);

        await expect(first).rejects.toBe(archiveError);
        await expect(second).rejects.toBe(archiveError);
        expect(arrayBuffer).toHaveBeenCalledTimes(1);
    });

    test('waits for a shared Blob materialization to settle after compressed reads are aborted', async () => {
        /** @type {(value: ArrayBuffer) => void} */
        let releaseArchive = () => {};
        /** @type {Promise<ArrayBuffer>} */
        const archiveGate = new Promise((resolve) => { releaseArchive = resolve; });
        const archive = new Blob([new Uint8Array(30)]);
        const arrayBuffer = vi.spyOn(archive, 'arrayBuffer').mockImplementation(async () => await archiveGate);
        const rawReader = new RawZipPayloadReader(archive);
        const files = Array.from({length: 4}, (_, index) => ({
            filename: `term_bank_${index + 1}.json`,
            offset: 0,
            compressionMethod: 8,
            compressedSize: 0,
            uncompressedSize: 2,
            signature: index,
            getData() {},
        }));
        const pipeline = new TermBankSourcePipeline({
            termFiles: files,
            enabled: true,
            read: async () => new TextEncoder().encode('[]'),
            readCompressed: async (file, signal) => await rawReader.read(file, signal),
        });
        const plan = pipeline.createCompressedImportRunPlan(0);
        if (plan === null) { throw new Error('Expected compressed import plan'); }
        const firstRead = plan.loaders[0]();
        const secondRead = plan.loaders[1]();
        const firstRejection = expect(firstRead).rejects.toMatchObject({name: 'AbortError'});
        const secondRejection = expect(secondRead).rejects.toMatchObject({name: 'AbortError'});
        const disposal = pipeline.dispose();
        let disposed = false;
        void disposal.then(() => { disposed = true; });

        await Promise.resolve();
        expect(disposed).toBe(false);
        releaseArchive(new ArrayBuffer(30));
        await disposal;
        await firstRejection;
        await secondRejection;
        expect(arrayBuffer).toHaveBeenCalledTimes(1);
    });

    test('bounds whole-archive materialization for direct ZIP reads', () => {
        expect(RawZipPayloadReader.supportsArchive(new ArrayBuffer(30))).toBe(true);
        expect(RawZipPayloadReader.supportsArchive(new ArrayBuffer(29))).toBe(false);
        expect(RawZipPayloadReader.supportsArchive(
            /** @type {ArrayBuffer} */ (/** @type {unknown} */ ({byteLength: 129 * 1024 * 1024})),
        )).toBe(false);
    });

    test('bounds read-ahead when ZIP entries do not expose uncompressed sizes', async () => {
        const files = Array.from({length: 12}, (_, index) => ({
            filename: `term_bank_${index + 1}.json`,
            getData() {},
        }));
        const read = vi.fn(async () => new TextEncoder().encode('[]'));
        const pipeline = new TermBankSourcePipeline({termFiles: files, enabled: true, read});

        expect(pipeline.prefetchNext(0)).toStrictEqual({fileCount: 8, estimatedBytes: 0});
        expect(pipeline.getBatch(0)).toEqual(files.slice(0, 8));
        expect(read).toHaveBeenCalledTimes(8);
        await pipeline.dispose();
    });

    test('joins reads started between a concurrent abort and disposal', async () => {
        const abortedFiles = [];
        const files = [1, 2].map((index) => ({
            filename: `term_bank_${index}.json`,
            uncompressedSize: 32,
            getData() {},
        }));
        const pipeline = new TermBankSourcePipeline({
            termFiles: files,
            enabled: true,
            read: async (file, signal) => await new Promise((resolve, reject) => {
                signal.addEventListener('abort', () => {
                    queueMicrotask(() => {
                        abortedFiles.push(file.filename);
                        reject(new Error(`aborted ${file.filename}`));
                    });
                }, {once: true});
            }),
        });

        const firstRead = pipeline.read(files[0]);
        const abortJoin = pipeline.abortAndJoin();
        const secondRead = pipeline.read(files[1]);
        const firstDisposal = pipeline.dispose();
        const secondDisposal = pipeline.dispose();

        await Promise.all([abortJoin, firstDisposal, secondDisposal]);
        await expect(firstRead).rejects.toThrow('aborted term_bank_1.json');
        await expect(secondRead).rejects.toThrow('aborted term_bank_2.json');
        expect(abortedFiles).toStrictEqual(['term_bank_1.json', 'term_bank_2.json']);
        expect(() => pipeline.read(files[0])).toThrow('Term bank ZIP read pool is disposed');
    });
});

describe('DictionaryImporter ZIP read cancellation', () => {
    test('waits for every concurrent worker to settle before propagating a failure', async () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const runWithConcurrencyLimit = /** @type {(items: number[], concurrency: number, fn: (item: number) => Promise<void>) => Promise<void>} */ (
            Reflect.get(importer, '_runWithConcurrencyLimit')
        );
        /** @type {() => void} */
        let releaseSecond = () => {};
        /** @type {Promise<void>} */
        const secondGate = new Promise((resolve) => { releaseSecond = resolve; });
        const firstError = new Error('first worker failed');
        /** @type {number[]} */
        const settledItems = [];
        /** @type {number[]} */
        const startedItems = [];

        const result = runWithConcurrencyLimit.call(importer, [1, 2, 3], 2, async (item) => {
            startedItems.push(item);
            if (item === 1) { throw firstError; }
            await secondGate;
            settledItems.push(item);
        });
        let resultSettled = false;
        void result.then(
            () => { resultSettled = true; },
            () => { resultSettled = true; },
        );
        await Promise.resolve();
        await Promise.resolve();

        expect(resultSettled).toBe(false);
        releaseSecond();
        await expect(result).rejects.toBe(firstError);
        expect(startedItems).toEqual([1, 2]);
        expect(settledItems).toEqual([2]);
    });

    test('closes the archive when index validation fails before session ownership', async () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const close = vi.fn(async () => {});
        Reflect.set(importer, '_getFilesFromArchive', vi.fn(async () => ({
            fileMap: new Map(),
            zipReader: {close},
        })));
        Reflect.set(importer, '_readAndValidateIndex', vi.fn(async () => {
            throw new Error('invalid index');
        }));
        const dictionaryDatabase = {
            isPrepared: vi.fn(() => true),
            setImportOptimizationFlags: vi.fn(),
        };

        const result = await importer.importDictionary(
            /** @type {import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} */ (/** @type {unknown} */ (dictionaryDatabase)),
            new ArrayBuffer(0),
            /** @type {import('dictionary-importer').ImportDetails} */ ({}),
        );

        expect(result.result).toBeNull();
        expect(result.errors.map(({message}) => message)).toEqual(['invalid index']);
        expect(close).toHaveBeenCalledTimes(1);
    });

    test('closes the archive when an existing dictionary is rejected', async () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const close = vi.fn(async () => {});
        Reflect.set(importer, '_getFilesFromArchive', vi.fn(async () => ({
            fileMap: new Map(),
            zipReader: {close},
        })));
        Reflect.set(importer, '_readAndValidateIndex', vi.fn(async () => ({
            title: 'Existing dictionary',
            revision: 'test',
            format: 3,
            version: 3,
        })));
        const dictionaryDatabase = {
            isPrepared: vi.fn(() => true),
            setImportOptimizationFlags: vi.fn(),
            dictionaryExists: vi.fn(async () => true),
        };

        const result = await importer.importDictionary(
            /** @type {import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} */ (/** @type {unknown} */ (dictionaryDatabase)),
            new ArrayBuffer(0),
            /** @type {import('dictionary-importer').ImportDetails} */ ({}),
        );

        expect(result.result).toBeNull();
        expect(result.errors.map(({message}) => message)).toEqual([
            'Dictionary Existing dictionary is already imported, skipped it.',
        ]);
        expect(close).toHaveBeenCalledTimes(1);
    });

    test('closes the archive when artifact setup throws before session ownership', async () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const close = vi.fn(async () => {});
        Reflect.set(importer, '_getFilesFromArchive', vi.fn(async () => ({
            fileMap: new Map([['manabitan-import-artifact.json', {filename: 'manabitan-import-artifact.json'}]]),
            zipReader: {close},
        })));
        Reflect.set(importer, '_readAndValidateIndex', vi.fn(async () => ({
            title: 'Artifact dictionary',
            revision: 'test',
            format: 3,
            version: 3,
        })));
        Reflect.set(importer, '_readTermArtifactManifest', vi.fn(async () => {
            throw new Error('invalid artifact manifest');
        }));
        const dictionaryDatabase = {
            isPrepared: vi.fn(() => true),
            setImportOptimizationFlags: vi.fn(),
            dictionaryExists: vi.fn(async () => false),
            setImportDebugLogging: vi.fn(),
        };

        await expect(importer.importDictionary(
            /** @type {import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} */ (/** @type {unknown} */ (dictionaryDatabase)),
            new ArrayBuffer(0),
            /** @type {import('dictionary-importer').ImportDetails} */ ({}),
        )).rejects.toThrow('invalid artifact manifest');
        expect(close).toHaveBeenCalledTimes(1);
    });

    test('reports an archive-close failure without hiding the primary setup error', async () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const close = vi.fn(async () => { throw new Error('close failed'); });
        Reflect.set(importer, '_getFilesFromArchive', vi.fn(async () => ({
            fileMap: new Map(),
            zipReader: {close},
        })));
        Reflect.set(importer, '_readAndValidateIndex', vi.fn(async () => {
            throw new Error('invalid index');
        }));
        const dictionaryDatabase = {
            isPrepared: vi.fn(() => true),
            setImportOptimizationFlags: vi.fn(),
        };

        const result = await importer.importDictionary(
            /** @type {import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} */ (/** @type {unknown} */ (dictionaryDatabase)),
            new ArrayBuffer(0),
            /** @type {import('dictionary-importer').ImportDetails} */ ({}),
        );

        expect(result.errors.map(({message}) => message)).toEqual([
            'invalid index',
            'Failed to close dictionary archive: close failed',
        ]);
        expect(close).toHaveBeenCalledTimes(1);
    });

    test('rejects an already-aborted in-memory byte read before returning bytes', async () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const getData = /** @type {(entry: unknown, writer: unknown, signal: AbortSignal) => Promise<Uint8Array>} */ (
            Reflect.get(importer, '_getData')
        );
        const abortController = new AbortController();
        abortController.abort();

        await expect(getData.call(
            importer,
            {filename: 'term_bank_1.json', bytes: new Uint8Array([0x5b, 0x5d])},
            {},
            abortController.signal,
        )).rejects.toMatchObject({name: 'AbortError'});
    });

    test('passes an explicit worker policy to every ZIP entry read', async () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const getData = /** @type {(entry: unknown, writer: unknown, signal?: AbortSignal) => Promise<Uint8Array>} */ (
            Reflect.get(importer, '_getData')
        );
        const entryGetData = vi.fn(async () => new Uint8Array([0x5b, 0x5d]));
        const writer = {};
        const abortController = new AbortController();

        await getData.call(importer, {filename: 'term_bank_1.json', getData: entryGetData}, writer, abortController.signal);
        expect(entryGetData).toHaveBeenLastCalledWith(writer, {
            useWebWorkers: true,
            signal: abortController.signal,
        });

        Reflect.set(importer, '_zipUseWebWorkers', false);
        await getData.call(importer, {filename: 'term_bank_2.json', getData: entryGetData}, writer);
        expect(entryGetData).toHaveBeenLastCalledWith(writer, {useWebWorkers: false});
    });

    test('uses native ZIP inflation only when the entire source import fits one batch', () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const selectPolicy = /** @type {(pipeline: TermBankSourcePipeline, files: Array<{filename: string, getData: () => void, uncompressedSize?: number}>, requested: boolean|null) => {useWebWorkers: boolean, autoDisabled: boolean, firstBatchFileCount: number, firstBatchEstimatedBytes: number, firstBatchSizeKnown: boolean}} */ (
            Reflect.get(importer, '_selectSourceZipWorkerPolicy')
        );
        const read = vi.fn(async () => new Uint8Array());
        const oneBatchFiles = Array.from({length: 3}, (_, index) => ({
            filename: `term_bank_${index + 1}.json`,
            getData: () => {},
            uncompressedSize: 1024,
        }));
        const oneBatchPipeline = new TermBankSourcePipeline({termFiles: oneBatchFiles, enabled: true, read});

        expect(selectPolicy.call(importer, oneBatchPipeline, oneBatchFiles, null)).toEqual({
            useWebWorkers: false,
            autoDisabled: true,
            firstBatchFileCount: 3,
            firstBatchEstimatedBytes: 3072,
            firstBatchSizeKnown: true,
        });
        expect(selectPolicy.call(importer, oneBatchPipeline, oneBatchFiles, true)).toEqual({
            useWebWorkers: true,
            autoDisabled: false,
            firstBatchFileCount: 3,
            firstBatchEstimatedBytes: 3072,
            firstBatchSizeKnown: true,
        });

        const multiBatchFiles = Array.from({length: 81}, (_, index) => ({
            filename: `term_bank_${index + 1}.json`,
            getData: () => {},
            uncompressedSize: 1024,
        }));
        const multiBatchPipeline = new TermBankSourcePipeline({termFiles: multiBatchFiles, enabled: true, read});
        expect(selectPolicy.call(importer, multiBatchPipeline, multiBatchFiles, null)).toEqual({
            useWebWorkers: true,
            autoDisabled: false,
            firstBatchFileCount: 80,
            firstBatchEstimatedBytes: 81920,
            firstBatchSizeKnown: true,
        });

        const oversizedFiles = [{
            filename: 'term_bank_1.json',
            getData: () => {},
            uncompressedSize: oneBatchPipeline.batchMaxBytes + 1,
        }];
        const oversizedPipeline = new TermBankSourcePipeline({termFiles: oversizedFiles, enabled: true, read});
        expect(selectPolicy.call(importer, oversizedPipeline, oversizedFiles, null)).toEqual({
            useWebWorkers: true,
            autoDisabled: false,
            firstBatchFileCount: 1,
            firstBatchEstimatedBytes: oneBatchPipeline.batchMaxBytes + 1,
            firstBatchSizeKnown: true,
        });

        const unknownSizeFiles = [{filename: 'term_bank_1.json', getData: () => {}}];
        const unknownSizePipeline = new TermBankSourcePipeline({termFiles: unknownSizeFiles, enabled: true, read});
        expect(selectPolicy.call(importer, unknownSizePipeline, unknownSizeFiles, null)).toEqual({
            useWebWorkers: true,
            autoDisabled: false,
            firstBatchFileCount: 1,
            firstBatchEstimatedBytes: 0,
            firstBatchSizeKnown: false,
        });
    });
});
