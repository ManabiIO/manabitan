/* SPDX-License-Identifier: GPL-3.0-or-later */
// Import-inert boundary. Tests inject counters; importing this file reads no clock.
import assert from 'node:assert/strict'

export const boundaryName = 'first-product-module-evaluation-through-import-fixed-semantic-probes-and-retirement'

export function createCpuBoundary(mode, clocks = {
    cpu: () => process.cpuUsage(),
    wall: () => process.hrtime.bigint(),
}) {
    assert.ok(mode === 'untimed' || mode === 'cpu-screen')
    let phase = 'before'
    let raw = null
    return {
        get phase() { return phase },
        start() {
            assert.equal(phase, 'before')
            phase = 'running'
            if (mode === 'cpu-screen') {
                // One cumulative process-wide pair; never sum thread CPU or stages.
                const cpuBefore = clocks.cpu()
                const wallBeforeNs = clocks.wall()
                raw = {cpuBefore, wallBeforeNs}
            }
        },
        stop() {
            assert.equal(phase, 'running')
            if (mode === 'cpu-screen') {
                raw.wallAfterNs = clocks.wall()
                raw.cpuAfter = clocks.cpu()
            }
            phase = 'retired'
        },
        assertOutside() { assert.notEqual(phase, 'running', 'Observer evidence work escaped into the CPU interval') },
        report() {
            assert.equal(phase, 'retired')
            if (raw === null) return null
            const user = raw.cpuAfter.user - raw.cpuBefore.user
            const system = raw.cpuAfter.system - raw.cpuBefore.system
            return {boundary: boundaryName, cpuBefore: raw.cpuBefore, cpuAfter: raw.cpuAfter,
                wallBeforeNs: String(raw.wallBeforeNs), wallAfterNs: String(raw.wallAfterNs),
                cpuMs: (user + system) / 1000,
                wallMs: Number(raw.wallAfterNs - raw.wallBeforeNs) / 1e6}
        },
    }
}

// The same control flow is used by the real driver and by synthetic boundary
// tests. Failed original attempts still close and retain their raw interval.
export async function runImportBoundary(boundary, perform, retire) {
    let value = null
    let error = null
    let retirement = null
    boundary.start()
    try { value = await perform() }
    catch (cause) { error = cause }
    try { retirement = await retire(error) }
    catch (cause) { error ??= cause }
    boundary.stop()
    return {value, error, retirement, timing: boundary.report()}
}
