/* SPDX-License-Identifier: GPL-3.0-or-later */
import assert from 'node:assert/strict'
import {parentPort, workerData, threadId} from 'node:worker_threads'
import {performance} from 'node:perf_hooks'
import {createParser, sourceFor, sha256, verifyGroup} from './common.mjs'

const {module, inputDirectory, groups, workerIndex} = workerData
assert.ok(parentPort)
assert.deepEqual(WebAssembly.Module.imports(module), [])
let parser
let calls = 0
let busy = false
const sources = new Map()
try {
    parser = await createParser(module, 'timed-worker-' + workerIndex)
    parentPort.postMessage({type: 'initialized', workerIndex, threadId, execArgv: process.execArgv})
} catch (error) {
    parentPort.postMessage({type: 'fatal', workerIndex, name: error.name, message: error.message, stack: error.stack})
}

parentPort.on('message', async message => {
    if (message.type === 'prepare') {
        try {
            assert.equal(busy, false)
            busy = true
            for (const group of groups) {
                sources.set(group.groupIndex, await Promise.all(group.banks.map(bank => sourceFor(inputDirectory, bank))))
            }
            parentPort.postMessage({type: 'prepared', workerIndex, threadId, groups: groups.map(group => group.groupIndex)})
        } catch (error) {
            parentPort.postMessage({type: 'fatal', workerIndex, name: error.name, message: error.message, stack: error.stack})
        } finally { busy = false }
        return
    }
    if (message.type !== 'run-group') { return }
    let current = {phase: message.phase, groupIndex: message.groupIndex, workerIndex, threadId,
        invocation: calls + 1, firstInvocation: calls === 0}
    try {
        assert.equal(busy, false)
        busy = true
        const group = groups.find(entry => entry.groupIndex === message.groupIndex)
        assert.ok(group)
        const input = sources.get(group.groupIndex)
        assert.ok(input)
        assert.equal(group.crcReuseEligible, false)
        const started = performance.now()
        let result
        try {
            result = await parser.inflateCompressedTermBankSourcesWasm(input, {}, true)
        } finally {
            current.owningMs = performance.now() - started
        }
        current.nativeInflateAndCrcMs = result.inflateMs
        current.compressedBytes = group.compressedBytes
        current.decodedBytes = group.decodedBytes
        current.rows = group.rows
        current.inputCopiedBytes = group.compressedBytes
        current.stage = 'output-oracle'
        Object.assign(current, verifyGroup(result, group))
        for (const [index, source] of input.entries()) {
            assert.equal(sha256(source.bytes), group.banks[index].compressedSha256)
        }
        ++calls
        current = {...current, passed: true, stage: 'complete'}
        parentPort.postMessage({type: 'group-result', ...current})
    } catch (error) {
        parentPort.postMessage({type: 'group-result', ...current, passed: false,
            error: {name: error.name, message: error.message, stack: error.stack}})
    } finally {
        busy = false
    }
})
