/*
 * Copyright (C) 2026  Yomitan Authors
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
 * Recognizes only explicit allocator failures, not decoder bounds or traps.
 * @param {unknown} error
 * @returns {boolean}
 */
export function isZstdResourceError(error) {
    if (!(error instanceof Error)) { return false; }
    switch (error.message) {
        case 'Failed to allocate Zstd input buffer':
        case 'Failed to allocate Zstd destination buffer':
        case 'Failed to allocate Zstd dictionary buffer':
            return true;
        case 'Array buffer allocation failed':
        case 'Failed to allocate ArrayBuffer':
        case 'WebAssembly.Memory.grow(): Out of memory':
        case 'WebAssembly.Memory.grow(): Maximum memory size exceeded':
        case 'WebAssembly.Memory.grow(): Unable to grow instance memory':
        case 'Memory.grow(): Out of memory':
        case 'Memory.grow(): Maximum memory size exceeded':
        case 'Memory.grow(): Unable to grow instance memory':
            return error instanceof RangeError;
        case 'Aborted(OOM)':
        case 'memory allocation failed':
            return error instanceof WebAssembly.RuntimeError;
        default:
            return false;
    }
}
