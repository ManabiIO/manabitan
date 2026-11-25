/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {describe, expect, test} from 'vitest'
import {analyze, createSchedule, validationFingerprint} from '../dev/perf/import-qualification/analysis.js'

/** @returns {import('../dev/perf/import-qualification/analysis.js').Observation[]} */
function observations() {
    return createSchedule().map((entry) => ({...entry, status: 'success', totalImportMs: entry.arm === 'B' ? 80 : 100, workerImportMs: null, storageBytes: 1000}))
}

describe('fixed import qualification analysis', () => {
    test('balances each arm in each position and excludes only scheduled warmups', () => {
        const schedule = createSchedule()
        expect(schedule).toHaveLength(23)
        expect(schedule.slice(0, 3).map((row) => row.phase)).toEqual(['warmup', 'warmup', 'warmup'])
        for (const arm of 'ABC') {
            for (let position = 0; position < 3; position++) {
                expect(schedule.filter((row, index) => row.phase === 'timed' && row.arm === arm && (index - 3) % 3 === position)).toHaveLength(2)
            }
        }
        const rows = observations()
        rows[0].totalImportMs = 1_000_000
        rows[22].totalImportMs = 1_000_000
        const result = /** @type {{medians: {A: {totalImportMs: number}}, comparisons: Record<string, {medianChangePct: number}>, qualified: boolean}} */ (analyze(rows))
        expect(result.medians.A.totalImportMs).toBe(100)
        expect(result.comparisons['B/A'].medianChangePct).toBeCloseTo(-20)
        expect(result.comparisons['C/A'].medianChangePct).toBe(0)
        expect(result.qualified).toBe(false)
    })

    test('retains same-source control drift separately from candidate effects', () => {
        const rows = observations()
        for (const row of rows) {
            if (row.arm === 'C') { row.totalImportMs = 125 }
        }
        const result = /** @type {{comparisons: Record<string, {medianChangePct: number}>}} */ (analyze(rows))
        expect(result.comparisons['B/A'].medianChangePct).toBeCloseTo(-20)
        expect(result.comparisons['B/C'].medianChangePct).toBeCloseTo(-36)
        expect(result.comparisons['C/A'].medianChangePct).toBeCloseTo(25)
    })

    test('uses paired changes rather than a ratio of unmatched medians', () => {
        const rows = observations()
        const candidateTimes = [9, 18, 27, 44, 55, 66]
        for (const row of rows) {
            if (row.cohort !== null) { row.totalImportMs = row.arm === 'B' ? candidateTimes[row.cohort] : (row.cohort + 1) * 10 }
        }
        const result = /** @type {{comparisons: Record<string, {medianChangePct: number, medianDifferenceMs: number}>}} */ (analyze(rows))
        expect(result.comparisons['B/A'].medianChangePct).toBeCloseTo(0)
        expect(result.comparisons['B/A'].medianDifferenceMs).toBe(1.5)
    })

    test('refuses missing, failed, reordered, or invalid observations', () => {
        expect(() => analyze(observations().slice(1))).toThrow(/Incomplete/)
        const failed = observations()
        failed[10].status = 'failed'
        expect(() => analyze(failed)).toThrow(/Failed/)
        const reordered = observations()
        const first = reordered[3]
        reordered[3] = reordered[4]
        reordered[4] = first
        expect(() => analyze(reordered)).toThrow(/schedule/)
        const invalid = observations()
        invalid[8].totalImportMs = Number.NaN
        expect(() => analyze(invalid)).toThrow(/duration/)
    })

    test('compares output bytes and lookup results while ignoring lookup timing', () => {
        const validation = {termRows: 1, media: {sha256: 'media'}, outputDigestSha256: 'content', lookup: {observations: [{pass: 0, term: '猫', results: 1, sha256: 'lookup', elapsedMs: 1}]}}
        const changed = structuredClone(validation)
        changed.lookup.observations[0].elapsedMs = 100
        changed.outputDigestSha256 = 'different-physical-placement'
        expect(validationFingerprint(changed)).toBe(validationFingerprint(validation))
        changed.lookup.observations[0].results = 2
        expect(validationFingerprint(changed)).not.toBe(validationFingerprint(validation))
        changed.lookup.observations[0].results = 1
        changed.media.sha256 = 'different-media'
        expect(validationFingerprint(changed)).not.toBe(validationFingerprint(validation))
    })
})
