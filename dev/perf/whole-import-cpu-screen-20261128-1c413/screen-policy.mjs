// Import-inert selected numeric policy and raw-clock arithmetic. No clock is read here.
import assert from 'node:assert/strict'

export const selectedGate = {
    minimumMedianPairedCpuSavingMs: 20,
    minimumMedianPairedCpuReductionPercent: 1,
    minimumFasterPairsAgainstEachControl: 10,
    pairsPerControlPerReplication: 12,
    maximumAbsoluteControlPairedMedianPercent: 3,
    maximumAbsoluteControlSummedCpuRatioPercent: 3,
    absoluteControlMillisecondGate: null,
    bothIndependentReplicationsMustPassSeparately: true,
    allSourceOutputWorkActivationLifecycleChecksMandatory: true,
    wholeBrowserQualificationStillRequired: true,
}

export function clockValues(timing) {
    for (const snapshot of [timing.cpuBefore, timing.cpuAfter]) {
        for (const key of ['user', 'system']) assert(Number.isSafeInteger(snapshot[key]) && snapshot[key] >= 0)
    }
    const user = timing.cpuAfter.user - timing.cpuBefore.user
    const system = timing.cpuAfter.system - timing.cpuBefore.system
    assert(user >= 0 && system >= 0 && Number.isSafeInteger(user + system))
    for (const value of [timing.wallBeforeNs, timing.wallAfterNs]) assert(typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value))
    const duration = BigInt(timing.wallAfterNs) - BigInt(timing.wallBeforeNs)
    assert(duration > 0n && duration <= BigInt(Number.MAX_SAFE_INTEGER))
    const result = {cpuMicros: user + system, cpuMs: (user + system) / 1000,
        wallNs: Number(duration), wallMs: Number(duration) / 1e6}
    assert(result.cpuMs > 0)
    assert.equal(timing.cpuMs, result.cpuMs)
    assert.equal(timing.wallMs, result.wallMs)
    return result
}
