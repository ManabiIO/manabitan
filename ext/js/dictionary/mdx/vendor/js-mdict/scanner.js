// @ts-nocheck
/*
 * Adapted from js-mdict (MIT).
 */

export class FileScanner {
    /**
     * @param {Uint8Array|ArrayBuffer} source
     */
    constructor(source) {
        this.offset = 0;
        this._buffer = source instanceof Uint8Array ? source : new Uint8Array(source);
    }

    close() {
        // NOP
    }

    /**
     * @param {number|bigint} offset
     * @param {number} length
     * @returns {Uint8Array}
     */
    readBuffer(offset, length) {
        const start = Number(offset);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 || start > this._buffer.byteLength || length > this._buffer.byteLength - start) {
            throw new RangeError(`MDict read out of bounds: offset=${start}, length=${length}, size=${this._buffer.byteLength}`);
        }
        return this._buffer.slice(start, start + length);
    }

    /**
     * @param {number|bigint} offset
     * @param {number} length
     * @returns {DataView}
     */
    readNumber(offset, length) {
        const buffer = this.readBuffer(offset, length);
        return new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    }
}
