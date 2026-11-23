/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {afterEach, describe, expect, test, vi} from 'vitest'
import {createGlossaryImagePathProjector} from '../ext/js/dictionary/dictionary-image-projection.js'

const encoder = new TextEncoder()

afterEach(() => { vi.restoreAllMocks() })

/**
 * @param {string} path
 * @param {number} [padding]
 * @returns {Uint8Array}
 */
function sharedGlossary(path, padding = 0) {
    const bytes = encoder.encode(JSON.stringify([{type: 'image', path}, 'x'.repeat(padding)]))
    const source = new Uint8Array(new SharedArrayBuffer(bytes.length + 20))
    source.fill(0xff)
    const view = source.subarray(7, 7 + bytes.length)
    view.set(bytes)
    return view
}

describe('bounded shared glossary image projection', () => {
    test('reuses private scratch without decoding stale trailing bytes or retaining shared input', () => {
        const decode = vi.spyOn(TextDecoder.prototype, 'decode')
        const project = createGlossaryImagePathProjector()
        const first = sharedGlossary('日本😀.webp', 3000)
        const second = sharedGlossary('small.png')
        const firstPaths = project('', first)
        first.fill(0)
        const secondPaths = project('', second)
        second.fill(0)
        expect(firstPaths).toEqual(['日本😀.webp'])
        expect(secondPaths).toEqual(['small.png'])
        const firstInput = decode.mock.calls[0][0]
        const secondInput = decode.mock.calls[1][0]
        if (!(firstInput instanceof Uint8Array) || !(secondInput instanceof Uint8Array)) { throw new Error('Expected private decode views') }
        expect(firstInput.buffer).toBeInstanceOf(ArrayBuffer)
        expect(firstInput.buffer).toBe(secondInput.buffer)
        expect(firstInput.byteLength).toBe(first.byteLength)
        expect(secondInput.byteLength).toBe(second.byteLength)
        expect(firstInput.buffer).not.toBe(first.buffer)
    })

    test('bounds reusable capacity and leaves oversized snapshots independent', () => {
        const decode = vi.spyOn(TextDecoder.prototype, 'decode')
        const project = createGlossaryImagePathProjector()
        const small = sharedGlossary('small.png')
        const large = sharedGlossary('large.webp', 70 * 1024)
        expect(project('', small)).toEqual(['small.png'])
        expect(project('', large)).toEqual(['large.webp'])
        expect(project('', small)).toEqual(['small.png'])
        const inputs = decode.mock.calls.map(([input]) => input)
        if (!inputs.every((input) => input instanceof Uint8Array)) { throw new Error('Expected byte decode inputs') }
        expect(inputs[0].buffer.byteLength).toBeLessThanOrEqual(64 * 1024)
        expect(inputs[1].buffer.byteLength).toBe(large.byteLength)
        expect(inputs[1].buffer).not.toBe(inputs[0].buffer)
        expect(inputs[2].buffer).toBe(inputs[0].buffer)
    })

    test('uses ordinary views directly and prefers an already decoded glossary', () => {
        const decode = vi.spyOn(TextDecoder.prototype, 'decode')
        const project = createGlossaryImagePathProjector()
        const bytes = encoder.encode('[{"type":"image","path":"ordinary.png"}]')
        expect(project('', bytes)).toEqual(['ordinary.png'])
        expect(decode.mock.calls[0][0]).toBe(bytes)
        expect(project('[{"type":"image","path":"decoded.png"}]', new Uint8Array(0))).toEqual(['decoded.png'])
        expect(decode).toHaveBeenCalledTimes(1)
    })

    test('snapshots shared views even when the SharedArrayBuffer constructor is hidden', () => {
        const bytes = sharedGlossary('hidden.png')
        const decode = vi.spyOn(TextDecoder.prototype, 'decode')
        const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'SharedArrayBuffer')
        try {
            Object.defineProperty(globalThis, 'SharedArrayBuffer', {value: void 0, configurable: true})
            expect(createGlossaryImagePathProjector()('', bytes)).toEqual(['hidden.png'])
            const input = decode.mock.calls[0][0]
            if (!(input instanceof Uint8Array)) { throw new Error('Expected private decode input') }
            expect(input.buffer).toBeInstanceOf(ArrayBuffer)
        } finally {
            if (typeof descriptor !== 'undefined') { Object.defineProperty(globalThis, 'SharedArrayBuffer', descriptor) }
        }
    })

    test('preserves escaped paths and recovers after malformed or unsupported glossaries', () => {
        const project = createGlossaryImagePathProjector()
        const glossary = String.raw`[{"type":"structured-content","content":[{"tag":"a","path":"ignored.png"},{"tag":"\u0069mg","pa\u0074h":"img/\u732b.webp"}]}]`
        const encoded = encoder.encode(glossary)
        const bytes = new Uint8Array(new SharedArrayBuffer(encoded.byteLength))
        bytes.set(encoded)
        expect(project('[{')).toEqual([])
        expect(project('[{"type":"image","path":"unsupported.txt"}]')).toEqual([])
        expect(project('', bytes)).toEqual(['img/猫.webp'])
        expect(project('')).toEqual([])
    })

    test('keeps independent projector scratch private and recovers from malformed shared JSON', () => {
        const decode = vi.spyOn(TextDecoder.prototype, 'decode')
        const first = createGlossaryImagePathProjector()
        const second = createGlossaryImagePathProjector()
        const malformed = new Uint8Array(new SharedArrayBuffer(2))
        malformed.set(encoder.encode('[{'))
        expect(first('', malformed)).toEqual([])
        expect(second('', sharedGlossary('second.png'))).toEqual(['second.png'])
        expect(first('', sharedGlossary('first.png'))).toEqual(['first.png'])
        const inputs = decode.mock.calls.map(([input]) => input)
        if (!inputs.every((input) => input instanceof Uint8Array)) { throw new Error('Expected byte decode inputs') }
        expect(inputs[0].buffer).toBe(inputs[2].buffer)
        expect(inputs[0].buffer).not.toBe(inputs[1].buffer)
    })

    test.each(['bom', 'malformed-utf8'])('preserves default decoder handling of %s bytes', (kind) => {
        const prefix = encoder.encode('[{"type":"image","path":"')
        const suffix = encoder.encode('.png"}]')
        const bytes = kind === 'bom' ?
            Uint8Array.of(0xef, 0xbb, 0xbf, ...prefix, 0x61, ...suffix) :
            Uint8Array.of(...prefix, 0xff, ...suffix)
        const source = new Uint8Array(new SharedArrayBuffer(bytes.byteLength))
        source.set(bytes)
        expect(createGlossaryImagePathProjector()('', source)).toEqual([kind === 'bom' ? 'a.png' : '\ufffd.png'])
    })
})
