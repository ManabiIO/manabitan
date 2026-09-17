/*
 * Copyright (C) 2026  Yomitan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */
import {afterEach, describe, expect, test} from 'vitest'
import {getParallelTermBankParserWorkerCount} from '../ext/js/dictionary/term-bank-wasm-parser.js'
import {snapshotTermBankExperiments} from '../ext/js/dictionary/term-bank-experiments.js'

/** @typedef {import('dictionary-importer').ImportExperiments} Experiments */
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
const names = /** @type {Array<keyof Experiments>} */ (['experimentalParserWorkers3'])

/**
 * @param {number} hardwareConcurrency
 * @param {number|undefined} deviceMemory
 */
function setNavigator(hardwareConcurrency, deviceMemory) {
    Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {hardwareConcurrency, deviceMemory}})
}

afterEach(() => {
    if (originalNavigator === undefined) {
        Reflect.deleteProperty(globalThis, 'navigator')
    } else {
        Object.defineProperty(globalThis, 'navigator', originalNavigator)
    }
})

describe('bounded parser worker experiments', () => {
    test.each(names)('%s is literal-true and default-off', (key) => {
        expect(snapshotTermBankExperiments()[key]).toBe(false)
        for (const value of [false, 0, 1, null, undefined, 'true', {}]) {
            const options = /** @type {Experiments} */ (/** @type {unknown} */ ({[key]: value}))
            expect(snapshotTermBankExperiments(options)[key]).toBe(false)
        }
        expect(snapshotTermBankExperiments(/** @type {Experiments} */ ({[key]: true}))[key]).toBe(true)
    })

    test('four-core devices select only the requested count', () => {
        setNavigator(4, 8)
        expect(getParallelTermBankParserWorkerCount()).toBe(2)
        expect(getParallelTermBankParserWorkerCount({experimentalParserWorkers3: true})).toBe(3)
    })

    test('does not weaken existing high-capability policy', () => {
        setNavigator(8, 8)
        expect(getParallelTermBankParserWorkerCount()).toBe(5)
        expect(getParallelTermBankParserWorkerCount({experimentalParserWorkers3: true})).toBe(5)
    })

    test('constrained and undersized devices stay baseline', () => {
        for (const [cpu, memory] of [[2, 8], [4, 4], [4, 2]]) {
            setNavigator(cpu, memory)
            expect(getParallelTermBankParserWorkerCount({experimentalParserWorkers3: true})).toBe(2)
        }
    })
})
