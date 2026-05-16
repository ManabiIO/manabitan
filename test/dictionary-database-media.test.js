/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {describe, expect, test, vi} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';

describe('DictionaryDatabase media deserialization', () => {
    test('returns an empty media payload instead of throwing when external content is unreadable', async () => {
        const database = new DictionaryDatabase();
        Reflect.set(database, '_termContentStore', {
            readSlice: vi.fn().mockResolvedValue(null),
        });

        const deserializeMediaRow = /** @type {(this: DictionaryDatabase, row: Record<string, unknown>) => Promise<{content: ArrayBuffer}>} */ (
            Reflect.get(database, '_deserializeMediaRow')
        );
        const result = await deserializeMediaRow.call(database, {
            dictionary: 'media-test',
            path: 'missing.png',
            mediaType: 'image/png',
            width: 16,
            height: 16,
            content: new Uint8Array(0),
            contentOffset: 128,
            contentLength: 64,
            contentCompressionMethod: 0,
            contentUncompressedLength: 0,
        });

        expect(result.content).toBeInstanceOf(ArrayBuffer);
        expect(result.content.byteLength).toBe(0);
        expect(Reflect.get(database, '_termContentStore').readSlice).toHaveBeenCalledWith(128, 64);
    });

    test('returns an empty media payload instead of throwing when external content read fails', async () => {
        const database = new DictionaryDatabase();
        Reflect.set(database, '_termContentStore', {
            readSlice: vi.fn().mockRejectedValue(new Error('media read failed')),
        });

        const deserializeMediaRow = /** @type {(this: DictionaryDatabase, row: Record<string, unknown>) => Promise<{content: ArrayBuffer}>} */ (
            Reflect.get(database, '_deserializeMediaRow')
        );
        const result = await deserializeMediaRow.call(database, {
            dictionary: 'media-test',
            path: 'broken.png',
            mediaType: 'image/png',
            width: 16,
            height: 16,
            content: new Uint8Array(0),
            contentOffset: 256,
            contentLength: 32,
            contentCompressionMethod: 0,
            contentUncompressedLength: 0,
        });

        expect(result.content).toBeInstanceOf(ArrayBuffer);
        expect(result.content.byteLength).toBe(0);
        expect(Reflect.get(database, '_termContentStore').readSlice).toHaveBeenCalledWith(256, 32);
    });
});
