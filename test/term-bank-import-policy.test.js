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

/* eslint @stylistic/semi: ["error", "never"] */

import {describe, expect, test} from 'vitest'
import {resolveTermBankImportExperiments, snapshotTermBankExperiments} from '../ext/js/dictionary/term-bank-experiments.js'

const enabled = new Set(['experimentalNativeSegmentedLookup'])
const keys = Object.keys(snapshotTermBankExperiments())

describe('bounded native import policy', () => {
    test('enables only native segmentation at the import boundary, not parser defaults', () => {
        const policy = resolveTermBankImportExperiments()
        for (const key of keys) {
            expect(Reflect.get(policy, key)).toBe(enabled.has(key))
            expect(Reflect.get(snapshotTermBankExperiments(), key)).toBe(false)
        }
        expect(Object.isFrozen(policy)).toBe(true)
    })

    test.each(keys)('retains strict explicit overrides for %s', (key) => {
        for (const value of [true, false, undefined, null, 0, 1, 'true', 'false']) {
            const policy = resolveTermBankImportExperiments({[key]: value})
            for (const other of keys) {
                expect(Reflect.get(policy, other)).toBe(other === key ? value === true : enabled.has(other))
            }
        }
    })

    test('preserves a fully disabled control and snapshots without cross-import leakage', () => {
        const options = Object.fromEntries(keys.map((key) => [key, false]))
        const disabled = resolveTermBankImportExperiments(options)
        expect(disabled).toEqual(snapshotTermBankExperiments())
        options.experimentalNativeSegmentedLookup = true
        expect(disabled.experimentalNativeSegmentedLookup).toBe(false)
        expect(resolveTermBankImportExperiments().experimentalNativeSegmentedLookup).toBe(true)
        expect(resolveTermBankImportExperiments()).not.toBe(resolveTermBankImportExperiments())
        expect(snapshotTermBankExperiments(resolveTermBankImportExperiments())).toEqual(resolveTermBankImportExperiments())
    })
})
