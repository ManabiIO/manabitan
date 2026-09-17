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
import {getTermBankGroupPolicy} from '../ext/js/dictionary/term-bank-group-policy.js'
import {snapshotTermBankExperiments} from '../ext/js/dictionary/term-bank-experiments.js'

/** @typedef {import('dictionary-importer').ImportExperiments} Experiments */
const names = /** @type {Array<keyof Experiments>} */ (['experimentalParserGroups16MiB', 'experimentalParserGroups32MiB', 'experimentalParserGroups48MiB'])

describe('bounded parser group experiments', () => {
    test.each([3, 4])('preserves default and non-lazy policies for %i groups', (groups) => {
        const baseline = {groupsPerWorker: groups, targetGroupBytes: 24 * 1024 * 1024}
        expect(getTermBankGroupPolicy(groups, true)).toEqual(baseline)
        for (const key of names) {
            expect(getTermBankGroupPolicy(groups, false, {[key]: true})).toEqual(baseline)
            for (const value of [false, 0, 1, null, undefined, 'true', {}]) {
                const flags = /** @type {Experiments} */ (/** @type {unknown} */ ({[key]: value}))
                expect(getTermBankGroupPolicy(groups, true, flags)).toEqual(baseline)
                expect(snapshotTermBankExperiments(flags)[key]).toBe(false)
            }
        }
    })
    test.each([3, 4])('bounds the nominal source lead per worker: %i', (groups) => {
        for (const [i, key] of names.entries()) {
            const flags = {[key]: true}
            const policy = getTermBankGroupPolicy(groups, true, flags)
            expect(policy.targetGroupBytes).toBe([16, 32, 48][i] * 1024 * 1024)
            expect(policy.groupsPerWorker).toBeGreaterThanOrEqual(1)
            expect(policy.groupsPerWorker * policy.targetGroupBytes).toBeLessThanOrEqual(groups * 24 * 1024 * 1024)
            expect(snapshotTermBankExperiments(flags)[key]).toBe(true)
        }
    })
    test.each([3, 4])('conflicting experiments use the baseline: %i', (groups) => {
        for (let mask = 1; mask < 8; mask++) {
            const enabled = names.filter((_, i) => (mask & (1 << i)) !== 0)
            if (enabled.length < 2) { continue }
            expect(getTermBankGroupPolicy(groups, true, Object.fromEntries(enabled.map((key) => [key, true])))).toEqual({groupsPerWorker: groups, targetGroupBytes: 24 * 1024 * 1024})
        }
    })
    test('has no mutable state across alternating imports', () => {
        const flags = {experimentalParserGroups32MiB: true}
        const frozen = snapshotTermBankExperiments(flags)
        flags.experimentalParserGroups32MiB = false
        expect(getTermBankGroupPolicy(4, true, frozen).targetGroupBytes).toBe(32 * 1024 * 1024)
        expect(getTermBankGroupPolicy(4, true, flags).targetGroupBytes).toBe(24 * 1024 * 1024)
        expect(getTermBankGroupPolicy(4, true).groupsPerWorker).toBe(4)
        expect(getTermBankGroupPolicy(3, true, {experimentalParserGroups48MiB: true}).groupsPerWorker).toBe(1)
        expect(getTermBankGroupPolicy(4, true).targetGroupBytes).toBe(24 * 1024 * 1024)
    })
})
