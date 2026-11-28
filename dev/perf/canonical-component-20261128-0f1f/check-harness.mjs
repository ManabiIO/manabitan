/* Copyright (C) 2026 Manabitan authors. SPDX-License-Identifier: GPL-3.0-or-later */
// Exercise transport, sequencing and failure retention with a fake native export and clock.
// This performs no native compilation or performance observation.
import assert from 'node:assert/strict'
import {webcrypto} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import {hash, toolingRoot} from './common.mjs'

const source = await readFile(path.join(toolingRoot, 'worker.mjs'), 'utf8')
const moduleBytes = Uint8Array.of(10, 20, 30, 40)
const before = new Uint8Array(65536)
const after = new Uint8Array(before)
new Uint32Array(after.buffer)[0] = 0x89abcdef
const groups = Array.from({length: 12}, (_, index) => ({
    group: index + 1, rowCount: 2, uniqueRows: 1, memoryPages: 1,
    expectedReturn: 0, before: {sha256: hash(before)}, afterSha256: hash(after),
}))
async function check(mode) {
    const messages = []
    let nativeCalls = 0
    let clockReads = 0
    let beforeFetches = 0
    let end
    const finished = new Promise((resolve) => { end = resolve })
    const context = {
        ArrayBuffer, Uint8Array, Uint32Array, crypto: webcrypto,
        performance: {timeOrigin: 0, now: () => ++clockReads},
        navigator: {userAgent: 'synthetic protocol check', hardwareConcurrency: 4, deviceMemory: 8},
        crossOriginIsolated: mode !== 'isolation-mismatch', self: {},
        fetch: async (url) => {
            let bytes
            if (url.startsWith('/modules/')) {
                bytes = moduleBytes
            } else if (url.endsWith('/before')) {
                bytes = before
                ++beforeFetches
            } else {
                bytes = after
            }
            const copy = new Uint8Array(bytes)
            if (mode === 'late-input-drift' && url.endsWith('/before') && beforeFetches === 13) { copy[400] = 1 }
            return {ok: true, status: 200, arrayBuffer: async () => copy.buffer}
        },
        WebAssembly: {
            compile: async (bytes) => { assert.equal(hash(new Uint8Array(bytes)), hash(moduleBytes)); return {} },
            Memory: class { constructor({initial, maximum}) { assert.equal(initial, 1); assert.equal(maximum, 1); this.buffer = new ArrayBuffer(65536) } },
            Instance: class {
                constructor(module, {env: {memory}}) {
                    this.exports = {
                        canonical_abi_version: () => 1, canonical_layout_end: () => 8263840,
                        canonical_max_rows: () => 100000, canonical_prefix_bytes: () => 8388608,
                        scan_canonical: () => {
                            ++nativeCalls
                            if (mode === 'native-trap') { throw new Error('synthetic trap') }
                            new Uint32Array(memory.buffer)[0] = 0x89abcdef
                            if (mode === 'tail-byte-drift') { new Uint8Array(memory.buffer)[65535] = 1 }
                            return mode === 'bad-return' ? -1 : 0
                        },
                    }
                }
            },
        },
        postMessage: (message) => {
            messages.push(JSON.parse(JSON.stringify(message)))
            if (message.type === 'call') {
                queueMicrotask(() => context.self.onmessage({data: {
                    type: 'ack', pass: message.call.pass,
                    group: message.call.group + (mode === 'wrong-ack' ? 1 : 0),
                }}))
            } else {
                end(message)
            }
        },
    }
    vm.runInNewContext(source, context, {filename: 'worker.mjs'})
    context.self.onmessage({data: {type: 'start', module: {id: 'baseline', sha256: hash(moduleBytes)}, groups, passes: 2, worker: {crossOriginIsolated: true}}})
    const terminal = await finished
    const calls = messages.filter(({type}) => type === 'call').map(({call}) => call)
    assert.equal(clockReads, nativeCalls * 2)
    assert(calls.every(({elapsedMs}) => elapsedMs === 1))
    if (mode === 'success') {
        assert.equal(terminal.type, 'complete')
        assert.equal(nativeCalls, 24)
        assert.equal(terminal.completedCalls, 24)
        assert.deepEqual(calls.map(({pass, group}) => [pass, group]), [1, 2].flatMap((pass) => groups.map(({group}) => [pass, group])))
        assert(calls.every((call) => call.fullMemoryEqual && call.actualAfterSha256 === hash(after)))
    } else {
        assert.equal(terminal.type, 'failed')
        assert.equal(calls.length, mode === 'late-input-drift' ? 12 : mode === 'isolation-mismatch' ? 0 : 1)
        if (mode === 'isolation-mismatch') { assert.equal(nativeCalls, 0); assert.match(terminal.error, /Isolated worker timer policy mismatch/) }
        if (mode === 'late-input-drift') {
            assert.equal(nativeCalls, 12)
            assert.equal(terminal.stage, 'input')
            assert.match(terminal.error, /Input arena digest mismatch/)
        }
        if (mode === 'bad-return') { assert.equal(calls[0].returnValue, -1) }
        if (mode === 'native-trap') { assert.match(calls[0].nativeError, /synthetic trap/) }
        if (mode === 'tail-byte-drift') { assert.equal(calls[0].fullMemoryEqual, false) }
        if (mode === 'wrong-ack') { assert.match(terminal.error, /Out-of-order acknowledgement/) }
    }
    return {mode, terminal: terminal.type, retainedCalls: calls.length, nativeCalls, fakeClockReads: clockReads}
}
const checks = []
for (const mode of ['success', 'late-input-drift', 'tail-byte-drift', 'bad-return', 'native-trap', 'wrong-ack', 'isolation-mismatch']) {
    checks.push(await check(mode))
}
console.log(JSON.stringify({schemaVersion: 1, scope: 'Synthetic worker protocol checks with a fake clock and fake native export; no performance measurements', workerSha256: hash(source), checks}, null, 2))
