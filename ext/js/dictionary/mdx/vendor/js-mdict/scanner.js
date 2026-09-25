// @ts-nocheck
/*
 * Adapted from js-mdict (MIT).
 */

export class FileScanner {
    /**
     * @param {Uint8Array|ArrayBuffer} source
     */
    constructor(source) {
        if (!(source instanceof Uint8Array) && !(source instanceof ArrayBuffer)) {
            throw new TypeError('MDict source must be an ArrayBuffer or Uint8Array');
        }
        this.offset = 0;
        this._buffer = source instanceof Uint8Array ? source : new Uint8Array(source);
    }

    close() {
        this._buffer = new Uint8Array(0);
    }

    /**
     * @param {number|bigint} offset
     * @param {number} length
     * @returns {Uint8Array}
     */
    readBuffer(offset, length) {
        return this.readBufferView(offset, length).slice();
    }

    /**
     * Returns a borrowed view into the scanner source. Callers must treat it as read-only.
     * @param {number|bigint} offset
     * @param {number} length
     * @returns {Uint8Array}
     */
    readBufferView(offset, length) {
        const start = Number(offset);
        if ((typeof offset !== 'number' && typeof offset !== 'bigint') ||
            !Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 ||
            start > this._buffer.byteLength || length > this._buffer.byteLength - start) {
            throw new RangeError('MDict read exceeds the available file data');
        }
        return this._buffer.subarray(start, start + length);
    }

    /**
     * @param {number|bigint} offset
     * @param {number} length
     * @returns {DataView}
     */
    readNumber(offset, length) {
        const buffer = this.readBufferView(offset, length);
        return new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    }
}
