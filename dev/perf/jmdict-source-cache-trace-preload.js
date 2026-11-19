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
/* eslint-disable no-underscore-dangle -- Diagnostic wrappers observe the production private cache ABI without changing its policy. */

import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {lstat, mkdir, readFile, realpath, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'

/** @typedef {import('../../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} Database */
/** @typedef {'fifo'|'lru-resident-lookup'|'lru-valid-hit'|'lru-exact-match'} Policy */
/** @typedef {{kind: 'publication', event: number, group: number, batchId: number|null, admitted: boolean, budgetBytes: number, retainedSpanBytes: number, copiedBytes: number, minimumOffset: number|null, maximumEnd: number, publishedCount: number, publishedContentBytes: number, repeatedWithinGroupCount: number, repeatedWithinGroupBytes: number, residentBytesBefore: number, residentBytesAfter: number, evictedBatchIds: number[]}} Publication */
/** @typedef {{kind: 'lookup', event: number, group: number, tableIndex: number|null, batchId: number|null, originPublicationEvent: number|null, sourceOffset: number|null, requestedBytes: number, multiplicityWithinOriginGroup: number, actualHit: boolean, missReason: string|null, exactEqual: boolean|null}} Lookup */
/** @typedef {Publication|Lookup} CacheEvent */
/** @typedef {{group: number, events: CacheEvent[], publications: Publication[], originEvents: Uint32Array, multiplicities: Uint32Array, currentMultiplicity: Map<number, number>, pendingComparison: {event: Lookup, buffer: Uint8Array, offset: number, length: number}|null, budgetBytes: number|null}} TraceState */
/** @typedef {{banks: string[], rows: number, sourceBytes: number, dictionaryTotalRows: number, pipelineProgress: {processedRows: number, totalRows: number, chunkIndex: number, chunkCount: number}, isFinalTermChunk: boolean}} TraceGroup */
/** @typedef {{harnessSemanticsVersion: number, source: unknown, harnessSha256: string, fixture: unknown, rows: number, policy: {groupCount: number}, groupResults: TraceGroup[], verification: {sha256: string}|null, storedFilesCanonicalSha256: string}} TraceComponentReport */

const MIB = 1024 * 1024
const scriptPath = fileURLToPath(import.meta.url)
const instrumentationKey = Symbol.for('manabitan.perf.instrumentation')
const finalizeKey = Symbol.for('manabitan.perf.finalize')

/**
 * Replay whole-batch retention with exact byte budgets and no miss refills.
 * A lookup can touch only a currently resident batch. Exact-match LRU remains
 * explicitly unqualified if its simulated hit needs an unobserved comparison.
 * @param {CacheEvent[]} events
 * @param {number} budgetBytes
 * @param {Policy} policy
 * @returns {{budgetBytes: number, policy: Policy, hits: number, misses: number, hitBytes: number, missBytes: number, promotions: number, evictions: number, admittedBatches: number, rejectedBatches: number, retainedBytes: number, peakRetainedBytes: number, unknownExactPromotions: number, observationMismatches: number, finalResidentBatchIds: number[]}}
 */
export function replaySourceCache(events, budgetBytes, policy) {
    assert.ok(Number.isSafeInteger(budgetBytes) && budgetBytes > 0)
    /** @type {Map<number, number>} */
    const resident = new Map()
    let retainedBytes = 0
    let peakRetainedBytes = 0
    let hits = 0
    let misses = 0
    let hitBytes = 0
    let missBytes = 0
    let promotions = 0
    let evictions = 0
    let admittedBatches = 0
    let rejectedBatches = 0
    let unknownExactPromotions = 0
    let observationMismatches = 0
    for (const event of events) {
        if (event.kind === 'publication') {
            // A batch rejected by the observed maximum budget cannot become
            // admissible at any of the smaller replay budgets used below.
            if (!event.admitted || event.batchId === null || event.copiedBytes > budgetBytes) {
                ++rejectedBatches
                continue
            }
            while (retainedBytes + event.copiedBytes > budgetBytes && resident.size > 0) {
                const oldest = resident.entries().next().value
                assert.ok(oldest)
                resident.delete(oldest[0])
                retainedBytes -= oldest[1]
                ++evictions
            }
            assert.ok(!resident.has(event.batchId), 'Batch IDs must not repeat')
            resident.set(event.batchId, event.copiedBytes)
            retainedBytes += event.copiedBytes
            peakRetainedBytes = Math.max(peakRetainedBytes, retainedBytes)
            ++admittedBatches
            continue
        }
        const bytes = event.batchId === null ? void 0 : resident.get(event.batchId)
        const present = typeof bytes === 'number'
        const hit = present && event.sourceOffset !== null && event.sourceOffset >= 0 &&
        event.requestedBytes >= 0 && event.sourceOffset <= bytes && event.requestedBytes <= bytes - event.sourceOffset
        if (hit) {
            ++hits
            hitBytes += event.requestedBytes
        } else {
            ++misses
            missBytes += event.requestedBytes
        }
        if (hit !== event.actualHit) { ++observationMismatches }
        const promote = (
            (policy === 'lru-resident-lookup' && present) ||
            (policy === 'lru-valid-hit' && hit) ||
            (policy === 'lru-exact-match' && hit && event.exactEqual === true)
        )
        if (policy === 'lru-exact-match' && hit && event.exactEqual === null) { ++unknownExactPromotions }
        if (promote && event.batchId !== null) {
            assert.ok(typeof bytes === 'number')
            resident.delete(event.batchId)
            resident.set(event.batchId, bytes)
            ++promotions
        }
    }
    return {budgetBytes, policy, hits, misses, hitBytes, missBytes, promotions, evictions, admittedBatches, rejectedBatches, retainedBytes, peakRetainedBytes, unknownExactPromotions, observationMismatches, finalResidentBatchIds: [...resident.keys()]}
}

/**
 * @param {CacheEvent[]} events
 * @returns {Record<string, unknown>}
 */
function summarizeDemand(events) {
    const publications = events.filter((event) => event.kind === 'publication')
    const lookups = events.filter((event) => event.kind === 'lookup')
    /** @type {Map<number, Lookup>} */
    const unique = new Map()
    for (const event of lookups) {
        if (event.tableIndex !== null && !unique.has(event.tableIndex)) { unique.set(event.tableIndex, event) }
    }
    const uniqueRequests = [...unique.values()]
    const perPublication = publications.map((publication) => {
        const requests = lookups.filter((event) => event.originPublicationEvent === publication.event)
        const publicationUniqueRequests = [...new Map(requests.filter((event) => event.tableIndex !== null).map((event) => [event.tableIndex, event])).values()]
        const requestedUniqueBytes = publicationUniqueRequests.reduce((total, event) => total + event.requestedBytes, 0)
        return {
            event: publication.event,
            batchId: publication.batchId,
            group: publication.group,
            publishedCount: publication.publishedCount,
            publishedContentBytes: publication.publishedContentBytes,
            copiedBytes: publication.copiedBytes,
            retainedSpanBytes: publication.retainedSpanBytes,
            spanOverheadBytes: publication.retainedSpanBytes - publication.publishedContentBytes,
            requests: requests.length,
            requestedBytes: requests.reduce((total, event) => total + event.requestedBytes, 0),
            requestedUniqueIndexes: publicationUniqueRequests.length,
            requestedUniqueBytes,
            requestedUniqueFractionOfCopiedBytes: publication.copiedBytes > 0 ? requestedUniqueBytes / publication.copiedBytes : null,
            repeatedWithinGroupCount: publication.repeatedWithinGroupCount,
            repeatedWithinGroupBytes: publication.repeatedWithinGroupBytes,
            requestedUniqueRepeatedWithinGroup: publicationUniqueRequests.filter((event) => event.multiplicityWithinOriginGroup >= 2).length,
            requestedUniqueRepeatedWithinGroupBytes: publicationUniqueRequests.filter((event) => event.multiplicityWithinOriginGroup >= 2).reduce((total, event) => total + event.requestedBytes, 0),
        }
    })
    return {
        publications: publications.length,
        lookupCount: lookups.length,
        actualHits: lookups.filter((event) => event.actualHit).length,
        actualMisses: lookups.filter((event) => !event.actualHit).length,
        actualEqualComparisons: lookups.filter((event) => event.exactEqual === true).length,
        actualUnequalComparisons: lookups.filter((event) => event.exactEqual === false).length,
        actualUnobservedComparisons: lookups.filter((event) => event.exactEqual === null).length,
        publishedCount: publications.reduce((total, event) => total + event.publishedCount, 0),
        publishedContentBytes: publications.reduce((total, event) => total + event.publishedContentBytes, 0),
        copiedBytes: publications.reduce((total, event) => total + event.copiedBytes, 0),
        requestedBytes: lookups.reduce((total, event) => total + event.requestedBytes, 0),
        requestedUniqueIndexes: uniqueRequests.length,
        requestedUniqueBytes: uniqueRequests.reduce((total, event) => total + event.requestedBytes, 0),
        requestedUniqueRepeatedWithinGroup: uniqueRequests.filter((event) => event.multiplicityWithinOriginGroup >= 2).length,
        requestedUniqueRepeatedWithinGroupBytes: uniqueRequests.filter((event) => event.multiplicityWithinOriginGroup >= 2).reduce((total, event) => total + event.requestedBytes, 0),
        perPublication,
    }
}

/**
 * @param {string} sourcePath
 * @param {string} outputPath
 * @returns {Promise<void>}
 */
async function installTrace(sourcePath, outputPath) {
    const source = await realpath(sourcePath)
    const output = path.resolve(outputPath)
    try {
        await lstat(output)
        assert.fail(`Trace output already exists: ${output}`)
    } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) { throw error }
    }
    assert.equal(Reflect.get(globalThis, instrumentationKey), void 0, 'Trace must run without another instrumentation preload')
    assert.equal(Reflect.get(globalThis, finalizeKey), void 0, 'Trace requires the diagnostic finalizer slot')
    const preloadSha256 = createHash('sha256').update(await readFile(scriptPath)).digest('hex')
    // eslint-disable-next-line no-unsanitized/method -- The caller explicitly selects a trusted local checkout.
    const imported = /** @type {unknown} */ (await import(pathToFileURL(path.join(source, 'ext/js/dictionary/dictionary-database.js')).href))
    const {DictionaryDatabase} = /** @type {typeof import('../../ext/js/dictionary/dictionary-database.js')} */ (imported)
    const prototype = /** @type {Database} */ (DictionaryDatabase.prototype)
    // The wrappers invoke these captured functions with their original receiver.
    const originalBulk = /** @type {Database['_bulkAddArtifactTermsChunkWithContentDedup']} */ (Reflect.get(prototype, '_bulkAddArtifactTermsChunkWithContentDedup'))
    const originalPublish = /** @type {Database['_cacheRecentPublishedTermContentSources']} */ (Reflect.get(prototype, '_cacheRecentPublishedTermContentSources'))
    const originalFind = /** @type {Database['_findRecentTermContentSource']} */ (Reflect.get(prototype, '_findRecentTermContentSource'))
    const originalEqual = /** @type {Database['_termContentBytesEqualSpan']} */ (Reflect.get(prototype, '_termContentBytesEqualSpan'))
    /** @type {WeakMap<Database, TraceState>} */
    const states = new WeakMap()
    /** @type {TraceState[]} */
    const observed = []
    /**
     * @param {Database} database
     * @returns {TraceState}
     */
    const stateFor = (database) => {
        let state = states.get(database)
        if (state) { return state }
        state = {group: 0, events: [], publications: [], originEvents: new Uint32Array(0), multiplicities: new Uint32Array(0), currentMultiplicity: new Map(), pendingComparison: null, budgetBytes: null}
        states.set(database, state)
        observed.push(state)
        return state
    }
    prototype._bulkAddArtifactTermsChunkWithContentDedup = async function traceBulkAddArtifactTermsChunk(chunk) {
        const state = stateFor(this)
        ++state.group
        state.currentMultiplicity.clear()
        const metas = chunk.contentMetaList
        const base = chunk.contentBytesBaseOffset ?? 0
        if (metas instanceof Uint32Array) {
            for (let i = 0; i < chunk.rowCount; ++i) {
                const offset = base + metas[i * 4]
                state.currentMultiplicity.set(offset, (state.currentMultiplicity.get(offset) ?? 0) + 1)
            }
        }
        try {
            await originalBulk.call(this, chunk)
        } finally {
            state.currentMultiplicity.clear()
        }
    }
    prototype._cacheRecentPublishedTermContentSources = function traceCacheRecentPublishedTermContentSources(staged, spans) {
        const state = stateFor(this)
        const before = new Set(this._recentTermContentSourceBatches.keys())
        const residentBytesBefore = this._recentTermContentSourceBatchBytes
        const copiedBytes = originalPublish.call(this, staged, spans)
        const nextCapacity = this._termEntryContentMetaStateTable.length
        if (state.originEvents.length < nextCapacity) {
            const origins = new Uint32Array(nextCapacity)
            origins.set(state.originEvents)
            state.originEvents = origins
            const multiplicities = new Uint32Array(nextCapacity)
            multiplicities.set(state.multiplicities)
            state.multiplicities = multiplicities
        }
        let minimumOffset = Infinity
        let maximumEnd = 0
        let publishedCount = 0
        let publishedContentBytes = 0
        let repeatedWithinGroupCount = 0
        let repeatedWithinGroupBytes = 0
        const eventIndex = state.events.length
        if (staged !== null && spans !== null) {
            for (let i = 0; i < staged.indexes.length; ++i) {
                const index = staged.indexes[i]
                // Audited TERM_CONTENT_META_SLOT_PUBLISHED is 1 in the selected
                // production source. Successful trace replay verifies admission.
                if (index < 0 || this._termEntryContentMetaStateTable[index] !== 1) { continue }
                const offset = spans.offsets[i]
                const length = spans.lengths[i]
                assert.ok(offset <= spans.buffer.length && length <= spans.buffer.length - offset)
                minimumOffset = Math.min(minimumOffset, offset)
                maximumEnd = Math.max(maximumEnd, offset + length)
                ++publishedCount
                publishedContentBytes += length
                const multiplicity = state.currentMultiplicity.get(offset) ?? 0
                state.originEvents[index] = eventIndex + 1
                state.multiplicities[index] = multiplicity
                if (multiplicity >= 2) {
                    ++repeatedWithinGroupCount
                    repeatedWithinGroupBytes += length
                }
            }
        }
        const added = [...this._recentTermContentSourceBatches.keys()].filter((id) => !before.has(id))
        assert.equal(added.length, copiedBytes > 0 ? 1 : 0, 'Publication must add at most one retained batch')
        const batchId = added[0] ?? null
        const budgetBytes = this._recentTermContentSourceCacheMaxBytes
        assert.ok(state.budgetBytes === null || state.budgetBytes === budgetBytes, 'Budget must remain fixed within a trace')
        state.budgetBytes = budgetBytes
        /** @type {Publication} */
        const event = {kind: 'publication', event: eventIndex, group: state.group, batchId, admitted: copiedBytes > 0, budgetBytes, retainedSpanBytes: Number.isFinite(minimumOffset) ? maximumEnd - minimumOffset : 0, copiedBytes, minimumOffset: Number.isFinite(minimumOffset) ? minimumOffset : null, maximumEnd, publishedCount, publishedContentBytes, repeatedWithinGroupCount, repeatedWithinGroupBytes, residentBytesBefore, residentBytesAfter: this._recentTermContentSourceBatchBytes, evictedBatchIds: [...before].filter((id) => !this._recentTermContentSourceBatches.has(id))}
        if (event.admitted) { assert.equal(event.retainedSpanBytes, event.copiedBytes) }
        state.events.push(event)
        state.publications.push(event)
        return copiedBytes
    }
    prototype._findRecentTermContentSource = function traceFindRecentTermContentSource(meta) {
        const state = stateFor(this)
        const index = meta.tableIndex
        const validIndex = typeof index === 'number' && index >= 0 && index < this._termEntryContentMetaRecentSourceBatchIdTable.length
        const tableIndex = validIndex ? index : null
        const batchId = validIndex ? this._termEntryContentMetaRecentSourceBatchIdTable[index] || null : null
        const sourceOffset = validIndex && batchId !== null ? this._termEntryContentMetaRecentSourceOffsetTable[index] : null
        const result = originalFind.call(this, meta)
        const actualHit = typeof result !== 'undefined'
        const resident = batchId !== null && this._recentTermContentSourceBatches.has(batchId)
        /** @type {string|null} */
        let missReason = null
        if (!actualHit) {
            if (!validIndex) {
                missReason = 'no-dense-index'
            } else if (batchId === null) {
                missReason = 'not-retained'
            } else if (!resident) {
                missReason = 'evicted'
            } else {
                missReason = 'invalid-range'
            }
        }
        /** @type {Lookup} */
        const event = {kind: 'lookup', event: state.events.length, group: state.group, tableIndex, batchId, originPublicationEvent: validIndex && state.originEvents[index] ? state.originEvents[index] - 1 : null, sourceOffset, requestedBytes: meta.length, multiplicityWithinOriginGroup: validIndex ? state.multiplicities[index] ?? 0 : 0, actualHit, missReason, exactEqual: null}
        state.events.push(event)
        state.pendingComparison = actualHit ? {event, ...result} : null
        return result
    }
    prototype._termContentBytesEqualSpan = function traceTermContentBytesEqualSpan(content, buffer, offset, length) {
        const equal = originalEqual.call(this, content, buffer, offset, length)
        const state = states.get(this)
        const pending = state?.pendingComparison
        if (pending && pending.buffer === buffer && pending.offset === offset && pending.length === length) {
            pending.event.exactEqual = equal
            state.pendingComparison = null
        }
        return equal
    }
    Reflect.set(globalThis, instrumentationKey, {kind: 'recent-source-cache-trace', diagnosticOnly: true, report: output, source, preloadSha256})
    /**
     * @param {TraceComponentReport} componentReport
     * @param {{source: string}} context
     * @returns {Promise<Record<string, unknown>>}
     */
    const finalizeTrace = async (componentReport, context) => {
        assert.equal(componentReport.harnessSemanticsVersion, 4, 'Cache trace requires explicit source and parser finality semantics')
        assert.equal(context.source, source, 'Preload and component checkout must be identical')
        assert.equal(observed.length, 1, 'Expected one import cache owner')
        const state = observed[0]
        assert.equal(state.group, componentReport.policy.groupCount, 'Trace must cover every production group')
        assert.ok(state.budgetBytes !== null && state.budgetBytes >= 96 * MIB, 'Trace the 96 MiB policy so all smaller replay budgets have complete admission evidence')
        assert.equal(state.events.filter((event) => event.kind === 'lookup' && event.actualHit && event.exactEqual === null).length, 0, 'A returned source was not followed by an observed exact comparison')
        const control = replaySourceCache(state.events, state.budgetBytes, 'fifo')
        assert.equal(control.observationMismatches, 0, 'FIFO replay does not reproduce observed cache hits')
        const policies = /** @type {Policy[]} */ (['fifo', 'lru-resident-lookup', 'lru-valid-hit', 'lru-exact-match'])
        const replays = [24, 48, 96].flatMap((mib) => policies.map((policy) => replaySourceCache(state.events, mib * MIB, policy)))
        const summary = summarizeDemand(state.events)
        const report = {
            schemaVersion: 1,
            harnessSemanticsVersion: componentReport.harnessSemanticsVersion,
            diagnosticOnly: true,
            source: componentReport.source,
            harnessSha256: componentReport.harnessSha256,
            preloadSha256,
            fixture: componentReport.fixture,
            rows: componentReport.rows,
            policy: componentReport.policy,
            groups: componentReport.groupResults.map(({banks, rows, sourceBytes, dictionaryTotalRows, pipelineProgress, isFinalTermChunk}) => ({banks, rows, sourceBytes, dictionaryTotalRows, pipelineProgress, isFinalTermChunk})),
            componentSemanticSha256: componentReport.verification?.sha256 ?? null,
            componentCanonicalFilesSha256: componentReport.storedFilesCanonicalSha256,
            summary,
            observedBudgetBytes: state.budgetBytes,
            fifoControl: control,
            replays,
            limits: [
                'Instrumentation performs additional scans and allocations. Do not use the component timing from this run as performance evidence.',
                'Replays model whole-batch byte-budget retention, with identical publication/lookup order and no refills on misses.',
                'A 48 MiB replay models the unknown-memory cache budget on the same 8 CPU/8 GiB source workload, not all other unknown-memory storage heuristics.',
                'A lower cache miss count is not an end-to-end speedup; saved OPFS reads/block decodes and LRU promotion overhead require a separate product experiment.',
                'LRU resident-lookup promotes any still-resident batch, valid-hit requires valid range, and exact-match additionally requires observed byte equality. None can promote an absent batch.',
                'Within-group repetition is measured only as diagnostic evidence; no selective admission policy is applied.',
            ],
            events: state.events,
        }
        assert.equal(createHash('sha256').update(await readFile(scriptPath)).digest('hex'), preloadSha256, 'Trace preload changed during the run')
        await mkdir(path.dirname(output), {recursive: true})
        await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, {flag: 'wx'})
        return {report: output, diagnosticOnly: true, summary, replays}
    }
    Reflect.set(globalThis, finalizeKey, finalizeTrace)
}

const source = process.env.MANABITAN_SOURCE_CACHE_TRACE_SOURCE
const output = process.env.MANABITAN_SOURCE_CACHE_TRACE_OUTPUT
if (typeof source !== 'undefined' || typeof output !== 'undefined') {
    assert.ok(source && output, 'Set both MANABITAN_SOURCE_CACHE_TRACE_SOURCE and MANABITAN_SOURCE_CACHE_TRACE_OUTPUT')
    await installTrace(source, output)
}

/* eslint-enable no-underscore-dangle */
