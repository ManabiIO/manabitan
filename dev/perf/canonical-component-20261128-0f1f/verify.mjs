/* Copyright (C) 2026 Manabitan authors. SPDX-License-Identifier: GPL-3.0-or-later */
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import path from 'node:path'
import {parseArgs} from 'node:util'
import {hash, loadInputs, loadSnapshot, writeJson} from './common.mjs'

const {values} = parseArgs({options: {snapshots: {type: 'string'}, modules: {type: 'string'}, output: {type: 'string'}}})
assert(values.snapshots && values.modules && values.output)
const snapshotRoot = path.resolve(values.snapshots)
const {protocol, inventory, snapshotInventorySha256} = await loadInputs(snapshotRoot)
const states = []
for (const entry of [protocol.baseline, ...Object.values(protocol.variants)]) {
    const bytes = await readFile(path.join(values.modules, entry.id + '.wasm'))
    assert.equal(hash(bytes), entry.sha256)
    const module = await WebAssembly.compile(bytes)
    const memory = new WebAssembly.Memory({initial: inventory.groups[0].memoryPages, maximum: inventory.groups[0].memoryPages})
    const instance = new WebAssembly.Instance(module, {env: {memory}})
    assert.equal(instance.exports.canonical_abi_version(), 1)
    assert.equal(instance.exports.canonical_layout_end(), 8263840)
    assert.equal(instance.exports.canonical_max_rows(), 100000)
    assert.equal(instance.exports.canonical_prefix_bytes(), 8388608)
    if (states.length) {
        assert.deepEqual(WebAssembly.Module.imports(module), WebAssembly.Module.imports(states[0].module))
        assert.deepEqual(WebAssembly.Module.exports(module), WebAssembly.Module.exports(states[0].module))
    }
    states.push({id: entry.id, module, memory, instance})
}
const report = {schemaVersion: 1, scope: 'Untimed complete native arena parity for every captured group and frozen module', snapshotInventorySha256, complete: false, observations: []}
await writeJson(values.output, report)
for (const group of inventory.groups) {
    const {before, after} = await loadSnapshot(snapshotRoot, group)
    for (const state of states) {
        assert.equal(state.memory.buffer.byteLength, group.memoryPages * 65536)
        const bytes = new Uint8Array(state.memory.buffer)
        bytes.set(before)
        const returned = state.instance.exports.scan_canonical()
        assert.equal(returned, group.expectedReturn)
        assert.equal(Buffer.compare(bytes, after), 0, `${state.id} group${group.group}`)
        const actualAfterSha256 = hash(bytes)
        assert.equal(actualAfterSha256, group.afterSha256)
        report.observations.push({module: state.id, group: group.group, returned, bytes: bytes.byteLength, actualAfterSha256})
    }
    await writeJson(values.output, report)
}
report.complete = true
await writeJson(values.output, report)
console.log(JSON.stringify({complete: true, groups: inventory.groups.length, modules: states.map(({id}) => id), validations: report.observations.length}))
