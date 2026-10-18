/*
 * Copyright (C) 2023-2026  Yomitan Authors
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
 * Utility function to convert an unknown value to an error.
 * This is useful for try-catch situations where the catch parameter has the `unknown` type.
 * @param {unknown} value
 * @returns {Error}
 */
export function toError(value) {
    if (value instanceof Error) { return value; }
    try {
        // String() supports Symbol values, unlike template interpolation.
        return new Error(String(value));
    } catch (e) {
        // Unknown thrown values can have a missing or throwing toString().
        // Converting an exception into an Error must never throw again.
        return new Error('Unknown error');
    }
}
