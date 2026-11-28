/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */
import assert from 'node:assert/strict'
import {parentPort, workerData} from 'node:worker_threads'

let native = {calls: 0, spans: 0, fallbacks: 0}
const instantiate = WebAssembly.instantiate
WebAssembly.instantiate = async (...args) => {
    const instance = await instantiate(...args)
    assert(instance instanceof WebAssembly.Instance)
    const project = instance.exports.project_single_glossary_image_path
    assert.equal(typeof project, 'function')
    // Observe only this export. Every call still reaches the unchanged native
    // implementation; the production parser reads only instance.exports.
    return {exports: {...instance.exports,
        project_single_glossary_image_path: (...values) => {
            ++native.calls
            const result = project(...values)
            if (result === 0n) { ++native.fallbacks } else { ++native.spans }
            return result
        }}}
}
globalThis.self = globalThis
globalThis.addEventListener = (type, listener) => {
    if (type !== 'message') { return }
    parentPort.on('message', (data) => {
        if (data.type === 'parse') { native = {calls: 0, spans: 0, fallbacks: 0} }
        listener({data})
    })
}
globalThis.postMessage = (message, transfer = []) => {
    if (message.type !== 'result') { parentPort.postMessage(message, transfer); return }
    assert.equal(transfer.length, new Set(transfer).size, 'Duplicate transferable')
    const chunk = message.chunk
    const columns = chunk?.projectedMedia
    const buffers = columns ? [columns.rowIndexes.buffer, columns.pathEnds.buffer,
        columns.diagnosticKeys.bytes.buffer, columns.diagnosticKeys.spans.buffer] : []
    for (const buffer of buffers) {
        assert(buffer instanceof ArrayBuffer)
        assert.notEqual(buffer, chunk.termRecordPreinternedPlan.stringsBuffer.buffer)
        assert.equal(transfer.filter((value) => value === buffer).length, buffer.byteLength === 0 ? 0 : 1)
    }
    message.oracleObservation = {native: {...native}, borrowsWorkerMemory: message.borrowsWorkerMemory,
        parser: {fusedParseAttempts: message.profile?.fusedParseAttempts ?? 0, fusedParseFallbacks: message.profile?.fusedParseFallbacks ?? 0},
        ownsContentBytes: message.ownsContentBytes, transferredBuffers: transfer.length,
        projectedBuffers: buffers.length, projectedBufferBytes: buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0)}
    parentPort.postMessage(message, transfer)
    parentPort.postMessage({type: 'oracle-transfer-proof', id: message.id,
        projectedBuffersDetached: buffers.every((buffer) => buffer.byteLength === 0)})
}
// The main harness supplies an explicit repository worker URL.
await import(workerData.url)
