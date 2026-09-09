/*
 * Copyright (C) 2023-2025  Yomitan Authors
 * Copyright (C) 2016-2022  Yomichan Authors
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

/**
 * Copies a stable byte view into an exact-sized, private buffer. The caller
 * must keep the source alive and unmodified until this synchronous call ends;
 * this is not a snapshot protocol for concurrently modified shared memory.
 *
 * For large unaligned shared views, first copy an aligned tail, then move it
 * inside the private destination and fill the short prefix. This avoids the
 * slow unaligned shared-byte copy in affected engines without retaining
 * padding, borrowing the source, or reading outside the requested view.
 * @param {Uint8Array} source
 * @returns {Uint8Array}
 */
export function copyStableByteView(source) {
    const length = source.byteLength;
    const prefix = (8 - (source.byteOffset & 7)) & 7;
    if (
        prefix === 0 || length < 1024 ||
        typeof SharedArrayBuffer === 'undefined' || !(source.buffer instanceof SharedArrayBuffer)
    ) {
        // eslint-disable-next-line unicorn/prefer-spread -- TypedArray ownership and return type must be preserved.
        return source.slice();
    }
    const owned = new Uint8Array(length);
    owned.set(source.subarray(prefix));
    owned.copyWithin(prefix, 0, length - prefix);
    owned.set(source.subarray(0, prefix));
    return owned;
}
