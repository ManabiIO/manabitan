/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterAll, beforeAll, describe, expect, test, vi} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js';
import {hashTermEntryContentBytesPair} from '../ext/js/dictionary/term-entry-content-hash.js';
import {parseTermBankWithWasmChunks} from '../ext/js/dictionary/term-bank-wasm-parser.js';
import {DictionaryImporterMediaLoader} from './mocks/dictionary-importer-media-loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const termBankParserWasmPath = path.resolve(__dirname, '../ext/lib/term-bank-parser.wasm');
const maybeTest = existsSync(termBankParserWasmPath) ? test : test.skip;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const nativeFetch = globalThis.fetch;

/**
 * @param {Array<unknown>} rows
 * @param {Parameters<typeof parseTermBankWithWasmChunks>[4]} [options]
 * @returns {Promise<Array<{
 *   expression: string,
 *   reading: string,
 *   glossaryMayContainMedia?: boolean,
 *   termEntryContentHash1?: number,
 *   termEntryContentHash2?: number,
 *   termEntryContentBytes: Uint8Array
 * }>>}
 */
async function parseRows(rows, options = {}) {
    /** @type {Array<{
     *   expression: string,
     *   reading: string,
     *   glossaryMayContainMedia?: boolean,
     *   termEntryContentHash1?: number,
     *   termEntryContentHash2?: number,
     *   termEntryContentBytes: Uint8Array
     * }>} */
    const parsedRows = [];
    await parseTermBankWithWasmChunks(
        textEncoder.encode(JSON.stringify(rows)),
        3,
        (chunk) => { parsedRows.push(...chunk); },
        2,
        {copyContentBytes: true, mediaHintFastScan: true, ...options},
    );
    return parsedRows;
}

/**
 * @param {{termEntryContentBytes: Uint8Array}} row
 * @returns {string}
 */
function getContentString(row) {
    return textDecoder.decode(row.termEntryContentBytes);
}

describe('term-bank WASM parser', () => {
    beforeAll(() => {
        vi.stubGlobal('fetch', async (resource) => {
            const url = resource instanceof URL ? resource : new URL(String(resource));
            if (url.protocol === 'file:') {
                return new Response(await readFile(fileURLToPath(url)));
            }
            return await nativeFetch(resource);
        });
    });

    afterAll(() => {
        vi.unstubAllGlobals();
    });

    maybeTest('keeps text-object glossary dedup equivalent to plain text glossary', async () => {
        const rows = await parseRows([
            ['plain', 'plain', '', '', 0, ['shared text'], 1, ''],
            ['object', 'object', '', '', 0, [{type: 'text', text: 'shared text'}], 2, ''],
        ]);

        expect(rows).toHaveLength(2);
        expect(getContentString(rows[0])).toBe('{"rules":"","definitionTags":"","termTags":"","glossary":["shared text"]}');
        expect(getContentString(rows[1])).toBe(getContentString(rows[0]));
        expect(rows[1].termEntryContentHash1).toBe(rows[0].termEntryContentHash1);
        expect(rows[1].termEntryContentHash2).toBe(rows[0].termEntryContentHash2);
    });

    maybeTest('uses the same dedup hash pair as every JavaScript fallback path', async () => {
        const [row] = await parseRows([
            ['hash', 'hash', 'tag', 'rule', 7, ['hash definition'], 1, 'term-tag'],
        ]);
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const database = new DictionaryDatabase();
        const hashEntryContentBytesPair = /** @type {(this: DictionaryImporter, bytes: Uint8Array) => [number, number]} */ (
            Reflect.get(importer, '_hashEntryContentBytesPair')
        );
        const hashEntryContent = /** @type {(this: DictionaryDatabase, contentJson: string) => string} */ (
            Reflect.get(database, '_hashEntryContent')
        );
        const contentString = getContentString(row);
        const expectedHashPair = [
            row.termEntryContentHash1,
            row.termEntryContentHash2,
        ];

        expect(hashTermEntryContentBytesPair(row.termEntryContentBytes)).toEqual(expectedHashPair);
        expect(hashEntryContentBytesPair.call(importer, row.termEntryContentBytes)).toEqual(expectedHashPair);
        expect(hashEntryContent.call(database, contentString)).toBe(
            `${(row.termEntryContentHash1 ?? 0).toString(16).padStart(8, '0')}` +
            `${(row.termEntryContentHash2 ?? 0).toString(16).padStart(8, '0')}`,
        );
    });

    maybeTest('does not collapse structured-content objects into text glossary content', async () => {
        const structuredGlossary = {
            type: 'structured-content',
            content: [{tag: 'span', content: 'structured definition'}],
        };
        const [row] = await parseRows([
            ['structured', 'structured', '', '', 0, [structuredGlossary], 1, ''],
        ]);

        const content = getContentString(row);
        expect(content).toContain('"type":"structured-content"');
        expect(content).toContain('"structured definition"');
        expect(content).not.toBe('{"rules":"","definitionTags":"","termTags":"","glossary":["structured definition"]}');
    });

    maybeTest('reports exact image media markers without matching ordinary words', async () => {
        const rows = await parseRows([
            ['image-row', 'image-row', '', '', 0, [{type: 'image', path: 'image-row.png'}], 1, ''],
            ['word-row', 'word-row', '', '', 0, ['imagination and imagery'], 2, ''],
        ]);

        expect(rows[0].glossaryMayContainMedia).toBe(true);
        expect(rows[1].glossaryMayContainMedia).toBe(false);
    });

    maybeTest('does not dispatch partial chunks when parsing malformed term-bank JSON', async () => {
        let chunkCount = 0;
        await expect(parseTermBankWithWasmChunks(
            textEncoder.encode('[["ok","ok","","",0,["ok"],1,""],not-json]'),
            3,
            () => { ++chunkCount; },
            1,
            {copyContentBytes: true},
        )).rejects.toThrow(/term-bank parser failed/);
        expect(chunkCount).toBe(0);
    });
});
