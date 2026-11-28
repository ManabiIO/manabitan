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
 * Copies media diagnostic keys into compact owned byte/span columns.
 * Decoded strings stay verbatim so lone surrogates do not pass through a
 * lossy UTF-8 encode/decode round trip.
 * @param {Array<string|Uint8Array>} keys Expression/reading pairs.
 * @param {number} byteLength Validated byte total, counting aliased pairs once.
 * @returns {import('dictionary-importer').MediaImportDiagnosticKeys}
 */
export function copyMediaDiagnosticKeys(keys, byteLength) {
    const bytes = new Uint8Array(byteLength);
    const spans = new Uint32Array(keys.length * 2);
    /** @type {Map<number, string>|null} */
    let decodedKeys = null;
    let offset = 0;
    for (let i = 0; i < keys.length; i += 2) {
        const expression = keys[i];
        const reading = keys[i + 1];
        const expressionOffset = offset;
        const expressionLength = typeof expression === 'string' ? 0 : expression.byteLength;
        if (typeof expression === 'string') {
            (decodedKeys ??= new Map()).set(i, expression);
        } else {
            bytes.set(expression, offset);
            offset += expressionLength;
        }
        const readingOffset = reading === expression ? expressionOffset : offset;
        const readingLength = typeof reading === 'string' ? 0 : reading.byteLength;
        if (typeof reading === 'string') {
            (decodedKeys ??= new Map()).set(i + 1, reading);
        } else if (reading !== expression) {
            bytes.set(reading, offset);
            offset += readingLength;
        }
        const spanIndex = i * 2;
        spans[spanIndex] = expressionOffset;
        spans[spanIndex + 1] = expressionLength;
        spans[spanIndex + 2] = readingOffset;
        spans[spanIndex + 3] = readingLength;
    }
    return {bytes, spans, decodedKeys};
}
