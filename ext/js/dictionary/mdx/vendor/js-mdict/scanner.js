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
        const end = Math.min(this._buffer.byteLength, start + length);
        return this._buffer.slice(start, end);
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
