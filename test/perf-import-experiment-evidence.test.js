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

import {afterEach, describe, expect, test} from 'vitest'
import {DictionaryImportController} from '../ext/js/pages/settings/dictionary-import-controller.js'
import {resolveTermBankImportExperiments, snapshotTermBankExperiments} from '../ext/js/dictionary/term-bank-experiments.js'
import {extractImportResult} from '../dev/perf/benchmark-support.js'
import {loadDictionaryFixtures} from '../dev/perf/dictionary-fixtures.js'

const fixture = (await loadDictionaryFixtures()).jmdict
const keys = Object.keys(snapshotTermBankExperiments())

/** @returns {Record<string, any>} */
function report() {
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
            importFlags: null,
            validation: {title: fixture.expectedTitle,
                revision: fixture.revision,
                termRows: fixture.termRows,
                contentReadable: true,
                probeCount: 12}},
        phases: [{name: 'JMdict: total import',
            durationMs: 123.5,
            startMs: 100,
            endMs: 223.5,
            data: {kind: 'dictionary-import',
                dictionary: 'JMdict',
                browserTiming: {startedAtMs: 10,
                    completedAtMs: 133.5,
                    sequence: 1,
                    sequenceBefore: 0,
                    trigger: 'file-input-change',
                    errorCount: 0},
                importDebug: {hasResult: true,
                    resultTitle: fixture.expectedTitle,
                    errorCount: 0,
                    addSettingsErrorCount: 0,
                    usesFallbackStorage: false}}},
        {name: 'Import JMdict via file input', startMs: 100, endMs: 140}],
    }
}

/** @returns {Record<string, any>} */
function readControls() {
    const controller = Object.create(DictionaryImportController.prototype)
    return Reflect.get(DictionaryImportController.prototype, '_getImportPerformanceFlags').call(controller)
}

afterEach(() => Reflect.deleteProperty(globalThis, 'manabitanImportPerformanceFlags'))

describe('import experiment controls and worker receipts', () => {
    test.each(keys)('snapshots the actual debug control %s without retaining it', (key) => {
        const flags = {[key]: true}
        Reflect.set(globalThis, 'manabitanImportPerformanceFlags', flags)
        const result = readControls().termBankExperiments
        expect(result).toEqual(resolveTermBankImportExperiments(flags))
        expect(Object.isFrozen(result)).toBe(true)
        flags[key] = false
        expect(result[key]).toBe(true)
        expect(readControls().termBankExperiments[key]).toBe(false)
        for (const value of [1, 'true', null]) {
            Reflect.set(globalThis, 'manabitanImportPerformanceFlags', {[key]: value})
            expect(readControls().termBankExperiments[key]).toBe(false)
        }
    })

    test.each([undefined, null, [], 'true', 1])('invalid global controls use the default import policy: %j', (value) => {
        Reflect.set(globalThis, 'manabitanImportPerformanceFlags', value)
        expect(readControls().termBankExperiments).toEqual(resolveTermBankImportExperiments())
    })

    test.each(keys)('rejects requested %s when parser receipts say false', (key) => {
        const data = report()
        const flags = {[key]: true}
        data.benchmark.importFlags = flags
        data.phases[0].data.importDebug.importerPhaseTimings = [
            {details: {parserExperiments: snapshotTermBankExperiments()}},
        ]
        expect(() => extractImportResult(data, 'jmdict', fixture, false, flags)).toThrow('experiment')
    })

    test('rejects absent receipts, malformed booleans, unexpected activation and unknown flags', () => {
        for (const flags of [{experimentalTermBankSpans: true}, {experimentalTermBankSpans: false}]) {
            const data = report()
            data.benchmark.importFlags = flags
            expect(() => extractImportResult(data, 'jmdict', fixture, false, flags)).toThrow('experiment')
        }
        const data = report()
        data.benchmark.importFlags = {}
        data.phases[0].data.importDebug.importerPhaseTimings = [{details: {
            fastPathParserEffectiveExperiments: {...snapshotTermBankExperiments(), experimentalTermBankSpans: true},
        }}]
        expect(() => extractImportResult(data, 'jmdict', fixture, false, {})).toThrow('experiment')
        data.phases[0].data.importDebug.importerPhaseTimings[0].details.fastPathParserEffectiveExperiments.experimentalTermBankSpans = 'false'
        expect(() => extractImportResult(data, 'jmdict', fixture, false, {})).toThrow('experiment')
        data.benchmark.importFlags = {experimentalTypo: true}
        expect(() => extractImportResult(data, 'jmdict', fixture, false, data.benchmark.importFlags)).toThrow('experiment')
    })

    test('requires every observed worker and effective snapshot to agree', () => {
        const data = report()
        const flags = {experimentalNativeSegmentedLookup: true, experimentalLookupScratchReuse: true}
        data.benchmark.importFlags = flags
        const phases = [
            {details: {parserExperiments: resolveTermBankImportExperiments(flags)}},
            {details: {fastPathParserEffectiveExperiments: resolveTermBankImportExperiments(flags)}},
        ]
        data.phases[0].data.importDebug.importerPhaseTimings = phases
        expect(extractImportResult(data, 'jmdict', fixture, false, flags).totalImportMs).toBe(123.5)
        phases.push({details: {parserExperiments: snapshotTermBankExperiments()}})
        expect(() => extractImportResult(data, 'jmdict', fixture, false, flags)).toThrow('experiment')
    })
})
