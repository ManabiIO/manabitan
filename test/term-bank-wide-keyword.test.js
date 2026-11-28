/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {readFile} from 'node:fs/promises';
import {beforeAll, describe, expect, test} from 'vitest';
import {tryCollectGlossaryImagePaths} from '../ext/js/dictionary/dictionary-image-references.js';

/** @typedef {{memory: WebAssembly.Memory, wasm_alloc: (length: number) => number, wasm_reset_heap: () => void, parse_term_bank_with_media_hints: (input: number, length: number, output: number, capacity: number, spans: number, bankCount: number, validateGlossaryTypes: number) => number, project_single_glossary_image_path: (input: number, length: number) => bigint}} ParserExports */
/** @typedef {{alignment?: number, logicalLength?: number, bankSpan?: boolean}} SourceOptions */
/** @type {ParserExports} */
let parser;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const keyword = 'structured-content';
const path = 'nested/image.png';

beforeAll(async () => {
    const {instance} = await WebAssembly.instantiate(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url)));
    parser = /** @type {ParserExports} */ (/** @type {unknown} */ (instance.exports));
});

/**
 * @param {string} token
 * @returns {string}
 */
function glossary(token) {
    return `[{"type":${token},"content":{"tag":"img","path":"${path}"}}]`;
}

/**
 * @param {string} value
 * @returns {string}
 */
function bank(value) {
    return `[["entry","","","",0,${value},1,""]]`;
}

/**
 * Place the literal's first byte at the requested alignment, with guards on
 * both sides. The physical source can extend beyond its logical input length.
 * @param {string} source
 * @param {number} alignment
 */
function placeSource(source, alignment) {
    const bytes = encoder.encode(source);
    parser.wasm_reset_heap();
    const allocation = parser.wasm_alloc(bytes.length + 40);
    const keywordOffset = Math.max(0, source.indexOf(keyword));
    const prefix = 16 + ((alignment - (allocation + 16 + keywordOffset)) & 7);
    const pointer = allocation + prefix;
    const memory = new Uint8Array(parser.memory.buffer, allocation, bytes.length + 40);
    memory.fill(0xa7);
    memory.set(bytes, prefix);
    expect((pointer + keywordOffset) & 7).toBe(alignment);
    return {bytes, pointer, memory, before: Uint8Array.from(memory)};
}

/**
 * @param {string} source
 * @param {SourceOptions} [options]
 */
function parseStrict(source, options = {}) {
    const input = placeSource(source, options.alignment ?? 0);
    const output = parser.wasm_alloc(17 * 4);
    const logicalLength = options.logicalLength ?? input.bytes.length;
    const spans = options.bankSpan ? parser.wasm_alloc(8) : 0;
    if (spans !== 0) {
        new Uint32Array(parser.memory.buffer, spans, 2).set([0, logicalLength]);
    }
    const count = parser.parse_term_bank_with_media_hints(
        input.pointer,
        spans === 0 ? logicalLength : input.bytes.length,
        output,
        1,
        spans,
        spans === 0 ? 0 : 1,
        1,
    );
    expect(input.memory).toEqual(input.before);
    if (count !== 1) { return {count, glossary: null}; }
    const metadata = new Uint32Array(parser.memory.buffer, output, 17);
    const start = metadata[9];
    const length = metadata[10];
    expect(start + length).toBeLessThanOrEqual(logicalLength);
    return {count, glossary: JSON.parse(decoder.decode(input.bytes.subarray(start, start + length)))};
}

/**
 * @param {string} source
 * @param {SourceOptions} [options]
 * @returns {string[]|null}
 */
function project(source, options = {}) {
    const input = placeSource(source, options.alignment ?? 0);
    const logicalLength = options.logicalLength ?? input.bytes.length;
    const result = parser.project_single_glossary_image_path(input.pointer, logicalLength);
    expect(input.memory).toEqual(input.before);
    if (result === 0n) { return null; }
    const start = Number(result >> 32n);
    const length = Number(result & 0xffffffffn);
    expect(start + length).toBeLessThanOrEqual(logicalLength);
    const projected = JSON.parse(decoder.decode(input.bytes.subarray(start, start + length)));
    expect(typeof projected).toBe('string');
    return [projected];
}

/**
 * @param {number[]} positions
 * @param {boolean} [uppercase]
 * @returns {string}
 */
function escapedToken(positions, uppercase = false) {
    return '"' + [...keyword].map((char, index) => {
        if (!positions.includes(index)) { return char; }
        const hex = char.charCodeAt(0).toString(16).padStart(4, '0');
        return `\\u${uppercase ? hex.toUpperCase() : hex}`;
    }).join('') + '"';
}

/**
 * @param {string} token
 * @param {number} [alignment]
 */
function expectRecognized(token, alignment = 0) {
    const source = glossary(token);
    expect(JSON.parse(token)).toBe(keyword);
    expect(parseStrict(bank(source), {alignment})).toEqual({count: 1, glossary: JSON.parse(source)});
    const expectedPaths = tryCollectGlossaryImagePaths(source);
    expect(expectedPaths).toEqual([path]);
    expect(project(source, {alignment})).toEqual(expectedPaths);
}

describe('bounded native long keyword identity', () => {
    test.each(Array.from({length: 8}, (_, index) => index))('recognizes the literal at byte alignment %i', (alignment) => {
        expectRecognized(JSON.stringify(keyword), alignment);
    });

    test.each(Array.from({length: keyword.length}, (_, index) => index))('recognizes a Unicode escape at character %i', (index) => {
        expectRecognized(escapedToken([index]));
    });

    test.each([false, true])('recognizes all escaped characters with uppercase hex=%s', (uppercase) => {
        expectRecognized(escapedToken(Array.from({length: keyword.length}, (_, index) => index), uppercase));
    });

    test('preserves the required content field for literal and escaped types', () => {
        for (const token of [JSON.stringify(keyword), escapedToken([0, 7, 8, 15, 16, 17])]) {
            for (const content of ['', ',"content":null']) {
                const source = `[{"type":${token}${content}}]`;
                expect(parseStrict(bank(source)).count).toBeLessThan(0);
                expect(project(source)).toBeNull();
            }
        }
    });

    const nearMatches = [
        ...[7, 8, 15, 16, 17].map((index) => JSON.stringify(keyword.slice(0, index) + 'X' + keyword.slice(index + 1))),
        ...['x' + keyword, keyword + 'x', keyword.slice(0, -1), keyword.slice(0, 8), 's', '', 'Structured-content', '\\u0073tructured-content'].map((value) => JSON.stringify(value)),
        '"structured-content\\u0078"',
    ];
    test.each(nearMatches)('rejects a near-match type %s', (token) => {
        expect(JSON.parse(token)).not.toBe(keyword);
        const source = glossary(token);
        expect(parseStrict(bank(source)).count).toBeLessThan(0);
        expect(project(source)).toBeNull();
    });

    const malformedTokens = [
        ...[0, 7, 8, 15, 16, 17].map((index) => '"' + keyword.slice(0, index) + '\\u00Q0' + keyword.slice(index + 1) + '"'),
        ...['\\', '\\u', '\\u0', '\\u00', '\\u007'].map((suffix) => '"structured-conten' + suffix + '"'),
    ];
    test.each(malformedTokens)('rejects malformed or incomplete escapes %s', (token) => {
        expect(() => JSON.parse(token)).toThrow();
        const source = glossary(token);
        expect(parseStrict(bank(source)).count).toBeLessThan(0);
        expect(project(source)).toBeNull();
    });

    test.each([JSON.stringify(keyword), escapedToken([7, 8, 15, 16])])('respects logical ends despite a physically present valid suffix: %s', (token) => {
        const source = glossary(token);
        const bankSource = bank(source);
        expect(parseStrict(bankSource, {bankSpan: true}).count).toBe(1);
        expect(project(source)).toEqual([path]);
        // These malformed banks may fail grammar before keyword comparison;
        // they verify bounded rejection, not execution of the literal branch.
        for (let offset = 1; offset <= token.length; ++offset) {
            for (const alignment of [0, 7]) {
                expect(parseStrict(bankSource, {
                    alignment,
                    logicalLength: bankSource.indexOf(token) + offset,
                    bankSpan: true,
                }).count).toBeLessThan(0);
                expect(project(source, {
                    alignment,
                    logicalLength: source.indexOf(token) + offset,
                })).toBeNull();
            }
        }
    });
});
