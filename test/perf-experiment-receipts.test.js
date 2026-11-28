/* SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */

import {describe, expect, test} from 'vitest'
import {createHash} from 'node:crypto'
import {extractImportResult} from '../dev/perf/benchmark-support.js'
import {loadDictionaryFixtures} from '../dev/perf/dictionary-fixtures.js'
import {snapshotTermBankExperiments} from '../ext/js/dictionary/term-bank-experiments.js'

const fixture = (await loadDictionaryFixtures()).jmdict
const threshold = 1024 * 1024 * 1024
const probeTerms = Array.from({length: 12}, (_, index) => `term-${index}`)

/**
 * @param {number} bytes
 * @param {boolean} projected
 * @param {Record<string, unknown>|null} flags
 * @returns {Record<string, any>}
 */
function report(bytes = threshold, projected = true, flags = null) {
    const requested = snapshotTermBankExperiments(flags ?? {})
    const effective = {...requested, experimentalNativeEscapedKeys: requested.experimentalNativeEscapedKeys || (projected && bytes >= threshold)}
    const term = {phase: 'term-file-fast-path:fixture',
        details: {
            parserSourceUncompressedBytes: bytes,
            parserParallelWorkerCount: 3,
            parserParallelSkipReason: null,
            parserExperiments: {...effective},
        }}
    const banks = {phase: 'import-data-banks',
        details: {
            useMediaPipeline: projected,
            hasArchiveImageMediaFiles: projected,
            fastPathParserSourceUncompressedBytes: bytes,
            fastPathParserParallelWorkerCount: 3,
            fastPathParserParallelSkipReason: null,
            fastPathParserExperiments: {...requested},
            fastPathParserEffectiveExperiments: {...effective},
        }}
    const compression = {phase: 'bulk-finalization', details: {compressionExperiments: {...requested}}}
    return {
        status: 'success',
        skippedVerification: false,
        benchmark: {dictionary: 'jmdict',
            pinnedDictionaries: true,
            productionImportDefaults: true,
            traceEnabled: false,
            authoritativeTiming: true,
            phaseProfiling: false,
            phaseScreenshots: false,
            processSampling: false,
            importFlags: flags,
            validation: {title: fixture.expectedTitle,
                revision: fixture.revision,
                termRows: fixture.termRows,
                contentReadable: true,
                probeCount: 12,
                probeTerms,
                restart: {title: fixture.expectedTitle, revision: fixture.revision, termRows: fixture.termRows, contentReadable: true, probeCount: 12, mediaFiles: 0},
                media: {mode: 'all', totalFiles: 0, totalBytes: 0, files: 0, bytes: 0, sha256: createHash('sha256').digest('hex')},
                storage: {bytes: 1000000},
                lookup: {observations: Array.from({length: 6}).flatMap((_, pass) => probeTerms.map((term) => ({pass, term, elapsedMs: 1, results: 1, originalTextLength: term.length, hasExactHeadwordMatch: true, sha256: 'b'.repeat(64)})))}}},
        phases: [{name: 'JMdict: total import',
            durationMs: 200,
            startMs: 100,
            endMs: 300,
            data: {kind: 'dictionary-import',
                dictionary: 'JMdict',
                browserTiming: {startedAtMs: 10, completedAtMs: 210, sequence: 1, sequenceBefore: 0, trigger: 'file-input-change', errorCount: 0},
                importDebug: {hasResult: true,
                    resultTitle: fixture.expectedTitle,
                    errorCount: 0,
                    addSettingsErrorCount: 0,
                    usesFallbackStorage: false,
                    importerPhaseTimings: [term, banks, compression]}}},
        {name: 'Import JMdict via file input', startMs: 100, endMs: 150}],
    }
}

/**
 * @param {ReturnType<typeof report>} value
 * @param {Record<string, unknown>|null} flags
 * @returns {ReturnType<typeof extractImportResult>}
 */
function extract(value, flags = null) {
    return extractImportResult(value, 'jmdict', fixture, false, flags)
}

/**
 * @param {ReturnType<typeof report>} value
 * @returns {Array<Record<string, any>>}
 */
function details(value) {
    const phases = /** @type {Array<{details: Record<string, any>}>} */ (value.phases[0].data.importDebug.importerPhaseTimings)
    return phases.map((phase) => phase.details)
}

/** @type {Array<[string, (term: Record<string, any>, banks: Record<string, any>) => void]>} */
const invalidContexts = [
    ['media pipeline', (term, banks) => { banks.useMediaPipeline = false }],
    ['archive images', (term, banks) => { banks.hasArchiveImageMediaFiles = false }],
    ['worker count', (term) => { term.parserParallelWorkerCount = 0 }],
    ['string worker count', (term) => { term.parserParallelWorkerCount = '3' }],
    ['parallel skip reason', (term) => { term.parserParallelSkipReason = 'disabled' }],
    ['source size', (term) => { term.parserSourceUncompressedBytes = threshold - 1 }],
    ['string source size', (term) => { term.parserSourceUncompressedBytes = String(threshold) }],
    ['missing source size', (term) => { delete term.parserSourceUncompressedBytes }],
    ['unsafe source size', (term) => { term.parserSourceUncompressedBytes = Number.MAX_SAFE_INTEGER + 1 }],
]

describe('requested versus effective parser receipt policy', () => {
    test.each([
        {bytes: 536870912, escaped: false},
        {bytes: 538927310, escaped: false},
        {bytes: 1073741823, escaped: false},
        {bytes: 1073741824, escaped: true},
        {bytes: 1073741825, escaped: true},
    ])('requires the production escaped-key receipt $escaped at $bytes source bytes', ({bytes, escaped}) => {
        // Keep these observed and boundary expectations independent of the
        // fixture builder's policy, including the pinned Jitendex source size.
        for (const key of ['parserExperiments', 'fastPathParserEffectiveExperiments']) {
            const value = report(bytes)
            const [term, banks] = details(value)
            term.parserExperiments.experimentalNativeEscapedKeys = escaped
            banks.fastPathParserEffectiveExperiments.experimentalNativeEscapedKeys = escaped
            expect(extract(value).totalImportMs).toBe(200)
            const receipt = key === 'parserExperiments' ? term[key] : banks[key]
            receipt.experimentalNativeEscapedKeys = !escaped
            expect(() => extract(value)).toThrow(`receipt mismatch: ${key}`)
        }
    })
    test('rejects an unexpected escaped-key switch on the small JMdict source', () => {
        const value = report(171092992)
        details(value)[0].parserExperiments.experimentalNativeEscapedKeys = true
        expect(() => extract(value)).toThrow('receipt mismatch: parserExperiments')
    })
    test('rejects the requested false value in an eligible effective receipt', () => {
        const value = report()
        details(value)[1].fastPathParserEffectiveExperiments.experimentalNativeEscapedKeys = false
        expect(() => extract(value)).toThrow('receipt mismatch: fastPathParserEffectiveExperiments')
    })
    test.each(['fastPathParserExperiments', 'compressionExperiments'])('does not promote requested/compression receipt %s', (key) => {
        const value = report()
        const entry = details(value).find((item) => key in item)
        if (typeof entry === 'undefined') { throw new Error(`Missing fixture receipt ${key}`) }
        const receipt = entry[key]
        receipt.experimentalNativeEscapedKeys = true
        expect(() => extract(value)).toThrow(`receipt mismatch: ${key}`)
    })
    test.each(Object.keys(snapshotTermBankExperiments()).filter((key) => key !== 'experimentalNativeEscapedKeys'))('rejects unrelated effective flag change %s', (key) => {
        const value = report()
        const receipt = details(value)[0].parserExperiments
        receipt[key] = !receipt[key]
        expect(() => extract(value)).toThrow('receipt mismatch: parserExperiments')
    })
    test.each(invalidContexts)('rejects incomplete projected/native/source proof: %s', (name, change) => {
        const value = report()
        const [term, banks] = details(value)
        change(term, banks)
        expect(() => extract(value)).toThrow('receipt mismatch: parserExperiments')
    })
    test.each([{skipImageMetadata: false}, {skipMediaImport: true}])('rejects projection inconsistent with explicit flags %j', (flags) => {
        const value = report(threshold, true, flags)
        expect(() => extract(value, flags)).toThrow('receipt mismatch: parserExperiments')
    })
    test('retains an explicitly requested escaped-key switch for a small input', () => {
        const flags = {experimentalNativeEscapedKeys: true}
        expect(extract(report(171092992, false, flags), flags).totalImportMs).toBe(200)
    })
    test('requires an effective parser receipt when requested and compression receipts match', () => {
        const flags = {experimentalNativeEscapedKeys: true}
        const value = report(171092992, false, flags)
        for (const receipt of details(value)) {
            delete receipt.parserExperiments
            delete receipt.fastPathParserEffectiveExperiments
        }
        expect(() => extract(value, flags)).toThrow('Missing import experiment worker receipts')
    })
    test('allows explicit false to receive the same existing large-source production override', () => {
        const flags = {experimentalNativeEscapedKeys: false}
        expect(extract(report(threshold, true, flags), flags).totalImportMs).toBe(200)
    })
    test('does not infer eligibility from a dictionary name', () => {
        expect(extract(report(threshold, false)).totalImportMs).toBe(200)
    })
})
