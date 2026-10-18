/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'
import {runInNewContext} from 'node:vm'
import {afterEach, test, vi} from 'vitest'
import {TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js'

const encoder = new TextEncoder()

afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
})

/**
 * @param {'ordinary'|'shared'|'foreign-shared'} kind
 * @returns {ArrayBuffer|SharedArrayBuffer}
 */
function makeBuffer(kind) {
    if (kind === 'ordinary') { return new ArrayBuffer(65536) }
    if (kind === 'foreign-shared') {
        return /** @type {SharedArrayBuffer} */ (runInNewContext('new WebAssembly.Memory({initial: 1, maximum: 2, shared: true}).buffer'))
    }
    return new WebAssembly.Memory({initial: 1, maximum: 2, shared: true}).buffer
}

/**
 * Node permits shared input; model Chromium's stricter contract without
 * replacing actual text decoding or the store's public append/lookup methods.
 * @param {TermRecordOpfsStore} store
 * @returns {ArrayBufferView[]}
 */
function observeDecoder(store) {
    const decoder = store._textDecoder
    const decode = decoder.decode.bind(decoder)
    /** @type {ArrayBufferView[]} */
    const inputs = []
    vi.spyOn(decoder, 'decode').mockImplementation((input, options) => {
        if (ArrayBuffer.isView(input)) {
            if (!(input.buffer instanceof ArrayBuffer)) { throw new TypeError('shared decoder input') }
            inputs.push(input)
        }
        return decode(input, options)
    })
    return inputs
}

/** @type {Array<'ordinary'|'shared'|'foreign-shared'>} */
const kinds = ['ordinary', 'shared', 'foreign-shared']
for (const kind of kinds) {
    for (const hidden of [false, true]) {
        for (const alias of [false, true]) {
            for (const existingIndex of [false, true]) {
                test(`${kind}, constructor ${hidden ? 'hidden' : 'visible'}, alias ${alias}, existing index ${existingIndex}`, async () => {
                    const store = new TermRecordOpfsStore()
                    const inputs = observeDecoder(store)
                    const buffer = makeBuffer(kind)
                    const backing = new Uint8Array(buffer)
                    backing.fill(0xa5)
                    const expression = '\ufeff語😀'
                    const reading = alias ? expression : '\ufeffご😀'
                    const expressionValue = encoder.encode(expression)
                    const readingValue = encoder.encode(reading)
                    const expressionBytes = new Uint8Array(buffer, 17, expressionValue.byteLength)
                    const readingBytes = new Uint8Array(buffer, 113, readingValue.byteLength)
                    expressionBytes.set(expressionValue)
                    readingBytes.set(readingValue)
                    const before = Uint8Array.from(backing)
                    if (hidden) { vi.stubGlobal('SharedArrayBuffer', void 0) }
                    if (existingIndex) { assert.deepEqual(store.findTermIds('shared-fields', expression, 'expression'), []) }
                    await store.appendBatchFromArtifactChunkResolvedContent({
                        dictionary: 'shared-fields',
                        rowCount: 1,
                        expressionBytesList: [expressionBytes],
                        readingBytesList: [readingBytes],
                        readingEqualsExpressionList: Uint8Array.of(alias ? 1 : 0),
                        scoreList: Float64Array.of(1.5),
                        sequenceList: Float64Array.of(4294967297),
                    }, [9], [12], 'raw')
                    assert.deepEqual(store.findTermIds('shared-fields', expression, 'expression'), [1])
                    if (!alias) { assert.deepEqual(store.findTermIds('shared-fields', reading, 'reading'), [1]) }
                    const record = store.getByIds([1]).get(1)
                    assert.ok(record)
                    assert.equal(record.expression, expression)
                    assert.equal(record.reading, reading)
                    assert.equal(record.score, 1.5)
                    assert.equal(record.sequence, 4294967297)
                    assert.equal(record.entryContentOffset, 9)
                    assert.equal(record.entryContentLength, 12)
                    assert.equal(record.entryContentDictName, 'raw')
                    assert.equal(inputs.length, alias ? 1 : 2)
                    for (const input of inputs) {
                        assert.ok(input.byteLength <= Math.max(expressionValue.byteLength, readingValue.byteLength))
                        if (kind === 'ordinary') {
                            assert.equal(input.buffer, buffer)
                        } else {
                            assert.notEqual(input.buffer, buffer)
                            assert.equal(input.buffer.byteLength, input.byteLength)
                        }
                    }
                    assert.deepEqual(backing, before)
                })
            }
        }
    }
}

for (const fatal of [false, true]) {
    test(`hidden shared string respects fatal=${fatal}`, () => {
        const store = new TermRecordOpfsStore()
        store._textDecoder = new TextDecoder('utf-8', {fatal, ignoreBOM: true})
        observeDecoder(store)
        const bytes = new Uint8Array(makeBuffer('shared'), 17, 2)
        bytes.set([0xc3, 0x28])
        vi.stubGlobal('SharedArrayBuffer', void 0)
        if (fatal) {
            assert.throws(() => store._decodeString(bytes, 0, bytes.byteLength), /encoded data|encoding/i)
        } else {
            assert.equal(store._decodeString(bytes, 0, bytes.byteLength), '\ufffd(')
        }
    })
}

test('empty hidden-shared fields do not invoke the decoder', () => {
    const store = new TermRecordOpfsStore()
    const inputs = observeDecoder(store)
    const bytes = new Uint8Array(makeBuffer('shared'), 17, 0)
    vi.stubGlobal('SharedArrayBuffer', void 0)
    assert.equal(store._decodeString(bytes, 0, 0), '')
    assert.equal(inputs.length, 0)
})
