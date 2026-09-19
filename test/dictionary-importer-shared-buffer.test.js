/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {describe, expect, test} from 'vitest';
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js';
import {DictionaryImporterMediaLoader} from './mocks/dictionary-importer-media-loader.js';

describe('DictionaryImporter shared-buffer decoding', () => {
    test('copies shared glossary bytes before decoding and caches the result', () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const decoder = new TextDecoder();
        let decodeCount = 0;
        /** @type {ArrayBuffer|null} */
        let decodedBuffer = null;
        Reflect.set(importer, '_textDecoder', {
            /**
             * @param {Uint8Array<ArrayBuffer>} bytes
             * @returns {string}
             */
            decode(bytes) {
                ++decodeCount;
                decodedBuffer = bytes.buffer;
                if (bytes.buffer instanceof SharedArrayBuffer) {
                    throw new TypeError('shared views are rejected by this decoder');
                }
                return decoder.decode(bytes);
            },
        });

        const encoded = new TextEncoder().encode('["shared glossary"]');
        const shared = new Uint8Array(new SharedArrayBuffer(encoded.byteLength + 8));
        shared.set(encoded, 4);
        const row = {
            glossaryJson: '',
            glossaryJsonBytes: shared.subarray(4, 4 + encoded.byteLength),
        };
        const getGlossaryJson = /** @type {(entry: typeof row) => string} */ (
            Reflect.get(importer, '_getFastRowGlossaryJson')
        ).bind(importer);

        expect(getGlossaryJson(row)).toBe('["shared glossary"]');
        expect(getGlossaryJson(row)).toBe('["shared glossary"]');
        expect(decodeCount).toBe(1);
        expect(decodedBuffer).toBeInstanceOf(ArrayBuffer);
    });
});
