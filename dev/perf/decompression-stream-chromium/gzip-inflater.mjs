/* SPDX-License-Identifier: GPL-3.0-or-later */
// Research only: independent bank spans in one exclusively owned parser heap.
// Production admission, fallback and cancellation are intentionally unchanged.
import {DictionarySourceIntegrityError} from '../../../ext/js/dictionary/dictionary-source-integrity-error.js'
import {TermBankWasmResourceError} from '../../../ext/js/dictionary/term-bank-wasm-parser.js'

export const INPUT_CHUNK_BYTES = 64 * 1024
export const SMALL_INPUT_CHUNK_BYTES = 1024
const MAX_WASM_BYTES = 0xffffffff
const whitespace = (byte) => byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d

function allocate(wasm, bytes, name) {
    const pointer = wasm.wasm_alloc(bytes)
    if (pointer === 0) { throw new TermBankWasmResourceError(`Could not allocate ${name}`) }
    return pointer
}

export async function createGzipInflater(module, inputChunkBytes = INPUT_CHUNK_BYTES) {
    if (inputChunkBytes !== INPUT_CHUNK_BYTES && inputChunkBytes !== SMALL_INPUT_CHUNK_BYTES) {
        throw new RangeError('Research protocol permits only frozen 64KiB and 1KiB input slices')
    }
    const {exports: wasm} = await WebAssembly.instantiate(module, {})
    let active = false
    return {
        get memoryBytes() { return wasm.memory.buffer.byteLength },
        async inflate(sources) {
            if (active) { throw new Error('Research inflater already owns the parser heap') }
            active = true
            try { return await inflateSources(wasm, sources, inputChunkBytes) } finally { active = false }
        },
    }
}

async function inflateSources(wasm, sources, inputChunkBytes) {
    if (!Array.isArray(sources) || sources.length === 0) { throw new TypeError('Compressed term-bank sources are empty') }
    let compressedBytes = 0
    let uncompressedBytes = 0
    for (const [index, source] of sources.entries()) {
        if (
            typeof source !== 'object' || source === null ||
            !(source.bytes instanceof Uint8Array) ||
            (source.compressionMethod !== 0 && source.compressionMethod !== 8) ||
            !Number.isSafeInteger(source.compressedSize) || source.compressedSize < 0 ||
            !Number.isSafeInteger(source.uncompressedSize) || source.uncompressedSize < 0 ||
            !Number.isInteger(source.signature) || source.signature < 0 || source.signature > 0xffffffff ||
            source.bytes.byteLength !== source.compressedSize
        ) { throw new TypeError(`Compressed term-bank source ${index + 1} metadata is invalid`) }
        compressedBytes += source.compressedSize
        uncompressedBytes += source.uncompressedSize
    }
    if (
        !Number.isSafeInteger(compressedBytes) || compressedBytes > MAX_WASM_BYTES ||
        !Number.isSafeInteger(uncompressedBytes) || uncompressedBytes > MAX_WASM_BYTES - 2
    ) { throw new TermBankWasmResourceError('Compressed term-bank source exceeds the 32-bit WASM parser limit') }

    // The real scheduler transfers owned ordinary inputs to one worker, awaits
    // the complete job, and awaits any borrowed result before sending another.
    // No other parser call is allowed between this reset and the returned result.
    wasm.wasm_reset_heap()
    const spansPtr = allocate(wasm, sources.length * 8, 'bank spans')
    const signaturesPtr = allocate(wasm, sources.length * 4, 'bank CRCs')
    const singleSpanPtr = allocate(wasm, 8, 'stored-bank CRC span')
    const outputPtr = allocate(wasm, uncompressedBytes + 2, 'inflated term-bank output')
    const spans = new Uint32Array(wasm.memory.buffer, spansPtr, sources.length * 2)
    const signatures = new Uint32Array(wasm.memory.buffer, signaturesPtr, sources.length)
    const singleSpan = new Uint32Array(wasm.memory.buffer, singleSpanPtr, 2)
    singleSpan[0] = 0
    let outputOffset = 0
    let decodedChunks = 0
    let inputChunks = 0
    let framedBytes = 0
    for (let index = 0; index < sources.length; ++index) {
        const source = sources[index]
        const expectedLength = source.uncompressedSize
        signatures[index] = source.signature
        spans[index * 2] = outputOffset
        spans[index * 2 + 1] = expectedLength
        if (source.compressionMethod === 0) {
            if (source.compressedSize !== expectedLength) { throw new DictionarySourceIntegrityError('Stored source size mismatch') }
            new Uint8Array(wasm.memory.buffer).set(source.bytes, outputPtr + outputOffset)
            singleSpan[1] = expectedLength
            if (wasm.verify_term_bank_source_crcs(outputPtr + outputOffset, expectedLength, singleSpanPtr, 1, signaturesPtr + index * 4, 0, 0, 0, 0) !== 0) {
                throw new DictionarySourceIntegrityError('Stored source CRC32 mismatch')
            }
        } else {
            // Fresh framing and all stream construction are inside the caller's
            // timer. No Blob or full compressed/decoded concatenation is used.
            const header = Uint8Array.of(0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255)
            const trailer = new Uint8Array(8)
            const trailerView = new DataView(trailer.buffer)
            trailerView.setUint32(0, source.signature, true)
            trailerView.setUint32(4, expectedLength >>> 0, true)
            framedBytes += 18
            let phase = 0
            let inputOffset = 0
            const input = new ReadableStream({pull(controller) {
                if (phase === 0) {
                    phase = 1
                    controller.enqueue(header)
                } else if (phase === 1 && inputOffset < source.bytes.length) {
                    const end = Math.min(source.bytes.length, inputOffset + inputChunkBytes)
                    controller.enqueue(source.bytes.subarray(inputOffset, end))
                    inputOffset = end
                } else if (phase < 2) {
                    phase = 2
                    controller.enqueue(trailer)
                } else {
                    controller.close()
                    return
                }
                ++inputChunks
            }}, {highWaterMark: 0})
            const reader = input.pipeThrough(new DecompressionStream('gzip')).getReader()
            let decoded = 0
            try {
                while (true) {
                    const {value, done} = await reader.read()
                    if (done) { break }
                    if (!(value instanceof Uint8Array) || value.byteLength > expectedLength - decoded) {
                        throw new DictionarySourceIntegrityError('Inflated source exceeds ZIP size')
                    }
                    new Uint8Array(wasm.memory.buffer).set(value, outputPtr + outputOffset + decoded)
                    decoded += value.byteLength
                    ++decodedChunks
                }
                if (decoded !== expectedLength) { throw new DictionarySourceIntegrityError('Inflated source does not match ZIP size') }
            } catch (error) {
                try { await reader.cancel(error) } catch {}
                throw error
            } finally { reader.releaseLock() }
        }
        // Keep complete source banks, matching the production multi-bank path.
        // CRC/size/stream completion precede JSON-array admission for each bank.
        const output = new Uint8Array(wasm.memory.buffer, outputPtr + outputOffset, expectedLength)
        let begin = 0
        let end = output.length
        while (begin < end && whitespace(output[begin])) { ++begin }
        while (end > begin && whitespace(output[end - 1])) { --end }
        if (end - begin < 2 || output[begin] !== 0x5b || output[end - 1] !== 0x5d) {
            throw new Error('Compressed term-bank source failed validation: inflated term bank is not a JSON array')
        }
        outputOffset += expectedLength
    }
    return {wasm, jsonPtr: outputPtr, jsonLength: outputOffset,
        sourceCount: sources.length, bankSpansPtr: spansPtr, bankSpanCount: sources.length,
        crcSignaturesPtr: 0, crcStatsPtr: 0, compressedBytes, uncompressedBytes,
        decodedChunks, inputChunks, framedBytes, inputChunkBytes, outputCopiedBytes: uncompressedBytes}
}
