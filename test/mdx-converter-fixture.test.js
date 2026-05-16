/*
 * Copyright (C) 2026  Yomitan Authors
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

import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {inflateSync} from 'node:zlib';
import JSZip from 'jszip';
import {describe, expect, test} from 'vitest';

Reflect.set(globalThis, 'pako', {
    /**
     * @param {Uint8Array} bytes
     * @returns {Uint8Array}
     */
    inflate(bytes) {
        return new Uint8Array(inflateSync(bytes));
    },
});

const {convertMdxToArchive} = await import('../ext/js/dictionary/mdx/mdx-converter.js');

const testDir = path.dirname(fileURLToPath(import.meta.url));
const dictionaryDir = path.join(testDir, 'data', 'dictionaries');

/**
 * @param {ArrayBuffer} archiveContent
 * @returns {Promise<JSZip>}
 */
async function loadArchive(archiveContent) {
    return JSZip.loadAsync(Buffer.from(archiveContent));
}

/**
 * @param {JSZip} zip
 * @param {string} pathName
 * @returns {Promise<unknown>}
 */
async function readJson(zip, pathName) {
    const file = zip.file(pathName);
    if (file === null) {
        throw new Error(`Expected archive file ${pathName}`);
    }
    return JSON.parse(await file.async('text'));
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function stringifyGlossary(value) {
    return JSON.stringify(value);
}

describe('convertMdxToArchive real fixtures', () => {
    test.each([
        {
            fileName: 'playwright-read.mdx',
            title: 'Manabitan Manual MDX Read Dictionary',
            description: 'A tiny hand-built MDX dictionary for manually testing Read lookups in Manabitan. Includes entries for Read, read, and 読め.',
            terms: ['read', 'Read', '読め'],
            glossaryText: 'To look at and understand written language.',
        },
        {
            fileName: 'playwright-yome.mdx',
            title: 'Manabitan Manual MDX Yome Dictionary',
            description: 'A tiny hand-built MDX dictionary for manually testing 読め lookups in Manabitan. Includes entries for Read, read, and 読め.',
            terms: ['read', 'Read', '読め'],
            glossaryText: 'Imperative or potential-related form used here for MDX import testing.',
        },
    ])('converts $fileName into a complete Yomitan archive', async ({fileName, title, description, terms, glossaryText}) => {
        const bytes = readFileSync(path.join(dictionaryDir, fileName));
        const result = await convertMdxToArchive(fileName, {enableAudio: false}, bytes, []);
        const zip = await loadArchive(result.archiveContent);
        const index = /** @type {{title: string, description: string, revision: string, format: number}} */ (await readJson(zip, 'index.json'));
        const termBank = /** @type {Array<[string, string, string, string, number, Array<unknown>, number, string]>} */ (await readJson(zip, 'term_bank_1.json'));

        expect(result.archiveFileName).toBe(`${title}.zip`);
        expect(index).toMatchObject({
            title,
            description,
            revision: 'mdx import',
            format: 3,
        });
        expect(termBank.map(([expression]) => expression)).toStrictEqual(terms);
        expect(stringifyGlossary(termBank)).toContain(glossaryText);
    });
});
