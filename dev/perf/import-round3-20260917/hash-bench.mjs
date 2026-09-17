import assert from 'node:assert/strict'
import {performance} from 'node:perf_hooks'
import {hashTermEntryContentBytesPair} from '../../../ext/js/dictionary/term-entry-content-hash.js'

const PRIME1 = 2654435761
const PRIME2 = 2246822519
const PRIME3 = 3266489917
const PRIME4 = 668265263
const PRIME5 = 374761393
const SEED1 = 0x811c9dc5
const SEED2 = 0x9e3779b9

const rotateLeft32 = (value, amount) => (((value << amount) >>> 0) | (value >>> (32 - amount))) >>> 0
const round = (accumulator, input) => Math.imul(rotateLeft32((accumulator + Math.imul(input >>> 0, PRIME2)) >>> 0, 13), PRIME1) >>> 0
const read32 = (bytes, offset) => (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0
const finish = (hash) => {
    hash ^= hash >>> 15
    hash = Math.imul(hash, PRIME2) >>> 0
    hash ^= hash >>> 13
    hash = Math.imul(hash, PRIME3) >>> 0
    hash ^= hash >>> 16
    return hash >>> 0
}

/** @param {Uint8Array} bytes */
function hashPairSinglePass(bytes) {
    let offset = 0
    const length = bytes.length
    let h1
    let h2
    if (length >= 16) {
        const limit = length - 16
        let a1 = (SEED1 + PRIME1 + PRIME2) >>> 0
        let a2 = (SEED1 + PRIME2) >>> 0
        let a3 = SEED1 >>> 0
        let a4 = (SEED1 - PRIME1) >>> 0
        let b1 = (SEED2 + PRIME1 + PRIME2) >>> 0
        let b2 = (SEED2 + PRIME2) >>> 0
        let b3 = SEED2 >>> 0
        let b4 = (SEED2 - PRIME1) >>> 0
        do {
            const w1 = read32(bytes, offset); offset += 4
            const w2 = read32(bytes, offset); offset += 4
            const w3 = read32(bytes, offset); offset += 4
            const w4 = read32(bytes, offset); offset += 4
            a1 = round(a1, w1); b1 = round(b1, w1)
            a2 = round(a2, w2); b2 = round(b2, w2)
            a3 = round(a3, w3); b3 = round(b3, w3)
            a4 = round(a4, w4); b4 = round(b4, w4)
        } while (offset <= limit)
        h1 = (rotateLeft32(a1, 1) + rotateLeft32(a2, 7) + rotateLeft32(a3, 12) + rotateLeft32(a4, 18)) >>> 0
        h2 = (rotateLeft32(b1, 1) + rotateLeft32(b2, 7) + rotateLeft32(b3, 12) + rotateLeft32(b4, 18)) >>> 0
    } else {
        h1 = (SEED1 + PRIME5) >>> 0
        h2 = (SEED2 + PRIME5) >>> 0
    }
    h1 = (h1 + length) >>> 0
    h2 = (h2 + length) >>> 0
    while ((offset + 4) <= length) {
        const word = read32(bytes, offset)
        h1 = (h1 + Math.imul(word, PRIME3)) >>> 0
        h2 = (h2 + Math.imul(word, PRIME3)) >>> 0
        h1 = Math.imul(rotateLeft32(h1, 17), PRIME4) >>> 0
        h2 = Math.imul(rotateLeft32(h2, 17), PRIME4) >>> 0
        offset += 4
    }
    while (offset < length) {
        const byte = bytes[offset]
        h1 = (h1 + Math.imul(byte, PRIME5)) >>> 0
        h2 = (h2 + Math.imul(byte, PRIME5)) >>> 0
        h1 = Math.imul(rotateLeft32(h1, 11), PRIME1) >>> 0
        h2 = Math.imul(rotateLeft32(h2, 11), PRIME1) >>> 0
        ++offset
    }
    h1 = finish(h1)
    h2 = finish(h2)
    if ((h1 | h2) === 0) h1 = 1
    return [h1 >>> 0, h2 >>> 0]
}

let state = 0x12345678
const random = () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return state >>> 0
}
let equalityChecks = 0
for (const length of [0, 1, 2, 3, 4, 7, 8, 15, 16, 17, 31, 32, 63, 64, 255, 256, 1023, 1024, 65535, 65536, 1048576]) {
    for (let alignment = 0; alignment < 8; ++alignment) {
        const backing = new Uint8Array(length + alignment)
        for (let i = 0; i < backing.length; ++i) backing[i] = random() & 255
        const bytes = backing.subarray(alignment)
        assert.deepEqual(hashPairSinglePass(bytes), hashTermEntryContentBytesPair(bytes), `${length}/${alignment}`)
        equalityChecks++
    }
}
for (let trial = 0; trial < 4096; ++trial) {
    const length = random() % 32769
    const bytes = new Uint8Array(length)
    for (let i = 0; i < length; ++i) bytes[i] = random() & 255
    assert.deepEqual(hashPairSinglePass(bytes), hashTermEntryContentBytesPair(bytes), `random ${trial}`)
    equalityChecks++
}

const data = new Uint8Array(8 * 1024 * 1024 + 7)
for (let i = 0; i < data.length; ++i) data[i] = random() & 255
let sink = 0
const run = (fn) => {
    const start = performance.now()
    for (let i = 0; i < 8; ++i) {
        const pair = fn(data.subarray(i & 7))
        sink ^= pair[0] ^ pair[1]
    }
    return performance.now() - start
}
for (let i = 0; i < 8; ++i) { run(hashTermEntryContentBytesPair); run(hashPairSinglePass) }
const pairs = []
const raw = []
for (let block = 1; block <= 12; ++block) {
    const a1 = run(hashTermEntryContentBytesPair)
    const b1 = run(hashPairSinglePass)
    const b2 = run(hashPairSinglePass)
    const a2 = run(hashTermEntryContentBytesPair)
    const p1 = 100 * (b1 / a1 - 1)
    const p2 = 100 * (b2 / a2 - 1)
    pairs.push(p1, p2)
    raw.push({block, a1, b1, b2, a2, p1, p2})
}
const median = values => {
    const sorted = [...values].sort((a, b) => a - b)
    const mid = sorted.length >> 1
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
const result = {
    equalityChecks,
    sink,
    pairedMedianPercent: median(pairs),
    pairsFaster: pairs.filter(value => value < 0).length,
    pairedPercentages: pairs,
    raw,
}
console.log(JSON.stringify(result, null, 2))
if (!(result.pairedMedianPercent < -2 && result.pairsFaster >= 18)) {
    throw new Error(`Single-pass hash did not clear component gate: ${result.pairedMedianPercent.toFixed(3)}%, ${result.pairsFaster}/24`)
}
