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

import {safePerformance} from '../core/safe-performance.js'
import {INDEX_IO_DIAGNOSTIC_ARM} from './term-record-import-index-diagnostic-arm.js'

/**
 * @typedef {Record<string, string|number|boolean|null>} IndexIoDiagnosticDetails
 * @typedef {IndexIoDiagnosticDetails & {sequence: number, realm: string, type: string, startMs: number, endMs: number, timeOriginMs: number}} IndexIoDiagnosticEvent
 * @typedef {{schemaVersion: 1, arm: 'A'|'B'|'C', purpose: 'mechanistic-diagnostic-only', events: IndexIoDiagnosticEvent[]}} IndexIoDiagnosticReceipt
 */

/** @type {IndexIoDiagnosticEvent[]} */
let events = []
let sequence = 0
let identifier = 0
let realm = 'record-store'
let active = false

/**
 * One serialized import owns the store realm; each I/O worker starts afresh.
 * Only diagnostic builds import this module. No payload bytes are retained.
 * @param {string} [name='record-store']
 */
export function resetIndexIoDiagnostic(name = 'record-store') {
    events = []
    sequence = 0
    identifier = 0
    realm = name
    active = true
}

/** @returns {number} */
export function nextIndexIoDiagnosticId() { return ++identifier }

/**
 * Realm monotonic clocks are reported separately. timeOrigin is descriptive,
 * not a claim that separately rounded clocks have sub-millisecond alignment.
 * @param {string} type
 * @param {IndexIoDiagnosticDetails} [details={}]
 * @param {number} [startMs]
 */
export function recordIndexIoDiagnostic(type, details = {}, startMs = safePerformance.now()) {
    if (!active) { return }
    events.push({
        ...details,
        sequence: ++sequence,
        realm,
        type,
        startMs,
        endMs: safePerformance.now(),
        timeOriginMs: globalThis.performance.timeOrigin,
    })
}

/**
 * Worker events piggyback on its existing ready/response messages; no added IPC.
 * @returns {IndexIoDiagnosticEvent[]}
 */
export function drainIndexIoDiagnosticEvents() {
    const result = events
    events = []
    return result
}

/** @param {IndexIoDiagnosticEvent[]|undefined} incoming */
export function appendIndexIoDiagnosticEvents(incoming) {
    if (active && Array.isArray(incoming)) { events.push(...incoming) }
}

/** @returns {IndexIoDiagnosticReceipt} */
export function getIndexIoDiagnosticReceipt() {
    return {schemaVersion: 1, arm: INDEX_IO_DIAGNOSTIC_ARM, purpose: 'mechanistic-diagnostic-only', events: [...events]}
}
