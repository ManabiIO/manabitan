/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {describe, expect, test} from 'vitest';
import {
    decodeRawTermContentHeader,
    decodeRawTermContentSharedGlossaryHeader,
    decodeRawTermContentTokenHeader,
    encodeRawTermContentBinary,
    encodeRawTermContentSharedGlossaryBinary,
} from '../ext/js/dictionary/raw-term-content.js';

const textEncoder = new TextEncoder();
const glossaryBytes = textEncoder.encode('["meaning"]');

/**
 * @param {string[]} rawTokens
 * @returns {Uint8Array}
 */
function createTokenWire(rawTokens) {
    return textEncoder.encode(`MBR6${rawTokens.join('\0')}\0["meaning"]`);
}

describe('raw term content string identity', () => {
    /**
     * @param {'raw-v2'|'raw-v3'} format
     * @param {[string, string, string]} tags
     * @returns {(decoder: TextDecoder) => {rules: string, definitionTags: string, termTags: string}|null}
     */
    function createDecode(format, tags) {
        if (format === 'raw-v2') {
            const bytes = encodeRawTermContentBinary(
                tags[0],
                tags[1],
                tags[2],
                glossaryBytes,
                textEncoder,
            );
            return (decoder) => decodeRawTermContentHeader(bytes, decoder);
        }
        const bytes = encodeRawTermContentSharedGlossaryBinary(
            tags[0],
            tags[1],
            tags[2],
            123,
            glossaryBytes.length,
            textEncoder,
        );
        return (decoder) => decodeRawTermContentSharedGlossaryHeader(bytes, decoder);
    }

    test.each(['raw-v2', 'raw-v3'])(
        '%s preserves leading U+FEFF tag characters for either decoder BOM policy',
        (format) => {
            const tags = /** @type {[string, string, string]} */ (['\ufeffrule', '\ufeff\ufeffdefinition', '\ufeff']);
            const decode = createDecode(/** @type {'raw-v2'|'raw-v3'} */ (format), tags);
            for (const ignoreBOM of [false, true]) {
                expect(decode(new TextDecoder('utf-8', {ignoreBOM}))).toMatchObject({
                    rules: tags[0],
                    definitionTags: tags[1],
                    termTags: tags[2],
                });
            }
        },
    );

    test('token fields preserve literal leading U+FEFF characters', () => {
        const tags = ['\ufeffrule', '\ufeff\ufeffdefinition', '\ufeff'];
        const bytes = createTokenWire(tags.map((value) => JSON.stringify(value)));
        for (const ignoreBOM of [false, true]) {
            expect(decodeRawTermContentTokenHeader(bytes, new TextDecoder('utf-8', {ignoreBOM}))).toMatchObject({
                rules: tags[0],
                definitionTags: tags[1],
                termTags: tags[2],
            });
        }
    });

    test.each([
        '"a"b"',
        '"a\nb"',
        '"a\tb"',
        `"a${String.fromCharCode(1)}b"`,
    ])('token fields reject malformed unescaped JSON string content %j', (malformed) => {
        for (let field = 0; field < 3; ++field) {
            const tokens = ['"rule"', '"definition"', '"term"'];
            tokens[field] = malformed;
            expect(decodeRawTermContentTokenHeader(createTokenWire(tokens), new TextDecoder())).toBeNull();
        }
    });
});
