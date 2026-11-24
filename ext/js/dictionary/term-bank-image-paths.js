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

import {getImageMediaTypeFromFileName} from '../media/media-util.js'

const MAX_PROJECTED_IMAGE_PATHS = 32
const MAX_IMAGE_PROJECTION_BYTES = 65536
/** @typedef {import('./term-bank-wasm-parser.js').TermBankWasmExports} TermBankWasmExports */
/** @type {WeakMap<object, {wasm: TermBankWasmExports, bytes: Uint8Array, spans: Uint32Array|null}>} */
const nativeSources = new WeakMap()

/**
 * A parser callback owns the borrowed source until it settles. Foreign and
 * copied chunks cannot inherit this capability through an object property.
 * @param {object} chunk
 * @param {TermBankWasmExports|null} wasm
 * @param {Uint8Array} bytes
 */
export function registerNativeImagePathSource(chunk, wasm, bytes) {
    if (wasm !== null && typeof wasm.project_term_glossary_image_paths === 'function' && bytes.buffer === wasm.memory.buffer) {
        nativeSources.set(chunk, {wasm, bytes, spans: null})
    }
}

/** @param {object} chunk */
export function releaseNativeImagePathSource(chunk) {
    nativeSources.delete(chunk)
}

/**
 * Read the current borrowed bytes, then immediately decode independent path
 * strings. No native span or source view escapes to the receiving worker.
 * A failed or bounded-out projection retains the complete JavaScript path.
 * @param {object} chunk
 * @param {{glossaryJson: string, glossaryJsonBytes?: Uint8Array}} row
 * @param {(bytes: Uint8Array, start: number, length: number) => string} decodeString
 * @returns {string[]|null}
 */
export function tryCollectNativeGlossaryImagePaths(chunk, row, decodeString) {
    const source = nativeSources.get(chunk)
    const bytes = row.glossaryJsonBytes
    if (
        typeof source === 'undefined' || row.glossaryJson.length > 0 ||
        !(bytes instanceof Uint8Array) || bytes.byteLength === 0 ||
        bytes.byteLength > MAX_IMAGE_PROJECTION_BYTES || bytes.buffer !== source.wasm.memory.buffer ||
        bytes.buffer !== source.bytes.buffer || bytes.byteOffset < source.bytes.byteOffset ||
        bytes.byteOffset + bytes.byteLength > source.bytes.byteOffset + source.bytes.byteLength
    ) { return null }
    try {
        const pointer = /** @type {(...args: number[]) => number} */ (source.wasm.project_term_glossary_image_paths)(bytes.byteOffset, bytes.byteLength)
        const spanBytes = (1 + MAX_PROJECTED_IMAGE_PATHS * 2) * 4
        if (!Number.isSafeInteger(pointer) || pointer < 0 || pointer % 4 !== 0 || pointer + spanBytes > bytes.buffer.byteLength) { return null }
        if (source.spans === null || source.spans.buffer !== bytes.buffer || source.spans.byteOffset !== pointer) {
            source.spans = new Uint32Array(bytes.buffer, pointer, 1 + MAX_PROJECTED_IMAGE_PATHS * 2)
        }
        const spans = source.spans
        const count = spans[0]
        if (count > MAX_PROJECTED_IMAGE_PATHS) { return null }
        /** @type {string[]} */
        const paths = []
        for (let i = 0; i < count; ++i) {
            const start = spans[1 + i * 2]
            const length = spans[2 + i * 2]
            if (length < 2 || start + length > bytes.byteLength || bytes[start] !== 0x22 || bytes[start + length - 1] !== 0x22) { return null }
            const path = decodeString(bytes, start, length)
            if (getImageMediaTypeFromFileName(path) !== null) { paths.push(path) }
        }
        return paths
    } catch (_) {
        return null
    }
}
