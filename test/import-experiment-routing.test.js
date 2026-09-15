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

import {afterEach, describe, expect, test, vi} from 'vitest'
import {DictionaryImportController, ImportProgressTracker} from '../ext/js/pages/settings/dictionary-import-controller.js'
import {snapshotTermBankExperiments} from '../ext/js/dictionary/term-bank-experiments.js'

const names = Object.keys(snapshotTermBankExperiments())
/** @returns {DictionaryImportController} */
function controller() { return /** @type {DictionaryImportController} */ (Object.create(DictionaryImportController.prototype)) }
/**
 * @param {DictionaryImportController} target
 * @returns {import('dictionary-importer').ImportExperiments}
 */
function readFlags(target) { return Reflect.get(target, '_getImportPerformanceFlags').call(target) }

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    Reflect.deleteProperty(globalThis, 'manabitanImportPerformanceFlags')
    Reflect.deleteProperty(globalThis, '__manabitanImportStepTimingHistory')
})

describe('settings experiment routing', () => {
    test.each(names)('snapshots %s strictly without retaining previous flags', (name) => {
        const target = controller()
        const flags = {[name]: true}
        Reflect.set(globalThis, 'manabitanImportPerformanceFlags', flags)
        const first = readFlags(target)
        expect(Reflect.get(first, name)).toBe(true)
        flags[name] = false
        expect(Reflect.get(first, name)).toBe(true)
        expect(Reflect.get(readFlags(target), name)).toBe(false)
        Reflect.deleteProperty(globalThis, 'manabitanImportPerformanceFlags')
        expect(readFlags(target)).toMatchObject(snapshotTermBankExperiments())
    })

    test.each([undefined, null, [], true, 'true', {experimentalSchemaRowParser: 'true'}])('rejects malformed debug flags %j', (value) => {
        Reflect.set(globalThis, 'manabitanImportPerformanceFlags', value)
        expect(readFlags(controller())).toMatchObject(snapshotTermBankExperiments())
    })

    test('passes the pre-await snapshot through dictionary import dispatch', async () => {
        const target = controller()
        const requested = Object.fromEntries(names.map((name) => [name, true]))
        Reflect.set(globalThis, 'manabitanImportPerformanceFlags', requested)
        const dispatch = vi.fn().mockResolvedValue({errors: [], importedTitle: 'Test'})
        const completion = vi.fn()
        vi.stubGlobal('document', {querySelectorAll: () => []})
        vi.stubGlobal('chrome', {runtime: {getManifest: () => ({version: 'test'})}})
        const settings = {
            application: {api: {setDictionaryImportMode: vi.fn(async () => {
                for (const name of names) { requested[name] = false }
            })}},
            getOptionsFull: vi.fn().mockResolvedValue({global: {database: {prefixWildcardsSupported: false}}}),
        }
        for (const [name, value] of Object.entries({
            _settingsController: settings,
            _statusFooter: null,
            _activeImportRunGeneration: 0,
            _modifying: false,
            _getUseImportSession: () => false,
            _preventPageExit: () => ({end: vi.fn()}),
            _setModifying: vi.fn(),
            _hideErrors: vi.fn(),
            _isImportRunCurrent: () => true,
            _showErrors: vi.fn(),
            _triggerStorageChanged: vi.fn(),
            _signalImportSessionCompletion: completion,
            _importDictionaryFromZip: dispatch,
        })) { Reflect.set(target, name, value) }
        async function *sources() { yield new File(['[]'], 'test.zip') }
        const tracker = new ImportProgressTracker([{label: ''}, {label: 'Importing'}], 1)
        await Reflect.get(target, '_importDictionaries').call(target, sources(), null, null, tracker)
        expect(dispatch).toHaveBeenCalledOnce()
        const details = dispatch.mock.calls[0][2]
        expect(details).toMatchObject(Object.fromEntries(names.map((name) => [name, true])))
        expect(completion).toHaveBeenCalledWith(expect.objectContaining({errorCount: 0}))
        expect(readFlags(target)).toMatchObject(snapshotTermBankExperiments())
    })
})
