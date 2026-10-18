/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */
import assert from 'node:assert/strict'
import {afterEach, expect, test, vi} from 'vitest'
import {createMdxImportData} from '../ext/js/dictionary/mdx/mdx-converter.js'
import {MDX} from '../ext/js/dictionary/mdx/vendor/js-mdict/mdx.js'
import {makeMdictFixture} from './util/mdict-binary-fixture.js'

const decoder = new TextDecoder()
afterEach(() => { vi.restoreAllMocks() })

/**
 * @param {number} count
 * @param {'raw'|'zlib'} compression
 * @returns {ReturnType<typeof makeMdictFixture>}
 */
function fixture(count, compression) {
    return makeMdictFixture(Array.from({length: count}, (_, i) => ({
        key: `term-${String(i).padStart(5, '0')}`,
        value: `<div>definition ${i} 日本語</div>`,
    })), {compression, keysPerBlock: 32, recordBlockSize: 65536})
}

/**
 * @param {Array<{stage: string, completed: number, total: number}>} progress
 * @param {number} total
 */
function verifyProgress(progress, total) {
    expect(progress[0]).toEqual({stage: 'convert', completed: 0, total})
    expect(progress.at(-1)).toEqual({stage: 'convert', completed: total, total})
    for (let i = 1; i < progress.length; ++i) {
        expect(progress[i].completed).toBeGreaterThan(progress[i - 1].completed)
        expect(progress[i].completed).toBeLessThanOrEqual(total)
        expect(progress[i].total).toBe(total)
    }
}

for (const compression of /** @type {const} */ (['raw', 'zlib'])) {
    for (const count of [0, 1, 2, 99, 100, 101, 1001]) {
        test(`real ${compression} MDX ${count} rows preserves output and exact progress endpoints`, async () => {
            vi.spyOn(Date, 'now').mockReturnValue(1000)
            const {bytes} = fixture(count, compression)
            const before = Uint8Array.from(bytes)
            /** @type {Array<{stage: string, completed: number, total: number}>} */
            const progress = []
            const expected = await createMdxImportData('progress.mdx', {}, bytes, [])
            const actual = await createMdxImportData('progress.mdx', {}, bytes, [], (event) => progress.push(event))
            expect(actual.files).toEqual(expected.files)
            expect(bytes).toEqual(before)
            const total = Math.max(1, count)
            verifyProgress(progress, total)
            expect(progress.length).toBeLessThanOrEqual(Math.ceil(total / Math.max(1, Math.ceil(total / 100))) + 1)
            const bank = actual.files.get('term_bank_1.json')
            expect(bank ? JSON.parse(decoder.decode(bank)).length : 0).toBe(count)
        })
    }
}

test('time threshold reports a slow conversion before the next count interval', async () => {
    let now = 1000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const fetch = MDX.prototype.fetch_definition
    vi.spyOn(MDX.prototype, 'fetch_definition').mockImplementation(/**
                                                                    * @this {MDX}
                                                                    * @param {unknown} item
                                                                    * @returns {ReturnType<MDX['fetch_definition']>}
                                                                    */ function timedFetch(item) {
            now += 30
            return fetch.call(this, item)
        },
    )
    /** @type {Array<{stage: string, completed: number, total: number}>} */
    const progress = []
    await createMdxImportData('slow.mdx', {}, fixture(1001, 'zlib').bytes, [], (event) => progress.push(event))
    verifyProgress(progress, 1001)
    expect(progress[1].completed).toBe(2)
    expect(progress.length).toBe(502)
})

test('clock rollback cannot suppress count-based progress or the endpoint', async () => {
    let now = 1000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const fetch = MDX.prototype.fetch_definition
    vi.spyOn(MDX.prototype, 'fetch_definition').mockImplementation(/**
                                                                    * @this {MDX}
                                                                    * @param {unknown} item
                                                                    * @returns {ReturnType<MDX['fetch_definition']>}
                                                                    */ function timedFetch(item) {
            now -= 100
            return fetch.call(this, item)
        },
    )
    /** @type {Array<{stage: string, completed: number, total: number}>} */
    const progress = []
    await createMdxImportData('rollback.mdx', {}, fixture(1001, 'raw').bytes, [], (event) => progress.push(event))
    verifyProgress(progress, 1001)
    expect(progress[1].completed).toBe(11)
})

test('skipped corrupt records advance progress and do not suppress valid records', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000)
    const fetch = MDX.prototype.fetch_definition
    vi.spyOn(MDX.prototype, 'fetch_definition').mockImplementation(/**
                                                                    * @this {MDX}
                                                                    * @param {{keyText: string}} item
                                                                    * @returns {ReturnType<MDX['fetch_definition']>}
                                                                    */ function failingFetch(item) {
            if (item.keyText === 'term-00050') { throw new Error('injected record failure') }
            return fetch.call(this, item)
        },
    )
    /** @type {Array<{stage: string, completed: number, total: number}>} */
    const progress = []
    const result = await createMdxImportData('skip.mdx', {}, fixture(1001, 'zlib').bytes, [], (event) => progress.push(event))
    verifyProgress(progress, 1001)
    expect(progress.length).toBeLessThanOrEqual(101)
    const bank = result.files.get('term_bank_1.json')
    assert.ok(bank)
    const rows = /** @type {unknown[][]} */ (JSON.parse(decoder.decode(bank)))
    expect(rows.length).toBe(1000)
    expect(rows.some(([key]) => key === 'term-00050')).toBe(false)
    expect(rows.some(([key]) => key === 'term-01000')).toBe(true)
})

test('real redirect entries retain aliases under coalesced progress', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000)
    const entries = Array.from({length: 1000}, (_, i) => ({key: `alias-${i}`, value: '@@@LINK=target'}))
    entries.push({key: 'target', value: '<div>target definition</div>'})
    const bytes = makeMdictFixture(entries, {compression: 'zlib'}).bytes
    /** @type {Array<{stage: string, completed: number, total: number}>} */
    const progress = []
    const result = await createMdxImportData('aliases.mdx', {}, bytes, [], (event) => progress.push(event))
    verifyProgress(progress, entries.length)
    expect(progress.length).toBeLessThanOrEqual(101)
    const bank = result.files.get('term_bank_1.json')
    assert.ok(bank)
    const rows = /** @type {unknown[][]} */ (JSON.parse(decoder.decode(bank)))
    expect(new Set(rows.map(([key]) => key))).toEqual(new Set(entries.map(({key}) => key)))
})
