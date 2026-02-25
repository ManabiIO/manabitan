/*
 * Copyright (C) 2026  Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {initWasm, Resvg} from '../../lib/resvg-wasm.js';
import {createApiMap, invokeApiMapHandler} from '../core/api-map.js';
import {ExtensionError} from '../core/extension-error.js';
import {log} from '../core/log.js';
import {safePerformance} from '../core/safe-performance.js';
import {stringReverse} from '../core/utilities.js';
import {deleteOpfsDatabaseFiles, didLastOpenUseFallbackStorage, getSqlite3, openOpfsDatabase} from './sqlite-wasm.js';
import {WasmPrefixBloomIndex} from './wasm-index-kernel.js';

const STORE_TABLE = 'lean_store';
const STORE_KEY_STATE_META = 'state.meta.json';
const STORE_KEY_STATE_MEDIA = 'state.media.blob';
const STORE_KEY_REVISION = 'state.revision';
const TERM_LOOKUP_VTAB_TABLE = 'lean_term_lookup';

function createEmptyState() {
    return {
        nextIds: {
            dictionaries: 1,
            terms: 1,
            termMeta: 1,
            kanji: 1,
            kanjiMeta: 1,
            tagMeta: 1,
            media: 1,
        },
        dictionaries: [],
        terms: [],
        termMeta: [],
        kanji: [],
        kanjiMeta: [],
        tagMeta: [],
        media: [],
    };
}

function fnv1a64(input, seed = 0xcbf29ce484222325n) {
    let hash = seed;
    for (let i = 0; i < input.length; ++i) {
        hash ^= BigInt(input.charCodeAt(i));
        hash *= 0x100000001b3n;
        hash &= 0xffffffffffffffffn;
    }
    return hash;
}

function mixHash32(value) {
    value ^= value >>> 16;
    value = Math.imul(value, 0x7feb352d);
    value ^= value >>> 15;
    value = Math.imul(value, 0x846ca68b);
    value ^= value >>> 16;
    return value >>> 0;
}

class BloomFilter {
    constructor(bitCount = 1 << 20, hashCount = 7) {
        this._bitCount = Math.max(8, bitCount);
        this._hashCount = Math.max(1, hashCount);
        this._bits = new Uint32Array(Math.ceil(this._bitCount / 32));
    }

    clear() {
        this._bits.fill(0);
    }

    _hashes(key) {
        const h1 = Number(fnv1a64(key, 0xcbf29ce484222325n) & 0xffffffffn) >>> 0;
        const h2 = Number(fnv1a64(key, 0x9e3779b97f4a7c15n) & 0xffffffffn) >>> 0;
        const hashes = new Array(this._hashCount);
        for (let i = 0; i < this._hashCount; ++i) {
            const h = (h1 + Math.imul(i, h2 || 1) + i * i) >>> 0;
            hashes[i] = mixHash32(h) % this._bitCount;
        }
        return hashes;
    }

    add(key) {
        for (const index of this._hashes(key)) {
            this._bits[index >>> 5] |= (1 << (index & 31));
        }
    }

    mightContain(key) {
        for (const index of this._hashes(key)) {
            if ((this._bits[index >>> 5] & (1 << (index & 31))) === 0) {
                return false;
            }
        }
        return true;
    }

    exportState() {
        return {
            bitCount: this._bitCount,
            hashCount: this._hashCount,
            bits: Array.from(this._bits),
        };
    }

    importState(state) {
        if (!state || typeof state !== 'object') { return false; }
        const bitCount = Number(state.bitCount);
        const hashCount = Number(state.hashCount);
        if (!Number.isFinite(bitCount) || !Number.isFinite(hashCount)) { return false; }
        const bitsArray = Array.isArray(state.bits) ? state.bits : null;
        if (bitsArray === null) { return false; }
        this._bitCount = Math.max(8, bitCount | 0);
        this._hashCount = Math.max(1, hashCount | 0);
        this._bits = new Uint32Array(Math.ceil(this._bitCount / 32));
        for (let i = 0; i < this._bits.length && i < bitsArray.length; ++i) {
            this._bits[i] = Number(bitsArray[i]) >>> 0;
        }
        return true;
    }
}

class TrieNode {
    constructor() {
        this.children = new Map();
        this.ids = new Set();
    }
}

class TrieIndex {
    constructor() {
        this._root = new TrieNode();
    }

    clear() {
        this._root = new TrieNode();
    }

    insert(key, id) {
        if (typeof key !== 'string' || key.length === 0) { return; }
        let node = this._root;
        for (const ch of key) {
            let next = node.children.get(ch);
            if (!next) {
                next = new TrieNode();
                node.children.set(ch, next);
            }
            next.ids.add(id);
            node = next;
        }
    }

    search(prefix) {
        if (typeof prefix !== 'string' || prefix.length === 0) { return []; }
        let node = this._root;
        for (const ch of prefix) {
            const next = node.children.get(ch);
            if (!next) { return []; }
            node = next;
        }
        return [...node.ids];
    }

    exportState() {
        return this._serializeNode(this._root);
    }

    importState(state) {
        const node = this._deserializeNode(state);
        if (node === null) { return false; }
        this._root = node;
        return true;
    }

    _serializeNode(node) {
        return {
            i: [...node.ids],
            c: [...node.children.entries()].map(([ch, child]) => [ch, this._serializeNode(child)]),
        };
    }

    _deserializeNode(state) {
        if (!state || typeof state !== 'object') { return null; }
        const node = new TrieNode();
        const ids = Array.isArray(state.i) ? state.i : [];
        for (const id of ids) {
            node.ids.add(Number(id));
        }
        const children = Array.isArray(state.c) ? state.c : [];
        for (const item of children) {
            if (!Array.isArray(item) || item.length !== 2) { continue; }
            const [ch, childState] = item;
            if (typeof ch !== 'string' || ch.length === 0) { continue; }
            const childNode = this._deserializeNode(childState);
            if (childNode !== null) {
                node.children.set(ch, childNode);
            }
        }
        return node;
    }
}

export class DictionaryDatabase {
    constructor() {
        this._isOpening = false;
        this._isPrepared = false;
        this._state = createEmptyState();
        this._dirty = false;
        this._db = null;
        this._sqlite3 = null;
        this._usesFallbackStorage = false;
        this._revision = 0;
        this._didLoadPersistedIndexes = false;
        this._didLoadPersistedWasmIndexes = false;
        this._wasmIndexInitAttempted = false;
        this._enableWasmIndexes = false;
        this._isBulkImport = false;

        this._termsById = new Map();
        this._termsByExpression = new Map();
        this._termsByReading = new Map();
        this._termsByExpressionReverse = new Map();
        this._termsByReadingReverse = new Map();
        this._termsBySequence = new Map();

        this._termMetaByExpression = new Map();
        this._kanjiByCharacter = new Map();
        this._kanjiMetaByCharacter = new Map();
        this._tagMetaByName = new Map();
        this._mediaByPath = new Map();

        this._expressionBloom = new BloomFilter(1 << 22, 7);
        this._readingBloom = new BloomFilter(1 << 22, 7);
        this._expressionReverseBloom = new BloomFilter(1 << 22, 7);
        this._readingReverseBloom = new BloomFilter(1 << 22, 7);

        this._expressionTrie = new TrieIndex();
        this._readingTrie = new TrieIndex();
        this._expressionReverseTrie = new TrieIndex();
        this._readingReverseTrie = new TrieIndex();
        this._expressionWasmIndex = null;
        this._readingWasmIndex = null;
        this._expressionReverseWasmIndex = null;
        this._readingReverseWasmIndex = null;
        this._termLookupVtabModule = null;
        this._termLookupVtabRegistered = false;
        this._useVirtualTermLookup = true;

        this._worker = null;
        this._resvgFontBuffer = null;

        this._apiMap = createApiMap([
            ['drawMedia', this._onDrawMedia.bind(this)],
        ]);
    }

    async prepare() {
        if (this._isPrepared) {
            throw new Error('Database already open');
        }
        if (this._isOpening) {
            throw new Error('Already opening');
        }

        try {
            this._isOpening = true;
            await this._openStorageConnection();
            if (this._enableWasmIndexes) {
                await this._initializeWasmIndexes();
            }
            await this._loadStateFromStorage();
            if (!this._didLoadPersistedIndexes) {
                this._rebuildIndexes();
            }
            if (this._enableWasmIndexes) {
                await this._ensureWasmIndexesReady();
            }

            const isWorker = self.constructor.name !== 'Window';
            if (!isWorker && this._worker === null) {
                this._worker = new Worker('/js/dictionary/dictionary-database-worker-main.js', {type: 'module'});
                this._worker.addEventListener('error', (event) => {
                    log.log('Worker terminated with error:', event);
                });
                this._worker.addEventListener('unhandledrejection', (event) => {
                    log.log('Unhandled promise rejection in worker:', event);
                });
            } else if (isWorker && this._resvgFontBuffer === null) {
                await initWasm(fetch('/lib/resvg.wasm'));
                const font = await fetch('/fonts/NotoSansJP-Regular.ttf');
                this._resvgFontBuffer = new Uint8Array(await font.arrayBuffer());
            }

            this._isPrepared = true;
        } finally {
            this._isOpening = false;
        }
    }

    async close() {
        if (!this._isPrepared) {
            throw new Error('Database is not open');
        }
        await this._persistIfDirty();
        this._destroyWasmIndexes();
        if (this._db !== null) {
            this._db.close();
            this._db = null;
        }
        this._termLookupVtabRegistered = false;
        this._termLookupVtabModule = null;
        this._useVirtualTermLookup = true;
        this._usesFallbackStorage = false;
        this._isBulkImport = false;
        this._isPrepared = false;
    }

    isPrepared() {
        return this._isPrepared;
    }

    isOpening() {
        return this._isOpening;
    }

    usesFallbackStorage() {
        return this._usesFallbackStorage;
    }

    async purge() {
        if (this._isOpening) {
            throw new Error('Cannot purge database while opening');
        }

        if (this._worker !== null) {
            this._worker.terminate();
            this._worker = null;
        }

        this._state = createEmptyState();
        this._rebuildIndexes();
        this._didLoadPersistedIndexes = false;
        this._didLoadPersistedWasmIndexes = false;
        this._isBulkImport = false;
        this._dirty = false;
        if (this._db !== null) {
            this._db.close();
            this._db = null;
        }
        await deleteOpfsDatabaseFiles();
        await this._openStorageConnection();
        await this._deletePersistedState();

        if (!this._isPrepared) {
            await this.prepare();
        }

        return true;
    }

    async deleteDictionary(dictionaryName, progressRate, onProgress) {
        await this._syncFromStorageIfNeeded();

        const targets = [
            ['kanji', 'dictionary'],
            ['kanjiMeta', 'dictionary'],
            ['terms', 'dictionary'],
            ['termMeta', 'dictionary'],
            ['tagMeta', 'dictionary'],
            ['media', 'dictionary'],
            ['dictionaries', 'title'],
        ];

        const progressData = {
            count: 0,
            processed: 0,
            storeCount: targets.length,
            storesProcesed: 0,
        };

        const counts = [];
        for (const [table, keyColumn] of targets) {
            const entries = this._state[table];
            let count = 0;
            for (const row of entries) {
                if (row[keyColumn] === dictionaryName) { ++count; }
            }
            counts.push(count);
            progressData.count += count;
            ++progressData.storesProcesed;
            onProgress(progressData);
        }

        progressData.storesProcesed = 0;

        for (let i = 0; i < targets.length; ++i) {
            const [table, keyColumn] = targets[i];
            this._state[table] = this._state[table].filter((row) => row[keyColumn] !== dictionaryName);
            progressData.processed += counts[i];
            ++progressData.storesProcesed;
            if ((progressData.processed % progressRate) === 0 || progressData.processed >= progressData.count) {
                onProgress(progressData);
            }
        }

        this._dirty = true;
        this._rebuildIndexes();
        onProgress(progressData);
    }

    async findTermsBulk(termList, dictionaries, matchType) {
        await this._syncFromStorageIfNeeded();
        const results = [];

        for (let itemIndex = 0; itemIndex < termList.length; ++itemIndex) {
            const term = termList[itemIndex];
            const visited = new Set();

            const forward = matchType !== 'suffix';
            const candidates = forward
                ? [
                    ['term', 'expression'],
                    ['reading', 'reading'],
                ]
                : [
                    ['term', 'expressionReverse'],
                    ['reading', 'readingReverse'],
                ];

            const queryTerm = matchType === 'suffix' ? stringReverse(term) : term;
            const lookupMode = matchType === 'exact' ? 'exact' : 'prefix';

            for (const [matchSource, keyName] of candidates) {
                const rows = this._queryTermLookupRows(queryTerm, lookupMode, keyName);
                if (rows !== null && rows.length > 0) {
                    for (const resultRow of rows) {
                        const id = this._asNumber(resultRow.id, -1);
                        if (id < 0) { continue; }
                        if (visited.has(id)) { continue; }
                        visited.add(id);
                        const row = this._termsById.get(id);
                        if (!row || !dictionaries.has(row.dictionary)) { continue; }

                        let resolvedMatchType = matchType;
                        const resolvedValue = keyName === 'expressionReverse' || keyName === 'readingReverse'
                            ? stringReverse(row[keyName])
                            : row[keyName === 'expression' || keyName === 'expressionReverse' ? 'expression' : 'reading'];
                        if (resolvedValue === term) {
                            resolvedMatchType = 'exact';
                        }
                        results.push(this._createTerm(matchSource, resolvedMatchType, row, itemIndex));
                    }
                    continue;
                }

                const ids = this._lookupTermIds(queryTerm, lookupMode, keyName);
                for (const id of ids) {
                    if (id < 0) { continue; }
                    if (visited.has(id)) { continue; }
                    visited.add(id);
                    const row = this._termsById.get(id);
                    if (!row || !dictionaries.has(row.dictionary)) { continue; }

                    let resolvedMatchType = matchType;
                    const resolvedValue = keyName === 'expressionReverse' || keyName === 'readingReverse'
                        ? stringReverse(row[keyName])
                        : row[keyName === 'expression' || keyName === 'expressionReverse' ? 'expression' : 'reading'];
                    if (resolvedValue === term) {
                        resolvedMatchType = 'exact';
                    }
                    results.push(this._createTerm(matchSource, resolvedMatchType, row, itemIndex));
                }
            }
        }

        return results;
    }

    async findTermsExactBulk(termList, dictionaries) {
        await this._syncFromStorageIfNeeded();
        const results = [];

        for (let itemIndex = 0; itemIndex < termList.length; ++itemIndex) {
            const item = termList[itemIndex];
            const lookupRows = this._queryTermLookupRows(item.term, 'exact', 'expression');
            if (lookupRows !== null && lookupRows.length > 0) {
                for (const lookupRow of lookupRows) {
                    const id = this._asNumber(lookupRow.id, -1);
                    if (id < 0) { continue; }
                    const row = this._termsById.get(id);
                    if (!row || row.reading !== item.reading || !dictionaries.has(row.dictionary)) { continue; }
                    results.push(this._createTerm('term', 'exact', row, itemIndex));
                }
                continue;
            }

            const ids = this._termsByExpression.get(item.term) ?? [];
            for (const id of ids) {
                const row = this._termsById.get(id);
                if (!row || row.reading !== item.reading || !dictionaries.has(row.dictionary)) { continue; }
                results.push(this._createTerm('term', 'exact', row, itemIndex));
            }
        }

        return results;
    }

    async findTermsBySequenceBulk(items) {
        await this._syncFromStorageIfNeeded();
        const results = [];

        for (let itemIndex = 0; itemIndex < items.length; ++itemIndex) {
            const item = items[itemIndex];
            const key = `${item.dictionary}\u001f${item.query}`;
            const lookupRows = this._queryTermLookupRows(key, 'exact', 'sequence');
            if (lookupRows !== null && lookupRows.length > 0) {
                for (const lookupRow of lookupRows) {
                    const id = this._asNumber(lookupRow.id, -1);
                    if (id < 0) { continue; }
                    const row = this._termsById.get(id);
                    if (!row) { continue; }
                    results.push(this._createTerm('sequence', 'exact', row, itemIndex));
                }
                continue;
            }

            const ids = this._termsBySequence.get(key) ?? [];
            for (const id of ids) {
                const row = this._termsById.get(id);
                if (!row) { continue; }
                results.push(this._createTerm('sequence', 'exact', row, itemIndex));
            }
        }

        return results;
    }

    async findTermMetaBulk(termList, dictionaries) {
        await this._syncFromStorageIfNeeded();
        const results = [];
        for (let itemIndex = 0; itemIndex < termList.length; ++itemIndex) {
            const term = termList[itemIndex];
            const rows = this._termMetaByExpression.get(term) ?? [];
            for (const row of rows) {
                if (!dictionaries.has(row.dictionary)) { continue; }
                results.push(this._createTermMeta(row, {itemIndex, indexIndex: 0, item: term}));
            }
        }
        return results;
    }

    async findKanjiBulk(kanjiList, dictionaries) {
        await this._syncFromStorageIfNeeded();
        const results = [];
        for (let itemIndex = 0; itemIndex < kanjiList.length; ++itemIndex) {
            const character = kanjiList[itemIndex];
            const rows = this._kanjiByCharacter.get(character) ?? [];
            for (const row of rows) {
                if (!dictionaries.has(row.dictionary)) { continue; }
                results.push(this._createKanji(row, {itemIndex, indexIndex: 0, item: character}));
            }
        }
        return results;
    }

    async findKanjiMetaBulk(kanjiList, dictionaries) {
        await this._syncFromStorageIfNeeded();
        const results = [];
        for (let itemIndex = 0; itemIndex < kanjiList.length; ++itemIndex) {
            const character = kanjiList[itemIndex];
            const rows = this._kanjiMetaByCharacter.get(character) ?? [];
            for (const row of rows) {
                if (!dictionaries.has(row.dictionary)) { continue; }
                results.push(this._createKanjiMeta(row, {itemIndex, indexIndex: 0, item: character}));
            }
        }
        return results;
    }

    async findTagMetaBulk(items) {
        await this._syncFromStorageIfNeeded();
        const results = new Array(items.length);

        for (let i = 0; i < items.length; ++i) {
            const item = items[i];
            const rows = this._tagMetaByName.get(item.query) ?? [];
            const found = rows.find((row) => row.dictionary === item.dictionary);
            results[i] = typeof found === 'undefined' ? void 0 : this._deserializeTagRow(found);
        }

        return results;
    }

    async findTagForTitle(name, dictionary) {
        await this._syncFromStorageIfNeeded();
        const rows = this._tagMetaByName.get(name) ?? [];
        const found = rows.find((row) => row.dictionary === dictionary);
        return typeof found === 'undefined' ? null : this._deserializeTagRow(found);
    }

    async getMedia(items) {
        await this._syncFromStorageIfNeeded();
        const results = [];

        for (let itemIndex = 0; itemIndex < items.length; ++itemIndex) {
            const item = items[itemIndex];
            const rows = this._mediaByPath.get(item.path) ?? [];
            for (const row of rows) {
                if (row.dictionary !== item.dictionary) { continue; }
                results.push(this._createMedia(row, {itemIndex, indexIndex: 0, item}));
            }
        }

        return results;
    }

    async drawMedia(items, source) {
        if (this._worker !== null) {
            this._worker.postMessage({action: 'drawMedia', params: {items}}, [source]);
            return;
        }

        safePerformance.mark('drawMedia:start');

        const groupedItems = new Map();
        for (const item of items) {
            const {path, dictionary, canvasIndex, canvasWidth, canvasHeight, generation} = item;
            const key = `${path}:::${dictionary}`;
            if (!groupedItems.has(key)) {
                groupedItems.set(key, {path, dictionary, canvasIndexes: [], canvasWidth, canvasHeight, generation});
            }
            groupedItems.get(key)?.canvasIndexes.push(canvasIndex);
        }
        const groupedItemsArray = [...groupedItems.values()];
        const media = await this.getMedia(groupedItemsArray);
        const results = media.map((item) => {
            const grouped = groupedItemsArray[item.index];
            return {
                ...item,
                canvasIndexes: grouped.canvasIndexes,
                canvasWidth: grouped.canvasWidth,
                canvasHeight: grouped.canvasHeight,
                generation: grouped.generation,
            };
        });

        results.sort((a, _b) => (a.mediaType === 'image/svg+xml' ? -1 : 1));

        for (const m of results) {
            if (m.mediaType === 'image/svg+xml') {
                const opts = {
                    fitTo: {
                        mode: 'width',
                        value: m.canvasWidth,
                    },
                    font: {
                        fontBuffers: this._resvgFontBuffer !== null ? [this._resvgFontBuffer] : [],
                    },
                };
                const resvgJS = new Resvg(new Uint8Array(m.content), opts);
                const render = resvgJS.render();
                source.postMessage({action: 'drawBufferToCanvases', params: {buffer: render.pixels.buffer, width: render.width, height: render.height, canvasIndexes: m.canvasIndexes, generation: m.generation}}, [render.pixels.buffer]);
            } else {
                if ('serviceWorker' in navigator) {
                    const imageDecoder = new ImageDecoder({type: m.mediaType, data: m.content});
                    await imageDecoder.decode().then((decodedImageResult) => {
                        source.postMessage({action: 'drawDecodedImageToCanvases', params: {decodedImage: decodedImageResult.image, canvasIndexes: m.canvasIndexes, generation: m.generation}}, [decodedImageResult.image]);
                    });
                } else {
                    const image = new Blob([m.content], {type: m.mediaType});
                    await createImageBitmap(image, {resizeWidth: m.canvasWidth, resizeHeight: m.canvasHeight, resizeQuality: 'high'}).then((decodedImage) => {
                        const canvas = new OffscreenCanvas(decodedImage.width, decodedImage.height);
                        const ctx = canvas.getContext('2d');
                        if (ctx !== null) {
                            ctx.drawImage(decodedImage, 0, 0);
                            const imageData = ctx.getImageData(0, 0, decodedImage.width, decodedImage.height);
                            source.postMessage({action: 'drawBufferToCanvases', params: {buffer: imageData.data.buffer, width: decodedImage.width, height: decodedImage.height, canvasIndexes: m.canvasIndexes, generation: m.generation}}, [imageData.data.buffer]);
                        }
                    });
                }
            }
        }

        safePerformance.mark('drawMedia:end');
        safePerformance.measure('drawMedia', 'drawMedia:start', 'drawMedia:end');
    }

    async getDictionaryInfo() {
        await this._syncFromStorageIfNeeded();
        const rows = [...this._state.dictionaries].sort((a, b) => a.id - b.id);
        return rows.map((row) => this._safeParseJson(row.summaryJson, {}));
    }

    async getDictionaryCounts(dictionaryNames, getTotal) {
        await this._syncFromStorageIfNeeded();
        const tables = ['kanji', 'kanjiMeta', 'terms', 'termMeta', 'tagMeta', 'media'];
        const counts = [];

        if (getTotal) {
            const total = {};
            for (const table of tables) {
                total[table] = this._state[table].length;
            }
            counts.push(total);
        }

        for (const dictionaryName of dictionaryNames) {
            const countGroup = {};
            for (const table of tables) {
                let count = 0;
                for (const row of this._state[table]) {
                    if (row.dictionary === dictionaryName) { ++count; }
                }
                countGroup[table] = count;
            }
            counts.push(countGroup);
        }

        const total = getTotal ? counts.shift() : null;
        return {total, counts};
    }

    async dictionaryExists(title) {
        await this._syncFromStorageIfNeeded();
        return this._state.dictionaries.some((row) => row.title === title);
    }

    async bulkAdd(objectStoreName, items, start, count) {
        await this._syncFromStorageIfNeeded();
        if (start + count > items.length) {
            count = items.length - start;
        }
        if (count <= 0) { return; }

        const cloneItem = !this._isBulkImport;
        for (let i = start, ii = start + count; i < ii; ++i) {
            const row = this._prepareRowForInsert(objectStoreName, items[i], cloneItem);
            this._state[objectStoreName].push(row);
            if (!this._isBulkImport) {
                this._indexInsertedRow(objectStoreName, row);
            }
        }

        this._dirty = true;
    }

    startBulkImport() {
        this._isBulkImport = true;
    }

    finishBulkImport() {
        if (!this._isBulkImport) { return; }
        this._isBulkImport = false;
        this._rebuildIndexes();
        this._dirty = true;
    }

    async finalizeImportPersistence() {
        await this._persistIfDirty();
    }

    async configureImportPerformance(options = {}) {
        const enableWasmIndexes = options.enableWasmIndexes === true;
        if (enableWasmIndexes === this._enableWasmIndexes) { return; }
        this._enableWasmIndexes = enableWasmIndexes;

        if (this._enableWasmIndexes) {
            await this._initializeWasmIndexes();
            await this._ensureWasmIndexesReady();
        } else {
            this._destroyWasmIndexes();
        }
    }

    async addWithResult(objectStoreName, item) {
        await this.bulkAdd(objectStoreName, [item], 0, 1);
        const rows = this._state[objectStoreName];
        const result = rows[rows.length - 1].id;
        const request = {
            result,
            onerror: null,
            onsuccess: null,
        };
        setTimeout(() => {
            if (typeof request.onsuccess === 'function') {
                request.onsuccess();
            }
        }, 0);
        return request;
    }

    async bulkUpdate(objectStoreName, items, start, count) {
        await this._syncFromStorageIfNeeded();
        if (objectStoreName !== 'dictionaries') {
            throw new Error(`Unsupported bulkUpdate store: ${objectStoreName}`);
        }
        if (start + count > items.length) {
            count = items.length - start;
        }
        if (count <= 0) { return; }

        for (let i = start, ii = start + count; i < ii; ++i) {
            const {data, primaryKey} = items[i];
            const summary = data;
            const row = this._state.dictionaries.find((entry) => entry.id === primaryKey);
            if (!row) { continue; }
            row.title = summary.title;
            row.version = summary.version;
            row.summaryJson = JSON.stringify(summary);
        }

        this._dirty = true;
    }

    async connectToDatabaseWorker(port) {
        if (this._worker !== null) {
            this._worker.postMessage({action: 'connectToDatabaseWorker'}, [port]);
            return;
        }

        port.onmessage = (event) => {
            const {action, params} = event.data;
            return invokeApiMapHandler(this._apiMap, action, params, [port], () => {});
        };
        port.onmessageerror = (event) => {
            const error = new ExtensionError('DictionaryDatabase: Error receiving message from main thread');
            error.data = event;
            log.error(error);
        };
    }

    async _initializeWasmIndexes() {
        if (this._wasmIndexInitAttempted) { return; }
        this._wasmIndexInitAttempted = true;

        const [expressionIndex, readingIndex, expressionReverseIndex, readingReverseIndex] = await Promise.all([
            WasmPrefixBloomIndex.create(1 << 22, 7),
            WasmPrefixBloomIndex.create(1 << 22, 7),
            WasmPrefixBloomIndex.create(1 << 22, 7),
            WasmPrefixBloomIndex.create(1 << 22, 7),
        ]);

        if (expressionIndex === null || readingIndex === null || expressionReverseIndex === null || readingReverseIndex === null) {
            expressionIndex?.destroy();
            readingIndex?.destroy();
            expressionReverseIndex?.destroy();
            readingReverseIndex?.destroy();
            return;
        }

        this._expressionWasmIndex = expressionIndex;
        this._readingWasmIndex = readingIndex;
        this._expressionReverseWasmIndex = expressionReverseIndex;
        this._readingReverseWasmIndex = readingReverseIndex;
    }

    async _ensureWasmIndexesReady() {
        if (!this._hasWasmIndexes()) { return; }
        if (this._didLoadPersistedWasmIndexes) { return; }

        this._expressionWasmIndex.clear();
        this._readingWasmIndex.clear();
        this._expressionReverseWasmIndex.clear();
        this._readingReverseWasmIndex.clear();
        for (const row of this._state.terms) {
            this._indexTermInWasm(row);
        }
        this._didLoadPersistedWasmIndexes = true;
    }

    _hasWasmIndexes() {
        return (
            this._expressionWasmIndex !== null &&
            this._readingWasmIndex !== null &&
            this._expressionReverseWasmIndex !== null &&
            this._readingReverseWasmIndex !== null
        );
    }

    _indexTermInWasm(row) {
        if (!this._hasWasmIndexes()) { return; }
        this._expressionWasmIndex.add(row.expression, row.id);
        this._readingWasmIndex.add(row.reading, row.id);
        if (typeof row.expressionReverse === 'string') {
            this._expressionReverseWasmIndex.add(row.expressionReverse, row.id);
        }
        if (typeof row.readingReverse === 'string') {
            this._readingReverseWasmIndex.add(row.readingReverse, row.id);
        }
    }

    _destroyWasmIndexes() {
        this._expressionWasmIndex?.destroy();
        this._readingWasmIndex?.destroy();
        this._expressionReverseWasmIndex?.destroy();
        this._readingReverseWasmIndex?.destroy();
        this._expressionWasmIndex = null;
        this._readingWasmIndex = null;
        this._expressionReverseWasmIndex = null;
        this._readingReverseWasmIndex = null;
        this._wasmIndexInitAttempted = false;
        this._didLoadPersistedWasmIndexes = false;
    }

    _onDrawMedia(params, port) {
        void this.drawMedia(params.requests, port);
    }

    _prepareRowForInsert(objectStoreName, item, cloneItem = true) {
        const row = cloneItem ? structuredClone(item) : item;
        if (typeof row.id !== 'number') {
            row.id = this._state.nextIds[objectStoreName]++;
        } else {
            this._state.nextIds[objectStoreName] = Math.max(this._state.nextIds[objectStoreName], row.id + 1);
        }
        return row;
    }

    _indexInsertedRow(storeName, row) {
        switch (storeName) {
            case 'terms': {
                this._termsById.set(row.id, row);
                this._insertMapArray(this._termsByExpression, row.expression, row.id);
                this._insertMapArray(this._termsByReading, row.reading, row.id);
                if (typeof row.expressionReverse === 'string') {
                    this._insertMapArray(this._termsByExpressionReverse, row.expressionReverse, row.id);
                }
                if (typeof row.readingReverse === 'string') {
                    this._insertMapArray(this._termsByReadingReverse, row.readingReverse, row.id);
                }
                if (typeof row.sequence === 'number') {
                    this._insertMapArray(this._termsBySequence, `${row.dictionary}\u001f${row.sequence}`, row.id);
                }
                this._expressionBloom.add(row.expression);
                this._readingBloom.add(row.reading);
                this._expressionTrie.insert(row.expression, row.id);
                this._readingTrie.insert(row.reading, row.id);
                if (typeof row.expressionReverse === 'string') {
                    this._expressionReverseBloom.add(row.expressionReverse);
                    this._expressionReverseTrie.insert(row.expressionReverse, row.id);
                }
                if (typeof row.readingReverse === 'string') {
                    this._readingReverseBloom.add(row.readingReverse);
                    this._readingReverseTrie.insert(row.readingReverse, row.id);
                }
                this._indexTermInWasm(row);
                break;
            }
            case 'termMeta':
                this._insertMapArray(this._termMetaByExpression, row.expression, row);
                break;
            case 'kanji':
                this._insertMapArray(this._kanjiByCharacter, row.character, row);
                break;
            case 'kanjiMeta':
                this._insertMapArray(this._kanjiMetaByCharacter, row.character, row);
                break;
            case 'tagMeta':
                this._insertMapArray(this._tagMetaByName, row.name, row);
                break;
            case 'media':
                this._insertMapArray(this._mediaByPath, row.path, row);
                break;
        }
    }

    _rebuildIndexes() {
        this._termsById.clear();
        this._termsByExpression.clear();
        this._termsByReading.clear();
        this._termsByExpressionReverse.clear();
        this._termsByReadingReverse.clear();
        this._termsBySequence.clear();

        this._termMetaByExpression.clear();
        this._kanjiByCharacter.clear();
        this._kanjiMetaByCharacter.clear();
        this._tagMetaByName.clear();
        this._mediaByPath.clear();

        this._expressionBloom.clear();
        this._readingBloom.clear();
        this._expressionReverseBloom.clear();
        this._readingReverseBloom.clear();

        this._expressionTrie.clear();
        this._readingTrie.clear();
        this._expressionReverseTrie.clear();
        this._readingReverseTrie.clear();
        if (this._hasWasmIndexes()) {
            this._expressionWasmIndex.clear();
            this._readingWasmIndex.clear();
            this._expressionReverseWasmIndex.clear();
            this._readingReverseWasmIndex.clear();
            this._didLoadPersistedWasmIndexes = true;
        }

        for (const row of this._state.terms) {
            this._indexInsertedRow('terms', row);
        }
        for (const row of this._state.termMeta) {
            this._indexInsertedRow('termMeta', row);
        }
        for (const row of this._state.kanji) {
            this._indexInsertedRow('kanji', row);
        }
        for (const row of this._state.kanjiMeta) {
            this._indexInsertedRow('kanjiMeta', row);
        }
        for (const row of this._state.tagMeta) {
            this._indexInsertedRow('tagMeta', row);
        }
        for (const row of this._state.media) {
            this._indexInsertedRow('media', row);
        }
    }

    _insertMapArray(map, key, value) {
        if (typeof key !== 'string') { return; }
        let list = map.get(key);
        if (!list) {
            list = [];
            map.set(key, list);
        }
        list.push(value);
    }

    _lookupMatchSource(keyKind) {
        switch (keyKind) {
            case 'reading':
            case 'readingReverse':
                return 'reading';
            case 'sequence':
                return 'sequence';
            default:
                return 'term';
        }
    }

    _lookupKeyValue(row, keyKind) {
        switch (keyKind) {
            case 'reading':
                return this._asString(row.reading);
            case 'expressionReverse':
                return this._asString(row.expressionReverse);
            case 'readingReverse':
                return this._asString(row.readingReverse);
            default:
                return this._asString(row.expression);
        }
    }

    _lookupTermIds(query, lookupMode, keyKind) {
        if (typeof query !== 'string' || query.length === 0) { return []; }
        if (keyKind === 'sequence') {
            return this._termsBySequence.get(query) ?? [];
        }

        const descriptor = this._lookupIndexDescriptor(keyKind);
        if (descriptor === null) { return []; }
        const {map, bloom, trie, wasmIndex} = descriptor;
        if (lookupMode === 'exact') {
            const maybe = wasmIndex !== null ? wasmIndex.mightContain(query) : bloom.mightContain(query);
            if (!maybe) { return []; }
            return map.get(query) ?? [];
        }
        return wasmIndex !== null ? wasmIndex.search(query) : trie.search(query);
    }

    _lookupIndexDescriptor(keyKind) {
        switch (keyKind) {
            case 'expression':
                return {
                    map: this._termsByExpression,
                    bloom: this._expressionBloom,
                    trie: this._expressionTrie,
                    wasmIndex: this._expressionWasmIndex,
                };
            case 'reading':
                return {
                    map: this._termsByReading,
                    bloom: this._readingBloom,
                    trie: this._readingTrie,
                    wasmIndex: this._readingWasmIndex,
                };
            case 'expressionReverse':
                return {
                    map: this._termsByExpressionReverse,
                    bloom: this._expressionReverseBloom,
                    trie: this._expressionReverseTrie,
                    wasmIndex: this._expressionReverseWasmIndex,
                };
            case 'readingReverse':
                return {
                    map: this._termsByReadingReverse,
                    bloom: this._readingReverseBloom,
                    trie: this._readingReverseTrie,
                    wasmIndex: this._readingReverseWasmIndex,
                };
            default:
                return null;
        }
    }

    _queryTermLookupRows(query, lookupMode, keyKind) {
        if (!this._useVirtualTermLookup) { return null; }
        if (typeof query !== 'string' || query.length === 0) { return []; }
        const db = this._requireDb();
        try {
            return db.selectObjects(
                `
                    SELECT id, matchSource, keyValue
                    FROM ${TERM_LOOKUP_VTAB_TABLE}($query, $lookupMode, $keyKind)
                `,
                {
                    $query: query,
                    $lookupMode: lookupMode,
                    $keyKind: keyKind,
                },
            );
        } catch (_e) {
            this._useVirtualTermLookup = false;
            return null;
        }
    }

    _createTerm(matchSource, matchType, row, index) {
        const {sequence} = row;
        return {
            index,
            matchType,
            matchSource,
            term: row.expression,
            reading: row.reading,
            definitionTags: this._splitField(row.definitionTags || row.tags),
            termTags: this._splitField(row.termTags),
            rules: this._splitField(row.rules),
            definitions: row.glossary,
            score: row.score,
            dictionary: row.dictionary,
            id: row.id,
            sequence: typeof sequence === 'number' ? sequence : -1,
        };
    }

    _createKanji(row, {itemIndex: index}) {
        const {stats} = row;
        return {
            index,
            character: row.character,
            onyomi: this._splitField(row.onyomi),
            kunyomi: this._splitField(row.kunyomi),
            tags: this._splitField(row.tags),
            definitions: row.meanings,
            stats: typeof stats === 'object' && stats !== null ? stats : {},
            dictionary: row.dictionary,
        };
    }

    _createTermMeta({expression: term, mode, data, dictionary}, {itemIndex: index}) {
        switch (mode) {
            case 'freq':
            case 'pitch':
            case 'ipa':
                return {index, term, mode, data, dictionary};
            default:
                throw new Error(`Unknown mode: ${mode}`);
        }
    }

    _createKanjiMeta({character, mode, data, dictionary}, {itemIndex: index}) {
        return {index, character, mode, data, dictionary};
    }

    _createMedia(row, {itemIndex: index}) {
        const {dictionary, path, mediaType, width, height, content} = row;
        return {index, dictionary, path, mediaType, width, height, content};
    }

    _deserializeTagRow(row) {
        return {
            name: this._asString(row.name),
            category: this._asString(row.category),
            order: this._asNumber(row.order ?? row.ord, 0),
            notes: this._asString(row.notes),
            score: this._asNumber(row.score, 0),
            dictionary: this._asString(row.dictionary),
        };
    }

    _splitField(field) {
        return typeof field === 'string' && field.length > 0 ? field.split(' ') : [];
    }

    _asNumber(value, fallback = 0) {
        return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    }

    _asString(value, fallback = '') {
        return typeof value === 'string' ? value : fallback;
    }

    _safeParseJson(value, fallback) {
        if (typeof value !== 'string') { return fallback; }
        try {
            return JSON.parse(value);
        } catch {
            return fallback;
        }
    }

    async _openStorageConnection() {
        if (this._db !== null) { return; }
        this._sqlite3 = await getSqlite3();
        this._db = await openOpfsDatabase();
        this._usesFallbackStorage = didLastOpenUseFallbackStorage();
        this._db.exec('PRAGMA journal_mode = MEMORY');
        this._db.exec('PRAGMA synchronous = OFF');
        this._db.exec('PRAGMA temp_store = MEMORY');
        this._db.exec('PRAGMA foreign_keys = OFF');
        this._initializeStorageSchema();
        this._registerLookupVirtualTable();
    }

    _initializeStorageSchema() {
        const db = this._requireDb();
        db.exec(`
            CREATE TABLE IF NOT EXISTS ${STORE_TABLE} (
                key TEXT PRIMARY KEY,
                value BLOB NOT NULL
            )
        `);
    }

    _registerLookupVirtualTable() {
        if (this._termLookupVtabRegistered) { return; }
        const sqlite3 = this._requireSqlite3();
        const db = this._requireDb();
        const {capi, vtab} = sqlite3;
        const owner = this;
        const cols = {
            id: {index: 0, type: 'INTEGER'},
            matchSource: {index: 1, type: 'TEXT'},
            keyValue: {index: 2, type: 'TEXT'},
            query: {index: 3, type: 'TEXT HIDDEN'},
            lookupMode: {index: 4, type: 'TEXT HIDDEN'},
            keyKind: {index: 5, type: 'TEXT HIDDEN'},
        };

        const cursorState = (pCursor, reset = false) => {
            const cursor = pCursor instanceof capi.sqlite3_vtab_cursor ? pCursor : vtab.xCursor.get(pCursor);
            if (reset || !cursor.vTabState) {
                cursor.vTabState = {rowIndex: 0, rows: []};
            }
            return cursor.vTabState;
        };

        const xConnectOrCreate = (pDb, _pAux, _argc, _argv, ppVtab) => {
            const columns = Object.entries(cols).map(([name, details]) => `${name} ${details.type}`);
            const rc = capi.sqlite3_declare_vtab(pDb, `CREATE TABLE x(${columns.join(', ')})`);
            if (rc === 0) {
                vtab.xVtab.create(ppVtab);
            }
            return rc;
        };

        this._termLookupVtabModule = new capi.sqlite3_module().setupModule({
            catchExceptions: true,
            methods: {
                xConnect: xConnectOrCreate,
                xCreate: null,
                xBestIndex: () => {
                    return 0;
                },
                xDisconnect: (pVtab) => {
                    vtab.xVtab.dispose(pVtab);
                    return 0;
                },
                xDestroy: null,
                xOpen: (_pVtab, ppCursor) => {
                    vtab.xCursor.create(ppCursor);
                    return 0;
                },
                xClose: (pCursor) => {
                    const cursor = vtab.xCursor.unget(pCursor);
                    delete cursor.vTabState;
                    cursor.dispose();
                    return 0;
                },
                xFilter: (pCursor, _idxNum, _idxStr, argc, argv) => {
                    const state = cursorState(pCursor, true);
                    const args = capi.sqlite3_values_to_js(argc, argv, false);
                    const query = typeof args[0] === 'string' ? args[0] : '';
                    const lookupMode = typeof args[1] === 'string' ? args[1] : 'prefix';
                    const keyKind = typeof args[2] === 'string' ? args[2] : 'expression';
                    const ids = owner._lookupTermIds(query, lookupMode, keyKind);
                    state.rows = ids.map((id) => {
                        const row = owner._termsById.get(id);
                        return {
                            id,
                            matchSource: owner._lookupMatchSource(keyKind),
                            keyValue: row ? owner._lookupKeyValue(row, keyKind) : '',
                        };
                    });
                    return 0;
                },
                xEof: (pCursor) => {
                    const state = cursorState(pCursor);
                    return state.rowIndex >= state.rows.length;
                },
                xNext: (pCursor) => {
                    const state = cursorState(pCursor);
                    state.rowIndex += 1;
                    return 0;
                },
                xColumn: (pCursor, pCtx, iCol) => {
                    const state = cursorState(pCursor);
                    const row = state.rows[state.rowIndex];
                    if (!row) {
                        capi.sqlite3_result_null(pCtx);
                        return 0;
                    }
                    switch (iCol) {
                        case cols.id.index:
                            capi.sqlite3_result_int(pCtx, row.id);
                            return 0;
                        case cols.matchSource.index:
                            capi.sqlite3_result_text(pCtx, row.matchSource, -1, capi.SQLITE_TRANSIENT);
                            return 0;
                        case cols.keyValue.index:
                            capi.sqlite3_result_text(pCtx, row.keyValue, -1, capi.SQLITE_TRANSIENT);
                            return 0;
                        case cols.query.index:
                        case cols.lookupMode.index:
                        case cols.keyKind.index:
                            capi.sqlite3_result_null(pCtx);
                            return 0;
                        default:
                            capi.sqlite3_result_error(pCtx, `Invalid column index: ${iCol}`);
                            return capi.SQLITE_RANGE;
                    }
                },
                xRowid: (pCursor, ppRowId64) => {
                    const state = cursorState(pCursor);
                    vtab.xRowid(ppRowId64, state.rowIndex + 1);
                    return 0;
                },
            },
        });

        const dbPointer = db.pointer;
        if (typeof dbPointer !== 'number') {
            throw new Error('sqlite database pointer is unavailable');
        }
        const createModuleResult = capi.sqlite3_create_module(dbPointer, TERM_LOOKUP_VTAB_TABLE, this._termLookupVtabModule, 0);
        if (createModuleResult !== capi.SQLITE_OK) {
            throw new Error(`Failed to register ${TERM_LOOKUP_VTAB_TABLE}: rc=${createModuleResult}`);
        }
        this._termLookupVtabRegistered = true;
    }

    _requireSqlite3() {
        if (this._sqlite3 === null) {
            throw new Error('sqlite3 module is not initialized');
        }
        return this._sqlite3;
    }

    _requireDb() {
        if (this._db === null) {
            throw new Error('Storage database is not open');
        }
        return this._db;
    }

    _readStorageValue(key) {
        const db = this._requireDb();
        return db.selectValue(`SELECT value FROM ${STORE_TABLE} WHERE key = $key`, {$key: key});
    }

    _writeStorageValue(key, value) {
        const db = this._requireDb();
        db.exec({
            sql: `INSERT INTO ${STORE_TABLE} (key, value) VALUES ($key, $value) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
            bind: {$key: key, $value: value},
        });
    }

    _deleteStorageValue(key) {
        const db = this._requireDb();
        db.exec({
            sql: `DELETE FROM ${STORE_TABLE} WHERE key = $key`,
            bind: {$key: key},
        });
    }

    _decodeStorageText(value) {
        if (typeof value === 'string') { return value; }
        if (value instanceof Uint8Array) {
            return new TextDecoder().decode(value);
        }
        if (value instanceof ArrayBuffer) {
            return new TextDecoder().decode(new Uint8Array(value));
        }
        return null;
    }

    _decodeStorageBytes(value) {
        if (value instanceof Uint8Array) { return value; }
        if (value instanceof ArrayBuffer) { return new Uint8Array(value); }
        if (typeof value === 'string') {
            return new TextEncoder().encode(value);
        }
        return null;
    }

    async _deletePersistedState() {
        this._deleteStorageValue(STORE_KEY_STATE_META);
        this._deleteStorageValue(STORE_KEY_STATE_MEDIA);
        this._deleteStorageValue(STORE_KEY_REVISION);
        this._revision = 0;
    }

    _serializeStateMeta(state) {
        let mediaOffset = 0;
        const media = new Array(state.media.length);
        for (let i = 0; i < state.media.length; ++i) {
            const row = state.media[i];
            const contentLength = row.content.byteLength;
            media[i] = {
                id: row.id,
                dictionary: row.dictionary,
                path: row.path,
                mediaType: row.mediaType,
                width: row.width,
                height: row.height,
                contentOffset: mediaOffset,
                contentLength,
            };
            mediaOffset += contentLength;
        }
        const indexArtifacts = {
            termsByExpression: [...this._termsByExpression.entries()],
            termsByReading: [...this._termsByReading.entries()],
            termsByExpressionReverse: [...this._termsByExpressionReverse.entries()],
            termsByReadingReverse: [...this._termsByReadingReverse.entries()],
            termsBySequence: [...this._termsBySequence.entries()],
            expressionBloom: this._expressionBloom.exportState(),
            readingBloom: this._readingBloom.exportState(),
            expressionReverseBloom: this._expressionReverseBloom.exportState(),
            readingReverseBloom: this._readingReverseBloom.exportState(),
            expressionTrie: this._expressionTrie.exportState(),
            readingTrie: this._readingTrie.exportState(),
            expressionReverseTrie: this._expressionReverseTrie.exportState(),
            readingReverseTrie: this._readingReverseTrie.exportState(),
        };
        return JSON.stringify({
            ...state,
            media,
            indexArtifacts,
            wasmIndexArtifacts: this._exportWasmIndexArtifacts(),
        });
    }

    _serializeStateMediaBlob(state) {
        let totalLength = 0;
        for (const row of state.media) {
            totalLength += row.content.byteLength;
        }
        const blob = new Uint8Array(totalLength);
        let offset = 0;
        for (const row of state.media) {
            const bytes = new Uint8Array(row.content);
            blob.set(bytes, offset);
            offset += bytes.byteLength;
        }
        return blob;
    }

    _deserializeStateFromMeta(metaText, mediaBlob) {
        const raw = JSON.parse(metaText);
        const state = createEmptyState();
        state.nextIds = raw.nextIds ?? state.nextIds;
        state.dictionaries = raw.dictionaries ?? [];
        state.terms = raw.terms ?? [];
        state.termMeta = raw.termMeta ?? [];
        state.kanji = raw.kanji ?? [];
        state.kanjiMeta = raw.kanjiMeta ?? [];
        state.tagMeta = raw.tagMeta ?? [];
        state.media = (raw.media ?? []).map((row) => {
            const offset = Math.max(0, Number(row.contentOffset) | 0);
            const length = Math.max(0, Number(row.contentLength) | 0);
            const bytes = mediaBlob.subarray(offset, offset + length);
            return {
                id: row.id,
                dictionary: row.dictionary,
                path: row.path,
                mediaType: row.mediaType,
                width: row.width,
                height: row.height,
                content: bytes.slice().buffer,
            };
        });
        this._didLoadPersistedIndexes = this._importIndexArtifacts(raw.indexArtifacts, state);
        this._didLoadPersistedWasmIndexes = this._importWasmIndexArtifacts(raw.wasmIndexArtifacts);
        return state;
    }

    _exportWasmIndexArtifacts() {
        if (!this._hasWasmIndexes()) { return null; }
        return {
            expression: this._expressionWasmIndex.exportState(),
            reading: this._readingWasmIndex.exportState(),
            expressionReverse: this._expressionReverseWasmIndex.exportState(),
            readingReverse: this._readingReverseWasmIndex.exportState(),
        };
    }

    _importIndexArtifacts(indexArtifacts, state) {
        if (!indexArtifacts || typeof indexArtifacts !== 'object') { return false; }
        try {
            const readMap = (value) => {
                const map = new Map();
                if (!Array.isArray(value)) { return map; }
                for (const entry of value) {
                    if (!Array.isArray(entry) || entry.length !== 2) { continue; }
                    const [k, ids] = entry;
                    if (typeof k !== 'string' || !Array.isArray(ids)) { continue; }
                    map.set(k, ids.map((id) => Number(id)));
                }
                return map;
            };

            this._termsByExpression = readMap(indexArtifacts.termsByExpression);
            this._termsByReading = readMap(indexArtifacts.termsByReading);
            this._termsByExpressionReverse = readMap(indexArtifacts.termsByExpressionReverse);
            this._termsByReadingReverse = readMap(indexArtifacts.termsByReadingReverse);
            this._termsBySequence = readMap(indexArtifacts.termsBySequence);

            this._expressionBloom.importState(indexArtifacts.expressionBloom);
            this._readingBloom.importState(indexArtifacts.readingBloom);
            this._expressionReverseBloom.importState(indexArtifacts.expressionReverseBloom);
            this._readingReverseBloom.importState(indexArtifacts.readingReverseBloom);

            this._expressionTrie.importState(indexArtifacts.expressionTrie);
            this._readingTrie.importState(indexArtifacts.readingTrie);
            this._expressionReverseTrie.importState(indexArtifacts.expressionReverseTrie);
            this._readingReverseTrie.importState(indexArtifacts.readingReverseTrie);

            this._termsById.clear();
            for (const row of state.terms) {
                this._termsById.set(row.id, row);
            }

            this._termMetaByExpression.clear();
            this._kanjiByCharacter.clear();
            this._kanjiMetaByCharacter.clear();
            this._tagMetaByName.clear();
            this._mediaByPath.clear();
            for (const row of state.termMeta) { this._indexInsertedRow('termMeta', row); }
            for (const row of state.kanji) { this._indexInsertedRow('kanji', row); }
            for (const row of state.kanjiMeta) { this._indexInsertedRow('kanjiMeta', row); }
            for (const row of state.tagMeta) { this._indexInsertedRow('tagMeta', row); }
            for (const row of state.media) { this._indexInsertedRow('media', row); }

            return true;
        } catch {
            return false;
        }
    }

    _importWasmIndexArtifacts(indexArtifacts) {
        if (!this._hasWasmIndexes()) { return false; }
        if (!indexArtifacts || typeof indexArtifacts !== 'object') { return false; }
        try {
            return (
                this._expressionWasmIndex.importState(indexArtifacts.expression) &&
                this._readingWasmIndex.importState(indexArtifacts.reading) &&
                this._expressionReverseWasmIndex.importState(indexArtifacts.expressionReverse) &&
                this._readingReverseWasmIndex.importState(indexArtifacts.readingReverse)
            );
        } catch {
            return false;
        }
    }

    async _persistIfDirty() {
        if (!this._dirty) { return; }
        if (this._isBulkImport) { return; }
        this._writeStorageValue(STORE_KEY_STATE_META, this._serializeStateMeta(this._state));
        this._writeStorageValue(STORE_KEY_STATE_MEDIA, this._serializeStateMediaBlob(this._state));
        this._revision += 1;
        this._writeStorageValue(STORE_KEY_REVISION, `${this._revision}`);
        this._dirty = false;
    }

    async _loadStateFromStorage() {
        const versionRaw = this._readStorageValue(STORE_KEY_REVISION);
        const metaRaw = this._readStorageValue(STORE_KEY_STATE_META);
        const mediaRaw = this._readStorageValue(STORE_KEY_STATE_MEDIA);
        const versionText = this._decodeStorageText(versionRaw);
        const metaText = this._decodeStorageText(metaRaw);
        const mediaBlob = this._decodeStorageBytes(mediaRaw);

        this._revision = versionText === null ? 0 : Number.parseInt(versionText, 10) || 0;
        if (metaText === null || metaText.length === 0 || mediaBlob === null) {
            this._state = createEmptyState();
            this._didLoadPersistedIndexes = false;
            this._didLoadPersistedWasmIndexes = false;
            return;
        }

        try {
            this._state = this._deserializeStateFromMeta(metaText, mediaBlob);
        } catch {
            this._state = createEmptyState();
            this._didLoadPersistedIndexes = false;
            this._didLoadPersistedWasmIndexes = false;
        }
    }

    async _syncFromStorageIfNeeded() {
        if (!this._isPrepared) {
            throw new Error(this._isOpening ? 'Database not ready' : 'Database not open');
        }
        if (this._dirty) { return; }

        const versionText = this._decodeStorageText(this._readStorageValue(STORE_KEY_REVISION));
        const externalRevision = versionText === null ? 0 : Number.parseInt(versionText, 10) || 0;
        if (externalRevision === this._revision) { return; }

        await this._loadStateFromStorage();
        if (!this._didLoadPersistedIndexes) {
            this._rebuildIndexes();
        }
        await this._ensureWasmIndexesReady();
    }
}
