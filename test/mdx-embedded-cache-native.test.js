/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'
import {afterEach, test, vi} from 'vitest'
import {createMdxImportData} from '../ext/js/dictionary/mdx/mdx-converter.js'
import {makeMdictFixture} from './util/mdict-binary-fixture.js'

const decoder = new TextDecoder()
afterEach(() => { vi.restoreAllMocks() })

/**
 * @param {string} url
 * @returns {string}
 */
function link(url) { return `<a href="${url}">asset</a>` }

/**
 * @param {string[]} definitions
 * @returns {Promise<Awaited<ReturnType<typeof createMdxImportData>>>}
 */
async function convert(definitions) {
    const fixture = makeMdictFixture(definitions.map((value, index) => ({key: `term-${String(index).padStart(4, '0')}`, value})), {
        compression: 'zlib', keysPerBlock: 16, recordBlockSize: 65536,
    })
    const before = Uint8Array.from(fixture.bytes)
    const result = await createMdxImportData('cache-native.mdx', {}, fixture.bytes, [])
    assert.deepEqual(fixture.bytes, before)
    return result
}

/**
 * @param {Awaited<ReturnType<typeof createMdxImportData>>} result
 * @returns {{assets: Array<[string, Uint8Array]>, rows: unknown[][], references: string[], details: Record<string, string|number|boolean|null>}}
 */
function inspect(result) {
    const assets = [...result.files].filter(([path]) => path.startsWith('mdict-media/embedded/'))
    const bankBytes = result.files.get('term_bank_1.json')
    assert.ok(bankBytes)
    const rows = /** @type {unknown[][]} */ (JSON.parse(decoder.decode(bankBytes)))
    /** @type {string[]} */
    const references = []
    /** @param {unknown} value */
    const visit = (value) => {
        if (typeof value !== 'object' || value === null) { return }
        const href = Reflect.get(value, 'href')
        const path = typeof href === 'string' && href.startsWith('media:') ? href.slice(6) : Reflect.get(value, 'path')
        if (typeof path === 'string' && path.startsWith('mdict-media/embedded/')) { references.push(path) }
        for (const child of Object.values(value)) { visit(child) }
    }
    for (const row of rows) { visit(row[5]) }
    for (const path of references) { assert.ok(result.files.has(path), `dangling embedded reference: ${path}`) }
    const details = result.phaseTimings.find(({phase}) => phase === 'prepare-mdx:convert-entries')?.details
    assert.ok(details)
    return {assets, rows, references, details}
}

for (const sameDefinition of [false, true]) {
    test(`real MDX shares repeated URL with sameDefinition=${sameDefinition}`, async () => {
        const value = link('data:text/plain,shared')
        const result = inspect(await convert(sameDefinition ? [value + value] : [value, value]))
        assert.equal(result.assets.length, 1)
        assert.equal(result.references.length, 2)
        assert.equal(result.references[0], result.references[1])
        assert.equal(decoder.decode(result.assets[0][1]), 'shared')
    })
}

test('entry budget spans definitions and retains valid uncached assets', async () => {
    const definitions = Array.from({length: 65}, (_, i) => link(`data:text/plain,unique-${i}`))
    definitions.push(link('data:text/plain,unique-64'), link('data:text/plain,unique-0'))
    const result = inspect(await convert(definitions))
    assert.equal(result.rows.length, 67)
    assert.equal(result.assets.length, 66)
    assert.equal(result.details.embeddedAssetDataUrlCacheEntries, 64)
    assert.notEqual(result.references[64], result.references[65])
    assert.equal(result.references[0], result.references[66])
})

for (const extra of [0, 1]) {
    test(`logical key-byte limit plus ${extra} is enforced exactly`, async () => {
        const prefix = 'data:text/plain,'
        const url = prefix + 'x'.repeat(131072 - prefix.length + extra)
        const result = inspect(await convert([link(url), link(url)]))
        assert.equal(result.assets.length, extra === 0 ? 1 : 2)
        assert.equal(result.details.embeddedAssetDataUrlCacheEntries, extra === 0 ? 1 : 0)
        assert.equal(result.details.embeddedAssetDataUrlRetainedKeyBytes, extra === 0 ? 262144 : 0)
        for (const [, bytes] of result.assets) { assert.equal(decoder.decode(bytes), url.slice(prefix.length)) }
    })
}

test('same sampled probe never conflates byte-distinct URLs', async () => {
    const prefix = 'data:text/plain,'
    const payload = 'a'.repeat(120)
    const other = `${payload.slice(0, 17)}b${payload.slice(18)}`
    const result = inspect(await convert([link(prefix + payload), link(prefix + other), link(prefix + payload)]))
    assert.equal(result.assets.length, 2)
    assert.equal(decoder.decode(result.assets[0][1]), payload)
    assert.equal(decoder.decode(result.assets[1][1]), other)
    assert.equal(result.references[0], result.references[2])
    assert.notEqual(result.references[0], result.references[1])
})

test('different URL spellings remain distinct even with equal decoded bytes', async () => {
    const result = inspect(await convert([link('data:text/plain,A'), link('data:text/plain,%41')]))
    assert.equal(result.assets.length, 2)
    assert.deepEqual(result.assets[0][1], result.assets[1][1])
    assert.notEqual(result.references[0], result.references[1])
})

test('failed definition cannot publish a cached path without asset bytes', async () => {
    const set = Map.prototype.set
    let injected = false
    /**
     * @this {Map<unknown, unknown>}
     * @param {unknown} key
     * @param {unknown} value
     * @returns {Map<unknown, unknown>}
     */
    function setWithFailure(key, value) {
        if (!injected && key === 'mdict-media/embedded/text/000002.bin') {
            injected = true
            throw new Error('injected asset registration failure after one local cache admission')
        }
        return set.call(this, key, value)
    }
    vi.spyOn(Map.prototype, 'set').mockImplementation(setWithFailure)
    const shared = link('data:text/plain,shared')
    const result = inspect(await convert([shared + link('data:text/plain,fail'), shared]))
    assert.equal(injected, true)
    assert.equal(result.rows.length, 1)
    assert.equal(result.details.skippedEntryErrorCount, 1)
    assert.equal(result.assets.length, 1)
    assert.equal(result.references[0], 'mdict-media/embedded/text/000003.bin')
    assert.equal(decoder.decode(result.assets[0][1]), 'shared')
    assert.equal(result.details.embeddedAssetDataUrlCacheEntries, 1)
})

test('cache lifetime is limited to one conversion', async () => {
    const first = inspect(await convert([link('data:text/plain,A')]))
    const second = inspect(await convert([link('data:text/plain,B')]))
    assert.equal(first.references[0], second.references[0])
    assert.equal(decoder.decode(first.assets[0][1]), 'A')
    assert.equal(decoder.decode(second.assets[0][1]), 'B')
    assert.equal(first.details.embeddedAssetDataUrlCacheEntries, 1)
    assert.equal(second.details.embeddedAssetDataUrlCacheEntries, 1)
})

test('definitions without data URLs leave cache empty', async () => {
    const result = inspect(await convert(['<div>first</div>', '<p>second</p>']))
    assert.equal(result.rows.length, 2)
    assert.equal(result.assets.length, 0)
    assert.equal(result.references.length, 0)
    assert.equal(result.details.embeddedAssetDataUrlCacheEntries, 0)
    assert.equal(result.details.embeddedAssetDataUrlRetainedKeyBytes, 0)
})
