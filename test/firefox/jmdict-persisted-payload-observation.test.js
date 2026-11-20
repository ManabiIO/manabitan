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

import {describe, expect, test, vi} from 'vitest'
import {errorReceipt, validateCompletedImport, validateReleasePackageManifest, withCleanup} from './jmdict-persisted-payload-observation.js'

/** @type {import('../../dev/perf/dictionary-fixtures.js').DictionaryFixture} */
const fixture = {label: 'JMdict',
    cacheFile: 'JMdict.zip',
    release: '',
    url: '',
    sha256: '',
    sizeBytes: 0,
    expectedTitle: 'JMdict [2026-09-06]',
    revision: 'JMdict.2026-09-06',
    termRows: 526_942}
const experiments = {experimentalGenericSpanCompression: true, experimentalSkipFusedParse: false}

/** @returns {{timing: Record<string, any>, debug: Record<string, any>}} */
function validImport() {
    return {
        timing: {trigger: 'file-input-change',
            sequenceBefore: 0,
            sequence: 1,
            errorCount: 0,
            startedAtMs: 10,
            completedAtMs: 110},
        debug: {
            hasResult: true,
            resultTitle: fixture.expectedTitle,
            errorCount: 0,
            addSettingsErrorCount: 0,
            usesFallbackStorage: false,
            openStorageDiagnostics: {mode: 'opfs-sahpool'},
            localPhaseTimings: [{phase: 'worker-import-dictionary', elapsedMs: 90}],
            importerPhaseTimings: [
                {phase: 'term-file-0-53',
                    details: {rows: fixture.termRows,
                        parserSourceCompressedBytes: 15_574_114,
                        parserSourceTransferredBytes: 15_574_114,
                        parserSourceUncompressedBytes: 171_092_992,
                        parserFusedFallbacks: 0,
                        parserDiscardedFusedRows: 0,
                        dedupNativeFallbackCount: 0,
                        parserMaxWasmHeapBytes: 38_928_384,
                        parserExperiments: {...experiments}}},
                {phase: 'bulk-finalization',
                    details: {ok: true,
                        published: true,
                        housekeepingErrors: [],
                        compressionExperiments: {...experiments}}},
            ],
        },
    }
}

describe('Firefox single-observation qualification', () => {
    test('requires current-operation completion without yielding a timing claim', () => {
        const result = validateCompletedImport(validImport(), fixture, experiments)
        expect(result.completion.currentOperationPostUi).toBe(true)
        expect(result).not.toHaveProperty('totalImportMs')
        expect(result).not.toHaveProperty('workerImportMs')
        expect(result.termFileWork).toHaveLength(1)
    })

    /** @type {Array<[string, (result: ReturnType<typeof validImport>) => void]>} */
    const failureCases = [
        ['a stale completion event', (result) => { result.timing.sequence = result.timing.sequenceBefore }],
        ['an unsuccessful UI operation', (result) => { result.timing.errorCount = 1 }],
        ['an inverted timing interval', (result) => { result.timing.completedAtMs = 9 }],
        ['fallback storage', (result) => { result.debug.usesFallbackStorage = true }],
        ['an unsupported storage mode', (result) => { result.debug.openStorageDiagnostics.mode = 'memory' }],
        ['changed production switches', (result) => { result.debug.importerPhaseTimings[0].details.parserExperiments.experimentalSkipFusedParse = true }],
        ['missing native path work', (result) => { delete result.debug.importerPhaseTimings[0].details.parserSourceCompressedBytes }],
        ['missing rows', (result) => { result.debug.importerPhaseTimings[0].details.rows -= 1 }],
        ['fused parser fallback', (result) => { result.debug.importerPhaseTimings[0].details.parserFusedFallbacks = 1 }],
        ['discarded fused rows', (result) => { result.debug.importerPhaseTimings[0].details.parserDiscardedFusedRows = 1 }],
        ['native deduplication fallback', (result) => { result.debug.importerPhaseTimings[0].details.dedupNativeFallbackCount = 1 }],
        ['a missing publication', (result) => { result.debug.importerPhaseTimings[1].details.published = false }],
        ['publication housekeeping errors', (result) => { result.debug.importerPhaseTimings[1].details.housekeepingErrors.push('write failed') }],
        ['a missing worker import', (result) => { result.debug.localPhaseTimings = [] }],
    ]
    test.each(failureCases)('rejects %s without yielding a qualified time', (_name, mutate) => {
        const result = validImport()
        mutate(result)
        expect(() => validateCompletedImport(result, fixture, experiments)).toThrow()
    })

    test('does not add overlapping phase durations to page timing', () => {
        const result = validImport()
        result.debug.importerPhaseTimings.push({phase: 'overlapping-work', elapsedMs: 100_000, details: {}})
        expect(validateCompletedImport(result, fixture, experiments).completion.currentOperationPostUi).toBe(true)
    })
})

describe('Firefox error preservation', () => {
    test('restores the context after success', async () => {
        const cleanup = vi.fn(async () => {})
        await expect(withCleanup(async () => 'reactivated', cleanup)).resolves.toBe('reactivated')
        expect(cleanup).toHaveBeenCalledExactlyOnceWith()
    })

    test('keeps the original failure when context restoration succeeds', async () => {
        const primary = new Error('content process crashed')
        const cleanup = vi.fn(async () => {})
        await expect(withCleanup(async () => { throw primary }, cleanup)).rejects.toBe(primary)
        expect(cleanup).toHaveBeenCalledExactlyOnceWith()
    })

    test('retains primary and cleanup failures in order', async () => {
        const primary = new Error('content process crashed')
        const cleanup = new Error('Marionette session was lost')
        let caught
        try {
            await withCleanup(
                async () => { throw primary },
                async () => { throw cleanup },
            )
        } catch (error) { caught = error }
        expect(caught).toBeInstanceOf(AggregateError)
        const receipt = errorReceipt(caught)
        expect(receipt.errors?.map((error) => error.message)).toEqual([primary.message, cleanup.message])
    })

    test('fails an otherwise successful operation when cleanup fails', async () => {
        const cleanup = new Error('could not restore content context')
        await expect(withCleanup(async () => 'reactivated', async () => { throw cleanup })).rejects.toBe(cleanup)
    })
})


describe('release Firefox package identity', () => {
    const releaseManifest = () => ({background: {page: 'background.html'},
        browser_specific_settings: {gecko: {id: '{1e12d533-8e72-4ec5-9edc-cd50e26d7d43}'}}})

    test('accepts the release background-page manifest', () => {
        expect(validateReleasePackageManifest(releaseManifest())).toBe('{1e12d533-8e72-4ec5-9edc-cd50e26d7d43}')
    })

    test('rejects the development add-on identity', () => {
        const manifest = releaseManifest()
        manifest.browser_specific_settings.gecko.id = '{accbebce-862b-48a9-bb9a-1da9ad1f8702}'
        expect(() => validateReleasePackageManifest(manifest)).toThrow('Expected release Firefox identity')
    })

    test('rejects a development update URL', () => {
        const manifest = releaseManifest()
        Reflect.set(manifest.browser_specific_settings.gecko, 'update_url', 'https://example.invalid/updates.json')
        expect(() => validateReleasePackageManifest(manifest)).toThrow('Unexpected development update channel')
    })

    test('rejects a Chromium background worker', () => {
        const manifest = releaseManifest()
        Reflect.set(manifest.background, 'service_worker', 'sw.js')
        expect(() => validateReleasePackageManifest(manifest)).toThrow('Unexpected Chromium background worker')
    })

    test('rejects a missing background page', () => {
        const manifest = releaseManifest()
        manifest.background.page = ''
        expect(() => validateReleasePackageManifest(manifest)).toThrow('Expected the Firefox background-page package')
    })
})
