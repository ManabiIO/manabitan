/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */
import {parentPort, workerData} from 'node:worker_threads'

// Adapt only transport; the production worker and compiled parser run intact.
globalThis.self = globalThis
globalThis.addEventListener = (type, listener) => {
    if (type === 'message') { parentPort.on('message', (data) => listener({data})) }
}
globalThis.postMessage = (message, transfer) => parentPort.postMessage(message, transfer)
// The URL comes exclusively from the production parser's new Worker call.
// eslint-disable-next-line no-unsanitized/method
await import(workerData.url)
