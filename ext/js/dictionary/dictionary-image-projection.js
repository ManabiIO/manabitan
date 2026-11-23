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

import {tryCollectGlossaryImagePaths} from './dictionary-image-references.js'

const MAX_REUSABLE_GLOSSARY_BYTES = 64 * 1024
const decoder = new TextDecoder()

/**
 * Project one chunk's validated media glossaries with bounded decode scratch.
 * TextDecoder cannot consume shared WASM views in Chromium. Each synchronous
 * decode finishes before this private scratch is reused, and only strings are
 * retained by the returned image paths. Oversized glossaries use an independent
 * temporary buffer without growing the reusable allocation.
 * @returns {(glossaryJson: string, glossaryJsonBytes?: Uint8Array) => string[]}
 */
export function createGlossaryImagePathProjector() {
    let scratch = new Uint8Array(0)
    return (glossaryJson, glossaryJsonBytes) => {
        if (glossaryJson.length === 0 && glossaryJsonBytes instanceof Uint8Array) {
            let bytes = glossaryJsonBytes
            // The shared-memory constructor can be hidden while views remain.
            if (!(bytes.buffer instanceof ArrayBuffer)) {
                if (bytes.byteLength > MAX_REUSABLE_GLOSSARY_BYTES) {
                    bytes = new Uint8Array(bytes)
                } else {
                    if (scratch.byteLength < bytes.byteLength) {
                        scratch = new Uint8Array(Math.min(
                            MAX_REUSABLE_GLOSSARY_BYTES,
                            Math.max(bytes.byteLength, scratch.byteLength * 2, 1024),
                        ))
                    }
                    scratch.set(bytes)
                    bytes = scratch.subarray(0, bytes.byteLength)
                }
            }
            glossaryJson = decoder.decode(bytes)
        }
        return tryCollectGlossaryImagePaths(glossaryJson)
    }
}
