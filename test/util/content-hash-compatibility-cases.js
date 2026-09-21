import assert from 'node:assert/strict'

/**
 * @param {(name: string, fn: () => void) => unknown} test
 * @param {typeof import('../../ext/js/dictionary/term-entry-content-hash.js')} hash
 * @param {{vectors: {length: number, salt: number, pair: number[]}[]}} fixture
 */
export function registerContentHashCompatibilityCases(test, hash, fixture) {
    const offsets = [0, 1, 2, 3, 5, 7, 8, 15]
    for (const offset of offsets) {
        test(`native XXH32 parity for unaligned view offset ${offset}`, () => {
            for (const {length, salt, pair} of fixture.vectors) {
                const backing = new Uint8Array(length + offset + 17).fill(0xa5)
                for (let i = 0; i < length; ++i) backing[offset + i] = ((i * 131 + (i >>> 3) * 17 + salt) ^ ((i * 7) >>> 2)) & 255
                const bytes = backing.subarray(offset, offset + length)
                assert.deepEqual(hash.hashTermEntryContentBytesPair(bytes), pair, `length ${length}, salt ${salt}`)
                assert.equal(hash.hashTermEntryContentBytes(bytes), pair.map((x) => x.toString(16).padStart(8, '0')).join(''))
            }
        })
    }
    test('shared-backed stable views match the native oracle', () => {
        for (const {length, salt, pair} of fixture.vectors.filter((x) => x.length < 256)) {
            const bytes = new Uint8Array(new SharedArrayBuffer(length + 6), 3, length)
            for (let i = 0; i < length; ++i) bytes[i] = ((i * 131 + (i >>> 3) * 17 + salt) ^ ((i * 7) >>> 2)) & 255
            assert.deepEqual(hash.hashTermEntryContentBytesPair(bytes), pair)
        }
    })
    test('hashing does not mutate its source or the surrounding slab', () => {
        const slab = new Uint8Array(4096)
        for (let i = 0; i < slab.length; ++i) slab[i] = i & 255
        const copy = slab.slice()
        hash.hashTermEntryContentBytesPair(slab.subarray(7, 4001))
        hash.hashTermEntryContentBytes(slab.subarray(7, 4001))
        assert.deepEqual(slab, copy)
    })
    test('hex formatting retains unsigned coercion and leading zeroes', () => {
        assert.equal(hash.hashPairToHex(0, 0), '0000000000000000')
        assert.equal(hash.hashPairToHex(-1, 1), 'ffffffff00000001')
        assert.equal(hash.hashPairToHex(2 ** 32 + 1, -2), '00000001fffffffe')
        assert.equal(hash.hashPairToHex(NaN, Infinity), '0000000000000000')
    })
}
