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
 * Trims a ranked terms response while preserving Array#splice limit semantics.
 * @template T
 * @param {T[]} dictionaryEntries
 * @param {number|undefined} responseLimit
 * @returns {T[]}
 */
export function limitFindTermsResponse(dictionaryEntries, responseLimit) {
    if (typeof responseLimit === 'number') { dictionaryEntries.splice(responseLimit); }
    return dictionaryEntries;
}
