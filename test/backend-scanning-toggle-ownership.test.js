/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFileSync} from 'node:fs'
import {afterEach, expect, test, vi} from 'vitest'
import {Backend} from '../ext/js/background/backend.js'
import {log} from '../ext/js/core/log.js'
import {deferPromise} from '../ext/js/core/utilities.js'
import {JsonSchema} from '../ext/js/data/json-schema.js'
import {OptionsUtil} from '../ext/js/data/options-util.js'

afterEach(() => { vi.restoreAllMocks() })

function setup() {
    const optionsUtil = new OptionsUtil()
    optionsUtil._optionsSchema = new JsonSchema(JSON.parse(readFileSync('ext/data/schemas/options-schema.json', 'utf8')))
    const options = optionsUtil.getDefault()
    options.profiles[0].id = 'profile-a'
    options.profiles[0].options.general.enable = true
    options.profiles.push({...structuredClone(options.profiles[0]), id: 'profile-b', name: 'B'})
    const save = vi.spyOn(optionsUtil, 'save').mockResolvedValue()
    const backend = /** @type {Backend} */ (Object.assign(Object.create(Backend.prototype), {
        _options: options,
        _optionsUtil: optionsUtil,
        _applyOptions: vi.fn(),
        _profileConditionsSchemaCache: [],
    }))
    Reflect.set(backend, '_commandHandlers', new Map([['toggleTextScanning', backend._onCommandToggleTextScanning.bind(backend)]]))
    const command = () => backend._onApiCommandExec({command: 'toggleTextScanning', params: void 0}, {})
    const values = () => Object.fromEntries(backend._getOptionsFull(false).profiles.map(({id, options: profile}) => [id, profile.general.enable]))
    const entered = /** @type {import('core').DeferredPromiseDetails<void>} */ (deferPromise())
    const release = /** @type {import('core').DeferredPromiseDetails<void>} */ (deferPromise())
    save.mockImplementationOnce(async () => {
        entered.resolve()
        await release.promise
    })
    return {backend, command, values, save, entered, release}
}

test('two browser commands toggle the committed value twice while the first save is delayed', async () => {
    const h = setup()
    expect(h.command()).toBe(true)
    await h.entered.promise
    expect(h.values()).toEqual({'profile-a': true, 'profile-b': true})
    expect(h.command()).toBe(true)
    h.release.resolve()
    await h.backend._optionsMutationTail
    expect(h.values()).toEqual({'profile-a': true, 'profile-b': true})
    expect(h.save.mock.calls.map(([options]) => options.profiles[0].options.general.enable)).toEqual([false, true])
})

test.each(['default switch', 'reorder'])('a command keeps its accepted profile across a queued %s', async (change) => {
    const h = setup()
    /** @type {import('settings-modifications').ScopedModification} */
    const target = change === 'default switch' ?
        {action: 'setDefaultProfile', profileId: 'profile-b', scope: 'global', optionsContext: null} :
        {action: 'swapProfiles', profileId1: 'profile-a', profileId2: 'profile-b', scope: 'global', optionsContext: null}
    const prior = h.backend._modifySettings([target], 'settings')
    await h.entered.promise
    h.command()
    h.release.resolve()
    await prior
    await h.backend._optionsMutationTail
    expect(h.values()).toEqual({'profile-a': false, 'profile-b': true})
})

test('a deleted accepted profile cannot redirect the command to the remaining profile', async () => {
    const h = setup()
    const report = vi.spyOn(log, 'error').mockImplementation(() => {})
    const prior = h.backend._modifySettings([{action: 'deleteProfile', profileId: 'profile-a', scope: 'global', optionsContext: null}], 'settings')
    await h.entered.promise
    h.command()
    h.release.resolve()
    await prior
    await h.backend._optionsMutationTail
    expect(h.values()).toEqual({'profile-b': true})
    expect(h.save).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(report).toHaveBeenCalledWith(expect.objectContaining({message: expect.stringContaining('Profile identity changed')})))
})

test('a later command uses the durable state after an earlier toggle save fails', async () => {
    const h = setup()
    const report = vi.spyOn(log, 'error').mockImplementation(() => {})
    h.save.mockReset()
    h.save.mockRejectedValueOnce(new Error('Settings write failed')).mockResolvedValue()
    h.command()
    await h.backend._optionsMutationTail
    expect(h.values()).toEqual({'profile-a': true, 'profile-b': true})
    h.command()
    await h.backend._optionsMutationTail
    expect(h.values()).toEqual({'profile-a': false, 'profile-b': true})
    expect(report).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({message: 'Settings write failed'}))
})
