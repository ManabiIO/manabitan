/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {parentPort} from 'node:worker_threads'

// Run the unmodified production worker and codec. Deliberately retain message
// events so reference release is deterministic and does not depend on a GC.
const retained = new Map()
const controls = new Map()
const nativeFetch = globalThis.fetch
const fields = ['source', 'sourceOffsets', 'sourceLengths']
globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.protocol !== 'file:') { return await nativeFetch(input, init) }
    return new Response(await readFile(url), {headers: {'Content-Type': 'application/wasm'}})
}
globalThis.self = globalThis
globalThis.addEventListener = (type, listener) => {
    if (type !== 'message') { return }
    parentPort.on('message', ({data, control = {}}) => {
        retained.set(data.id, {data})
        controls.set(data.id, control.overwriteOnConsumed ?
            {
                ...control,
                originalSource: data.source,
                originalOffsets: data.sourceOffsets,
                originalLengths: data.sourceLengths,
            } :
            control)
        listener(retained.get(data.id))
    })
}
globalThis.postMessage = (message, transfer) => {
    const event = retained.get(message.id)
    const control = controls.get(message.id)
    const witness = event ?
        {
            retainedFields: fields.filter((field) => event.data[field] !== undefined),
            retainedEventCount: retained.size,
        } :
        null
    if (message.type === 'source-consumed' && control?.overwriteOnConsumed) {
        // Mutate after the actual gather but before native compression finishes.
        // This witnesses the existing source-consumed contract without a race.
        control.originalSource.fill(255)
        control.originalOffsets.fill(0xffffffff)
        control.originalLengths.fill(0xffffffff)
        delete control.originalSource
        delete control.originalOffsets
        delete control.originalLengths
    }
    parentPort.postMessage({...message, witness}, transfer)
    if (message.type === 'source-consumed' && control?.failAfterConsumed) {
        throw new Error('injected failure after source acknowledgement')
    }
}
await import('../../../ext/js/dictionary/zstd-term-content-compression-worker.js')
