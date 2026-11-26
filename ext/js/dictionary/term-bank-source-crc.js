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

import {DictionarySourceIntegrityError} from './dictionary-source-integrity-error.js'
import {safePerformance} from '../core/safe-performance.js'

/**
 * Complete the parser worker's private source transaction before any source or
 * result view escapes. With no complete fused result, verify the original banks
 * directly. A rejected source stays rejected through cleanup and retry.
 * @param {import('./term-bank-wasm-parser.js').PreloadedTermBankSource|null} source
 * @param {number} [metasPtr]
 * @param {number} [rowCount]
 * @param {number} [witnessesPtr]
 * @param {boolean} [compactMetadata]
 * @throws {Error} If source integrity or verifier metadata is invalid.
 */
export function verifyTermBankSourceCrc(source, metasPtr = 0, rowCount = 0, witnessesPtr = 0, compactMetadata = false) {
    if (source === null || !source.crcSignaturesPtr || source.crcVerified) { return }
    if (source.crcError instanceof Error) { throw source.crcError }
    const verify = source.wasm.verify_term_bank_source_crcs
    if (typeof verify !== 'function') { throw new Error('Term-bank source CRC verifier is unavailable') }
    const startedAt = safePerformance.now()
    let result
    try {
        result = verify(
            source.jsonPtr,
            source.jsonLength,
            source.bankSpansPtr ?? 0,
            source.bankSpanCount ?? 0,
            source.crcSignaturesPtr,
            metasPtr,
            rowCount,
            witnessesPtr,
            source.crcStatsPtr ?? 0,
            compactMetadata ? 1 : 0,
        )
    } catch (error) {
        source.crcError = error instanceof Error ? error : new Error('Term-bank source CRC verification failed', {cause: error})
        throw source.crcError
    } finally {
        source.crcMs = Math.max(0, safePerformance.now() - startedAt)
    }
    if (result !== 0) {
        source.crcError = result === -4 ?
            new DictionarySourceIntegrityError('Compressed term-bank source failed validation: inflated bytes do not match the ZIP CRC32') :
            new Error(`Term-bank source CRC verifier failed with code ${result}`)
        throw source.crcError
    }
    source.crcVerified = true
    if (source.crcStatsPtr) {
        const stats = new Uint32Array(source.wasm.memory.buffer, source.crcStatsPtr, 3)
        source.crcScannedBytes = stats[0]
        source.crcReusedBytes = stats[1]
        source.crcReusedGlossaryCount = stats[2]
    }
}
