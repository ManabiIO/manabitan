/*
 * Copyright (C) 2026  Manabitan authors
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

import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {median} from '../benchmark-support.js'

export const baselineSha = '7d1643e6147a10cb2165e9744cf0e63b59e46632'

export const baselineTree = '99d23f16e973c7ae9feba77ca3643d1c27dfb93d'

export const candidates = {
    startup: {sha: 'afd8b69d0460195b5f56f6f24a6738ba4fee47a6', tree: '53784cdf7a9b4ed75e3c9b4578aaff42e59b64c7', target: 'jmdict'},
    media: {sha: '8994b3ff5be56f1b7d972760c0d9684a262a7296', tree: '509a77c356300268d464ecc1fb18d3d0d91a67a5', target: 'vndb'},
}

export const dictionaries = ['jmdict', 'jitendex', 'vndb']

/** @typedef {{arm: string, phase: string, cohort: number|null, mediaCheck: 'sample'|'all'}} ScheduledRun */
/** @typedef {ScheduledRun & {status: string, totalImportMs?: number, workerImportMs?: number|null, storageBytes?: number}} Observation */

/** @returns {ScheduledRun[]} */
export function createSchedule() {
    /** @type {ScheduledRun[]} */
    const schedule = [...'ABC'].map((arm) => ({arm, phase: 'warmup', cohort: null, mediaCheck: 'sample'}))
    for (const [cohort, order] of ['ABC', 'BCA', 'CAB', 'ACB', 'CBA', 'BAC'].entries()) {
        for (const arm of order) { schedule.push({arm, phase: 'timed', cohort, mediaCheck: 'sample'}) }
    }
    for (const arm of 'AB') { schedule.push({arm, phase: 'validation', cohort: null, mediaCheck: 'all'}) }
    return schedule
}

/**
 * The existing harness has already validated every observation. Compare the
 * exact public lookup results (including stable fresh-profile IDs) and verified
 * media bytes across sources, excluding lookup times. The existing restart
 * probe digest includes physical offsets and remains a per-run diagnostic.
 * This is not a complete database digest or an ID-independent semantic hash.
 * @param {Record<string, unknown>} validation
 * @returns {string}
 */
export function validationFingerprint(validation) {
    const lookup = /** @type {{observations: Array<{pass: number, term: string, results: number, sha256: string}>}} */ (validation.lookup)
    return createHash('sha256').update(JSON.stringify({
        title: validation.title,
        revision: validation.revision,
        termRows: validation.termRows,
        probeTerms: validation.probeTerms,
        media: validation.media,
        lookup: lookup.observations.map(({pass, term, results, sha256}) => ({pass, term, results, sha256})),
    })).digest('hex')
}

/**
 * Never calculate a success statistic from an incomplete or filtered campaign.
 * The scheduled warmup and exhaustive-validation runs remain in the receipt.
 * @param {Observation[]} observations
 * @returns {object}
 */
export function analyze(observations) {
    const schedule = createSchedule()
    assert.equal(observations.length, schedule.length, 'Incomplete qualification schedule')
    for (const [index, row] of observations.entries()) {
        const {arm, phase, cohort, mediaCheck} = row
        assert.deepEqual({arm, phase, cohort, mediaCheck}, schedule[index], 'Changed or reordered schedule')
        assert.equal(row.status, 'success', 'Failed observation must not be filtered')
        assert(Number.isFinite(row.totalImportMs) && Number(row.totalImportMs) > 0, 'Invalid import duration')
    }
    const timed = observations.filter((row) => row.phase === 'timed')
    const medians = Object.fromEntries([...'ABC'].map((arm) => {
        const rows = timed.filter((row) => row.arm === arm)
        return [arm, {
            totalImportMs: median(rows.map((row) => row.totalImportMs ?? null)),
            workerImportMs: median(rows.map((row) => row.workerImportMs ?? null)),
            storageBytes: median(rows.map((row) => row.storageBytes ?? null)),
        }]
    }))
    const comparisons = Object.fromEntries([['B', 'A'], ['B', 'C'], ['C', 'A']].map(([numerator, denominator]) => {
        const pairs = Array.from({length: 6}, (_, cohort) => {
            const a = /** @type {number} */ (timed.find((row) => row.cohort === cohort && row.arm === denominator)?.totalImportMs)
            const b = /** @type {number} */ (timed.find((row) => row.cohort === cohort && row.arm === numerator)?.totalImportMs)
            return {cohort, differenceMs: b - a, ratio: b / a, changePct: 100 * (b / a - 1)}
        })
        return [`${numerator}/${denominator}`, {
            medianDifferenceMs: median(pairs.map((pair) => pair.differenceMs)),
            medianChangePct: median(pairs.map((pair) => pair.changePct)),
            faster: pairs.filter((pair) => pair.ratio < 1).length,
            pairs,
        }]
    }))
    return {medians, comparisons, qualified: false, limitation: 'One hosted screen: independent-host replication, process memory, and complete persisted database equality remain unmeasured.'}
}
