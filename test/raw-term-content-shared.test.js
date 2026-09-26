/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'
import {afterEach, test, vi} from 'vitest'
import {
    decodeRawTermContentBinary,
    decodeRawTermContentSharedGlossaryHeader,
    decodeRawTermContentTokenBinary,
    encodeRawTermContentBinary,
    encodeRawTermContentSharedGlossaryBinary,
} from '../ext/js/dictionary/raw-term-content.js'

const encoder = new TextEncoder()
const glossaryJson = '["日本語", "definition"]'

/** @typedef {'raw'|'token'|'shared-header'} Format */
/** @type {Format[]} */
const formats = ['raw', 'token', 'shared-header']

/**
 * @param {Format} format
 * @param {string[]} fields
 * @returns {Uint8Array}
 */
function encode(format, fields) {
    if (format === 'token') {
        return encoder.encode(`MBR6${fields.map((field) => JSON.stringify(field) + '\0').join('')}${glossaryJson}`)
    }
    if (format === 'shared-header') {
        return encodeRawTermContentSharedGlossaryBinary(fields[0], fields[1], fields[2], 4321, 23, encoder)
    }
    return encodeRawTermContentBinary(fields[0], fields[1], fields[2], encoder.encode(glossaryJson), encoder)
}

/**
 * @param {Format} format
 * @param {Uint8Array} bytes
 * @param {TextDecoder} decoder
 * @returns {ReturnType<typeof decodeRawTermContentBinary>|ReturnType<typeof decodeRawTermContentSharedGlossaryHeader>}
 */
function decode(format, bytes, decoder) {
    switch (format) {
        case 'raw': return decodeRawTermContentBinary(bytes, decoder)
        case 'token': return decodeRawTermContentTokenBinary(bytes, decoder)
        case 'shared-header': return decodeRawTermContentSharedGlossaryHeader(bytes, decoder)
    }
}

/**
 * Node accepts shared views, whereas Chromium rejects them. Model that input
 * contract while retaining the actual decoder, encoding and error policy.
 * @param {boolean} ignoreBOM
 * @param {boolean} [fatal=false]
 * @returns {{decoder: TextDecoder, inputs: ArrayBufferView[]}}
 */
function strictDecoder(ignoreBOM, fatal = false) {
    const decoder = new TextDecoder('utf-8', {ignoreBOM, fatal})
    const original = decoder.decode.bind(decoder)
    /** @type {ArrayBufferView[]} */
    const inputs = []
    vi.spyOn(decoder, 'decode').mockImplementation((input, options) => {
        if (ArrayBuffer.isView(input)) {
            if (!(input.buffer instanceof ArrayBuffer)) { throw new TypeError('shared decoder input') }
            inputs.push(input)
        }
        return original(input, options)
    })
    return {decoder, inputs}
}

/**
 * Construct real shared Wasm memory, not a fake buffer. This also works when
 * a browser realm does not expose the SharedArrayBuffer global constructor.
 * @param {Uint8Array} bytes
 * @param {boolean} shared
 * @returns {Uint8Array}
 */
function sourceView(bytes, shared) {
    const buffer = shared ? new WebAssembly.Memory({initial: 1, maximum: 1, shared: true}).buffer : new ArrayBuffer(65536)
    const source = new Uint8Array(buffer, 13, bytes.byteLength)
    source.set(bytes)
    return source
}

afterEach(() => { vi.restoreAllMocks() })

for (const format of formats) {
    for (const shared of [false, true]) {
        for (const ignoreBOM of [false, true]) {
            for (const fields of [
                ['n', 'popular', 'tag'],
                ['助詞', '日本', '🙂'],
                ['\ufeffn', '\ufeff\ufeff人気', '\ufefftag'],
                ['n\\x', 'line\nbreak', '"quote"'],
                ['', '', ''],
            ]) {
                test(`${format} shared=${shared} ignoreBOM=${ignoreBOM} fields=${JSON.stringify(fields)}`, () => {
                    const ordinary = encode(format, fields)
                    const source = sourceView(ordinary, shared)
                    const {decoder, inputs} = strictDecoder(ignoreBOM)
                    const result = decode(format, source, decoder)
                    assert.ok(result)
                    assert.deepEqual([result.rules, result.definitionTags, result.termTags], fields)
                    if ('glossaryJson' in result) { assert.equal(result.glossaryJson, glossaryJson) }
                    if ('glossaryOffset' in result) {
                        assert.equal(result.glossaryOffset, 4321)
                        assert.equal(result.glossaryLength, 23)
                    }
                    assert.deepEqual(Uint8Array.from(source), ordinary)
                    assert.ok(inputs.length > 0)
                    for (const input of inputs) {
                        if (shared) {
                            assert.notEqual(input.buffer, source.buffer)
                            assert.equal(input.buffer.byteLength, input.byteLength, 'copy must be bounded to the decoded field')
                            assert.ok(input.byteLength < source.byteLength, 'never copy the whole encoded row')
                        } else {
                            assert.equal(input.buffer, source.buffer, 'ordinary input must remain zero-copy')
                        }
                    }
                })
            }
        }
        for (const fatal of [false, true]) {
            test(`${format} shared=${shared} retains fatal=${fatal} decoding policy`, () => {
                const ordinary = encode(format, ['n', '', ''])
                const position = format === 'raw' ? 20 : (format === 'shared-header' ? 28 : 5)
                ordinary[position] = 0xff
                const source = sourceView(ordinary, shared)
                const {decoder} = strictDecoder(false, fatal)
                if (fatal) {
                    assert.throws(() => decode(format, source, decoder), /encoded data|encoding/i)
                } else {
                    assert.equal(decode(format, source, decoder)?.rules, '\ufffd')
                }
                assert.deepEqual(Uint8Array.from(source), ordinary)
            })
        }
    }
}

for (const shared of [false, true]) {
    test(`malformed token and raw length still reject with shared=${shared}`, () => {
        const {decoder} = strictDecoder(false)
        assert.equal(decodeRawTermContentTokenBinary(sourceView(encoder.encode('MBR6"missing delimiter"'), shared), decoder), null)
        const raw = encode('raw', ['n', '', ''])
        new DataView(raw.buffer).setUint32(16, 0xffffffff, true)
        assert.equal(decodeRawTermContentBinary(sourceView(raw, shared), decoder), null)
    })
}
