import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {readFile, writeFile, rename} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

export const toolingRoot = path.dirname(fileURLToPath(import.meta.url))
export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
export const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'))
export async function hashFile(file) {
    const digest = createHash('sha256')
    for await (const bytes of createReadStream(file)) digest.update(bytes)
    return digest.digest('hex')
}
export async function writeJson(file, value) {
    const temporary = file + '.tmp'
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n')
    await rename(temporary, file)
}
export function childPath(root, relative) {
    assert.equal(typeof relative, 'string')
    assert(relative.length > 0 && !path.isAbsolute(relative))
    assert(!relative.split(/[\\/]/).includes('..'))
    return path.join(root, relative)
}
export async function verifySourceInventory() {
    const bytes = await readFile(path.join(toolingRoot, 'source-inventory.json'))
    const inventory = JSON.parse(bytes)
    assert.equal(inventory.schemaVersion, 1)
    const seen = new Set()
    for (const entry of inventory.files) {
        assert(!seen.has(entry.path))
        seen.add(entry.path)
        const file = await readFile(childPath(toolingRoot, entry.path))
        assert.equal(file.byteLength, entry.bytes, entry.path)
        assert.equal(hash(file), entry.sha256, entry.path)
    }
    for (const name of ['protocol.json', 'input-inventory.json', 'baseline-loop.mjs', 'native-validator.mjs',
        'record-run-validator.wasm', 'common.mjs', 'observe.mjs', 'run.mjs', 'worker.mjs', 'check-harness.mjs', 'analyze.py', 'check-analysis.py']) {
        assert(seen.has(name), `Missing source inventory entry: ${name}`)
    }
    const protocol = await readJson(path.join(toolingRoot, 'protocol.json'))
    if (protocol.hostedWorkflow) {
        const repositoryRoot = path.resolve(toolingRoot, '../../..')
        assert.equal(await hashFile(childPath(repositoryRoot, protocol.hostedWorkflow.path)), protocol.hostedWorkflow.sha256)
    }
    for (const name of protocol.additionalSourceFiles ?? []) assert(seen.has(name), `Missing hosted source entry: ${name}`)
    return hash(bytes)
}
export async function loadInputs(inputRoot) {
    const protocolBytes = await readFile(path.join(toolingRoot, 'protocol.json'))
    const protocol = JSON.parse(protocolBytes)
    assert.equal(protocol.schemaVersion, 1)
    assert.equal(protocol.status, 'frozen', 'Acquisition is blocked until parent review and explicit protocol freeze')
    const inventoryBytes = await readFile(path.join(toolingRoot, protocol.inputInventoryFile))
    assert.equal(hash(inventoryBytes), protocol.inputInventorySha256)
    const inventory = JSON.parse(inventoryBytes)
    assert.equal(inventory.baselineHead, protocol.baselineHead)
    assert.equal(inventory.baselineStoreSha256, protocol.baselineStoreSha256)
    assert.equal(inventory.rows, 528299)
    assert.equal(inventory.uniqueReferences, 366030)
    assert.equal(inventory.inputCopyBytesPerPass, protocol.checks.nativeCopiedInputBytesPerPass)
    assert.deepEqual(inventory.groups.map(({group}) => group), Array.from({length: 12}, (_, i) => i + 1))
    for (const group of inventory.groups) {
        const payload = await readFile(childPath(inputRoot, group.file))
        assert.equal(payload.byteLength, group.bytes)
        assert.equal(hash(payload), group.sha256)
    }
    return {protocol, inventory, protocolSha256: hash(protocolBytes), inputInventorySha256: hash(inventoryBytes)}
}
