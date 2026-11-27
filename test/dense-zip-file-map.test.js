/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {describe, expect, test} from 'vitest'
import {DenseZipFileMap} from '../ext/js/dictionary/dense-zip-file-map.js'

const filenames = ['first.png', 'second.png', 'third.png']
const encoder = new TextEncoder()

/** @returns {DenseZipFileMap} */
function fixture() {
    /**
     * @this {import('../ext/js/dictionary/dense-zip-directory.js').DenseZipEntry}
     * @returns {Promise<string>}
     */
    const getData = async function getFixtureEntryData() { return this.filename }
    const map = new DenseZipFileMap(filenames.length, encoder.encode(filenames.join('')), getData)
    let position = 0
    for (let i = 0; i < filenames.length; ++i) {
        map.addDirectoryMetadata(i, position, i * 100, i + 10, i + 100, i === 0 ? 0 : 8, 0xffffffff - i)
        position += filenames[i].length
    }
    expect(map.finishDirectory()).toBeNull()
    return map
}

/**
 * @param {string} filename
 * @returns {import('dictionary-importer').ImportFileEntry}
 */
function owned(filename) { return {filename, bytes: new Uint8Array([1, 2, 3])} }

/**
 * @param {DenseZipFileMap} map
 * @returns {number}
 */
function materializedCount(map) {
    const entries = /** @type {Map<string, unknown>} */ (Reflect.get(map, '_entries'))
    return [...entries.values()].filter((entry) => typeof entry !== 'number').length
}

describe('compact dense ZIP file map', () => {
    test('reads names without materializing entries and caches one requested entry', async () => {
        const map = fixture()
        expect(map.size).toBe(3)
        expect([...map.keys()]).toEqual(filenames)
        expect(map.has('first.png')).toBe(true)
        expect(map.get('missing.png')).toBeUndefined()
        expect(materializedCount(map)).toBe(0)
        const entry = map.get('second.png')
        expect(entry).toMatchObject({
            filename: 'second.png',
            offset: 100,
            compressedSize: 11,
            uncompressedSize: 101,
            compressionMethod: 8,
            signature: 0xfffffffe,
            encrypted: false,
            directory: false,
            rawFilename: encoder.encode('second.png'),
        })
        expect(map.get('second.png')).toBe(entry)
        expect(materializedCount(map)).toBe(1)
        const getData = /** @type {() => Promise<unknown>} */ (Reflect.get(/** @type {object} */ (entry), 'getData'))
        expect(await getData.call(entry)).toBe('second.png')
    })

    test('keeps materialized metadata and path views independent', () => {
        const map = fixture()
        const first = map.get('first.png')
        const second = map.get('second.png')
        if (typeof first === 'undefined' || typeof second === 'undefined') { throw new Error('Missing entries') }
        const firstBytes = /** @type {Uint8Array} */ (Reflect.get(first, 'rawFilename'))
        const secondBytes = /** @type {Uint8Array} */ (Reflect.get(second, 'rawFilename'))
        expect(firstBytes.buffer).toBe(secondBytes.buffer)
        expect(firstBytes.buffer.byteLength).toBe(filenames.join('').length)
        firstBytes[0] = 0x78
        expect(secondBytes).toEqual(encoder.encode('second.png'))
        first.filename = 'changed.png'
        expect(map.get('first.png')?.filename).toBe('changed.png')
        expect(map.has('changed.png')).toBe(false)
    })

    test('recognizes only untouched directory slots without materializing their metadata', () => {
        const map = fixture()
        expect(map.hasUnmaterializedEntry('first.png')).toBe(true)
        expect(map.hasUnmaterializedEntry('missing.png')).toBe(false)
        expect(materializedCount(map)).toBe(0)
        const first = map.get('first.png')
        expect(map.hasUnmaterializedEntry('first.png')).toBe(false)
        expect(first).toMatchObject({filename: 'first.png', compressedSize: 10})
        map.set('second.png', owned('second.png'))
        expect(map.hasUnmaterializedEntry('second.png')).toBe(false)
        map.delete('third.png')
        expect(map.hasUnmaterializedEntry('third.png')).toBe(false)
        map.clear()
        expect(map.hasUnmaterializedEntry('first.png')).toBe(false)
        expect(Reflect.get(map, '_metadata')).toHaveLength(0)
    })

    test('preserves set, delete and reinsert order without decoding replaced entries', () => {
        const map = fixture()
        const replacement = owned('replacement.png')
        expect(map.set('second.png', replacement)).toBe(map)
        expect(map.get('second.png')).toBe(replacement)
        expect(map.delete('first.png')).toBe(true)
        expect(map.delete('missing.png')).toBe(false)
        map.set('first.png', owned('first.png'))
        expect([...map.keys()]).toEqual(['second.png', 'third.png', 'first.png'])
        expect([...map.values()].map(({filename}) => filename)).toEqual(['replacement.png', 'third.png', 'first.png'])
        expect(map.size).toBe(3)
    })

    test('keeps entry iterators live across deletion, insertion and clear', () => {
        const map = fixture()
        const iterator = map.entries()
        expect(iterator.next().value?.[0]).toBe('first.png')
        map.delete('second.png')
        const extra = owned('fourth.png')
        map.set('fourth.png', extra)
        expect(iterator.next().value?.[0]).toBe('third.png')
        expect(iterator.next().value).toEqual(['fourth.png', extra])
        map.clear()
        const afterClear = owned('last.png')
        map.set('last.png', afterClear)
        expect(iterator.next().value).toEqual(['last.png', afterClear])
        expect(iterator.next().done).toBe(true)
        map.set('after-end.png', owned('after-end.png'))
        expect(iterator.next().done).toBe(true)
        expect([...map]).toEqual([['last.png', afterClear], ['after-end.png', map.get('after-end.png')]])
    })

    test('passes callback context and observes forEach mutations in Map order', () => {
        const map = fixture()
        const context = {tag: 7}
        /** @type {string[]} */
        const visited = []
        // Exercise the catalog's Map-compatible forEach callback and thisArg.
        // eslint-disable-next-line unicorn/no-array-for-each
        map.forEach(function visitEntry(value, key, current) {
            expect(this).toBe(context)
            expect(current).toBe(map)
            expect(current.get(key)).toBe(value)
            visited.push(key)
            if (key === 'first.png') {
                current.delete('second.png')
                current.set('fourth.png', owned('fourth.png'))
            }
        // eslint-disable-next-line unicorn/no-array-method-this-argument
        }, context)
        expect(visited).toEqual(['first.png', 'third.png', 'fourth.png'])
    })

    test('clear releases the compact arrays and archive reader while preserving obtained entries', async () => {
        const map = fixture()
        const entry = map.get('first.png')
        const keys = map.keys()
        map.clear()
        expect(map.size).toBe(0)
        expect([...keys]).toEqual([])
        expect(map.get('first.png')).toBeUndefined()
        expect(Reflect.get(map, '_metadata')).toHaveLength(0)
        expect(Reflect.get(map, '_filenames')).toHaveLength(0)
        expect(Reflect.get(map, '_getData')).toBeNull()
        const getData = /** @type {() => Promise<unknown>} */ (Reflect.get(/** @type {object} */ (entry), 'getData'))
        expect(await getData.call(entry)).toBe('first.png')
    })

    test('reports the first duplicate directory name', () => {
        const duplicateNames = ['first.png', 'first.png']
        const map = new DenseZipFileMap(duplicateNames.length, encoder.encode(duplicateNames.join('')), async () => null)
        map.addDirectoryMetadata(0, 0, 0, 10, 10, 0, 1)
        map.addDirectoryMetadata(1, duplicateNames[0].length, 99, 1, 1, 0, 0)
        expect(map.finishDirectory()).toBe('first.png')
    })

    test('releases compact metadata when fallback enumerates every entry', () => {
        const map = fixture()
        const values = [...map.values()]
        expect(values.map(({filename}) => filename)).toEqual(filenames)
        expect(Reflect.get(map, '_metadata')).toHaveLength(0)
        expect(Reflect.get(map, '_filenames')).toHaveLength(0)
        expect(Reflect.get(map, '_getData')).toBeNull()
        expect([...map.values()]).toEqual(values)
    })

    test('counts removed and replaced placeholders without dropping still-needed metadata', () => {
        const map = fixture()
        const replacement = owned('replacement.png')
        map.set('first.png', replacement)
        // Replacing an already materialized value must not consume another placeholder.
        // eslint-disable-next-line sonarjs/no-element-overwrite
        map.set('first.png', replacement)
        expect(map.delete('second.png')).toBe(true)
        expect(map.delete('second.png')).toBe(false)
        expect(Reflect.get(map, '_metadata')).toHaveLength(filenames.length * 6)
        expect(map.get('third.png')).toMatchObject({filename: 'third.png', offset: 200, signature: 0xfffffffd})
        expect(Reflect.get(map, '_metadata')).toHaveLength(0)
        expect([...map.keys()]).toEqual(['first.png', 'third.png'])
        expect(map.get('first.png')).toBe(replacement)
    })
})
