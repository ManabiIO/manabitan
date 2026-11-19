/* SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */

/**
 * Same-length keys share a long prefix but every expression and reading is
 * unique. This exercises the extra exact-comparison cost without reuse hits.
 * Fixture construction stays outside any timed parser region.
 * @param {number} [rowCount]
 * @returns {string[]}
 */
export function createUniqueKeyBanks(rowCount = 20000) {
    if (!Number.isSafeInteger(rowCount) || rowCount < 1 || rowCount > 999999) {
        throw new RangeError('Invalid unique-key fixture row count')
    }
    const banks = []
    for (let start = 0; start < rowCount; start += 10000) {
        const rows = []
        for (let index = start; index < Math.min(start + 10000, rowCount); ++index) {
            const suffix = String(index).padStart(6, '0')
            rows.push([`固有項目${suffix}`, `ことば${suffix}`, '', '', 1, ['shared definition'], index + 1, ''])
        }
        banks.push(JSON.stringify(rows))
    }
    return banks
}
