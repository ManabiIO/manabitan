/* SPDX-License-Identifier: GPL-3.0-or-later */
const check = (condition, message) => { if (!condition) { throw new Error(message) } }
const sha256 = async (bytes) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('')
const read = async (filename) => {
    const response = await fetch(`/input/${encodeURIComponent(filename)}`, {cache: 'no-store'})
    check(response.ok, `Input read failed: ${filename}`)
    return new Uint8Array(await response.arrayBuffer())
}
let parser
let inflater
let smallInflater
let arm
let busy = false
let calls = 0
let currentTiming = null

async function initialize(data) {
    check(arm === undefined, 'Worker already initialized')
    arm = data.arm
    check(['native', 'gzip64', 'gzip1k', 'conformance'].includes(arm), 'Unknown inflater arm')
    const started = performance.now()
    parser = await import('/repo/ext/js/dictionary/term-bank-wasm-parser.js')
    parser.setTermBankWasmModule(data.module)
    if (arm === 'native' || arm === 'conformance') { await parser.initializeTermBankWasmParser() }
    if (arm !== 'native') {
        const helper = await import('/repo/dev/perf/decompression-stream-chromium/gzip-inflater.mjs')
        inflater = await helper.createGzipInflater(data.module, arm === 'gzip1k' ? 1024 : 65536)
        if (arm === 'conformance') { smallInflater = await helper.createGzipInflater(data.module, 1024) }
    }
    return {initializationMs: performance.now() - started, arm, crossOriginIsolated,
        hardwareConcurrency: navigator.hardwareConcurrency, deviceMemory: navigator.deviceMemory ?? null,
        userAgent: navigator.userAgent, timeOrigin: performance.timeOrigin}
}

async function sourcesFor(banks, conformance = false) {
    const sources = []
    for (const bank of banks) {
        const bytes = await read(bank.filename)
        check(bytes.length === (conformance ? bank.byteLength : bank.compressedSize), 'Source byte count mismatch')
        check(await sha256(bytes) === (conformance ? bank.sha256 : bank.compressedSha256), 'Source digest mismatch')
        sources.push({bytes, compressionMethod: bank.compressionMethod,
            compressedSize: bank.compressedSize, uncompressedSize: bank.uncompressedSize,
            signature: bank.signature, filename: bank.zipFilename ?? bank.filename})
    }
    return sources
}

async function copyAndVerify(result, group) {
    check(result.jsonLength === group.decodedBytes, 'Decoded group size mismatch')
    check(result.bankSpanCount === group.banks.length && result.bankSpansPtr !== 0, 'Bank spans not preserved')
    const spans = new Uint32Array(result.wasm.memory.buffer, result.bankSpansPtr, group.banks.length * 2)
    let offset = 0
    for (const [index, bank] of group.banks.entries()) {
        check(spans[index * 2] === offset && spans[index * 2 + 1] === bank.uncompressedSize, 'Bank boundary changed')
        offset += bank.uncompressedSize
    }
    // Identical post-timer owned copies make SharedArrayBuffer-backed parser
    // output suitable for WebCrypto. Neither arm omits its decoder input/output
    // copies from timing. No decoded oracle data is retained across calls.
    const owned = new Uint8Array(result.wasm.memory.buffer, result.jsonPtr, result.jsonLength).slice()
    const digest = await sha256(owned)
    check(digest === group.decodedSha256, 'Full decoded group bytes differ from independent zlib oracle')
    offset = 0
    for (const bank of group.banks) {
        check(await sha256(owned.subarray(offset, offset + bank.uncompressedSize)) === bank.decodedSha256,
            'Full decoded bank bytes differ from independent zlib oracle')
        offset += bank.uncompressedSize
    }
    return digest
}

async function runGroup(group) {
    check(['native', 'gzip64', 'gzip1k'].includes(arm), 'Wrong worker mode')
    check(group.banks.length > 1 && !group.crcReuseEligible, 'Group cannot use this immediate-CRC comparison')
    const sources = await sourcesFor(group.banks)
    const started = performance.now()
    currentTiming = {groupIndex: group.groupIndex, arm, phase: 'inflate'}
    let result
    try {
        result = arm === 'native' ?
            await parser.inflateCompressedTermBankSourcesWasm(sources, {}, true) :
            await inflater.inflate(sources)
    } catch (error) {
        currentTiming.inflateAndCrcMs = performance.now() - started
        throw error
    }
    const inflateAndCrcMs = performance.now() - started
    currentTiming = {...currentTiming, phase: 'output-oracle', inflateAndCrcMs}
    check(!result.crcSignaturesPtr, 'Actual native path deferred CRC; comparison is invalid')
    const decodedSha256 = await copyAndVerify(result, group)
    ++calls
    return {groupIndex: group.groupIndex, arm, invocation: calls, firstInvocation: calls === 1,
        inflateAndCrcMs, expectedRows: group.rows, compressedBytes: group.compressedBytes,
        decodedBytes: group.decodedBytes, decodedSha256,
        wasmCapacityBytes: result.wasm.memory.buffer.byteLength,
        wasmMemoryShared: result.wasm.memory.buffer instanceof SharedArrayBuffer,
        inputCopiedBytes: arm === 'native' ? group.compressedBytes : 0,
        outputCopiedBytes: arm !== 'native' ? result.outputCopiedBytes : 0,
        inputChunks: result.inputChunks ?? null, decodedChunks: result.decodedChunks ?? null,
        inputChunkBytes: result.inputChunkBytes ?? null, framedBytes: result.framedBytes ?? 0, nativeFallbackCalls: 0}
}

async function conformanceCase(entry) {
    check(arm === 'conformance', 'Wrong worker mode')
    const sources = await sourcesFor(entry.sources, true)
    const direct = []
    for (const [variant, engine] of [['gzip64', inflater], ['gzip1k', smallInflater]]) {
        let actual
        try {
            const result = await engine.inflate(sources)
            const owned = new Uint8Array(result.wasm.memory.buffer, result.jsonPtr, result.jsonLength).slice()
            actual = {accepted: true, decodedBytes: owned.length, decodedSha256: await sha256(owned)}
        } catch (error) { actual = {accepted: false, error: {name: error.name, message: error.message}} }
        check(actual.accepted === entry.expected.accepted, `DS acceptance differs from native: ${entry.name}/${variant}`)
        if (actual.accepted) {
            check(actual.decodedBytes === entry.expected.decodedBytes && actual.decodedSha256 === entry.expected.decodedSha256,
                `DS bytes differ from native: ${entry.name}/${variant}`)
        }
        for (const [index, source] of sources.entries()) {
            check(await sha256(source.bytes) === entry.sources[index].sha256, 'DS changed original input bytes')
        }
        direct.push({variant, ...actual})
    }
    // A product fallback would classify failures with the unchanged native
    // operation. Verify original compressed bytes survive all asynchronous DS
    // reads, then reproduce the complete prior error name/message. This cannot
    // hide a DS false acceptance: the acceptance check above already failed it.
    let native
    try {
        const result = await parser.inflateCompressedTermBankSourcesWasm(sources, {experimentalTermBankSpans: true})
        const bytes = new Uint8Array(result.wasm.memory.buffer, result.jsonPtr, result.jsonLength).slice()
        native = {accepted: true, decodedBytes: bytes.length, decodedSha256: await sha256(bytes)}
    } catch (error) { native = {accepted: false, error: {name: error.name, message: error.message}} }
    check(JSON.stringify(native) === JSON.stringify(entry.expected), `Native oracle differs in Chromium: ${entry.name}`)
    return {name: entry.name, direct, native, originalInputPreserved: true}
}

async function formatCase(entry) {
    check(arm === 'conformance', 'Wrong worker mode')
    const parts = []
    for (const part of entry.parts) {
        const bytes = await read(part.filename)
        check(bytes.length === part.byteLength && await sha256(bytes) === part.sha256, 'Format input mismatch')
        parts.push(bytes)
    }
    let index = 0
    const reader = new ReadableStream({pull(controller) {
        if (index < parts.length) { controller.enqueue(parts[index++]) } else { controller.close() }
    }}, {highWaterMark: 0}).pipeThrough(new DecompressionStream(entry.format)).getReader()
    let actual
    let count = 0
    const output = new Uint8Array(entry.maxDecodedBytes)
    try {
        while (true) {
            const {done, value} = await reader.read()
            if (done) { break }
            check(value.length <= output.length - count, 'Format decoded limit exceeded')
            output.set(value, count)
            count += value.length
        }
        actual = {accepted: true, bytes: count, decodedSha256: await sha256(output.subarray(0, count))}
    } catch (error) {
        try { await reader.cancel(error) } catch {}
        actual = {accepted: false, bytes: count, error: {name: error.name, message: error.message}}
    } finally { reader.releaseLock() }
    check(actual.accepted === entry.expectedAccepted, `Browser format conformance failed: ${entry.name}`)
    if (actual.accepted) { check(actual.decodedSha256 === entry.expectedSha256, 'Format valid bytes changed') }
    return {name: entry.name, actual}
}

self.onmessage = async ({data}) => {
    if (busy) { self.postMessage({id: data.id, complete: false, error: 'Concurrent parser command rejected'}); return }
    busy = true
    try {
        let result
        if (data.type === 'initialize') { result = await initialize(data) }
        else if (data.type === 'group') { result = await runGroup(data.group) }
        else if (data.type === 'conformance') { result = await conformanceCase(data.entry) }
        else if (data.type === 'format') { result = await formatCase(data.entry) }
        else { throw new Error('Unknown worker command') }
        self.postMessage({id: data.id, complete: true, result})
        currentTiming = null
    } catch (error) {
        self.postMessage({id: data.id, complete: false, error: String(error?.stack ?? error), type: data.type,
            context: data.group?.groupIndex ?? data.entry?.name ?? null, timing: currentTiming})
    } finally { busy = false }
}
