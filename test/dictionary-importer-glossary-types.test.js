/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import {readFile} from 'node:fs/promises';
import {TextReader, Uint8ArrayReader, Uint8ArrayWriter, ZipWriter} from '@zip.js/zip.js';
import {beforeAll, describe, expect, test, vi} from 'vitest';
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js';
import {consumeLastTermBankWasmParseProfile, parseTermBankWithWasmChunks, parseTermBankWithWasmColumnChunks, setTermBankWasmModule} from '../ext/js/dictionary/term-bank-wasm-parser.js';
import {DictionaryImporterMediaLoader} from './mocks/dictionary-importer-media-loader.js';

beforeAll(async () => {
    setTermBankWasmModule(await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))));
});

const invalidGlossaries = [
    ['unknown type', '[{"type":"unsupported"}]'],
    ['missing type', '[{"text":"definition"}]'],
    ['empty object after supported object', '[{"type":"text","text":"definition"},{}]'],
    ['null type', '[{"type":null}]'],
    ['numeric type', '[{"type":1}]'],
    ['object type', '[{"type":{"type":"text"}}]'],
    ['later object type', '[{"type":"text","type":{"type":"text"}}]'],
    ['array type', '[{"type":["text"]}]'],
    ['later unknown type', '[{"type":"text","text":"definition","type":"unsupported"}]'],
    ['later escaped unknown type', String.raw`[{"type":"text","text":"definition","ty\u0070e":"unsupported"}]`],
    ['later null type', '[{"type":"text","type":null}]'],
    ['nested type cannot supply parent type', '[{"content":{"type":"text","text":"nested"}}]'],
    ['real image cannot hide unknown sibling', '[{"type":"image","path":"image.png"},{"type":"unsupported"}]'],
];

const validGlossaries = [
    ['ordinary text', '["definition"]'],
    ['text object', '[{"type":"text","text":"definition"}]'],
    ['nested data type', '[{"type":"structured-content","content":{"tag":"span","data":{"type":"unsupported"},"content":"definition"}}]'],
    ['later supported type', '[{"type":"unsupported","type":"text","text":"definition"}]'],
    ['later escaped supported type', String.raw`[{"type":null,"ty\u0070e":"te\u0078t","text":"definition"}]`],
    ['type after nested value', '[{"content":{"type":"unsupported"},"type":"structured-content"}]'],
    ['nested array retains existing behavior', '[[{"type":"unsupported"}]]'],
    ['scalar elements retain existing behavior', '[12,true,null]'],
    ['image', '[{"type":"image","path":"image.png"}]'],
    ['escaped image type', String.raw`[{"ty\u0070e":"im\u0061ge","path":"image.png"}]`],
    ['escaped structured-content type', String.raw`[{"type":"structured\u002dcontent","content":"definition"}]`],
    ['nested image', '[{"type":"structured-content","content":{"tag":"img","path":"image.png"}}]'],
];

/**
 * @param {string} glossary
 * @param {boolean} imageFile
 * @returns {Promise<Uint8Array>}
 */
async function archive(glossary, imageFile) {
    const writer = new ZipWriter(new Uint8ArrayWriter(), {level: 0});
    const options = {useWebWorkers: false};
    await writer.add('index.json', new TextReader(JSON.stringify({title: 'Glossary types', revision: '1', format: 3})), options);
    await writer.add('term_bank_1.json', new TextReader(`[["term","","","",1,${glossary},1,""]]`), options);
    if (imageFile) {
        await writer.add('image.png', new Uint8ArrayReader(Uint8Array.of(1, 2, 3)), options);
    }
    return Uint8Array.from(await writer.close());
}

function database() {
    const pending = {terms: 0};
    return {
        pending,
        isPrepared: () => true,
        setImportOptimizationFlags() {},
        setTermEntryContentDedupEnabled() {},
        setImportDebugLogging() {},
        dictionaryExists: async () => false,
        addWithResult: vi.fn(async () => 1),
        startBulkImport: vi.fn(async () => 'glossary-session'),
        finishBulkImport: vi.fn(async () => ({})),
        abortBulkImport: vi.fn(async () => { pending.terms = 0; }),
        deleteDictionaryImportPlaceholder: vi.fn(async () => {}),
        getLastBulkAddTermsMetrics: () => null,
        queuePendingTermContentImportWrites: async () => {},
        bulkAdd: vi.fn(async (/** @type {string} */ store, /** @type {unknown[]} */ _items, /** @type {number} */ _start, /** @type {number} */ count) => {
            if (store === 'terms') { pending.terms += count; }
        }),
        bulkAddArtifactTermsChunk: vi.fn(async (/** @type {{rowCount: number}} */ chunk) => { pending.terms += chunk.rowCount; }),
    };
}

describe('ordinary ZIP glossary object types', () => {
    for (const slow of [false, true]) {
        for (const imageFile of [false, true]) {
            for (const skipImageMetadata of [false, true]) {
                const mode = `slow=${slow}, imageFile=${imageFile}, skipMetadata=${skipImageMetadata}`;
                test.each(invalidGlossaries)(`rejects %s independently of media (${mode})`, async (_name, glossary) => {
                    const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
                    importer._disableTermBankWasmFastPath = slow;
                    const db = database();
                    const result = await importer.importDictionary(
                        /** @type {import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} */ (/** @type {unknown} */ (db)),
                        new Blob([await archive(glossary, imageFile)]),
                        /** @type {import('dictionary-importer').ImportDetails} */ ({skipImageMetadata, zipUseWebWorkers: false}),
                    );
                    expect(result.result).toBeNull();
                    expect(result.errors.length).toBeGreaterThan(0);
                    expect(db.pending.terms).toBe(0);
                    expect(db.finishBulkImport).not.toHaveBeenCalled();
                    expect(db.abortBulkImport).toHaveBeenCalledOnce();
                    expect(db.deleteDictionaryImportPlaceholder).toHaveBeenCalledOnce();
                });

                test.each(validGlossaries)(`preserves %s (${mode})`, async (_name, glossary) => {
                    const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
                    importer._disableTermBankWasmFastPath = slow;
                    const db = database();
                    const result = await importer.importDictionary(
                        /** @type {import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} */ (/** @type {unknown} */ (db)),
                        new Blob([await archive(glossary, imageFile)]),
                        /** @type {import('dictionary-importer').ImportDetails} */ ({skipImageMetadata, zipUseWebWorkers: false}),
                    );
                    expect(result.errors).toEqual([]);
                    expect(result.result?.counts?.terms.total).toBe(1);
                    expect(db.pending.terms).toBe(1);
                    expect(db.finishBulkImport).toHaveBeenCalledOnce();
                    expect(db.abortBulkImport).not.toHaveBeenCalled();
                });
            }
        }
    }
});

describe('internal native glossary validation', () => {
    for (const mode of ['rows', 'fused', 'fallback']) {
        for (const mediaHintFastScan of [false, true]) {
            test.each(invalidGlossaries)(`rejects %s before dispatch (${mode}, hints=${mediaHintFastScan})`, async (_name, glossary) => {
                // A wide first score makes the fused encoder enter its native
                // fallback before the malformed second bank is encountered.
                const first = `["first","","","",${mode === 'fallback' ? '1.5' : '1'},["valid"],1,""]`;
                const bad = `["bad","","","",1,${glossary},2,""]`;
                const encoder = new TextEncoder();
                const onChunk = vi.fn();
                const options = {validateGlossaryTypes: true, mediaHintFastScan, emitContentSlab: true, emitTokenBinaryContent: true, singleChunk: true};
                const parsing = mode === 'rows' ?
                    parseTermBankWithWasmChunks(encoder.encode(`[${first},${bad}]`), 3, onChunk, 1, options) :
                    parseTermBankWithWasmColumnChunks([encoder.encode(`[${first}]`), encoder.encode(`[${bad}]`)], 3, onChunk, 1, options);
                await expect(parsing).rejects.toThrow(/parser failed/u);
                expect(onChunk).not.toHaveBeenCalled();
            });

            test.each(validGlossaries)(`accepts %s with validation (${mode}, hints=${mediaHintFastScan})`, async (_name, glossary) => {
                const encoder = new TextEncoder();
                const source = encoder.encode(`[["term","","","",${mode === 'fallback' ? '1.5' : '1'},${glossary},1,""]]`);
                const onChunk = vi.fn();
                const options = {validateGlossaryTypes: true, mediaHintFastScan, emitContentSlab: true, emitTokenBinaryContent: true, singleChunk: true};
                if (mode === 'rows') {
                    await parseTermBankWithWasmChunks(source, 3, onChunk, 1, options);
                } else {
                    await parseTermBankWithWasmColumnChunks([source, encoder.encode('[]')], 3, onChunk, 1, options);
                    expect(consumeLastTermBankWasmParseProfile()?.fusedParseFallbacks ?? 0).toBe(mode === 'fallback' ? 1 : 0);
                }
                expect(onChunk).toHaveBeenCalledOnce();
            });
        }

        test(`keeps generic parsing permissive by default (${mode})`, async () => {
            const source = new TextEncoder().encode(`[["term","","","",${mode === 'fallback' ? '1.5' : '1'},[{"type":"unsupported"}],1,""]]`);
            const onChunk = vi.fn();
            const options = {mediaHintFastScan: false, emitContentSlab: true, emitTokenBinaryContent: true, singleChunk: true};
            if (mode === 'rows') {
                await parseTermBankWithWasmChunks(source, 3, onChunk, 1, options);
            } else {
                await parseTermBankWithWasmColumnChunks([source, new TextEncoder().encode('[]')], 3, onChunk, 1, options);
                expect(consumeLastTermBankWasmParseProfile()?.fusedParseFallbacks ?? 0).toBe(mode === 'fallback' ? 1 : 0);
            }
            expect(onChunk).toHaveBeenCalledOnce();
        });
    }
});
