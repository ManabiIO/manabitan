/* Copyright (C) 2026 Manabitan authors. SPDX-License-Identifier: GPL-3.0-or-later */
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {readFile, writeFile, rename} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {gunzipSync} from 'node:zlib'

export const toolingRoot = path.dirname(fileURLToPath(import.meta.url))
export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
export const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'))
export async function hashFile(file) {
    const digest = createHash('sha256')
    for await (const bytes of createReadStream(file)) { digest.update(bytes) }
    return digest.digest('hex')
}
export async function writeJson(file, value) {
    const temporary = file + '.tmp'
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n')
    await rename(temporary, file)
}
export function childPath(root, relative) {
    assert.equal(typeof relative, 'string')
    assert.ok(relative.length > 0 && !path.isAbsolute(relative))
    assert.ok(!relative.split(/[\\/]/).includes('..'))
    return path.join(root, relative)
}
export async function verifySourceInventory() {
    const file = path.join(toolingRoot, 'source-inventory.json')
    const bytes = await readFile(file)
    const inventory = JSON.parse(bytes)
    assert.equal(inventory.schemaVersion, 1)
    assert.ok(inventory.files.length > 0)
    const seen = new Set()
    for (const entry of inventory.files) {
        assert.ok(!seen.has(entry.path), 'Duplicate source inventory entry')
        seen.add(entry.path)
        const value = await readFile(childPath(toolingRoot, entry.path))
        assert.equal(value.byteLength, entry.bytes, entry.path)
        assert.equal(hash(value), entry.sha256, entry.path)
    }
    for (const required of ['protocol.json', 'snapshot-inventory.json', 'common.mjs', 'capture.mjs', 'build.mjs', 'verify.mjs', 'run.mjs', 'observe.mjs', 'worker.mjs', 'analyze.py']) {
        assert.ok(seen.has(required), `Missing source inventory entry: ${required}`)
    }
    const protocol = await readJson(path.join(toolingRoot, 'protocol.json'))
    const repositoryRoot = path.resolve(toolingRoot, '../../..')
    assert.equal(await hashFile(childPath(repositoryRoot, protocol.hostedWorkflow.path)), protocol.hostedWorkflow.sha256)
    return hash(bytes)
}
export async function loadInputs(snapshotRoot) {
    const protocolBytes = await readFile(path.join(toolingRoot, 'protocol.json'))
    const protocol = JSON.parse(protocolBytes)
    assert.equal(protocol.schemaVersion, 1)
    const expectedInventoryBytes = await readFile(path.join(toolingRoot, protocol.snapshotInventoryFile))
    assert.equal(hash(expectedInventoryBytes), protocol.snapshotInventorySha256)
    const inventoryBytes = await readFile(path.join(snapshotRoot, 'inventory.json'))
    assert.equal(hash(inventoryBytes), protocol.snapshotInventorySha256, 'Captured inventory differs from preregistration')
    const inventory = JSON.parse(inventoryBytes)
    assert.equal(inventory.complete, true)
    assert.equal(inventory.sourceCommit, protocol.baseline.sourceCommit)
    assert.equal(inventory.canonicalWasmSha256, protocol.baseline.sha256)
    assert.deepEqual(inventory.fixture, protocol.fixture)
    assert.equal(inventory.sourceRows, protocol.fixture.rows)
    assert.equal(inventory.groups.length, protocol.capture.expectedGroups)
    assert.deepEqual(inventory.groups.map(({group}) => group), Array.from({length: 12}, (_, i) => i + 1))
    return {protocol, inventory, protocolSha256: hash(protocolBytes), snapshotInventorySha256: hash(inventoryBytes)}
}
export async function loadSnapshot(snapshotRoot, group) {
    async function decompress(entry) {
        const compressed = await readFile(childPath(snapshotRoot, entry.path))
        assert.equal(compressed.byteLength, entry.compressedBytes)
        assert.equal(hash(compressed), entry.compressedSha256)
        const raw = gunzipSync(compressed)
        assert.equal(raw.byteLength, entry.bytes)
        assert.equal(hash(raw), entry.sha256)
        return raw
    }
    const before = await decompress(group.before)
    const after = await decompress(group.afterXor)
    assert.equal(before.byteLength, group.memoryPages * 65536)
    assert.equal(after.byteLength, before.byteLength)
    for (let i = 0; i < after.length; ++i) { after[i] ^= before[i] }
    assert.equal(hash(after), group.afterSha256)
    return {before, after}
}
