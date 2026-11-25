/*
 * Copyright (C) 2026  Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */
/* eslint @stylistic/semi: ["error", "never"] */

import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {parentPort, workerData} from 'node:worker_threads'

const port = parentPort
const options = /** @type {unknown} */ (workerData)
if (port === null || typeof options !== 'object' || options === null ||
!('sourceRoot' in options) || typeof options.sourceRoot !== 'string') {
    throw new Error('Missing parser worker source root or parent port')
}

Reflect.set(globalThis, 'self', {
    /**
     * @param {string} type
     * @param {(event: {data: unknown}) => void} listener
     * @throws {Error} If the production worker requests an unsupported listener.
     */
    addEventListener(type, listener) {
        if (type !== 'message') { throw new Error(`Unexpected listener ${type}`) }
        port.on('message', (/** @type {unknown} */ data) => { listener({data}) })
    },
    /**
     * @param {unknown} message
     * @param {Parameters<import('node:worker_threads').MessagePort['postMessage']>[1]} [transfer]
     */
    postMessage(message, transfer = []) { port.postMessage(message, transfer) },
})

// Explicit caller-selected checkout, never a path supplied by dictionary data.
// eslint-disable-next-line no-unsanitized/method
await import(pathToFileURL(path.join(options.sourceRoot, 'ext/js/dictionary/term-bank-wasm-parser-worker.js')).href)
port.postMessage({type: 'bridge-ready'})
