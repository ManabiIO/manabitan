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

const MAX_FILENAME_BYTES = 65_535
const DECODE_WINDOW_BYTES = MAX_FILENAME_BYTES + 1

/**
 * Create a bounded decoder for the printable ASCII filename arena. Admitted
 * ZIP names are at most 65,535 bytes, so each returned string fits one window.
 * @param {Uint8Array} filenames
 * @returns {(start: number, end: number) => string}
 */
export function createDenseZipFilenameDecoder(filenames) {
    const decoder = new TextDecoder()
    let decodedStart = -1
    let decodedNames = ''
    return (start, end) => {
        if (start < decodedStart || end > decodedStart + decodedNames.length) {
            decodedStart = start
            decodedNames = decoder.decode(filenames.subarray(start, start + DECODE_WINDOW_BYTES))
        }
        return decodedNames.slice(start - decodedStart, end - decodedStart)
    }
}
