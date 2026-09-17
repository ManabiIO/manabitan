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
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {beforeAll, describe, expect, test} from 'vitest'
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js'
import {DictionaryImporterMediaLoader} from './mocks/dictionary-importer-media-loader.js'
import {setTermBankWasmModule} from '../ext/js/dictionary/term-bank-wasm-parser.js'

beforeAll(async () => {
    setTermBankWasmModule(await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))))
})

describe('media headwords with omitted native byte columns', () => {
    test.each([
        ['画像', 'がぞう'],
        ['same', 'same'],
        ['猫', ''],
        ['', 'reading'],
        ['quoted"head', 'escaped\\reading'],
        ['日本😀', 'にほん'],
    ])('retains expression %s and reading %s in image requirements', async (expression, reading) => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader())
        Reflect.set(importer, '_skipImageMetadata', true)
        /** @type {import('dictionary-importer').ImportRequirement[]} */
        const observed = []
        let chunks = 0
        const bytes = new TextEncoder().encode(JSON.stringify([[expression, reading, '', '', 0, [{type: 'image', path: 'image.png'}], 0, '']]))
        const entry = /** @type {import('@zip.js/zip.js').Entry} */ (/** @type {unknown} */ ({filename: 'term_bank_1.json'}))
        await importer._readTermBankFileFast(entry, 3, 'media-fixture', false, true, true, 'raw-bytes', (terms, requirements) => {
            const columns = /** @type {{rowCount: number, expressionBytesList: Uint8Array[], readingBytesList: Uint8Array[]}} */ (/** @type {unknown} */ (terms))
            expect(columns.rowCount).toBe(1)
            expect(columns.expressionBytesList).toHaveLength(0)
            expect(columns.readingBytesList).toHaveLength(0)
            expect(requirements).not.toBeNull()
            observed.push(...(requirements ?? []))
            ++chunks
        }, bytes)
        expect(chunks).toBe(1)
        expect(observed).toHaveLength(1)
        expect(observed[0].entry).toMatchObject({expression, reading: reading || expression, dictionary: 'media-fixture'})
    })
})
