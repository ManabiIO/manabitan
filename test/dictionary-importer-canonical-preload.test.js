/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import {readFile} from 'node:fs/promises';
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {DictionaryImporterMediaLoader} from './mocks/dictionary-importer-media-loader.js';

const wasm = new Uint8Array(await readFile(new URL('../ext/lib/term-content-canonical-scan-v1.wasm', import.meta.url)));
const parserWasm = new Uint8Array(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url)));

beforeEach(() => {
    // Give the actual module loader a fresh single-flight cache for each case.
    vi.resetModules();
    vi.clearAllMocks();
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

async function setup() {
    const [{DictionaryImporter}, canonical, {DictionaryDatabase}] = await Promise.all([
        import('../ext/js/dictionary/dictionary-importer.js'),
        import('../ext/js/dictionary/term-content-canonical-scan.js'),
        import('../ext/js/dictionary/dictionary-database.js'),
    ]);
    const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
    /**
     * @param {{dedup?: boolean, stream?: boolean, storage?: 'baseline'|'raw-bytes', media?: boolean, skipImageMetadata?: boolean, sink?: () => void}} [options]
     * @returns {ReturnType<import('../ext/js/dictionary/dictionary-importer.js').DictionaryImporter['_readTermBankFileFast']>}
     */
    const parse = (options = {}) => {
        Reflect.set(importer, '_skipImageMetadata', options.skipImageMetadata ?? false);
        return Reflect.get(importer, '_readTermBankFileFast').call(
            importer,
            /** @type {import('@zip.js/zip.js').Entry} */ ({filename: 'term_bank_1.json'}),
            3,
            'Preload',
            false,
            options.media ?? false,
            options.dedup ?? true,
            options.storage ?? 'raw-bytes',
            options.stream === false ? void 0 : options.sink ?? (() => {}),
            new TextEncoder().encode('[["term","","","",1,["definition"],1,""]]'),
        );
    };
    return {parse, canonical, DictionaryDatabase};
}

/**
 * @param {() => Promise<Response>} canonicalFetch
 * @param {() => void} [parserFetch]
 */
function provideAssets(canonicalFetch, parserFetch = () => {}) {
    vi.stubGlobal('fetch', async (/** @type {URL|string} */ url) => {
        if (String(url).endsWith('/term-content-canonical-scan-v1.wasm')) { return await canonicalFetch(); }
        if (String(url).endsWith('/term-bank-parser.wasm')) {
            parserFetch();
            return new Response(parserWasm);
        }
        throw new Error(`Unexpected asset: ${url}`);
    });
}

/**
 * @param {import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} database
 * @returns {ReturnType<import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase['_resolveArtifactTermContentDedup']>}
 */
async function resolveOne(database) {
    const plan = {
        uniqueCount: 1,
        sourceRowCount: 1,
        uniqueRowIndexes: Uint32Array.of(0),
        uniqueSignatures: new Uint32Array(3),
        resolvedFlags: new Uint8Array(1),
        resolvedOffsets: new Float64Array(1),
        resolvedLengths: new Uint32Array(1),
        resolvedDictNames: null,
        pendingEpochs: null,
        pendingIndexes: null,
        nextEpoch: 1,
        nextUnresolvedUniqueIndex: 0,
        persistedLookupRequired: true,
    };
    const chunk = {
        rowCount: 1,
        contentRowStart: 0,
        contentBytesList: [],
        contentHash1List: [],
        contentHash2List: [],
        contentBytesBuffer: Uint8Array.of(1, 2, 3, 4),
        contentBytesBaseOffset: 0,
        contentMetaList: Uint32Array.of(0, 4, 1, 2),
        contentUniqueIndexList: Uint32Array.of(0),
        contentDedupPlan: plan,
        contentDictNameList: null,
        uniformContentDictName: 'raw',
        useResolvedContentReferences: true,
    };
    return await Reflect.get(database, '_resolveArtifactTermContentDedup').call(database, chunk, true);
}

describe('canonical helper preload at direct native import admission', () => {
    test('starts immutable compilation before parsing without awaiting it or creating a native instance', async () => {
        const pending = /** @type {PromiseWithResolvers<Response>} */ (Promise.withResolvers());
        const fetch = vi.fn(() => pending.promise);
        const {parse, canonical} = await setup();
        provideAssets(fetch, () => { expect(fetch).toHaveBeenCalledOnce(); });
        const instances = vi.spyOn(WebAssembly, 'Instance');
        try {
            await parse();
            expect(fetch).toHaveBeenCalledOnce();
            const parserInstances = instances.mock.calls.length;
            const first = canonical.compileCanonicalScanModule();
            const second = canonical.compileCanonicalScanModule();
            expect(first).toBe(second);
            pending.resolve(new Response(wasm));
            await expect(first).resolves.toBeInstanceOf(WebAssembly.Module);
            expect(fetch).toHaveBeenCalledOnce();
            expect(instances).toHaveBeenCalledTimes(parserInstances);
        } finally {
            pending.resolve(new Response(wasm));
        }
    });

    test.each([
        {dedup: false},
        {stream: false},
        {storage: /** @type {const} */ ('baseline')},
        {media: true, skipImageMetadata: false},
    ])('skips unused routes: %j', async (options) => {
        const fetch = vi.fn(async () => new Response(wasm));
        const {parse} = await setup();
        provideAssets(fetch);
        await parse(options);
        expect(fetch).not.toHaveBeenCalled();
    });

    test('preloads the existing direct media route with the same deduplication gate', async () => {
        const fetch = vi.fn(async () => new Response(wasm));
        const {parse, canonical} = await setup();
        provideAssets(fetch);
        await parse({media: true, skipImageMetadata: true});
        expect(fetch).toHaveBeenCalledOnce();
        await canonical.compileCanonicalScanModule();
        expect(fetch).toHaveBeenCalledOnce();
    });

    test.each(['missing', 'invalid'])('preserves ordinary scanner fallback and healthy retry after %s asset', async (failure) => {
        const pending = /** @type {PromiseWithResolvers<Response>} */ (Promise.withResolvers());
        const fetch = vi.fn(() => pending.promise);
        const {parse, DictionaryDatabase} = await setup();
        provideAssets(fetch);
        await parse();
        expect(fetch).toHaveBeenCalledOnce();
        const database = new DictionaryDatabase();
        const resolving = resolveOne(database);
        pending.resolve(failure === 'missing' ? new Response('', {status: 404}) : new Response(Uint8Array.of(1, 2, 3)));
        const fallback = await resolving;
        expect(fallback.nativeScanMetrics).toMatchObject({
            dedupNativeCallCount: 0, dedupNativeFallbackAssetCount: 1,
        });
        expect(fallback.pendingContentCount).toBe(1);
        expect(fetch).toHaveBeenCalledOnce();
        fetch.mockImplementation(async () => new Response(wasm));
        const retried = await resolveOne(new DictionaryDatabase());
        expect(retried.nativeScanMetrics).toMatchObject({
            dedupNativeCallCount: 1, dedupNativeFallbackCount: 0,
        });
        expect(retried.pendingContentCount).toBe(1);
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    test('preserves parser failure while a preload is pending and observes its later rejection', async () => {
        const pending = /** @type {PromiseWithResolvers<Response>} */ (Promise.withResolvers());
        const fetch = vi.fn(() => pending.promise);
        const {parse, canonical} = await setup();
        provideAssets(fetch);
        const failure = new Error('Parser failed independently');
        await expect(parse({sink: () => { throw failure; }})).rejects.toBe(failure);
        expect(fetch).toHaveBeenCalledOnce();
        const originalLoad = canonical.compileCanonicalScanModule();
        pending.reject(new Error('Preload failed after parsing'));
        await expect(originalLoad).rejects.toThrow('Preload failed after parsing');
        fetch.mockImplementation(async () => new Response(wasm));
        await parse();
        await canonical.compileCanonicalScanModule();
        expect(fetch).toHaveBeenCalledTimes(2);
    });
});
