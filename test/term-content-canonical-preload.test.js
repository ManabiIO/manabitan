/* SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */
/* eslint no-underscore-dangle: off */

import {afterEach, expect, test, vi} from 'vitest'
import {NativeCanonicalScanner} from '../ext/js/dictionary/term-content-canonical-scan.js'
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js'

afterEach(() => { vi.restoreAllMocks() })

const module = new WebAssembly.Module(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0))

test('starts optional code loading without creating a metadata arena or scanning rows', async () => {
    /** @type {(value: WebAssembly.Module) => void} */
    let finish = () => {}
    /** @type {Promise<WebAssembly.Module>} */
    const pending = new Promise((resolve) => { finish = resolve })
    const loadModule = vi.fn(() => pending)
    const scanner = new NativeCanonicalScanner({loadModule})
    const before = {...scanner.stats}
    const preload = scanner.preload()
    expect(loadModule).toHaveBeenCalledOnce()
    expect(scanner.stats).toEqual(before)
    finish(module)
    await expect(preload).resolves.toBeUndefined()
    expect(scanner.stats).toEqual(before)
})

test.each(['synchronous', 'asynchronous'])('owns %s preload failure and permits the existing loader to retry', async (failure) => {
    const loadModule = vi.fn()
        .mockImplementationOnce(() => {
            if (failure === 'synchronous') { throw new Error('optional native asset unavailable') }
            return Promise.reject(new Error('optional native asset unavailable'))
        })
        .mockResolvedValueOnce(module)
    const scanner = new NativeCanonicalScanner({loadModule})
    await expect(scanner.preload()).resolves.toBeUndefined()
    await expect(scanner.preload()).resolves.toBeUndefined()
    expect(loadModule).toHaveBeenCalledTimes(2)
    expect(scanner.stats.calls).toBe(0)
    expect(scanner.stats.fallbacks).toBe(0)
})

test('bulk import reserves ownership before preloading and does not wait for optional code', async () => {
    const database = new DictionaryDatabase()
    /** @type {string[]} */
    const order = []
    vi.spyOn(database, '_requireDb').mockReturnValue(/** @type {ReturnType<DictionaryDatabase['_requireDb']>} */ ({}))
    vi.spyOn(database, '_beginBulkImportLifecycle').mockImplementation(() => { order.push('ownership') })
    vi.spyOn(database, '_startBulkImportSetup').mockImplementation(async () => {
        order.push('setup')
        return 'test-session'
    })
    const scanner = /** @type {NativeCanonicalScanner} */ (Reflect.get(database, '_nativeCanonicalScanner'))
    vi.spyOn(scanner, 'preload').mockImplementation(() => {
        order.push('preload')
        return new Promise(() => {})
    })
    await expect(database.startBulkImport()).resolves.toBe('test-session')
    expect(order).toEqual(['ownership', 'preload', 'setup'])
})
