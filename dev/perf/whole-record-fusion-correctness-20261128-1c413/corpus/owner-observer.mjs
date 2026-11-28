/* SPDX-License-Identifier: GPL-3.0-or-later */
// Import-inert correctness observer. No product import, readiness await or clock.
import assert from 'node:assert/strict'

const workKeys = ['nativeCalls', 'nativeRows', 'nativeAttempts', 'wholeNativeCalls',
    'wholeNativeRows', 'wholeNativeAttempts', 'inputCopiedBytes', 'outputCopiedBytes',
    'tableBytesRequested', 'memoryGrowthBytes']
const maps = ['declines', 'wholeAdmissionDeclines', 'wholeCopiedDeclines']
const attempts = ['unsupported-compact', 'native-trap', 'native-return', 'native-base', 'native-header', 'output-copy']
const allowed = new Set(['eligibility', 'memory-bound', 'unsupported-compact'])
const native = (metrics, key) => metrics?.native?.[key] ?? 0
const delta = (before, after, key) => native(after, key) - native(before, key)
const sum = (values) => values.reduce((total, value) => total + value, 0)
const mapDelta = (before, after, name, reason) =>
    (after?.native?.[name]?.[reason] ?? 0) - (before?.native?.[name]?.[reason] ?? 0)
const mapSum = (value, names = null) => sum((names ?? Object.keys(value ?? {})).map((name) => value?.[name] ?? 0))
const safe = (value) => assert.ok(Number.isSafeInteger(value) && value >= 0)

function shape(chunk) {
    return {rowCount: chunk.rowCount, uniqueCount: chunk.resolvedContentReferences?.offsets?.length ?? null}
}

export function scalarBaseBits(value) {
    const bytes = new Uint8Array(8)
    new DataView(bytes.buffer).setFloat64(0, value, true)
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function observeRecordOwners(store, digest) {
    const state = {owners: [], fields: [], observerErrors: [], active: null}
    const metrics = () => store._getImportRecordFieldMetrics?.() ?? null
    const originalOwner = store._encodeAndAppendArtifactChunkForState
    const originalField = store._encodeArtifactRecordFields
    store._encodeAndAppendArtifactChunkForState = function (...args) {
        assert.equal(state.active, null, 'Concurrent or nested owners require a new declared observer boundary')
        const owner = {ordinal: state.owners.length, ...shape(args[1]), firstId: args[2],
            contentDictName: args[6] ?? 'raw', fieldStart: state.fields.length,
            fieldEnd: null, before: metrics(), after: null, settled: false, error: null}
        state.owners.push(owner)
        state.active = owner
        const finish = (error) => {
            try {
                assert.equal(state.active, owner)
                owner.after = metrics()
                owner.fieldEnd = state.fields.length
                owner.settled = true
                owner.error = error === null ? null : String(error)
            } catch (cause) { state.observerErrors.push(String(cause)) }
            finally { state.active = null }
        }
        let promise
        try { promise = Reflect.apply(originalOwner, this, args) }
        catch (cause) { finish(cause); throw cause }
        assert.ok(promise instanceof Promise, 'The original owner must retain its async contract')
        // Attach observation before returning the exact original Promise. This
        // records completion before the caller resumes, without replacing that
        // Promise or waiting for the optional encoder.
        void promise.then(() => finish(null), (cause) => finish(cause))
        return promise
    }
    store._encodeArtifactRecordFields = function (...args) {
        const owner = state.active
        assert.ok(owner, 'Field output escaped the enclosing recorded owner')
        const before = metrics()
        const bytes = Reflect.apply(originalField, this, args)
        assert.ok(bytes instanceof Uint8Array)
        const after = metrics()
        const attempt = args[4] ?? null
        state.fields.push({ordinal: state.fields.length, ownerOrdinal: owner.ordinal,
            ...shape(args[0]), contentOffsetBase: args[3], contentOffsetBaseBits: scalarBaseBits(args[3]), bytes: bytes.byteLength,
            sha256: digest(bytes), before, after,
            wholeAttempt: attempt === null ? null : {
                copied: attempt.copied, succeeded: attempt.recordFields === bytes,
                contentOffsetBase: attempt.recordFields === bytes ? attempt.contentOffsetBase : null,
                contentOffsetBaseBits: attempt.recordFields === bytes ? scalarBaseBits(attempt.contentOffsetBase) : null,
            }})
        return bytes
    }
    return state
}

function checkNativeProgress(before, after) {
    for (const [key, value] of Object.entries(after?.native ?? {})) {
        if (typeof value === 'number') {
            safe(value)
            assert.ok(value >= native(before, key), 'Native counter regressed: ' + key)
        }
    }
    for (const name of maps) {
        const reasons = new Set([...Object.keys(before?.native?.[name] ?? {}), ...Object.keys(after?.native?.[name] ?? {})])
        for (const reason of reasons) {
            safe(after?.native?.[name]?.[reason] ?? 0)
            assert.ok(mapDelta(before, after, name, reason) >= 0)
        }
    }
}

function copiedInput(shapeValue, count) {
    if (count === 0) return 0
    safe(shapeValue.rowCount)
    assert.ok(Number.isSafeInteger(shapeValue.uniqueCount) && shapeValue.uniqueCount > 0)
    return count * (shapeValue.rowCount * 8 + shapeValue.uniqueCount * 12)
}

function tableBytes(rows, count) {
    let slots = 2
    while (slots < Math.min(rows, 65535) * 2) slots *= 2
    return count * slots * 4
}

// This validation consumes retained observer data only. Whole work happens
// before the field hook, so owner/direct totals are authoritative. The field
// hook is used only for complete outputs, ordinary work, and authenticated
// unsplit fallback commits; overlapping decline maps are never blindly added.
export function verifyOwnerAccounting(state, fieldMetrics, arm, totalRows) {
    assert.deepEqual(state.observerErrors, [])
    assert.equal(state.active, null)
    assert.ok(state.owners.length > 0 && state.fields.length > 0)
    assert.deepEqual(state.owners.map((owner) => owner.ordinal), state.owners.map((_, index) => index))
    assert.deepEqual(state.fields.map((call) => call.ordinal), state.fields.map((_, index) => index))
    assert.equal(sum(state.fields.map((call) => call.rowCount)), totalRows)
    let cursor = 0
    let successfulWhole = 0
    let wholeRows = 0
    let successfulOrdinary = 0
    let ordinaryRows = 0
    let readinessCalls = 0
    let committedWholeAttemptDeclines = 0
    let expectedInputs = 0
    let expectedTables = 0
    let expectedOutputs = 0
    const ownerWork = Object.fromEntries(workKeys.map((key) => [key, 0]))
    for (const owner of state.owners) {
        assert.ok(owner.settled && owner.error === null)
        assert.equal(owner.fieldStart, cursor)
        assert.ok(Number.isSafeInteger(owner.fieldEnd) && owner.fieldEnd > cursor)
        const fields = state.fields.slice(cursor, owner.fieldEnd)
        assert.equal(fields.length, owner.fieldEnd - cursor)
        assert.equal(sum(fields.map((call) => call.rowCount)), owner.rowCount)
        assert.ok(fields.every((call) => call.ownerOrdinal === owner.ordinal))
        cursor = owner.fieldEnd
        if (arm === 'A') {
            assert.equal(owner.before, null)
            assert.equal(owner.after, null)
            assert.ok(fields.every((call) => call.before === null && call.after === null && call.wholeAttempt === null))
            continue
        }
        assert.ok(owner.before && owner.after)
        checkNativeProgress(owner.before, owner.after)
        assert.equal(owner.after.calls - owner.before.calls, fields.length)
        const wholeAttempts = delta(owner.before, owner.after, 'wholeNativeAttempts')
        assert.ok(wholeAttempts === 0 || wholeAttempts === 1)
        const wholeCalls = fields.filter((call) => call.wholeAttempt?.succeeded === true)
        assert.ok(wholeCalls.length <= 1)
        if (wholeCalls.length > 0) {
            assert.equal(fields.length, 1)
            assert.equal(wholeCalls[0].rowCount, owner.rowCount)
            assert.equal(wholeCalls[0].wholeAttempt.contentOffsetBase, wholeCalls[0].contentOffsetBase)
            assert.equal(wholeCalls[0].wholeAttempt.contentOffsetBaseBits, wholeCalls[0].contentOffsetBaseBits)
        }
        let ordinaryCalls = 0
        let ordinaryAttempts = 0
        let ownerInputs = copiedInput(owner, wholeAttempts)
        let ownerTables = tableBytes(owner.rowCount, wholeAttempts)
        let ownerOutputs = 0
        let ownerNativeRows = 0
        let ownerJs = 0
        for (const call of fields) {
            assert.ok(call.before && call.after)
            checkNativeProgress(call.before, call.after)
            assert.equal(call.after.calls, call.before.calls + 1)
            assert.equal(call.after.calls, call.after.javascriptCalls + native(call.after, 'nativeCalls'))
            const ordinary = delta(call.before, call.after, 'nativeCalls')
            const attempt = delta(call.before, call.after, 'nativeAttempts')
            assert.ok(ordinary === 0 || ordinary === 1)
            assert.ok(attempt === 0 || attempt === 1)
            const whole = call.wholeAttempt?.succeeded === true ? 1 : 0
            assert.ok(whole + ordinary <= 1)
            assert.equal(delta(call.before, call.after, 'wholeNativeCalls'), 0)
            assert.equal(delta(call.before, call.after, 'wholeNativeAttempts'), 0)
            assert.equal(delta(call.before, call.after, 'nativeRows'), ordinary * call.rowCount)
            assert.equal(delta(call.before, call.after, 'outputCopiedBytes'), ordinary * call.bytes)
            const js = call.after.javascriptCalls - call.before.javascriptCalls
            assert.equal(js, 1 - whole - ordinary)
            if (call.before.native === null) readinessCalls += 1
            if (call.wholeAttempt?.copied === true && whole === 0) {
                assert.equal(fields.length, 1)
                assert.equal(ordinary, 0)
                assert.equal(attempt, 0)
                const reasons = Object.keys(call.after.native?.declines ?? {}).filter((reason) => mapDelta(call.before, call.after, 'declines', reason) > 0)
                assert.equal(reasons.length, 1)
                assert.equal(mapDelta(call.before, call.after, 'declines', reasons[0]), 1)
                if (attempts.includes(reasons[0])) committedWholeAttemptDeclines += 1
            }
            ordinaryCalls += ordinary
            ordinaryAttempts += attempt
            ordinaryRows += ordinary * call.rowCount
            ownerJs += js
            ownerNativeRows += (whole + ordinary) * call.rowCount
            ownerInputs += copiedInput(call, attempt)
            ownerTables += tableBytes(call.rowCount, attempt)
            ownerOutputs += (whole + ordinary) * call.bytes + whole * 8
        }
        assert.equal(delta(owner.before, owner.after, 'wholeNativeCalls'), wholeCalls.length)
        assert.equal(delta(owner.before, owner.after, 'wholeNativeRows'), wholeCalls.length * owner.rowCount)
        assert.equal(delta(owner.before, owner.after, 'nativeCalls'), wholeCalls.length + ordinaryCalls)
        assert.equal(delta(owner.before, owner.after, 'nativeRows'), ownerNativeRows)
        assert.equal(delta(owner.before, owner.after, 'nativeAttempts'), wholeAttempts + ordinaryAttempts)
        assert.equal(owner.after.javascriptCalls - owner.before.javascriptCalls, ownerJs)
        assert.equal(delta(owner.before, owner.after, 'inputCopiedBytes'), ownerInputs)
        assert.equal(delta(owner.before, owner.after, 'tableBytesRequested'), ownerTables)
        assert.equal(delta(owner.before, owner.after, 'outputCopiedBytes'), ownerOutputs)
        for (const key of workKeys) ownerWork[key] += delta(owner.before, owner.after, key)
        successfulWhole += wholeCalls.length
        wholeRows += wholeCalls.length * owner.rowCount
        successfulOrdinary += ordinaryCalls
        expectedInputs += ownerInputs
        expectedTables += ownerTables
        expectedOutputs += ownerOutputs
    }
    assert.equal(cursor, state.fields.length)
    if (arm === 'A') {
        assert.equal(fieldMetrics, null)
        return {passed: true, ownerCalls: state.owners.length, fieldCalls: state.fields.length, nativeActivated: false}
    }
    assert.deepEqual(fieldMetrics, state.owners.at(-1).after)
    assert.equal(fieldMetrics.calls, state.fields.length)
    assert.equal(fieldMetrics.calls, fieldMetrics.javascriptCalls + fieldMetrics.native.nativeCalls)
    for (const key of workKeys) assert.equal(ownerWork[key], fieldMetrics.native[key], 'Native work outside recorded owners: ' + key)
    for (const name of maps) {
        for (const [reason, count] of Object.entries(fieldMetrics.native[name])) {
            safe(count)
            assert.ok(count === 0 || allowed.has(reason), 'Unexpected native failure/disable decline: ' + name + ':' + reason)
        }
    }
    const final = fieldMetrics.native
    assert.equal(final.wholeNativeAttempts, final.wholeNativeCalls + mapSum(final.wholeCopiedDeclines, attempts))
    assert.equal(final.nativeAttempts, final.nativeCalls + mapSum(final.declines, attempts) +
        mapSum(final.wholeCopiedDeclines, attempts) - committedWholeAttemptDeclines)
    assert.equal(fieldMetrics.javascriptCalls, readinessCalls + mapSum(final.declines))
    assert.equal(final.wholeNativeCalls, successfulWhole)
    assert.equal(final.wholeNativeRows, wholeRows)
    assert.equal(final.nativeCalls, successfulWhole + successfulOrdinary)
    assert.equal(final.nativeRows, wholeRows + ordinaryRows)
    assert.equal(final.inputCopiedBytes, expectedInputs)
    assert.equal(final.outputCopiedBytes, expectedOutputs)
    assert.equal(final.tableBytesRequested, expectedTables)
    assert.equal(final.memoryGrowthBytes % 65536, 0)
    assert.equal(final.maximumLinearMemoryBytes, 2 * 65536 + final.memoryGrowthBytes)
    assert.ok(final.maximumLinearMemoryBytes <= 1024 * 65536)
    assert.ok(final.maximumScratchBytes <= final.maximumLinearMemoryBytes)
    assert.ok(successfulWhole > 0 && wholeRows > 0,
        'No whole fusion activated naturally; retain this attempt without replacement')
    return {passed: true, ownerCalls: state.owners.length, fieldCalls: state.fields.length,
        nativeActivated: true, wholeNativeCalls: successfulWhole, wholeNativeRows: wholeRows,
        ordinaryNativeCalls: successfulOrdinary, ordinaryNativeRows: ordinaryRows,
        readinessJavascriptCalls: readinessCalls, committedWholeAttemptDeclines,
        inputCopiedBytes: expectedInputs, outputCopiedBytes: expectedOutputs, tableBytesRequested: expectedTables}
}
