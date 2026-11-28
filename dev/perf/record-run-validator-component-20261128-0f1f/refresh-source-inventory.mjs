// Hash preparation only. This does not approve, freeze, or run the protocol.
import {readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {hash, toolingRoot} from './common.mjs'

const names = ['protocol.json', 'input-inventory.json', 'baseline-loop.mjs', 'native-validator.mjs',
    'record-run-validator.wasm', 'common.mjs', 'observe.mjs', 'run.mjs', 'worker.mjs', 'check-harness.mjs',
    'analyze.py', 'check-analysis.py', 'harness-lineage.json', 'refresh-source-inventory.mjs', 'README.md']
const protocol = JSON.parse(await readFile(path.join(toolingRoot, 'protocol.json'), 'utf8'))
const files = []
for (const name of [...new Set([...names, ...(protocol.additionalSourceFiles ?? [])])]) {
    const bytes = await readFile(path.join(toolingRoot, name))
    files.push({path: name, bytes: bytes.byteLength, sha256: hash(bytes)})
}
const inventory = {schemaVersion: 1, status: protocol.status, files}
const serialized = JSON.stringify(inventory, null, 2) + '\n'
await writeFile(path.join(toolingRoot, 'source-inventory.json'), serialized)
console.log(JSON.stringify({status: protocol.status, files: files.length, sha256: hash(serialized)}))
