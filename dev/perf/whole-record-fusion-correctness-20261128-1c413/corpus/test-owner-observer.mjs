/* SPDX-License-Identifier: GPL-3.0-or-later */
// Pure synthetic observer tests; no product modules, files, workers or clocks.
import assert from 'node:assert/strict'
import {observeRecordOwners, verifyOwnerAccounting, scalarBaseBits} from './owner-observer.mjs'

const clone = (value) => structuredClone(value)
const empty = () => ({calls: 0, javascriptCalls: 0, native: {
    nativeCalls: 0, nativeRows: 0, nativeAttempts: 0,
    wholeNativeCalls: 0, wholeNativeRows: 0, wholeNativeAttempts: 0,
    inputCopiedBytes: 0, outputCopiedBytes: 0, tableBytesRequested: 0,
    memoryGrowthBytes: 0, maximumLinearMemoryBytes: 131072, maximumScratchBytes: 224,
    declines: {}, wholeAdmissionDeclines: {}, wholeCopiedDeclines: {},
}})
const size = (rows) => 20 + rows * 8
function nativeWork(metrics, rows, whole, success) {
    const value = metrics.native
    value.nativeAttempts += 1
    value.wholeNativeAttempts += Number(whole)
    value.inputCopiedBytes += rows * 8 + 3 * 12
    let slots = 2
    while (slots < Math.min(rows, 65535) * 2) slots *= 2
    value.tableBytesRequested += slots * 4
    if (success) {
        value.nativeCalls += 1
        value.nativeRows += rows
        value.wholeNativeCalls += Number(whole)
        value.wholeNativeRows += whole ? rows : 0
        value.outputCopiedBytes += size(rows) + (whole ? 8 : 0)
    } else {
        const reasons = whole ? value.wholeCopiedDeclines : value.declines
        reasons['unsupported-compact'] = (reasons['unsupported-compact'] ?? 0) + 1
    }
}

function fixture(modes = ['whole']) {
    const state = {owners: [], fields: [], observerErrors: [], active: null}
    const metrics = empty()
    for (const mode of modes) {
        const split = mode === 'split'
        const rows = split ? 32 : 16
        const owner = {ordinal: state.owners.length, rowCount: rows, uniqueCount: 3,
            firstId: state.fields.reduce((sum, call) => sum + call.rowCount, 0), contentDictName: 'raw',
            fieldStart: state.fields.length, before: clone(metrics), error: null, settled: true}
        if (mode !== 'ordinary') nativeWork(metrics, rows, true, mode === 'whole')
        for (let i = 0; i < (split ? 2 : 1); i += 1) {
            const before = clone(metrics)
            const whole = mode === 'whole'
            const fallback = mode === 'fallback'
            const emitted = fallback ? 16 * 12 : size(16)
            if (mode === 'ordinary' || split) nativeWork(metrics, 16, false, true)
            metrics.calls += 1
            if (fallback) {
                metrics.javascriptCalls += 1
                metrics.native.declines['unsupported-compact'] = (metrics.native.declines['unsupported-compact'] ?? 0) + 1
            }
            state.fields.push({ordinal: state.fields.length, ownerOrdinal: owner.ordinal,
                rowCount: 16, uniqueCount: 3, contentOffsetBase: 0, contentOffsetBaseBits: scalarBaseBits(0), bytes: emitted, sha256: 'synthetic',
                before, after: clone(metrics),
                wholeAttempt: whole || fallback ? {copied: true, succeeded: whole, contentOffsetBase: whole ? 0 : null,
                    contentOffsetBaseBits: whole ? scalarBaseBits(0) : null} : null})
        }
        owner.after = clone(metrics)
        owner.fieldEnd = state.fields.length
        state.owners.push(owner)
    }
    return {state, metrics: clone(metrics), rows: state.fields.reduce((sum, call) => sum + call.rowCount, 0)}
}

const tests = []
const test = (name, body) => tests.push([name, body])
const verify = ({state, metrics, rows}) => verifyOwnerAccounting(state, metrics, 'B', rows)

test('whole work precedes the field hook but is fully owned', () => {
    const f = fixture()
    assert.equal(f.state.fields[0].before.native.nativeCalls, 1)
    assert.equal(verify(f).wholeNativeCalls, 1)
    assert.equal(verify(f).outputCopiedBytes, size(16) + 8)
})
test('signed-zero scalar identity survives JSON receipt serialization', () => {
    const value = JSON.parse(JSON.stringify({positive: scalarBaseBits(0), negative: scalarBaseBits(-0)}))
    assert.equal(value.positive, '0000000000000000')
    assert.equal(value.negative, '0000000000000080')
    const f = fixture()
    f.state.fields[0].contentOffsetBaseBits = scalarBaseBits(-0)
    assert.throws(() => verify(f))
})
test('ordinary work and whole work retain different ownership', () => {
    const result = verify(fixture(['ordinary', 'whole']))
    assert.equal(result.ordinaryNativeCalls, 1)
    assert.equal(result.wholeNativeCalls, 1)
})
test('copied unsplit decline is accounted once', () => {
    const result = verify(fixture(['fallback', 'whole']))
    assert.equal(result.committedWholeAttemptDeclines, 1)
})
test('copied split attempt plus both ordinary slices are all charged', () => {
    const result = verify(fixture(['split', 'whole']))
    assert.equal(result.ordinaryNativeCalls, 2)
    assert.equal(result.committedWholeAttemptDeclines, 0)
    assert.equal(result.inputCopiedBytes, (32 * 8 + 36) + 3 * (16 * 8 + 36))
})
test('missing base-output bytes rejects', () => {
    const f = fixture()
    for (const value of [f.metrics, f.state.owners[0].after, f.state.fields[0].before, f.state.fields[0].after]) value.native.outputCopiedBytes -= 8
    assert.throws(() => verify(f))
})
test('duplicate copied fallback work rejects', () => {
    const f = fixture(['fallback', 'whole'])
    f.state.owners[0].after.native.inputCopiedBytes += 164
    assert.throws(() => verify(f))
})
test('a hidden pre-field attempt rejects', () => {
    const f = fixture()
    f.state.owners[0].after.native.nativeAttempts += 1
    assert.throws(() => verify(f))
})
test('lost or overlapping owner field membership rejects', () => {
    const f = fixture(['whole', 'whole'])
    f.state.owners[1].fieldStart = 0
    assert.throws(() => verify(f))
})
test('ordinary native success alone does not prove fusion', () => {
    assert.throws(() => verify(fixture(['ordinary'])), /No whole fusion/)
})
test('unexpected disabling failure rejects', () => {
    const f = fixture()
    for (const value of [f.metrics, f.state.owners[0].after]) value.native.wholeAdmissionDeclines['native-trap'] = 1
    assert.throws(() => verify(f), /failure\/disable/)
})
test('owner wrapper preserves original Promise and records before caller resume', async () => {
    let originalPromise
    const bytes = new Uint8Array(24)
    const chunk = {rowCount: 2}
    const store = {
        _encodeArtifactRecordFields() { return bytes },
        _encodeAndAppendArtifactChunkForState(...args) {
            originalPromise = (async () => {
                this._encodeArtifactRecordFields(args[1], [], [], 0)
                await Promise.resolve()
                return 7
            })()
            return originalPromise
        },
    }
    const observed = observeRecordOwners(store, () => 'synthetic')
    const result = store._encodeAndAppendArtifactChunkForState({}, chunk, 0, [], [])
    assert.equal(result, originalPromise)
    assert.equal(await result, 7)
    assert.equal(observed.active, null)
    assert.equal(observed.owners[0].settled, true)
    assert.equal(verifyOwnerAccounting(observed, null, 'A', 2).nativeActivated, false)
})
test('field output outside an owner fails before being accepted', () => {
    const store = {_encodeArtifactRecordFields() { return new Uint8Array(12) },
        async _encodeAndAppendArtifactChunkForState() {}}
    observeRecordOwners(store, () => 'synthetic')
    assert.throws(() => store._encodeArtifactRecordFields({rowCount: 1}, [], [], 0), /escaped/)
})
test('original owner rejection is retained without replacing its Promise', async () => {
    const failure = new Error('original failure')
    let originalPromise
    const store = {_encodeArtifactRecordFields() { return new Uint8Array(12) },
        _encodeAndAppendArtifactChunkForState() { originalPromise = Promise.reject(failure); return originalPromise }}
    const observed = observeRecordOwners(store, () => 'synthetic')
    const promise = store._encodeAndAppendArtifactChunkForState({}, {rowCount: 1}, 0, [], [])
    assert.equal(promise, originalPromise)
    await assert.rejects(promise, (error) => error === failure)
    assert.equal(observed.owners[0].error, String(failure))
    assert.equal(observed.active, null)
})

for (const [name, body] of tests) {
    await body()
    console.log('PASS ' + name)
}
console.log(JSON.stringify({passed: true, cases: tests.length, productExecution: false,
    performanceMeasurements: false, node: process.version}))
