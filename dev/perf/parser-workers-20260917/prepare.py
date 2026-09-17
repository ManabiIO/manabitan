from pathlib import Path

ROOT=Path.cwd()

def edit(name,old,new,count=1):
    p=ROOT/name
    text=p.read_text()
    assert text.count(old)==count,(name,old[:100],text.count(old),count)
    p.write_text(text.replace(old,new))

for flag in ['experimentalParserWorkers3','experimentalParserWorkers4']:
    edit('ext/js/dictionary/term-bank-experiments.js','    return Object.freeze({\n',f'    return Object.freeze({{\n        {flag}: options.{flag} === true,\n')
    edit('types/ext/dictionary-importer.d.ts','export type ImportExperiments = {\n',f'export type ImportExperiments = {{\n    {flag}?: boolean;\n')

p='ext/js/dictionary/term-bank-wasm-parser.js'
edit(p,'    /** @returns {Promise<boolean>} */\n    async prewarm() {\n        const disposalGeneration = this._disposalGeneration;\n        const workerCount = getParallelTermBankParserWorkerCount();', '''    /**
     * @param {import('dictionary-importer').ImportExperiments} [options]
     * @returns {Promise<boolean>}
     */
    async prewarm(options = {}) {
        const disposalGeneration = this._disposalGeneration;
        const workerCount = getParallelTermBankParserWorkerCount(options);''')
edit(p,' * @returns {Promise<boolean>}\n */\nexport async function prewarmParallelTermBankParser() {\n    if (!canUseParallelTermBankParser()) { return false; }\n    return await parallelTermBankParserPool.prewarm();', ''' * @param {import('dictionary-importer').ImportExperiments} [options]
 * @returns {Promise<boolean>}
 */
export async function prewarmParallelTermBankParser(options = {}) {
    if (!canUseParallelTermBankParser()) { return false; }
    return await parallelTermBankParserPool.prewarm(options);''')
edit(p,'    const workerCount = getParallelTermBankParserWorkerCount();\n    const pipelineGroupsPerWorker = getParallelSourcePipelineGroupsPerWorker(options);','    const workerCount = getParallelTermBankParserWorkerCount(options);\n    const pipelineGroupsPerWorker = getParallelSourcePipelineGroupsPerWorker(options);')
edit(p,' * @returns {number}\n */\nexport function getParallelTermBankParserWorkerCount() {',''' * @param {import('dictionary-importer').ImportExperiments} [options]
 * @returns {number}
 */
export function getParallelTermBankParserWorkerCount(options = {}) {''')
old='''    return hasEnoughCpus && !hasConstrainedMemory ?
        HIGH_CAPABILITY_PARALLEL_SOURCE_WORKER_COUNT :
        DEFAULT_PARALLEL_SOURCE_WORKER_COUNT;'''
new='''    const baseline = hasEnoughCpus && !hasConstrainedMemory ?
        HIGH_CAPABILITY_PARALLEL_SOURCE_WORKER_COUNT :
        DEFAULT_PARALLEL_SOURCE_WORKER_COUNT;
    if (hasConstrainedMemory || typeof rawHardwareConcurrency !== 'number' || !Number.isFinite(rawHardwareConcurrency)) {
        return baseline;
    }
    const workers3 = options.experimentalParserWorkers3 === true;
    const workers4 = options.experimentalParserWorkers4 === true;
    if (workers3 === workers4 || rawHardwareConcurrency < 4) { return baseline; }
    return Math.max(baseline, workers4 ? 4 : 3);'''
edit(p,old,new)
edit('ext/js/dictionary/dictionary-importer.js','                void prewarmParallelTermBankParser();','                void prewarmParallelTermBankParser(this._termBankExperiments);')

(Path('test/term-bank-parser-worker-policy.test.js')).write_text('''/*
 * Copyright (C) 2026  Yomitan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */
import {afterEach, describe, expect, test} from 'vitest'
import {getParallelTermBankParserWorkerCount} from '../ext/js/dictionary/term-bank-wasm-parser.js'
import {snapshotTermBankExperiments} from '../ext/js/dictionary/term-bank-experiments.js'

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')

function setNavigator(hardwareConcurrency, deviceMemory) {
    Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {hardwareConcurrency, deviceMemory}})
}

afterEach(() => {
    if (originalNavigator === undefined) {
        delete globalThis.navigator
    } else {
        Object.defineProperty(globalThis, 'navigator', originalNavigator)
    }
})

describe('bounded parser worker experiments', () => {
    test.each(['experimentalParserWorkers3', 'experimentalParserWorkers4'])('%s is literal-true and default-off', (key) => {
        expect(snapshotTermBankExperiments()[key]).toBe(false)
        for (const value of [false, 0, 1, null, undefined, 'true', {}]) {
            expect(snapshotTermBankExperiments({[key]: value})[key]).toBe(false)
        }
        expect(snapshotTermBankExperiments({[key]: true})[key]).toBe(true)
    })

    test('four-core devices select only the requested count', () => {
        setNavigator(4, 8)
        expect(getParallelTermBankParserWorkerCount()).toBe(2)
        expect(getParallelTermBankParserWorkerCount({experimentalParserWorkers3: true})).toBe(3)
        expect(getParallelTermBankParserWorkerCount({experimentalParserWorkers4: true})).toBe(4)
        expect(getParallelTermBankParserWorkerCount({experimentalParserWorkers3: true, experimentalParserWorkers4: true})).toBe(2)
    })

    test('does not weaken existing high-capability policy', () => {
        setNavigator(8, 8)
        expect(getParallelTermBankParserWorkerCount()).toBe(5)
        expect(getParallelTermBankParserWorkerCount({experimentalParserWorkers3: true})).toBe(5)
        expect(getParallelTermBankParserWorkerCount({experimentalParserWorkers4: true})).toBe(5)
    })

    test('constrained and undersized devices stay baseline', () => {
        for (const [cpu, memory] of [[2, 8], [4, 4], [4, 2]]) {
            setNavigator(cpu, memory)
            expect(getParallelTermBankParserWorkerCount({experimentalParserWorkers3: true})).toBe(2)
            expect(getParallelTermBankParserWorkerCount({experimentalParserWorkers4: true})).toBe(2)
        }
    })
})
''')
print('Installed default-off 3/4 worker policies; high-capability and <=4 GiB policies remain unchanged')
