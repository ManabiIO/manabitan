/* SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFileSync} from 'node:fs'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'
import {hashTermLookupKeyBytes} from '../ext/js/dictionary/term-lookup-index.js'

const artifact = readFileSync(new URL('../dev/data/dictionary-wasm/term-record-checksum.wasm', import.meta.url))
const fetchModule = vi.fn(async () => new Response(Uint8Array.from(artifact)))

beforeEach(() => {
    vi.resetModules()
    fetchModule.mockReset().mockImplementation(async () => new Response(Uint8Array.from(artifact)))
    vi.stubGlobal('fetch', fetchModule)
})

afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
})

async function create() {
    const {createImportLookupChecksum} = await import('../ext/js/dictionary/term-record-checksum.js')
    return createImportLookupChecksum()
}

async function requireChecksum() {
    const checksum = await create()
    if (checksum === null) { throw new Error('The recorded checksum module must load') }
    return checksum
}

/**
 * @param {number} length
 * @returns {Uint8Array}
 */
function pattern(length) {
    return Uint8Array.from({length}, (_, index) => ((index * 131) ^ ((index >>> 7) * 17) ^ length) & 0xff)
}

describe('native lookup checksum', () => {
    test('matches independent XXH32 vectors in exact unaligned views', async () => {
        // Same independent upstream XXH32 oracle as term-key-hash.test.js.
        const vectors = [
            [0, 1786691832],
            [1, 536960313],
            [15, 2152134394],
            [16, 3096359642],
            [17, 1177447463],
            [31, 1155932947],
            [32, 3695765420],
            [65, 2800707149],
            [1023, 4061057387],
            [1024, 3057859126],
            [1025, 3761688658],
            [65535, 1066372610],
            [65536, 780141939],
            [65537, 2379506235],
            [1048576, 1626041054],
        ]
        const checksum = await requireChecksum()
        for (const [length, expected] of vectors) {
            for (const offset of [0, 1, 2, 3, 7]) {
                const storage = new Uint8Array(length + offset + 19).fill(0xa5)
                const input = storage.subarray(offset, offset + length)
                input.set(pattern(length))
                const before = Buffer.from(storage)
                expect(checksum.hash(input), `length ${length}, offset ${offset}`).toBe(expected)
                expect(Buffer.compare(Buffer.from(storage), before)).toBe(0)
            }
        }
    })

    test('preserves all scalar tails, SIMD boundaries and memory-growth boundaries', async () => {
        const checksum = await requireChecksum()
        const lengths = [
            ...Array.from({length: 81}, (_, index) => index),
            127,
            128,
            129,
            255,
            256,
            257,
            511,
            512,
            513,
            1023,
            1024,
            1025,
            64511,
            64512,
            64513,
            65535,
            65536,
            65537,
            131071,
            131072,
            131073,
        ]
        for (const length of lengths) {
            const input = pattern(length)
            expect(checksum.hash(input), `length ${length}`).toBe(hashTermLookupKeyBytes(input))
        }
    })

    test('copies every current input and does not retain a caller view', async () => {
        const checksum = await requireChecksum()
        const input = pattern(2049)
        const first = checksum.hash(input)
        input[1024] ^= 0xff
        const second = checksum.hash(input)
        expect(second).not.toBe(first)
        expect(second).toBe(hashTermLookupKeyBytes(input))
        expect(checksum.hash(pattern(3))).toBe(hashTermLookupKeyBytes(pattern(3)))
        expect(checksum.hash(input)).toBe(second)
        checksum.dispose()
        expect(checksum.hash(input)).toBeNull()
    })

    test('bounds private memory and falls back for an oversized view without retiring the instance', async () => {
        const checksum = await requireChecksum()
        const grow = vi.spyOn(WebAssembly.Memory.prototype, 'grow')
        const input = new Uint8Array(16 * 1024 * 1024 + 1)
        const maximum = input.subarray(0, -1)
        expect(checksum.hash(maximum)).toBe(hashTermLookupKeyBytes(maximum))
        expect(grow.mock.calls.reduce((total, [pages]) => total + pages, 0)).toBeLessThanOrEqual(256)
        expect(checksum.hash(input)).toBeNull()
        expect(checksum.hash(pattern(17))).toBe(1177447463)
    })

    test('leaves shared, subclassed and accessor-bearing views on the JavaScript path', async () => {
        const checksum = await requireChecksum()
        const shared = new SharedArrayBuffer(32)
        expect(checksum.hash(new Uint8Array(shared))).toBeNull()
        Object.setPrototypeOf(shared, ArrayBuffer.prototype)
        expect(checksum.hash(new Uint8Array(shared))).toBeNull()
        class DerivedBytes extends Uint8Array {}
        expect(checksum.hash(new DerivedBytes(32))).toBeNull()
        const accessor = pattern(32)
        const getter = vi.fn(() => { throw new Error('Do not invoke this accessor') })
        Object.defineProperty(accessor, 'byteOffset', {get: getter})
        expect(checksum.hash(accessor)).toBeNull()
        expect(getter).not.toHaveBeenCalled()
        const disguised = new Float32Array(8)
        Object.setPrototypeOf(disguised, Uint8Array.prototype)
        expect(checksum.hash(/** @type {Uint8Array} */ (/** @type {unknown} */ (disguised)))).toBeNull()
        expect(checksum.hash(pattern(32))).toBe(3695765420)
    })

    test('retires a failed native instance and lets the caller use JavaScript', async () => {
        const checksum = await requireChecksum()
        vi.spyOn(WebAssembly.Memory.prototype, 'grow').mockImplementationOnce(() => { throw new RangeError('No memory') })
        expect(checksum.hash(new Uint8Array(131072))).toBeNull()
        expect(checksum.hash(pattern(16))).toBeNull()
    })

    test('caches only compilation while creating independent disposable instances', async () => {
        const first = await requireChecksum()
        const second = await requireChecksum()
        expect(fetchModule).toHaveBeenCalledTimes(1)
        first.dispose()
        expect(second.hash(pattern(16))).toBe(3096359642)
    })
})

describe('optional checksum availability', () => {
    test.each(['fetch', 'status', 'compile', 'abi'])('retries after %s failure', async (failure) => {
        switch (failure) {
            case 'fetch':
                fetchModule.mockRejectedValueOnce(new Error('Unavailable'))
                break
            case 'status':
                fetchModule.mockResolvedValueOnce(new Response(null, {status: 404}))
                break
            case 'compile':
                fetchModule.mockResolvedValueOnce(new Response(Uint8Array.of(0, 1)))
                break
            default:
                fetchModule.mockResolvedValueOnce(new Response(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0)))
                break
        }
        expect(await create()).toBeNull()
        const checksum = await requireChecksum()
        expect(checksum.hash(pattern(16))).toBe(3096359642)
        expect(fetchModule).toHaveBeenCalledTimes(2)
    })

    test('does not poison the compiled cache after an instance allocation fails', async () => {
        vi.spyOn(WebAssembly, 'instantiate').mockRejectedValueOnce(new RangeError('Unavailable instance'))
        expect(await create()).toBeNull()
        const checksum = await requireChecksum()
        expect(checksum.hash(pattern(16))).toBe(3096359642)
        expect(fetchModule).toHaveBeenCalledTimes(1)
    })

    test('returns the JavaScript fallback when SIMD compilation is unavailable', async () => {
        vi.spyOn(WebAssembly, 'compile').mockRejectedValueOnce(new WebAssembly.CompileError('SIMD unavailable'))
        expect(await create()).toBeNull()
        expect(hashTermLookupKeyBytes(pattern(16))).toBe(3096359642)
    })
})
