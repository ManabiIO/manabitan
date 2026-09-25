/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {describe, expect, test} from 'vitest';
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js';
import {DictionaryImporterMediaLoader} from '../ext/js/dictionary/dictionary-importer-media-loader.js';
import {hashTermEntryContentBytesPair} from '../ext/js/dictionary/term-entry-content-hash.js';

/**
 * @returns {import('dictionary-database').DatabaseTermEntry}
 */
function createEntry() {
    return /** @type {import('dictionary-database').DatabaseTermEntry} */ ({
        dictionary: 'Test',
        expression: 'term',
        reading: 'term',
        definitionTags: '',
        termTags: '',
        rules: '',
        glossary: ['definition'],
        score: 0,
        sequence: -1,
    });
}

describe('DictionaryImporter numeric content hashes', () => {
    test('prepares content bytes and numeric hashes without materializing the legacy hex hash', () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const entry = createEntry();

        Reflect.get(importer, '_prepareTermEntrySerialization').call(importer, entry, true);

        expect(entry.termEntryContentBytes).toBeInstanceOf(Uint8Array);
        const [hash1, hash2] = hashTermEntryContentBytesPair(/** @type {Uint8Array} */ (entry.termEntryContentBytes));
        expect(entry.termEntryContentHash1).toBe(hash1);
        expect(entry.termEntryContentHash2).toBe(hash2);
        expect(Object.hasOwn(entry, 'termEntryContentHash')).toBe(false);
    });

    test('clears a stale legacy hex hash when serialization replaces content metadata', () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const entry = createEntry();
        entry.termEntryContentHash = '0000000000000000';

        Reflect.get(importer, '_prepareTermEntrySerialization').call(importer, entry, true);

        expect(entry.termEntryContentHash).toBeUndefined();
        expect(entry.termEntryContentHash1).toEqual(expect.any(Number));
        expect(entry.termEntryContentHash2).toEqual(expect.any(Number));
    });

    test('clears a stale legacy hash after raw-byte artifact normalization', () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const sourceBytes = new TextEncoder().encode(JSON.stringify({
            rules: '',
            definitionTags: '',
            termTags: '',
            glossary: ['definition'],
        }));
        const entry = createEntry();
        entry.termEntryContentBytes = sourceBytes;
        entry.termEntryContentHash = 'ffffffffffffffff';

        Reflect.get(importer, '_normalizeArtifactTermEntryContent').call(importer, entry, 'raw-bytes');

        expect(entry.termEntryContentBytes).toBeInstanceOf(Uint8Array);
        expect(entry.termEntryContentBytes).not.toBe(sourceBytes);
        const [hash1, hash2] = hashTermEntryContentBytesPair(/** @type {Uint8Array} */ (entry.termEntryContentBytes));
        expect(entry.termEntryContentHash1).toBe(hash1);
        expect(entry.termEntryContentHash2).toBe(hash2);
        expect(entry.termEntryContentHash).toBeUndefined();
    });

    test('does not rewrite legacy artifact metadata when normalization is disabled', () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const sourceBytes = new TextEncoder().encode('{"glossary":["definition"]}');
        const entry = createEntry();
        entry.termEntryContentBytes = sourceBytes;
        entry.termEntryContentHash = '0123456789abcdef';

        Reflect.get(importer, '_normalizeArtifactTermEntryContent').call(importer, entry, 'baseline');

        expect(entry.termEntryContentBytes).toBe(sourceBytes);
        expect(entry.termEntryContentHash).toBe('0123456789abcdef');
        expect(entry.termEntryContentHash1).toBeUndefined();
        expect(entry.termEntryContentHash2).toBeUndefined();
    });
});
