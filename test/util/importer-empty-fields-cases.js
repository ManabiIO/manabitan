/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

const sourcePath = process.env.MANABITAN_IMPORTER_SOURCE ?? new URL('../../ext/js/dictionary/dictionary-importer.js', import.meta.url)
const source = await readFile(sourcePath, 'utf8')
function extract(name) {
    const match = source.match(new RegExp(`^    ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^    \\}`, 'm'))
    assert(match, `Missing production method ${name}`)
    assert.equal(source.match(new RegExp(`^    ${name}\\(`, 'gm'))?.length, 1)
    return match[0]
}
const quote = extract('_quoteJsonStringCached')
const compose = extract('_createTermEntryContentJson')
function createImporter(capacity = 8192) {
    const Constructor = Function('JSON_QUOTED_STRING_CACHE_MAX_ENTRIES', `return class {
        constructor() { this._jsonQuotedStringCache = new Map() }
        ${quote}
        ${compose}
    }`)(capacity)
    return new Constructor()
}

test('three empty fields serialize without touching the cache', () => {
    const importer = createImporter()
    importer._jsonQuotedStringCache = new Proxy({}, {get() { throw new Error('Empty string touched the cache') }})
    assert.equal(importer._createTermEntryContentJson('', '', '', '[]'), '{"rules":"","definitionTags":"","termTags":"","glossary":[]}')
})

test('three empty fields do not occupy or evict bounded cache entries', () => {
    const importer = createImporter(2)
    importer._quoteJsonStringCached('n')
    importer._quoteJsonStringCached('v1')
    for (let i = 0; i < 100; ++i) { importer._createTermEntryContentJson('', '', '', '["日本語"]') }
    assert.deepEqual([...importer._jsonQuotedStringCache.keys()], ['n', 'v1'])
})

test('nonempty tags preserve JSON escaping and Unicode exactly', () => {
    const importer = createImporter()
    for (const value of ['n', '"', '\\', '\0', '\n', '\r\t', '\ufeff猫', '𠮷', '\ud800', '\udfff', '\u2028\u2029', '']) {
        assert.equal(importer._quoteJsonStringCached(value), JSON.stringify(value))
        assert.equal(importer._quoteJsonStringCached(value), JSON.stringify(value))
    }
})

test('nonempty hits retain LRU promotion and eviction order', () => {
    const importer = createImporter(2)
    importer._createTermEntryContentJson('a', 'b', 'a', '[]')
    importer._createTermEntryContentJson('', '', '', '[]')
    importer._createTermEntryContentJson('c', 'a', 'c', '[]')
    assert.deepEqual([...importer._jsonQuotedStringCache.keys()], ['a', 'c'])
})

test('cache stays bounded across many distinct tags and interleaved empty fields', () => {
    const importer = createImporter()
    for (let i = 0; i < 9000; ++i) {
        assert.equal(importer._quoteJsonStringCached(`tag-${i}`), JSON.stringify(`tag-${i}`))
        importer._createTermEntryContentJson('', '', '', '[]')
    }
    assert.equal(importer._jsonQuotedStringCache.size, 8192)
    assert(!importer._jsonQuotedStringCache.has(''))
    assert.equal(importer._jsonQuotedStringCache.keys().next().value, 'tag-808')
})

test('importer instances have independent nonempty caches', () => {
    const a = createImporter()
    const b = createImporter()
    a._quoteJsonStringCached('n')
    b._createTermEntryContentJson('', '', '', '[]')
    assert.equal(a._jsonQuotedStringCache.size, 1)
    assert.equal(b._jsonQuotedStringCache.size, 0)
})

test('term content JSON and UTF-8 bytes equal canonical serialization', () => {
    const importer = createImporter()
    const encoder = new TextEncoder()
    const fields = ['', 'n', 'v1', '\ufeff語', 'a"b', 'c\\d', '\0', '𠮷', '\ud800']
    for (const rules of fields) {
        for (const definitionTags of fields) {
            for (const termTags of fields) {
                const glossary = ['日本語', {type: 'text', text: 'quote " and backslash \\'}]
                const actual = importer._createTermEntryContentJson(rules, definitionTags, termTags, JSON.stringify(glossary))
                const expected = JSON.stringify({rules, definitionTags, termTags, glossary})
                assert.equal(actual, expected)
                assert.deepEqual(encoder.encode(actual), encoder.encode(expected))
            }
        }
    }
})

test('seeded varied strings retain byte-for-byte quoting parity', () => {
    const importer = createImporter(16)
    let seed = 0x48617368
    for (let i = 0; i < 5000; ++i) {
        let value = ''
        for (let j = 0; j < i % 17; ++j) {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
            value += String.fromCharCode(seed & 0xffff)
        }
        assert.equal(importer._quoteJsonStringCached(value), JSON.stringify(value))
    }
})

test('mixed empty and nonempty fields retain the fallback quote calls', () => {
    for (let mask = 0; mask < 8; ++mask) {
        const importer = createImporter()
        const calls = []
        const original = importer._quoteJsonStringCached.bind(importer)
        importer._quoteJsonStringCached = (value) => { calls.push(value); return original(value) }
        const fields = [mask & 1 ? 'n' : '', mask & 2 ? 'common' : '', mask & 4 ? 'tag' : '']
        const actual = importer._createTermEntryContentJson(...fields, '["glossary"]')
        const [rules, definitionTags, termTags] = fields
        assert.equal(actual, JSON.stringify({rules, definitionTags, termTags, glossary: ['glossary']}))
        assert.deepEqual(calls, mask === 0 ? [] : fields)
    }
})
