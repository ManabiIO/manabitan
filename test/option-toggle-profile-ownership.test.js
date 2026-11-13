/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFileSync} from 'node:fs'
import {expect, test, vi} from 'vitest'
import {Backend} from '../ext/js/background/backend.js'
import {deferPromise} from '../ext/js/core/utilities.js'
import {JsonSchema} from '../ext/js/data/json-schema.js'
import {OptionsUtil} from '../ext/js/data/options-util.js'
import {OptionToggleHotkeyHandler} from '../ext/js/display/option-toggle-hotkey-handler.js'

/**
 * @param {?import('settings').OptionsContext} [context]
 * @returns {{
 * backend: Backend,
 * handler: OptionToggleHotkeyHandler,
 * state: {profileId: string|null, delayRead: boolean},
 * readStarted: import('core').DeferredPromiseDetails<void>,
 * releaseRead: import('core').DeferredPromiseDetails<void>,
 * getSettings: ReturnType<typeof vi.fn>,
 * modifySettings: ReturnType<typeof vi.fn>,
 * notifications: import('vitest').MockInstance<OptionToggleHotkeyHandler['_showNotification']>,
 * save: import('vitest').MockInstance<OptionsUtil['save']>,
 * values: () => Record<string, boolean>,
 * }}
 */
function setup(context = null) {
    context ??= {current: true}
    const optionsUtil = new OptionsUtil()
    optionsUtil._optionsSchema = new JsonSchema(JSON.parse(readFileSync(new URL('../ext/data/schemas/options-schema.json', import.meta.url), 'utf8')))
    const options = optionsUtil.getDefault()
    options.profiles[0].id = 'profile-a'
    options.profiles[0].options.general.enable = false
    options.profiles.push({...structuredClone(options.profiles[0]), id: 'profile-b', name: 'B'})
    const save = vi.spyOn(optionsUtil, 'save').mockResolvedValue()
    const backend = /** @type {Backend} */ (Object.assign(Object.create(Backend.prototype), {
        _options: options,
        _optionsUtil: optionsUtil,
        _applyOptions: vi.fn(),
        _profileConditionsSchemaCache: [],
    }))
    const readStarted = /** @type {import('core').DeferredPromiseDetails<void>} */ (deferPromise())
    const releaseRead = /** @type {import('core').DeferredPromiseDetails<void>} */ (deferPromise())
    const state = {profileId: /** @type {string|null} */ ('profile-a'), delayRead: true}
    const getSettings = vi.fn(async (/** @type {import('settings-modifications').ScopedRead[]} */ targets) => {
        const result = backend._onApiGetSettings({targets}, {})
        readStarted.resolve()
        if (state.delayRead) { await releaseRead.promise }
        return result
    })
    const modifySettings = vi.fn((/** @type {import('settings-modifications').ScopedModification[]} */ targets, /** @type {string} */ source) => backend._modifySettings(targets, source))
    const display = /** @type {import('../ext/js/display/display.js').Display} */ (/** @type {unknown} */ ({
        getOptionsContext: () => context,
        getOptionsProfileId: () => state.profileId,
        application: {api: {getSettings, modifySettings}},
    }))
    const handler = new OptionToggleHotkeyHandler(display)
    const notifications = vi.spyOn(handler, '_showNotification').mockImplementation(() => {})
    vi.spyOn(handler, '_createSuccessMessage').mockReturnValue(/** @type {DocumentFragment} */ ({}))
    vi.spyOn(handler, '_createErrorMessage').mockReturnValue(/** @type {DocumentFragment} */ ({}))
    const values = () => Object.fromEntries(backend._getOptionsFull(false).profiles.map(({id, options: profile}) => [id, profile.general.enable]))
    return {backend, handler, state, readStarted, releaseRead, getSettings, modifySettings, notifications, save, values}
}

test.each(['default switch', 'profile reorder'])('a toggle keeps its original profile across %s', async (change) => {
    const fixture = setup(change === 'profile reorder' ? {index: 0} : {current: true})
    const pending = fixture.handler._toggleOption('general.enable')
    await fixture.readStarted.promise
    /** @type {import('settings-modifications').ScopedModification} */
    const mutation = change === 'profile reorder' ?
        {action: 'swapProfiles', profileId1: 'profile-a', profileId2: 'profile-b', scope: 'global', optionsContext: null} :
        {action: 'setDefaultProfile', profileId: 'profile-b', scope: 'global', optionsContext: null}
    await fixture.backend._modifySettings([mutation], 'other settings page')
    fixture.releaseRead.resolve()
    await pending

    expect(fixture.values()).toEqual({'profile-a': true, 'profile-b': false})
    expect(fixture.notifications).toHaveBeenCalledExactlyOnceWith(expect.anything(), true)
})

test('a new applied profile cancels a read even if the options context object is unchanged', async () => {
    const fixture = setup()
    const pending = fixture.handler._toggleOption('general.enable')
    await fixture.readStarted.promise
    await fixture.backend._modifySettings([{action: 'setDefaultProfile', profileId: 'profile-b', scope: 'global', optionsContext: null}], 'other settings page')
    fixture.state.profileId = 'profile-b'
    fixture.releaseRead.resolve()
    await pending

    expect(fixture.values()).toEqual({'profile-a': false, 'profile-b': false})
    expect(fixture.modifySettings).not.toHaveBeenCalled()
    expect(fixture.notifications).not.toHaveBeenCalled()
})

test('deleting the captured profile cannot redirect a pending toggle to the surviving profile', async () => {
    const fixture = setup()
    const pending = fixture.handler._toggleOption('general.enable')
    await fixture.readStarted.promise
    await fixture.backend._modifySettings([{action: 'deleteProfile', profileId: 'profile-a', scope: 'global', optionsContext: null}], 'other settings page')
    fixture.releaseRead.resolve()
    await pending

    expect(fixture.values()).toEqual({'profile-b': false})
    expect(fixture.notifications).toHaveBeenCalledExactlyOnceWith(expect.anything(), false)
})

test('an unavailable applied profile cannot toggle whichever profile is currently selected', async () => {
    const fixture = setup()
    fixture.state.profileId = null
    fixture.state.delayRead = false

    await fixture.handler._toggleOption('general.enable')

    expect(fixture.getSettings).not.toHaveBeenCalled()
    expect(fixture.modifySettings).not.toHaveBeenCalled()
    expect(fixture.values()).toEqual({'profile-a': false, 'profile-b': false})
    expect(fixture.notifications).toHaveBeenCalledExactlyOnceWith(expect.anything(), false)
})

test('two serialized toggles still update the captured profile twice', async () => {
    const fixture = setup()
    fixture.state.delayRead = false

    await Promise.all([fixture.handler._toggleOption('general.enable'), fixture.handler._toggleOption('general.enable')])

    expect(fixture.values()).toEqual({'profile-a': false, 'profile-b': false})
    expect(fixture.modifySettings).toHaveBeenCalledTimes(2)
    expect(fixture.save).toHaveBeenCalledTimes(2)
})
