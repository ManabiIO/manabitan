/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {readFile} from 'node:fs/promises';
import {crc32} from 'node:zlib';
import {afterEach, beforeAll, describe, expect, test, vi} from 'vitest';
import {tryCollectGlossaryImagePaths} from '../ext/js/dictionary/dictionary-image-references.js';
import {getImageMediaTypeFromFileName} from '../ext/js/media/media-util.js';
import {copyWasmBackedColumnChunk, inflateCompressedTermBankSourcesWasm, parseTermBankWithWasmColumnChunks, setTermBankWasmModule} from '../ext/js/dictionary/term-bank-wasm-parser.js';

/** @typedef {{memory: WebAssembly.Memory, wasm_reset_heap: () => void, wasm_alloc: (size: number) => number, project_single_glossary_image_path: (pointer: number, length: number) => bigint}} ProjectionWasm */
/** @type {ProjectionWasm} */
let wasm;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {ignoreBOM: true});

beforeAll(async () => {
    const module = await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url)));
    wasm = /** @type {ProjectionWasm} */ ((await WebAssembly.instantiate(module)).exports);
    setTermBankWasmModule(module);
});
afterEach(() => { vi.restoreAllMocks(); });

/**
 * @param {string} source
 * @returns {string[]|null}
 */
function projectNative(source) {
    const bytes = encoder.encode(source);
    wasm.wasm_reset_heap();
    const pointer = wasm.wasm_alloc(bytes.length + 32);
    const memory = new Uint8Array(wasm.memory.buffer, pointer, bytes.length + 32);
    memory.fill(0xe7);
    memory.set(bytes, 16);
    const before = Uint8Array.from(memory);
    const heapEnd = wasm.wasm_alloc(0);
    const memoryLength = wasm.memory.buffer.byteLength;
    const span = wasm.project_single_glossary_image_path(pointer + 16, bytes.length);
    expect(wasm.wasm_alloc(0)).toBe(heapEnd);
    expect(wasm.memory.buffer.byteLength).toBe(memoryLength);
    expect(memory).toEqual(before);
    if (span === 0n) { return null; }
    const start = Number((span >> 32n) & 0xffffffffn);
    const length = Number(span & 0xffffffffn);
    expect(start + length).toBeLessThanOrEqual(bytes.length);
    const path = JSON.parse(decoder.decode(bytes.subarray(start, start + length)));
    expect(typeof path).toBe('string');
    return getImageMediaTypeFromFileName(path) === null ? null : [path];
}

const singleImageCases = [
    '[{"type":"image","path":"image.webp"}]',
    ' \n["img", 5, null, [], {"path":"image.png","ignored":{"tag":"img","path":"ignored.png"},"type":"image"}]\t',
    '[{"type":"structured-content","content":{"tag":"img","path":"image.png"}}]',
    '[{"type":"structured-content","content":{"content":["text",null,{"path":"image.png","tag":"img"}],"tag":"div"}}]',
    '[{"type":"structured-content","content":{"tag":"img","content":{"tag":"img","path":"ignored.png"},"path":"outer.png"}}]',
    '[{"type":"structured-content","content":{"content":{"tag":"img","path":"ignored.png"},"path":"outer.png","tag":"img"}}]',
    '[{"type":"structured-content","content":{"tag":"img","path":"first.png","path":"last.png"}}]',
    '[{"type":"image","path":null,"path":"last.png"}]',
    '[{"type":"image","type":"structured-content","path":"ignored.png","content":{"tag":"img","path":"last.png"}}]',
    '[{"type":"structured-content","type":"image","path":"last.png","content":{"tag":"img","path":"ignored.png"}}]',
    '[{"type":"structured-content","content":{"tag":"img","path":"first.png"},"content":{"tag":"img","path":"last.png"}}]',
    '[{"type":"structured-content","content":{"tag":"div","tag":"img","path":"last.png","content":{"tag":"img","path":"ignored.png"}}}]',
    '[{"type":"structured-content","content":{"tag":"img","tag":"div","path":"ignored.png","content":{"tag":"img","path":"last.png"}}}]',
    '[{"type":"structured-content","content":{"tag":null,"path":"ignored.png","content":[{"tag":"img","path":"last.png"}]}}]',
    '[{"type":"image","content":{"tag":"img","path":"ignored.png"},"path":"日本😀.png"}]',
    String.raw`[{"ty\u0070e":"im\u0061ge","pa\u0074h":"img/\u732b.webp"}]`,
    String.raw`[{"type":"structured-content","\u0063ontent":{"ta\u0067":"\u0069mg","path":"img/quote\"\\\ud800.png"}}]`,
    String.raw`[{"type":"image","path":"\ufeffimage.png"}]`,
    String.raw`[{"type":"image","path":"first.png","pa\u0074h":"last.png"}]`,
    '[{"type":"image","__proto__":{"type":"text"},"path":"owned.png"}]',
];
const fallbackCases = [
    '[]',
    'null',
    '{}',
    '[[{"type":"image","path":"ignored.png"}]]',
    '["image",{"type":"text","text":"img","path":"ignored.png"}]',
    '[{"type":"structured-content","content":{"tag":"a","href":"image.png","path":"ignored.png"}}]',
    '[{"type":"image","path":"image.bin"}]',
    '[{"type":"image","path":"first.png"},{"type":"image","path":"second.png"}]',
    '[{"type":"structured-content","content":[{"tag":"img","path":"same.png"},{"tag":"img","path":"same.png"}]}]',
    '[{"type":"structured-content","content":[{"tag":"img","path":"valid.png"},{"tag":"img","path":"ignored.bin"}]}]',
    '[{"type":"image","path":"first.png","path":null}]',
    '[{"type":"image","path":"first.png","type":false}]',
    '[{"type":"structured-content","content":{"tag":"img","path":"first.png"},"content":false}]',
    '[{"type":"structured-content","content":{"tag":"img","content":{"tag":"img","path":"ignored.png"}}}]',
];

describe('native single-image semantic projection', () => {
    test.each(singleImageCases)('projects exact semantic image paths: %s', (source) => {
        const expected = tryCollectGlossaryImagePaths(source);
        expect(expected).toHaveLength(1);
        expect(projectNative(source)).toEqual(expected);
    });

    test.each(fallbackCases)('retains general projection for %s', (source) => {
        expect(projectNative(source)).toBeNull();
    });

    test('matches duplicate last-key semantics in different field orders', () => {
        const types = ['"image"', '"structured-content"', '"text"', 'null'];
        const paths = ['"last.png"', 'null', 'false'];
        const contents = ['{"tag":"img","path":"nested.png"}', 'null', '["text"]'];
        for (const type of types) {
            for (const path of paths) {
                for (const content of contents) {
                    const fields = [`"type":"image","type":${type}`, `"path":"first.png","path":${path}`, `"content":{"tag":"img","path":"first-child.png"},"content":${content}`];
                    for (const order of [[0, 1, 2], [2, 1, 0], [1, 0, 2]]) {
                        const source = `[{${order.map((index) => fields[index]).join(',')}}]`;
                        const expected = tryCollectGlossaryImagePaths(source);
                        expect(projectNative(source)).toEqual(expected.length === 1 ? expected : null);
                    }
                }
            }
        }
    });

    test.each([
        '[',
        '[{',
        '[{"type":"image","path":"x.png"},]',
        '[{"type":"image","path":"x.png",}]',
        '[{"type":"image","path":"x.png","unknown":00}]',
        '[{"type":"image","path":"x.png","unknown":{"trailing":true,}}]',
        '[{"type":"image","path":"x.png"}]garbage',
        '[{"type":"image","path":"x.png"} true]',
        '[{"type":"image" "path":"x.png"}]',
        String.raw`[{"type":"image","path":"invalid\q.png"}]`,
        String.raw`[{"type":"image","path":"invalid\u00Q0.png"}]`,
    ])('does not accept malformed bytes: %s', (source) => {
        expect(projectNative(source)).toBeNull();
    });

    test('bounds every read and preserves the source and heap at the nesting limit', () => {
        expect(wasm.project_single_glossary_image_path(wasm.memory.buffer.byteLength - 1, 2)).toBe(0n);
        expect(wasm.project_single_glossary_image_path(0xffffffff, 0xffffffff)).toBe(0n);
        const nested = (/** @type {number} */ depth) => '[{"type":"structured-content","content":' +
        '{"content":'.repeat(depth) + '{"tag":"img","path":"deep.png"}' + '}'.repeat(depth) + '}]';
        for (const depth of [0, 32, 128, 253]) {
            expect(projectNative(nested(depth))).toEqual(['deep.png']);
        }
        expect(projectNative(nested(256))).toBeNull();
    });
});

/**
 * @param {string} glossary
 * @param {(chunk: Parameters<typeof copyWasmBackedColumnChunk>[0], source: Awaited<ReturnType<typeof inflateCompressedTermBankSourcesWasm>>) => void} inspect
 */
async function parseCompressedGlossary(glossary, inspect) {
    const bytes = encoder.encode(`[["画像","がぞう","","",0,${glossary},1,""]]`);
    const source = await inflateCompressedTermBankSourcesWasm([{bytes, compressionMethod: 0, compressedSize: bytes.length, uncompressedSize: bytes.length, signature: crc32(bytes)}]);
    await parseTermBankWithWasmColumnChunks(new Uint8Array(0), 3, (chunk) => inspect(chunk, source), 2048, {
        singleChunk: true,
        emitTermByteLists: false,
        computeContentHashes: true,
        emitContentSlab: true,
        emitTokenBinaryContent: true,
        compactContentMetadata: true,
        mediaHintFastScan: true,
        validateGlossaryTypes: true,
        prepareLookupIndexes: true,
        preloadedSource: source,
    });
}

describe('compressed worker-source media projection', () => {
    test('removes full glossary parsing and decoding while preserving all columns and owned paths', async () => {
        let retained;
        let snapshot;
        const glossary = JSON.stringify([{type: 'structured-content', content: {tag: 'div', content: ['text'.repeat(1024), {tag: 'img', path: 'img/日本.webp'}]}}]);
        await parseCompressedGlossary(glossary, (chunk, source) => {
            const expected = copyWasmBackedColumnChunk(chunk, false, true);
            const sourceBefore = Uint8Array.from(new Uint8Array(source.wasm.memory.buffer, source.jsonPtr, source.jsonLength));
            const parse = vi.spyOn(JSON, 'parse');
            const decode = vi.spyOn(TextDecoder.prototype, 'decode');
            const actual = copyWasmBackedColumnChunk(chunk, false, true, false, source);
            expect(parse).not.toHaveBeenCalled();
            expect(decode).toHaveBeenCalledTimes(1);
            expect(decode.mock.calls[0][0]?.byteLength).toBe(encoder.encode('img/日本.webp').length);
            expect(actual).toEqual(expected);
            expect(new Uint8Array(source.wasm.memory.buffer, source.jsonPtr, source.jsonLength)).toEqual(sourceBefore);
            retained = actual;
            snapshot = structuredClone(actual);
        });
        vi.restoreAllMocks();
        await parseCompressedGlossary('[{"type":"image","path":"later.png"}]', () => {});
        expect(retained).toEqual(snapshot);
    });

    test.each(['multiple', 'foreign', 'range', 'decoded', 'missing-export'])('keeps the collector fallback for %s', async (kind) => {
        const glossary = kind === 'multiple' ?
            '[{"type":"image","path":"first.png"},{"type":"image","path":"second.png"}]' :
            '[{"type":"image","path":"first.png"}]';
        await parseCompressedGlossary(glossary, (chunk, source) => {
            const row = chunk.mediaRows[0].row;
            if (kind === 'foreign') { row.glossaryJsonBytes = Uint8Array.from(row.glossaryJsonBytes ?? []); }
            if (kind === 'decoded') { row.glossaryJson = glossary; }
            if (kind === 'range') { source = {...source, jsonLength: 1}; }
            if (kind === 'missing-export') { source = {...source, wasm: {...source.wasm, project_single_glossary_image_path: undefined}}; }
            const parse = vi.spyOn(JSON, 'parse');
            const actual = copyWasmBackedColumnChunk(chunk, false, true, false, source);
            expect(parse).toHaveBeenCalledTimes(1);
            expect(actual.mediaRows[0].imagePaths).toEqual(kind === 'multiple' ? ['first.png', 'second.png'] : ['first.png']);
        });
    });
});
