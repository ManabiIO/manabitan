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

const EMPTY_BYTES = new Uint8Array(0)
const decoder = new TextDecoder()
const GLOSSARY = 0
const ITEM = 1
const CONTENT = 2
const IMAGE = 1
const STRUCTURED = 2
const MAX_DEPTH = 256

/**
 * Projects one image from a native-validated glossary without materializing
 * its JSON object graph. This is not a JSON validator: the producer has already
 * checked the bounded source span. Unproven shapes use the ordinary collector.
 * One cursor is reused within a synchronous chunk; no input survives a call.
 */
export class ValidatedImagePathProjector {
    constructor() {
        /** @type {Uint8Array} */
        this._bytes = EMPTY_BYTES
        /** @type {number} */
        this._cursor = 0
        /** @type {number} */
        this._pathStart = -1
        /** @type {number} */
        this._pathEnd = -1
    }

    /**
     * @param {Uint8Array} bytes
     * @returns {string[]|null}
     */
    project(bytes) {
        this._bytes = bytes
        this._cursor = 0
        this._pathStart = -1
        this._pathEnd = -1
        try {
            this._space()
            if (bytes[this._cursor] !== 0x5b || !this._array(GLOSSARY, 0)) { return null }
            this._space()
            if (this._cursor !== bytes.length || this._pathStart < 0) { return null }
            const token = bytes.subarray(this._pathStart, this._pathEnd)
            // TextDecoder cannot consume shared memory. Only the selected
            // path token needs a stable private snapshot, not the glossary.
            const owned = token.buffer instanceof ArrayBuffer ? token : new Uint8Array(token)
            this._bytes = EMPTY_BYTES
            const path = parseJson(decoder.decode(owned))
            return typeof path === 'string' && getImageMediaTypeFromFileName(path) !== null ? [path] : null
        } catch (_) {
            return null
        } finally {
            this._bytes = EMPTY_BYTES
        }
    }

    /**
     * @param {number} mode
     * @param {number} depth
     * @returns {boolean}
     */
    _value(mode, depth) {
        if (depth > MAX_DEPTH) { return false }
        this._pathStart = -1
        this._pathEnd = -1
        this._space()
        const byte = this._bytes[this._cursor]
        if (byte === 0x7b) { return this._object(mode, depth) }
        if (byte === 0x5b && mode === CONTENT) { return this._array(CONTENT, depth) }
        return this._skipValue()
    }

    /**
     * @param {number} mode
     * @param {number} depth
     * @returns {boolean}
     */
    _array(mode, depth) {
        ++this._cursor
        this._space()
        let start = -1
        let end = -1
        if (this._bytes[this._cursor] !== 0x5d) {
            for (;;) {
                if (!this._value(mode === GLOSSARY ? ITEM : CONTENT, depth + 1)) { return false }
                if (this._pathStart >= 0) {
                    if (start >= 0) { return false }
                    start = this._pathStart
                    end = this._pathEnd
                }
                this._space()
                if (this._bytes[this._cursor] !== 0x2c) { break }
                ++this._cursor
            }
        }
        if (this._bytes[this._cursor] !== 0x5d) { return false }
        ++this._cursor
        this._pathStart = start
        this._pathEnd = end
        return true
    }

    /**
     * @param {number} mode
     * @param {number} depth
     * @returns {boolean}
     */
    _object(mode, depth) {
        ++this._cursor
        let selector = 0
        let seen = 0
        let ownStart = -1
        let ownEnd = -1
        let contentStart = -1
        let contentEnd = -1
        this._space()
        if (this._bytes[this._cursor] !== 0x7d) {
            for (;;) {
                this._space()
                const keyStart = this._cursor
                if (!this._string()) { return false }
                const keyEnd = this._cursor
                // An escaped key may name a semantic field. The established
                // collector handles escapes and duplicate-last-key behavior.
                if (this._escaped(keyStart, keyEnd)) { return false }
                let key = 0
                if (this._equals(keyStart, keyEnd, mode === ITEM ? 'type' : 'tag')) {
                    key = 1
                } else if (this._equals(keyStart, keyEnd, 'content')) {
                    key = 2
                } else if (this._equals(keyStart, keyEnd, 'path')) {
                    key = 4
                }
                if ((seen & key) !== 0) { return false }
                seen |= key
                this._space()
                if (this._bytes[this._cursor++] !== 0x3a) { return false }
                this._space()
                if (key === 1 && this._bytes[this._cursor] === 0x22) {
                    const valueStart = this._cursor
                    if (!this._string()) { return false }
                    const valueEnd = this._cursor
                    if (this._escaped(valueStart, valueEnd)) { return false }
                    selector = this._equals(valueStart, valueEnd, mode === ITEM ? 'image' : 'img') ?
                        IMAGE :
                        (mode === ITEM && this._equals(valueStart, valueEnd, 'structured-content') ? STRUCTURED : 0)
                } else if (key === 2 && selector !== IMAGE) {
                    if (!this._value(CONTENT, depth + 1)) { return false }
                    contentStart = this._pathStart
                    contentEnd = this._pathEnd
                } else if (key === 4 && this._bytes[this._cursor] === 0x22) {
                    ownStart = this._cursor
                    if (!this._string()) { return false }
                    ownEnd = this._cursor
                } else if (!this._skipValue()) { return false }
                this._space()
                if (this._bytes[this._cursor] !== 0x2c) { break }
                ++this._cursor
            }
        }
        if (this._bytes[this._cursor] !== 0x7d) { return false }
        ++this._cursor
        if (selector === IMAGE) {
            this._pathStart = ownStart
            this._pathEnd = ownEnd
        } else if (mode === CONTENT || selector === STRUCTURED) {
            this._pathStart = contentStart
            this._pathEnd = contentEnd
        } else {
            this._pathStart = -1
            this._pathEnd = -1
        }
        return true
    }

    /** @returns {boolean} */
    _skipValue() {
        const bytes = this._bytes
        const first = bytes[this._cursor]
        if (first === 0x22) { return this._string() }
        if (first === 0x7b || first === 0x5b) {
            let depth = 1
            ++this._cursor
            while (this._cursor < bytes.length) {
                const byte = bytes[this._cursor]
                if (byte === 0x22) {
                    if (!this._string()) { return false }
                    continue
                }
                ++this._cursor
                if (byte === 0x7b || byte === 0x5b) {
                    if (++depth > MAX_DEPTH) { return false }
                } else if ((byte === 0x7d || byte === 0x5d) && --depth === 0) {
                    return true
                }
            }
            return false
        }
        const start = this._cursor
        while (this._cursor < bytes.length) {
            const byte = bytes[this._cursor]
            if (byte === 0x2c || byte === 0x7d || byte === 0x5d || byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09) { break }
            ++this._cursor
        }
        return this._cursor > start
    }

    /** @returns {boolean} */
    _string() {
        const bytes = this._bytes
        if (bytes[this._cursor] !== 0x22) { return false }
        let start = this._cursor + 1
        for (;;) {
            const end = bytes.indexOf(0x22, start)
            if (end < 0) { return false }
            let escape = end
            while (bytes[escape - 1] === 0x5c) { --escape }
            if (((end - escape) & 1) === 0) {
                this._cursor = end + 1
                return true
            }
            start = end + 1
        }
    }

    /**
     * @param {number} start
     * @param {number} end
     * @param {string} value
     * @returns {boolean}
     */
    _equals(start, end, value) {
        if (end - start !== value.length + 2) { return false }
        for (let i = 0; i < value.length; ++i) {
            if (this._bytes[start + 1 + i] !== value.charCodeAt(i)) { return false }
        }
        return true
    }

    /**
     * @param {number} start
     * @param {number} end
     * @returns {boolean}
     */
    _escaped(start, end) {
        for (let i = start + 1; i < end - 1; ++i) {
            if (this._bytes[i] === 0x5c) { return true }
        }
        return false
    }

    /** Skip JSON whitespace within the producer's bounded source span. */
    _space() {
        for (;;) {
            const byte = this._bytes[this._cursor]
            if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) { break }
            ++this._cursor
        }
    }
}
