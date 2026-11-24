/*
 * Copyright (C) 2026 Manabitan authors
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

import {parseJson} from '../core/json.js'
import {getImageMediaTypeFromFileName} from '../media/media-util.js'

/** @typedef {import('./term-bank-wasm-parser.js').TermBankColumnChunk} ColumnChunk */
/** @typedef {import('./term-bank-wasm-parser.js').TermBankWasmExports} Wasm */
/** @typedef {{wasm: Wasm, sourceOffset: number, sourceLength: number, outputPtr: number, outputCapacity: number}} ProjectionScratch */

/** @type {WeakMap<ColumnChunk, ProjectionScratch>} */
const scratchByChunk = new WeakMap()
const decoder = new TextDecoder('utf-8', {ignoreBOM: true})
const U32_NULL = 0xffffffff

/**
 * Lend the finished native lookup output arena only while the parser's single
 * complete chunk callback owns its source. All lookup containers have already
 * been copied to independent buffers before this lease is created.
 * @param {ColumnChunk} chunk
 * @param {ProjectionScratch} scratch
 * @returns {() => void}
 */
export function lendNativeMediaProjectionScratch(chunk, scratch) {
    scratchByChunk.set(chunk, scratch)
    return () => {
        if (scratchByChunk.get(chunk) === scratch) { scratchByChunk.delete(chunk) }
    }
}

/**
 * Project a batch without allocating another WASM arena or constructing whole
 * glossary strings/objects. A null row means the existing JSON collector must
 * process that entire glossary; native output from failed rows never escapes.
 * @param {ColumnChunk} chunk
 * @returns {Array<string[]|null>|null}
 */
export function projectNativeMediaPaths(chunk) {
    const scratch = scratchByChunk.get(chunk)
    const project = scratch?.wasm.project_term_media_paths
    const count = chunk.mediaRows.length
    if (typeof scratch === 'undefined' || typeof project !== 'function' || count === 0) { return null }
    const {wasm, sourceOffset, sourceLength, outputPtr, outputCapacity} = scratch
    const memory = wasm.memory.buffer
    const rowBytes = count * 8
    const metadataBytes = rowBytes * 2
    if (
        !Number.isSafeInteger(metadataBytes) || metadataBytes + 8 > outputCapacity ||
        outputPtr < 0 || (outputPtr & 3) !== 0 || outputPtr > memory.byteLength - outputCapacity ||
        sourceOffset < 0 || sourceOffset > memory.byteLength - sourceLength
    ) { return null }
    const inputs = new Uint32Array(memory, outputPtr, count * 2)
    let eligibleRows = 0
    for (let index = 0; index < count; ++index) {
        const {row} = chunk.mediaRows[index]
        const bytes = row.glossaryJsonBytes
        if (
            row.termEntryContentBytes.length > 0 && row.glossaryJson.length === 0 &&
            bytes instanceof Uint8Array && bytes.buffer === memory &&
            bytes.byteOffset >= sourceOffset &&
            bytes.byteLength <= sourceLength - (bytes.byteOffset - sourceOffset)
        ) {
            inputs[index * 2] = bytes.byteOffset - sourceOffset
            inputs[index * 2 + 1] = bytes.byteLength
            ++eligibleRows
        } else {
            inputs[index * 2] = U32_NULL
            inputs[index * 2 + 1] = 0
        }
    }
    if (eligibleRows === 0) { return null }
    const resultsPtr = outputPtr + rowBytes
    const pathsPtr = outputPtr + metadataBytes
    const pathCapacity = Math.floor((outputCapacity - metadataBytes) / 8)
    const pathCount = project(sourceOffset, sourceLength, outputPtr, count, resultsPtr, pathsPtr, pathCapacity)
    if (pathCount < 0 || pathCount > pathCapacity) { return null }
    const results = new Uint32Array(memory, resultsPtr, count * 2)
    const spans = new Uint32Array(memory, pathsPtr, pathCount * 2)
    /** @type {Array<string[]|null>} */
    const projected = new Array(count).fill(null)
    for (let row = 0; row < count; ++row) {
        const firstPath = results[row * 2]
        const rowPathCount = results[row * 2 + 1]
        if (rowPathCount === U32_NULL || firstPath > pathCount || rowPathCount > pathCount - firstPath) { continue }
        /** @type {string[]} */
        const paths = []
        let complete = true
        for (let index = firstPath, end = firstPath + rowPathCount; index < end; ++index) {
            const start = spans[index * 2]
            const length = spans[index * 2 + 1]
            if (length < 2 || start > sourceLength || length > sourceLength - start) {
                complete = false
                break
            }
            // The quoted token preserves leading BOMs and JSON-only surrogate
            // escapes. Ordinary path strings avoid even a scalar JSON.parse.
            const quoted = new Uint8Array(memory, sourceOffset + start, length)
            const body = quoted.subarray(1, length - 1)
            const path = body.includes(0x5c) ?
                /** @type {string} */ (parseJson(decoder.decode(new Uint8Array(quoted)))) :
                decoder.decode(new Uint8Array(body))
            if (getImageMediaTypeFromFileName(path) !== null) { paths.push(path) }
        }
        if (complete) { projected[row] = paths }
    }
    return projected
}
