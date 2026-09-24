/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import {setImmediate} from 'node:timers/promises';
import {describe, expect, test, vi} from 'vitest';
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js';
import {DictionaryImporterMediaLoader} from './mocks/dictionary-importer-media-loader.js';

/** @returns {{promise: Promise<void>, release: () => void}} */
function gate() {
    /** @type {() => void} */
    let release = () => {};
    const promise = new Promise((resolve) => { release = () => resolve(void 0); });
    return {promise, release};
}

/**
 * Exercise importDictionary's real setup/cleanup path. Only archive I/O and
 * index/manifest metadata are substituted so reads can be held deterministically.
 * @param {{filename: string, getData: () => Promise<Uint8Array|Blob>}[]} entries
 * @param {unknown} manifest
 * @param {() => Promise<void>} close
 * @returns {{importer: DictionaryImporter, database: import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase}}
 */
function setup(entries, manifest, close) {
    const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
    const fileMap = new Map(entries.map((entry) => [entry.filename, entry]));
    if (manifest !== null) {
        fileMap.set('manabitan-import-artifact.json', {filename: 'manabitan-import-artifact.json', getData: async () => new Uint8Array(0)});
        Reflect.set(importer, '_readTermArtifactManifest', vi.fn(async () => manifest));
    }
    Reflect.set(importer, '_getFilesFromArchive', vi.fn(async () => ({fileMap, zipReader: {close}})));
    Reflect.set(importer, '_readAndValidateIndex', vi.fn(async () => ({title: 'Artifact preload', version: 3, revision: '1'})));
    const database = /** @type {import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} */ (/** @type {unknown} */ ({
        isPrepared: () => true,
        setImportOptimizationFlags() {},
        dictionaryExists: async () => false,
        setImportDebugLogging() {},
        setTermEntryContentDedupEnabled() {},
    }));
    return {importer, database};
}

describe('artifact preload ownership', () => {
    test.each([false, true])('joins unpacked sibling reads before cleanup (sibling failure=%s)', async (siblingFails) => {
        const release = gate();
        const firstFailure = new Error('first artifact failed');
        const siblingFailure = new Error('second artifact failed');
        /** @type {string[]} */
        const events = [];
        const entries = Array.from({length: 8}, (_, i) => ({
            filename: `term_bank_${i + 1}.mbtb`,
            getData: async () => {
                events.push(`start:${i}`);
                try {
                    if (i === 0) { throw firstFailure; }
                    await release.promise;
                    if (siblingFails && i === 1) { throw siblingFailure; }
                    return Uint8Array.of(i);
                } finally { events.push(`settle:${i}`); }
            },
        }));
        const close = vi.fn(async () => { events.push('close'); });
        const {importer, database} = setup(entries, null, close);
        const result = importer.importDictionary(database, new ArrayBuffer(0), /** @type {import('dictionary-importer').ImportDetails} */ ({}))
            .then(() => null, (/** @type {unknown} */ error) => error);
        try {
            await setImmediate();
            expect(events).toContain('start:1');
            expect(close).not.toHaveBeenCalled();
            expect(events).not.toContain('start:4');
        } finally { release.release(); }
        expect(await result).toBe(firstFailure);
        expect(close).toHaveBeenCalledOnce();
        expect(events.indexOf('close')).toBeGreaterThan(events.indexOf('settle:3'));
        expect(events).not.toContain('start:4');
    });

    test.each([
        {skipImageMetadata: false, failed: 'term'},
        {skipImageMetadata: true, failed: 'term'},
        {skipImageMetadata: false, failed: 'media'},
        {skipImageMetadata: true, failed: 'media'},
    ])('joins parallel packed reads before cleanup ($failed fails, Blob=$skipImageMetadata)', async ({skipImageMetadata, failed}) => {
        const release = gate();
        const failure = new Error(`${failed} read failed`);
        /** @type {string[]} */
        const events = [];
        const entries = ['term', 'media'].map((kind) => ({
            filename: `${kind}.bin`,
            getData: async () => {
                events.push(`start:${kind}`);
                try {
                    if (kind === failed) { throw failure; }
                    await release.promise;
                    return kind === 'media' && skipImageMetadata ? new Blob([Uint8Array.of(1)]) : Uint8Array.of(1);
                } finally { events.push(`settle:${kind}`); }
            },
        }));
        const manifest = {
            packedFileName: 'term.bin',
            packedMediaFileName: 'media.bin',
            packedMediaEntries: new Array(100000).fill({}),
            termBanksByArtifact: new Map(),
        };
        const close = vi.fn(async () => { events.push('close'); });
        const {importer, database} = setup(entries, manifest, close);
        const result = importer.importDictionary(database, new ArrayBuffer(0), /** @type {import('dictionary-importer').ImportDetails} */ ({skipImageMetadata}))
            .then(() => null, (/** @type {unknown} */ error) => error);
        try {
            await setImmediate();
            expect(events).toEqual(expect.arrayContaining(['start:term', 'start:media']));
            expect(close).not.toHaveBeenCalled();
        } finally { release.release(); }
        expect(await result).toBe(failure);
        expect(close).toHaveBeenCalledOnce();
        expect(events.indexOf('close')).toBeGreaterThan(events.indexOf(`settle:${failed === 'term' ? 'media' : 'term'}`));
    });

    test('successful preloads preserve input order and exact bytes across batches', async () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const files = Array.from({length: 9}, (_, i) => ({filename: `term_bank_${i + 1}.mbtb`, bytes: Uint8Array.of(i, 255)}));
        const result = await Reflect.get(importer, '_preloadTermArtifactFiles').call(importer, files);
        expect([...result]).toEqual(files.map(({filename, bytes}) => [filename, bytes]));
    });
});
