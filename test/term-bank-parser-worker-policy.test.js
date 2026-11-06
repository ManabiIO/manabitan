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

describe('bounded parser worker policy', () => {
    test('defaults on and accepts only a literal true or an absent value', () => {
        expect(snapshotTermBankExperiments().experimentalParserWorkers3).toBe(true)
        for (const value of [false, 0, 1, null, 'true', {}]) {
            const options = /** @type {Experiments} */ (/** @type {unknown} */ ({experimentalParserWorkers3: value}))
            expect(snapshotTermBankExperiments(options).experimentalParserWorkers3).toBe(false)
        }
        for (const value of [undefined, true]) {
            expect(snapshotTermBankExperiments({experimentalParserWorkers3: value}).experimentalParserWorkers3).toBe(true)
        }
    })

    test('selects three workers on eligible middle-CPU devices, including Firefox without a memory hint', () => {
        for (const cpu of [4, 5, 6, 7]) {
            for (const memory of [8, undefined]) {
                setNavigator(cpu, memory)
                expect(getParallelTermBankParserWorkerCount()).toBe(3)
                expect(getParallelTermBankParserWorkerCount(snapshotTermBankExperiments())).toBe(3)
                expect(getParallelTermBankParserWorkerCount({experimentalParserWorkers3: true})).toBe(3)
                expect(getParallelTermBankParserWorkerCount({experimentalParserWorkers3: false})).toBe(2)
            }
        }
    })

    test('retains the high-capability policy', () => {
        for (const memory of [8, undefined]) {
            setNavigator(8, memory)
            expect(getParallelTermBankParserWorkerCount()).toBe(5)
            expect(getParallelTermBankParserWorkerCount({experimentalParserWorkers3: true})).toBe(5)
            expect(getParallelTermBankParserWorkerCount({experimentalParserWorkers3: false})).toBe(5)
        }
    })

    test('constrained, undersized and unknown CPU devices retain two workers', () => {
        for (const [cpu, memory] of [[2, 8], [3, 8], [4, 4], [4, 2], [8, 4], [Number.NaN, 8], [Infinity, 8]]) {
            setNavigator(cpu, memory)
            expect(getParallelTermBankParserWorkerCount()).toBe(2)
            expect(getParallelTermBankParserWorkerCount({experimentalParserWorkers3: true})).toBe(2)
        }
        Reflect.deleteProperty(globalThis, 'navigator')
        expect(getParallelTermBankParserWorkerCount()).toBe(2)
    })
})
