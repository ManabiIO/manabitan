import assert from 'node:assert/strict'
import {readFile, writeFile} from 'node:fs/promises'
import {pathToFileURL, fileURLToPath} from 'node:url'
import path from 'node:path'

const [aRoot, bRoot, output] = process.argv.slice(2)
const originalFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.startsWith('file:')) {
        return new Response(await readFile(fileURLToPath(url)), {headers: {'Content-Type': 'application/wasm'}})
    }
    return originalFetch(input, init)
}
const load = async (root) => {
    const api = await import(pathToFileURL(path.join(root, 'dev/lib/zstd-wasm.js')).href)
    await api.init(pathToFileURL(path.join(root, 'dev/data/zstd-simd.wasm')).href)
    return api
}
const a = await load(aRoot)
const b = await load(bRoot)
const ac = a.createCCtx()
const bc = b.createCCtx()
const ad = a.createDCtx()
const dictionary = new Uint8Array(await readFile(path.join(aRoot, 'dev/data/zstd-dicts/jmdict.zdict')))
const encoder = new TextEncoder()
let cases = 0
let aBytes = 0
let bBytes = 0
let sameFrames = 0
let state = 0x97c55231
const random = () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return state >>> 0
}
try {
    for (const level of [-1, 1, 3]) {
        for (const size of [0, 1, 3, 7, 15, 16, 31, 32, 255, 256, 4095, 16384, 65535, 131073, 262144]) {
            for (const pattern of ['repeated', 'irregular']) {
                const text = pattern === 'repeated' ? 'dictionary 日本語 '.repeat(Math.ceil(size / 15)).slice(0, size) :
                    Array.from({length: size}, () => String.fromCharCode(32 + random() % 90)).join('')
                const input = encoder.encode(JSON.stringify([text, 'meaning', '']))
                const aa = a.compressUsingDictWithPrefix(ac, input, dictionary, 12, level, true)
                const bb = b.compressUsingDictWithPrefix(bc, input, dictionary, 12, level, true)
                assert.deepEqual(a.decompressUsingDict(ad, bb.subarray(12), dictionary), input)
                assert.deepEqual(a.decompressUsingDict(ad, aa.subarray(12), dictionary), input)
                assert.deepEqual(bb.subarray(0, 4), Uint8Array.of(0x4d, 0x42, 0x43, 0x32))
                const offsets = Uint32Array.of(0, Math.floor(input.length / 2))
                const lengths = Uint32Array.of(offsets[1], input.length - offsets[1])
                const shared = new Uint8Array(new SharedArrayBuffer(input.length + 16), 8, input.length)
                shared.set(input)
                const prepared = b.prepareSpanCompression(bc, shared, offsets, lengths, input.length, dictionary, 12, level, true)
                shared.fill(0)
                const spans = b.finishPreparedSpanCompression(prepared)
                assert.deepEqual(spans, bb)
                aBytes += aa.length
                bBytes += bb.length
                if (Buffer.compare(aa, bb) === 0) { ++sameFrames }
                ++cases
            }
        }
    }
    const rawDictionary = encoder.encode('a mutable dictionary has more than eight bytes of content')
    for (let iteration = 0; iteration < 64; ++iteration) {
        rawDictionary[iteration % rawDictionary.length] ^= 1
        const input = encoder.encode(`test ${iteration} a mutable dictionary has content`)
        const compressed = b.compressUsingDict(bc, input, rawDictionary, iteration % 2 ? -1 : 3)
        assert.deepEqual(a.decompressUsingDict(ad, compressed, rawDictionary), input)
        ++cases
    }
    const saved = b.compressUsingDict(bc, encoder.encode('["retained"]'), dictionary, -1)
    const copy = Uint8Array.from(saved)
    for (let i = 0; i < 5; ++i) { b.compressUsingDict(bc, encoder.encode('["different"]'), dictionary, -1) }
    assert.deepEqual(saved, copy)
    const invalidOffsets = Uint32Array.of(100)
    assert.throws(() => b.prepareSpanCompression(bc, Uint8Array.of(1), invalidOffsets, Uint32Array.of(1), 1, dictionary, 0, -1))
} finally {
    a.freeCCtx(ac)
    b.freeCCtx(bc)
    a.freeDCtx(ad)
    globalThis.fetch = originalFetch
}
await writeFile(output, JSON.stringify({status: 'success', cases, aBytes, bBytes, sameFrames,
    description: 'Actual codec conformance; synthetic inputs, not dictionary-import timing or total storage'}, null, 2))
console.log(JSON.stringify({cases, aBytes, bBytes, sameFrames}))
